/**
 * createBot.js - Creates a single mineflayer bot instance with full lifecycle logic.
 *
 * Flow: Connect -> Spawn -> Stay AFK (bot spawns directly in AFK area)
 * Auto-reconnect on kick/disconnect with exponential backoff.
 * Monitors server identity — reconnects if not on Donut SMP.
 * Handles "Servers are updating" messages gracefully.
 *
 * Features: Anti-detection movement, proxy support, teleport detection,
 * username mention alerts, Discord webhooks, session tracking.
 */

const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const logger = require('../utils/logger');
const webhook = require('../utils/webhook');

// SOCKS5 proxy support (optional)
let SocksClient = null;
try { SocksClient = require('socks').SocksClient; } catch (_) { }

const MAX_RETRIES = 99999;
const BASE_RECONNECT_DELAY = 15000; // 15 seconds (exponential backoff base)
const MAX_RECONNECT_DELAY = 300000; // 5 minutes cap
const TELEPORT_THRESHOLD = 20; // blocks
const PLAYTIME_REPORT_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const MILESTONE_HOURS = 72; // 3 days

/**
 * Creates and manages a single Minecraft bot.
 * @param {Object} accountConfig - { name } (label only, auth via device code)
 * @param {Object} serverConfig - { host, port }
 * @param {Object} callbacks - { onChatMessage, onStatusChange, onDisconnect, onAfkReached, onDeviceCode }
 * @param {string|null} proxyUrl - Proxy URL to use, or null for direct connection
 * @returns {Object} BotState
 */
function createBotState(accountConfig, serverConfig, callbacks = {}, proxyUrl = null) {
  const accountName = accountConfig.name;

  // Create a per-account auth cache directory for token persistence
  const profilesFolder = path.join(process.cwd(), 'auth_cache', accountName);
  if (!fs.existsSync(profilesFolder)) {
    fs.mkdirSync(profilesFolder, { recursive: true });
  }

  const state = {
    accountName,
    proxyUrl,
    bot: null,
    status: 'offline',
    reconnectAttempts: 0,
    shouldReconnect: true,
    reconnectTimer: null,
    antiAfkInterval: null,
    serverMonitorInterval: null,
    serverConfig,
    callbacks,
    profilesFolder,
    // Scoreboard stats
    playtime: null,
    shards: null,
    // Guard flags
    _disconnecting: false, // prevents double reconnect from kicked+end
    _connecting: false,     // prevents overlapping connect calls
    _serverUpdating: false, // true when "Servers are updating" message is detected
    // Anti-detection & staff detection
    _lastPosition: null,       // {x,y,z} for teleport detection
    _positionTrackInterval: null,
    _mentionFrozen: false,     // true when bot's name mentioned in chat — freeze movement
    _teleportGraceUntil: 0,    // timestamp — ignore teleports until this time (spawn/respawn grace)
    // Session tracking
    _sessionStartTime: null,   // Date.now() on spawn
    _cumulativeSessionMs: 0,   // total across reconnects
    _playtimeReportInterval: null,
    _milestoneAlerted: false,  // prevent duplicate 72h alerts
    _milestoneCheckInterval: null,
  };

  return state;
}

// ========== Utility functions for text parsing ==========

/**
 * Strips Minecraft color/formatting codes from text.
 */
function stripColorCodes(text) {
  if (!text) return '';
  // Match both raw section sign and escaped versions
  return text
    .replace(/\xA7[0-9a-fk-or]/gi, '')
    .replace(/\\u00a7[0-9a-fk-or]/gi, '')
    .trim();
}

/**
 * Extracts plain text from Minecraft JSON text components.
 */
function extractTextFromJson(json) {
  if (!json) return '';
  if (typeof json === 'string') {
    try {
      const parsed = JSON.parse(json);
      return extractTextFromJson(parsed);
    } catch (_) {
      return stripColorCodes(json);
    }
  }
  let result = '';
  if (json.text) result += json.text;
  if (json.extra && Array.isArray(json.extra)) {
    for (const part of json.extra) {
      result += extractTextFromJson(part);
    }
  }
  if (json.translate) result += json.translate;
  return stripColorCodes(result);
}

/**
 * Formats a raw score value (assumed minutes) into a human-readable playtime string.
 */
function formatPlaytime(totalMinutes) {
  if (totalMinutes == null || isNaN(totalMinutes)) return 'N/A';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return hours + 'h ' + minutes + 'm';
  }
  return minutes + 'm';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detects auth-related errors that indicate stale/invalid tokens.
 */
function isAuthError(message) {
  if (!message) return false;
  var lower = message.toLowerCase();
  return (
    lower.includes('failed to obtain profile data') ||
    lower.includes('does the account own minecraft') ||
    lower.includes('failed to get minecraft profile') ||
    lower.includes('invalid or expired token') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication failed') ||
    lower.includes('fetch failed') ||
    lower.includes('protocol error') ||
    lower.includes('network error')
  );
}

/**
 * Clears all cached auth token files for an account.
 * This forces the next connection attempt to use a fresh device code flow.
 */
function clearAuthCache(profilesFolder, accountName) {
  try {
    var files = fs.readdirSync(profilesFolder);
    for (var i = 0; i < files.length; i++) {
      var filePath = path.join(profilesFolder, files[i]);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        logger.info('Deleted stale token: ' + files[i], accountName);
      }
    }
    logger.info('Auth cache cleared — next connect will prompt a fresh device code login.', accountName);
  } catch (err) {
    logger.error('Failed to clear auth cache: ' + err.message, accountName);
  }
}

// ========== Proxy helper ==========

/**
 * Creates a proxied TCP socket via SOCKS5 or HTTP proxy.
 * Returns null if no proxy configured.
 */
async function createProxySocket(host, port, proxyUrl) {
  if (!proxyUrl) return null;

  try {
    var parsed = new URL(proxyUrl);
    var proxyType = parsed.protocol.replace(':', '').toLowerCase();

    if ((proxyType === 'socks5' || proxyType === 'socks4') && SocksClient) {
      var socksOptions = {
        proxy: {
          host: parsed.hostname,
          port: parseInt(parsed.port) || 1080,
          type: proxyType === 'socks5' ? 5 : 4,
        },
        command: 'connect',
        destination: { host: host, port: port },
      };
      if (parsed.username) {
        socksOptions.proxy.userId = decodeURIComponent(parsed.username);
        socksOptions.proxy.password = decodeURIComponent(parsed.password || '');
      }
      var info = await SocksClient.createConnection(socksOptions);
      logger.info('Connected via SOCKS5 proxy: ' + parsed.hostname + ':' + parsed.port);
      return info.socket;
    } else if (proxyType === 'http' || proxyType === 'https') {
      // HTTP CONNECT tunnel
      return await new Promise(function (resolve, reject) {
        var proxyPort = parseInt(parsed.port) || 80;
        var connectReq = 'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n';
        if (parsed.username) {
          var auth = Buffer.from(decodeURIComponent(parsed.username) + ':' + decodeURIComponent(parsed.password || '')).toString('base64');
          connectReq += 'Proxy-Authorization: Basic ' + auth + '\r\n';
        }
        connectReq += '\r\n';
        var socket = net.connect(proxyPort, parsed.hostname, function () {
          socket.write(connectReq);
        });
        socket.once('data', function (chunk) {
          if (chunk.toString().includes('200')) {
            logger.info('Connected via HTTP proxy: ' + parsed.hostname + ':' + proxyPort);
            resolve(socket);
          } else {
            reject(new Error('HTTP proxy rejected: ' + chunk.toString().split('\r\n')[0]));
          }
        });
        socket.once('error', reject);
        setTimeout(function () { reject(new Error('Proxy connect timeout')); }, 15000);
      });
    } else {
      logger.warn('Unknown proxy protocol: ' + proxyType + ' — connecting directly.');
      return null;
    }
  } catch (err) {
    logger.error('Proxy connection failed: ' + err.message + ' — falling back to direct.');
    return null;
  }
}

// ========== Performance Optimization (Safe Memory Cleanup) ==========

/**
 * Sets up safe performance optimizations for an AFK bot.
 *
 * IMPORTANT: We do NOT intercept/drop packets at the protocol emit level.
 * The server tracks unacknowledged packets and kicks clients that don't
 * process them ("Packet limit" kick). Instead, we:
 *
 * 1. Let ALL packets through so the protocol layer can send required acks.
 * 2. Periodically purge entities from mineflayer's entity tracker (frees RAM/CPU).
 * 3. Periodically clear cached world column data (frees huge amounts of RAM).
 * 4. Remove mineflayer's event listeners for cosmetic-only events that waste CPU
 *    (these listeners don't affect protocol responses).
 */
function setupPerformanceOptimizations(bot, state) {
  // ---- 1. Suppress cosmetic mineflayer events (safe — no protocol impact) ----
  // These remove mineflayer's internal handlers so it doesn't waste CPU building
  // particle/sound objects, but the protocol layer still processes the raw packets.
  bot.removeAllListeners('particle');

  // ---- 2. Periodic entity purge (every 2s) ----
  // Entities pile up in bot.entities as players/mobs enter view range.
  // We keep ONLY the bot's own entity (needed for position/health tracking).
  state._entityPurgeInterval = setInterval(function () {
    if (!bot || !bot.entities) return;
    if (!bot.entity || !bot.entity.position) return; // Prevent early purge before spawn
    var botId = bot.entity ? bot.entity.id : null;
    var keys = Object.keys(bot.entities);
    var purged = 0;
    for (var i = 0; i < keys.length; i++) {
      var id = parseInt(keys[i]);
      if (id !== botId) {
        delete bot.entities[id];
        purged++;
      }
    }
  }, 2000);

  // ---- 3. Periodic world column purge (every 2s) ----
  // Chunk data accumulates massive RAM causing OOM.
  state._worldPurgeInterval = setInterval(function () {
    if (!bot || !bot.world) return;
    if (!bot.entity || !bot.entity.position) return; // Prevent early purge before spawn
    try {
      var botX = Math.floor(bot.entity.position.x / 16);
      var botZ = Math.floor(bot.entity.position.z / 16);

      // mineflayer stores columns in bot.world.columns or bot.world._columns
      var columns = bot.world.columns || bot.world._columns;
      if (columns && typeof columns === 'object') {
        var colKeys = Object.keys(columns);
        var cleared = 0;
        if (colKeys.length > 0) {
          for (var c = 0; c < colKeys.length; c++) {
            var key = colKeys[c];
            var parts = key.split(',');
            if (parts.length === 2 && botX !== null && botZ !== null) {
              var cx = parseInt(parts[0]);
              var cz = parseInt(parts[1]);
              if (Math.abs(cx - botX) <= 1 && Math.abs(cz - botZ) <= 1) {
                continue; // Keep 3x3 area around bot so physics doesn't make it fall
              }
            }
            delete columns[key];
            cleared++;
          }
          if (cleared > 0) {
            logger.debug('Cleared ' + cleared + ' world columns from memory.', state.accountName);
          }
        }
      }
      // Also try the async column store (prismarine-world)
      if (bot.world.async && bot.world.async.columns) {
        var asyncCols = Object.keys(bot.world.async.columns);
        for (var a = 0; a < asyncCols.length; a++) {
          var aKey = asyncCols[a];
          var aParts = aKey.split(',');
          if (aParts.length === 2 && botX !== null && botZ !== null) {
            var acx = parseInt(aParts[0]);
            var acz = parseInt(aParts[1]);
            if (Math.abs(acx - botX) <= 1 && Math.abs(acz - botZ) <= 1) {
              continue;
            }
          }
          delete bot.world.async.columns[aKey];
        }
      }
    } catch (_) { }
  }, 2000);

  logger.info('Performance optimizations active — entity/world cleanup every 2s.', state.accountName);
}

/**
 * Stops the performance optimization intervals to prevent memory leaks on disconnect.
 */
function stopPerformanceOptimizations(state) {
  if (state._entityPurgeInterval) {
    clearInterval(state._entityPurgeInterval);
    state._entityPurgeInterval = null;
  }
  if (state._worldPurgeInterval) {
    clearInterval(state._worldPurgeInterval);
    state._worldPurgeInterval = null;
  }
}

// ========== Bot connection and lifecycle ==========

/**
 * Connects the bot to the Minecraft server.
 * @param {Object} state - BotState
 */
async function connectBot(state) {
  // Prevent overlapping connect calls
  if (state._connecting) {
    logger.warn('Already connecting, ignoring duplicate connect call.', state.accountName);
    return;
  }
  state._connecting = true;
  state._disconnecting = false;

  if (state.bot) {
    try {
      state.bot.removeAllListeners();
      state.bot.quit();
    } catch (_) { }
    state.bot = null;
    // Wait for the server to fully release the old session
    await sleep(3000);
    if (!state.shouldReconnect) {
      logger.info('Connection aborted because bot was stopped.', state.accountName);
      state._connecting = false;
      return;
    }
  }

  setStatus(state, 'connecting');
  logger.info('Connecting to ' + state.serverConfig.host + ':' + state.serverConfig.port + '...', state.accountName);

  const botOptions = {
    host: state.serverConfig.host,
    port: state.serverConfig.port,
    username: state.accountName,
    auth: 'microsoft',
    version: false, // auto-detect
    checkTimeoutInterval: 120000, // 2 min — survive server restarts without timing out
    hideErrors: true,
    profilesFolder: state.profilesFolder,
    // Disable chunk column parsing — AFK bot doesn't need world data
    viewDistance: 'tiny',
    // Physics must be enabled for jumping/movement to work
    physicsEnabled: true,
    onMsaCode: function (data) {
      var msg = 'To sign in, open: ' + data.verification_uri + ' and enter code: ' + data.user_code;
      logger.info(msg, state.accountName);
      logger.info('Code expires in ' + Math.floor((data.expires_in || 900) / 60) + ' minutes', state.accountName);
      setStatus(state, 'awaiting_auth');
      if (state.callbacks.onDeviceCode) {
        state.callbacks.onDeviceCode(state.accountName, data);
      }
    },
  };

  // Proxy support: create proxied socket if configured
  try {
    if (state.proxyUrl) {
      var proxySocket = await createProxySocket(state.serverConfig.host, state.serverConfig.port, state.proxyUrl);
      if (proxySocket) {
        botOptions.connect = function (client) {
          client.setSocket(proxySocket);
          client.emit('connect');
        };
      }
    } else {
      logger.info('Connecting directly (proxy disabled).', state.accountName);
    }
  } catch (proxyErr) {
    logger.warn('Proxy setup failed: ' + proxyErr.message + ' — connecting directly.', state.accountName);
  }

  try {
    const bot = mineflayer.createBot(botOptions);
    state.bot = bot;

    // ========== PERFORMANCE OPTIMIZATIONS — Safe memory cleanup ==========
    // Purges entities/world data from memory periodically.
    // Does NOT block protocol packets (that causes "Packet limit" kicks).
    setupPerformanceOptimizations(bot, state);

    // ---- Spawn Event ----
    bot.once('spawn', async function () {
      state._connecting = false;
      state.reconnectAttempts = 0;
      state._serverUpdating = false;
      state._mentionFrozen = false;
      // Grace period: ignore teleports for 15s after initial spawn
      state._teleportGraceUntil = Date.now() + 15000;
      setStatus(state, 'online');
      logger.success('Spawned into server!', state.accountName);

      // Discord webhook: login success
      webhook.logLogin(state.accountName);

      // Session tracking
      state._sessionStartTime = Date.now();
      startPlaytimeReporting(state);
      startMilestoneCheck(state);

      // Wait for full spawn / chunks to load
      await sleep(5000);

      // Send /afk 50 to bypass the AFK GUI selector and join directly
      logger.info('Sending /afk 50 command...', state.accountName);
      try {
        bot.chat('/afk 50');
      } catch (err) {
        logger.error('Failed to send /afk 50: ' + err.message, state.accountName);
      }

      // Wait for the server to process the /afk command and teleport
      await sleep(5000);

      // (Teleport detection removed to prevent false positives when server routes to lobbies)

      setStatus(state, 'afk');
      logger.success('Bot sent /afk 50. Now staying AFK...', state.accountName);
      if (state.callbacks.onAfkReached) {
        state.callbacks.onAfkReached(state.accountName);
      }

      // Start anti-detection movement loop (randomized jump/crouch/look)
      startAntiAfk(state, true);

      // Start server monitor: check we're still on Donut SMP
      startServerMonitor(state);
    });

    // ---- Re-spawn Event (world change) ----
    // Some servers fire 'spawn' again when moving between worlds
    bot.on('spawn', async function () {
      if (state.status === 'offline') return;
      logger.info('World change detected (re-spawn). Checking server...', state.accountName);
      // Grace period: ignore teleports for 10s after world change / AFK zone restart
      state._teleportGraceUntil = Date.now() + 10000;
      // Reset last known position so we don't compare old world coords
      if (state.bot && state.bot.entity && state.bot.entity.position) {
        var p = state.bot.entity.position;
        state._lastPosition = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      }
      // Give the server a moment to settle
      await sleep(2000);
      // Verify we're still on the right server
      checkServerIdentity(state);
    });

    // ---- Chat Event ----
    bot.on('chat', function (username, message) {
      if (username === bot.username) return;
      
      // Disabled rendering/logging of other players' messages to save memory
      // logger.info('<' + username + '> ' + message, state.accountName);

      // Username mention detection
      checkForMention(state, '<' + username + '> ' + message);

      // Disabled forwarding general chat to Discord
      // if (state.callbacks.onChatMessage) {
      //   state.callbacks.onChatMessage(state.accountName, username, message);
      // }
    });

    // ---- System message / whisper ----
    bot.on('message', function (jsonMsg) {
      var text = jsonMsg.toString();
      if (text && text.trim().length > 0) {
        // Detect "Servers are updating" message
        if (text.toLowerCase().includes('servers are updating')) {
          state._serverUpdating = true;
          logger.warn('Server update detected: "' + text.trim() + '" — pausing activity, waiting to be put back.', state.accountName);
          // Stop anti-AFK during updates to avoid any teleport issues
          stopAntiAfk(state);
          if (state.callbacks.onStatusChange) {
            state.callbacks.onStatusChange(state.accountName, 'updating', 'Server is updating — waiting to be put back');
          }
        }

        // Username mention detection (system messages too)
        checkForMention(state, text);

        // Disabled forwarding general system messages to Discord (except for mentions/restarts which have their own alerts)
        // if (state.callbacks.onChatMessage) {
        //   state.callbacks.onChatMessage(state.accountName, null, text);
        // }
      }
    });

    // ---- Death Event ----
    bot.on('death', function () {
      logger.warn('Bot died!', state.accountName);
      if (state.callbacks.onStatusChange) {
        state.callbacks.onStatusChange(state.accountName, 'died', 'Bot died in-game');
      }
      bot.emit('respawn');
    });

    // ---- Kicked Event ----
    bot.on('kicked', function (reason) {
      var reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
      var cleanReason = stripColorCodes(reasonText);
      logger.error('Kicked: ' + cleanReason, state.accountName);

      // Stop all monitoring on kick
      stopServerMonitor(state);
      stopTeleportDetection(state);
      stopPlaytimeReporting(state);
      stopMilestoneCheck(state);
      stopPerformanceOptimizations(state);

      // Set flag so the 'end' event (which always fires after 'kicked') doesn't double-reconnect
      state._disconnecting = true;
      setStatus(state, 'offline');

      // Check if this is a world-change / server-update kick
      var lowerReason = cleanReason.toLowerCase();
      var isUpdateKick = lowerReason.includes('servers are updating') ||
                         lowerReason.includes('server is restarting') ||
                         lowerReason.includes('server closed') ||
                         lowerReason.includes('server is full') ||
                         lowerReason.includes('restart') ||
                         lowerReason.includes('reboot') ||
                         lowerReason.includes('maintenance') ||
                         lowerReason.includes('timed out') ||
                         lowerReason.includes('read timed out') ||
                         lowerReason.includes('connection reset') ||
                         lowerReason.includes('internal exception') ||
                         lowerReason.includes('io.netty') ||
                         lowerReason.includes('disconnect.overflow') ||
                         lowerReason.includes('multiplayer.disconnect');

      if (state.callbacks.onDisconnect) {
        state.callbacks.onDisconnect(state.accountName, 'Kicked: ' + cleanReason);
      }
      webhook.logDisconnect(state.accountName, 'Kicked: ' + cleanReason);

      if (isUpdateKick) {
        // Wait longer for server updates before reconnecting (45s)
        logger.info('Server update/restart kick — waiting 45s before reconnect...', state.accountName);
        state.reconnectAttempts = 0; // Reset attempts for server restarts
        state.reconnectTimer = setTimeout(function () {
          if (state.shouldReconnect) {
            state._connecting = false;
            state._serverUpdating = false;
            connectBot(state);
          }
        }, 45000);
      } else {
        scheduleReconnect(state);
      }
    });

    // ---- End Event (disconnect) ----
    bot.on('end', function (reason) {
      // Stop server monitor on disconnect
      stopServerMonitor(state);
      stopAntiAfk(state);
      stopTeleportDetection(state);
      stopPlaytimeReporting(state);
      stopMilestoneCheck(state);
      stopPerformanceOptimizations(state);

      // If kicked handler already scheduled a reconnect, skip
      if (state._disconnecting) {
        state._disconnecting = false;
        return;
      }
      if (state.status === 'offline' && !state.shouldReconnect) return;

      var reasonStr = typeof reason === 'string' ? reason : (reason ? JSON.stringify(reason) : 'unknown');
      logger.warn('Disconnected: ' + reasonStr, state.accountName);
      setStatus(state, 'offline');

      // Check if this looks like a server restart / lag timeout
      var lowerReason = reasonStr.toLowerCase();
      var isServerIssue = lowerReason.includes('socketclosed') ||
                          lowerReason.includes('timed out') ||
                          lowerReason.includes('timeout') ||
                          lowerReason.includes('econnreset') ||
                          lowerReason.includes('disconnect.timeout') ||
                          lowerReason.includes('keepalive');

      if (state.callbacks.onDisconnect) {
        state.callbacks.onDisconnect(state.accountName, 'Disconnected: ' + reasonStr);
      }

      if (isServerIssue) {
        // Server lag or restart — wait 45s then reconnect with reset attempts
        logger.info('Server lag/restart detected — waiting 45s before reconnect...', state.accountName);
        state.reconnectAttempts = 0;
        state.reconnectTimer = setTimeout(function () {
          if (state.shouldReconnect) {
            state._connecting = false;
            state._serverUpdating = false;
            connectBot(state);
          }
        }, 45000);
      } else {
        scheduleReconnect(state);
      }
    });

    // ==================================================================
    // SCOREBOARD / STATS TRACKING (Playtime & Shards)
    // Parses from: sidebar scoreboard, tab list, action bar, boss bar
    // ==================================================================

    /**
     * Try to extract playtime and shards from a single text string.
     * Very lenient matching - captures anything after the keyword.
     */
    function tryParseStats(text) {
      if (!text) return;
      var clean = stripColorCodes(text);
      if (!clean || clean.length === 0) return;

      // Playtime - match with or without colon/space, capture rest of line
      var ptPatterns = [
        /play\s*time[:\s»>-]+(.+)/i,
        /play\s*time\s*[:\s]*(\d[\dhms ,dw]+)/i,
        /playtime\s*(.+)/i,
      ];
      for (var pi = 0; pi < ptPatterns.length; pi++) {
        var ptMatch = clean.match(ptPatterns[pi]);
        if (ptMatch && ptMatch[1] && ptMatch[1].trim().length > 0) {
          var ptVal = ptMatch[1].trim();
          // Don't store if it's just the word itself or a label
          if (ptVal.length > 0 && !/^[:\s]*$/.test(ptVal)) {
            state.playtime = ptVal;
            logger.info('PARSED playtime = "' + state.playtime + '"', state.accountName);
            break;
          }
        }
      }

      // Shards - match with or without colon/space
      var shPatterns = [
        /shard[s]?[:\s»>-]+(.+)/i,
        /shard[s]?\s*[:\s]*(\d[\d,. ]*)/i,
        /shards?\s*(.+)/i,
      ];
      for (var si = 0; si < shPatterns.length; si++) {
        var shMatch = clean.match(shPatterns[si]);
        if (shMatch && shMatch[1] && shMatch[1].trim().length > 0) {
          var shVal = shMatch[1].trim();
          if (shVal.length > 0 && !/^[:\s]*$/.test(shVal)) {
            state.shards = shVal;
            logger.info('PARSED shards = "' + state.shards + '"', state.accountName);
            break;
          }
        }
      }
    }

    /**
     * Collects all team texts in order and does multi-line stat parsing.
     * Handles cases where "Playtime" is on one team line and the value
     * (e.g. "5h 23m") is on the next team line.
     */
    function parseTeamStats() {
      if (!bot.teams) return;

      var teamKeys = Object.keys(bot.teams);
      var allLines = [];

      for (var t = 0; t < teamKeys.length; t++) {
        var team = bot.teams[teamKeys[t]];
        var prefix = '';
        var suffix = '';

        if (team.prefix) {
          prefix = typeof team.prefix === 'object'
            ? extractTextFromJson(team.prefix) : stripColorCodes(String(team.prefix));
        }
        if (team.suffix) {
          suffix = typeof team.suffix === 'object'
            ? extractTextFromJson(team.suffix) : stripColorCodes(String(team.suffix));
        }

        var fullText = (prefix + ' ' + suffix).trim();
        if (fullText.length > 0) {
          allLines.push(fullText);
          // Silent - no debug logging for team entries
        }
      }

      // First: try parsing each line individually
      for (var i = 0; i < allLines.length; i++) {
        tryParseStats(allLines[i]);
      }

      // Second: if still not found, try multi-line matching
      // (Playtime on line N, value on line N+1)
      if (!state.playtime) {
        for (var j = 0; j < allLines.length - 1; j++) {
          var line = stripColorCodes(allLines[j]);
          var nextLine = stripColorCodes(allLines[j + 1]);
          if (/play\s*time/i.test(line) && nextLine.length > 0) {
            // Check if next line looks like a time value
            if (/\d/.test(nextLine)) {
              state.playtime = nextLine.trim();
              logger.info('PARSED playtime (next-line) = "' + state.playtime + '"', state.accountName);
            }
          }
        }
      }

      if (!state.shards) {
        for (var k = 0; k < allLines.length - 1; k++) {
          var sLine = stripColorCodes(allLines[k]);
          var sNextLine = stripColorCodes(allLines[k + 1]);
          if (/shard/i.test(sLine) && sNextLine.length > 0) {
            if (/\d/.test(sNextLine)) {
              state.shards = sNextLine.trim();
              logger.info('PARSED shards (next-line) = "' + state.shards + '"', state.accountName);
            }
          }
        }
      }

      // Third: try joining ALL lines and parsing as one blob
      if (!state.playtime || !state.shards) {
        var blob = allLines.join(' ');
        tryParseStats(blob);
      }
    }

    /**
     * Dumps and parses ALL scoreboard positions.
     * Logs raw structure for debugging when entries are not found.
     */
    function dumpAndParseScoreboard() {
      try {
        if (!bot.scoreboard) return;

        // Iterate all positions: 0=list, 1=sidebar, 2=belowName, 3-18=team sidebars
        for (var pos = 0; pos <= 18; pos++) {
          var objective = bot.scoreboard[pos];
          if (!objective) continue;

          var title = objective.displayName
            ? extractTextFromJson(objective.displayName)
            : (objective.name || 'Unknown');

          // Dump ALL properties of the objective for debugging
          var objKeys = Object.keys(objective);
          // Silent - no debug logging for scoreboard positions

          // Try every property that might contain items
          var propsToCheck = ['items', 'itemsMap', 'scores', 'entries', 'players', 'list'];
          for (var p = 0; p < propsToCheck.length; p++) {
            var prop = propsToCheck[p];
            if (objective[prop]) {
              var isArray = Array.isArray(objective[prop]);
              var isObj = typeof objective[prop] === 'object' && !isArray;

              if (isArray && objective[prop].length > 0) {
                // Silent
                for (var i = 0; i < objective[prop].length; i++) {
                  var arrItem = objective[prop][i];
                  dumpAndParseEntry(arrItem, prop + '[' + i + ']');
                }
              } else if (isObj) {
                var objEntryKeys = Object.keys(objective[prop]);
                if (objEntryKeys.length > 0) {
                  // Silent
                  for (var k = 0; k < objEntryKeys.length; k++) {
                    var entryKey = objEntryKeys[k];
                    var entryVal = objective[prop][entryKey];
                    dumpAndParseEntry(entryVal, prop + '.' + entryKey, entryKey);
                  }
                }
              }
            }
          }

          // Parse title itself
          tryParseStats(title);
        }

        // ---- Scan teams using multi-line aware parser ----
        parseTeamStats();

        // ---- Also check bot.scoreboards (alternative API) ----
        if (bot.scoreboards) {
          var sbKeys = Object.keys(bot.scoreboards);
          for (var s = 0; s < sbKeys.length; s++) {
            var sb = bot.scoreboards[sbKeys[s]];
            // Silent
          }
        }

      } catch (err) {
        logger.debug('Scoreboard parse error: ' + err.message, state.accountName);
      }
    }

    /**
     * Dumps and parses a single scoreboard entry (from items, itemsMap, etc.)
     */
    function dumpAndParseEntry(entry, label, rawKey) {
      if (!entry) return;

      // Log the raw entry structure
      var entryKeys = typeof entry === 'object' ? Object.keys(entry) : [];
      var entryName = '';
      var entryDisplay = '';
      var entryValue = null;

      // Try all common property names
      entryName = entry.name || entry.entry || entry.player || rawKey || '';
      entryValue = entry.value != null ? entry.value : (entry.score != null ? entry.score : null);

      if (entry.displayName) {
        entryDisplay = typeof entry.displayName === 'object'
          ? extractTextFromJson(entry.displayName)
          : stripColorCodes(String(entry.displayName));
      }

      var cleanName = stripColorCodes(String(entryName));
      // Silent - no debug logging for individual entries

      tryParseStats(cleanName);
      tryParseStats(entryDisplay);

      // Check if this entry directly represents a stat
      if (/shard/i.test(cleanName) || /shard/i.test(entryDisplay)) {
        if (entryValue != null && !state.shards) {
          state.shards = entryValue.toLocaleString();
          logger.info('Found shards from score value: ' + state.shards, state.accountName);
        }
      }
      if (/play\s*time/i.test(cleanName) || /play\s*time/i.test(entryDisplay)) {
        if (entryValue != null && !state.playtime) {
          state.playtime = formatPlaytime(entryValue);
          logger.info('Found playtime from score value: ' + state.playtime, state.accountName);
        }
      }
    }

    // ---- Tab list header/footer (many servers show stats here) ----
    bot._client.on('playerlist_header', function (packet) {
      try {
        var header = extractTextFromJson(packet.header);
        var footer = extractTextFromJson(packet.footer);
        if (header) {
          // Silent
          tryParseStats(header);
        }
        if (footer) {
          // Silent
          tryParseStats(footer);
        }
      } catch (err) {
        logger.debug('Tab list parse error: ' + err.message, state.accountName);
      }
    });

    // ---- Action bar messages ----
    bot._client.on('action_bar', function (packet) {
      try {
        var text = extractTextFromJson(packet.text);
        if (text) {
          // Silent
          tryParseStats(text);
        }
      } catch (_) { }
    });

    // ---- Boss bar ----
    bot.on('bossBarCreated', function (bossBar) {
      try {
        var title = extractTextFromJson(bossBar.title);
        // Silent
        tryParseStats(title);
      } catch (_) { }
    });

    bot.on('bossBarUpdated', function (bossBar) {
      try {
        var title = extractTextFromJson(bossBar.title);
        tryParseStats(title);
      } catch (_) { }
    });

    // ---- Scoreboard events ----
    bot.on('scoreboardCreated', function () {
      setTimeout(function () { dumpAndParseScoreboard(); }, 1500);
    });

    bot.on('scoreUpdated', function () {
      dumpAndParseScoreboard();
    });

    bot.on('scoreboardPosition', function () {
      setTimeout(function () { dumpAndParseScoreboard(); }, 500);
    });

    bot.on('scoreboardDeleted', function () {
      // Silent
    });

    // Parse periodically (every 15s) in case events are missed
    var scoreboardInterval = setInterval(function () {
      if (state.bot && state.status !== 'offline') {
        dumpAndParseScoreboard();
      } else {
        clearInterval(scoreboardInterval);
      }
    }, 15000);

    // ---- Error Event ----
    bot.on('error', function (err) {
      var errMsg = err.message || '';
      logger.error('Error: ' + errMsg, state.accountName);

      // ENOSPC: disk full — clear auth cache to free space, then reconnect
      if (errMsg.includes('ENOSPC')) {
        logger.warn('Disk full (ENOSPC) — clearing auth cache to free space and reconnecting...', state.accountName);
        clearAuthCache(state.profilesFolder, state.accountName);
        try { bot.quit(); } catch (_) {}
        return;
      }

      // Auto-recover from stale auth tokens
      if (isAuthError(errMsg)) {
        logger.warn('Detected auth/profile error — clearing cached tokens and retrying...', state.accountName);
        clearAuthCache(state.profilesFolder, state.accountName);
        try { bot.quit(); } catch (_) {}
      }
    });

    // ---- Keep-alive error handling (prevents disconnect on lag spikes) ----
    bot._client.on('error', function (err) {
      var errMsg = err.message || '';
      // ENOSPC: disk full — gracefully disconnect and let reconnect handle it
      if (errMsg.includes('ENOSPC')) {
        logger.warn('Disk full (ENOSPC) on protocol write — clearing auth cache and reconnecting...', state.accountName);
        clearAuthCache(state.profilesFolder, state.accountName);
        try { bot.quit(); } catch (_) {}
        return;
      }
      // Suppress keep-alive timeout errors — these happen during server restarts
      if (errMsg.toLowerCase().includes('keepalive') || errMsg.toLowerCase().includes('timed out')) {
        logger.warn('Keep-alive timeout (server may be lagging/restarting) — will auto-reconnect', state.accountName);
        try { bot.quit(); } catch (_) {}
      } else {
        logger.error('Protocol error: ' + errMsg, state.accountName);
      }
    });

  } catch (err) {
    var errMsg = err.message || '';
    logger.error('Failed to create bot: ' + errMsg, state.accountName);

    // Auto-recover from stale auth tokens on creation failure
    if (isAuthError(errMsg)) {
      logger.warn('Detected auth/profile error — clearing cached tokens for fresh login...', state.accountName);
      clearAuthCache(state.profilesFolder, state.accountName);
    }

    setStatus(state, 'offline');
    state._connecting = false;
    scheduleReconnect(state);
  }
}

// ========== Anti-Detection Movement (randomized behavior loop) ==========

/**
 * Performs a random jump sequence (2-3 jumps).
 */
function actionJump(state) {
  var jumpCount = 2 + Math.floor(Math.random() * 2);
  logger.info('Anti-AFK: jumping ' + jumpCount + 'x', state.accountName);
  var jumped = 0;
  function doOne() {
    if (jumped >= jumpCount || !state.bot) return;
    try {
      state.bot.setControlState('jump', true);
      // Wait ~500ms for jump to complete
      setTimeout(function () { if (state.bot) state.bot.setControlState('jump', false); }, 500);
      
      // Also rotate head slightly to guarantee movement registers
      var yaw = (Math.random() * 2 - 1) * Math.PI; // random direction
      var pitch = (Math.random() - 0.5) * Math.PI * 0.4;
      state.bot.look(yaw, pitch, false).catch(() => {});
      
    } catch (_) { }
    jumped++;
    // Wait ~2-3s between jumps
    setTimeout(doOne, 2000 + Math.floor(Math.random() * 1000));
  }
  doOne();
}

/**
 * Crouches (sneaks) for 3-5 seconds then releases.
 */
function actionCrouch(state) {
  var duration = 3000 + Math.floor(Math.random() * 2000); // Increased from 1-3s to 3-5s
  logger.info('Anti-AFK: crouching for ' + (duration / 1000).toFixed(1) + 's', state.accountName);
  try {
    state.bot.setControlState('sneak', true);
    setTimeout(function () { if (state.bot) state.bot.setControlState('sneak', false); }, duration);
  } catch (_) { }
}

/**
 * Rotates head to a random yaw/pitch.
 */
function actionLook(state) {
  var yaw = (Math.random() * 2 - 1) * Math.PI; // -PI to PI
  var pitch = (Math.random() - 0.5) * Math.PI * 0.6; // -0.3PI to 0.3PI
  logger.info('Anti-AFK: rotating head', state.accountName);
  try {
    state.bot.look(yaw, pitch, false);
  } catch (_) { }
}

/**
 * Swings the bot's arm.
 */
function actionSwing(state) {
  logger.info('Anti-AFK: swinging arm', state.accountName);
  try {
    state.bot.swingArm('right');
  } catch (_) { }
}

/**
 * Combo: jump then crouch.
 */
function actionCombo(state) {
  logger.info('Anti-AFK: combo (jump+crouch)', state.accountName);
  actionJump(state);
  setTimeout(function () { actionCrouch(state); }, 4000); // Increased delay
}

/**
 * Starts the anti-detection movement loop.
 * Picks a random action every 120-300 seconds.
 * Skips if server is updating or mention-frozen.
 */
function startAntiAfk(state, immediate) {
  stopAntiAfk(state);

  var actions = [actionJump];

  function doAction() {
    if (!state.bot || state.status === 'offline') return;
    if (state._serverUpdating) {
      logger.info('Anti-AFK: skipping (server updating)', state.accountName);
      return;
    }
    if (state._mentionFrozen) {
      logger.info('Anti-AFK: skipping (mention frozen)', state.accountName);
      return;
    }
    var action = actions[Math.floor(Math.random() * actions.length)];
    action(state);
  }

  function scheduleNext() {
    // 120 to 300 seconds (2-5 minutes)
    var delay = (120 + Math.floor(Math.random() * 180)) * 1000;
    state.antiAfkInterval = setTimeout(function () {
      doAction();
      scheduleNext();
    }, delay);
  }

  logger.info('Anti-detection enabled — random actions every 120-300s.', state.accountName);

  if (immediate) {
    setTimeout(function () { doAction(); }, 5000);
  }
  scheduleNext();
}

/**
 * Stops the anti-detection movement loop.
 */
function stopAntiAfk(state) {
  if (state.antiAfkInterval) {
    clearTimeout(state.antiAfkInterval);
    state.antiAfkInterval = null;
  }
}

// ========== Teleport Detection ==========

/**
 * Monitors bot position every 2 seconds.
 * If position changes >20 blocks in one check, triggers urgent alert.
 * Ignores teleports during grace period (spawn, respawn, server update).
 */
function startTeleportDetection(state) {
  stopTeleportDetection(state);

  // Initialize position
  if (state.bot && state.bot.entity && state.bot.entity.position) {
    var p = state.bot.entity.position;
    state._lastPosition = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }

  state._positionTrackInterval = setInterval(function () {
    if (!state.bot || !state.bot.entity || !state.bot.entity.position) return;
    var pos = state.bot.entity.position;
    var cur = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };

    if (state._lastPosition) {
      var dx = cur.x - state._lastPosition.x;
      var dy = cur.y - state._lastPosition.y;
      var dz = cur.z - state._lastPosition.z;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist > TELEPORT_THRESHOLD) {
        // Skip if in grace period (spawn, respawn, AFK zone restart)
        if (Date.now() < state._teleportGraceUntil) {
          logger.info('Teleport ignored (grace period — spawn/respawn/zone restart). Dist: ' + Math.round(dist), state.accountName);
          state._lastPosition = cur;
          return;
        }
        // Skip if server is updating (will teleport to lobby/spawn)
        if (state._serverUpdating) {
          logger.info('Teleport ignored (server updating). Dist: ' + Math.round(dist), state.accountName);
          state._lastPosition = cur;
          return;
        }

        logger.error('TELEPORT DETECTED! Distance: ' + Math.round(dist) + ' blocks — STAFF ALERT', state.accountName);
        webhook.alertTeleport(state.accountName, state._lastPosition, cur, dist);

        if (state.callbacks.onTeleportDetected) {
          state.callbacks.onTeleportDetected(state.accountName, state._lastPosition, cur, dist);
        }

        // Disconnect immediately — do NOT auto-reconnect
        state.shouldReconnect = false;
        disconnectBot(state);
        return;
      }
    }
    state._lastPosition = cur;
  }, 2000);
}

function stopTeleportDetection(state) {
  if (state._positionTrackInterval) {
    clearInterval(state._positionTrackInterval);
    state._positionTrackInterval = null;
  }
}

// ========== Username Mention Detection ==========

/**
 * Checks if the bot's in-game username appears in a chat message.
 * If found: freeze all movement and send webhook alert.
 */
function checkForMention(state, text) {
  if (!state.bot || !text) return;
  var botName = state.bot.username;
  if (!botName) return;

  if (text.toLowerCase().includes(botName.toLowerCase())) {
    // Don't alert on our own messages
    if (text.startsWith('<' + botName + '>')) return;

    logger.warn('USERNAME MENTIONED in chat: ' + text, state.accountName);
    state._mentionFrozen = true;
    stopAntiAfk(state);
    webhook.alertMention(state.accountName, text);

    if (state.callbacks.onMentionDetected) {
      state.callbacks.onMentionDetected(state.accountName, text);
    }
  }
}

// ========== Session Tracking & Playtime Reporting ==========

/**
 * Starts a 12-hour interval to report playtime via webhook.
 */
function startPlaytimeReporting(state) {
  stopPlaytimeReporting(state);

  state._playtimeReportInterval = setInterval(function () {
    if (!state.bot || state.status === 'offline') return;
    var sessionMs = Date.now() - (state._sessionStartTime || Date.now());
    var totalMs = state._cumulativeSessionMs + sessionMs;
    var sessionHours = Math.floor(totalMs / 3600000);
    webhook.logPlaytime(state.accountName, state.playtime || 'N/A', sessionHours);
    logger.info('12h playtime report sent. Session: ' + sessionHours + 'h', state.accountName);
  }, PLAYTIME_REPORT_INTERVAL);
}

function stopPlaytimeReporting(state) {
  if (state._playtimeReportInterval) {
    clearInterval(state._playtimeReportInterval);
    state._playtimeReportInterval = null;
  }
}

/**
 * Starts a periodic check for the 72-hour milestone.
 * Checks every 10 minutes to avoid wasting resources.
 */
function startMilestoneCheck(state) {
  stopMilestoneCheck(state);

  state._milestoneCheckInterval = setInterval(function () {
    if (state._milestoneAlerted) return;
    var sessionMs = Date.now() - (state._sessionStartTime || Date.now());
    var totalMs = state._cumulativeSessionMs + sessionMs;
    var totalHours = totalMs / 3600000;

    if (totalHours >= MILESTONE_HOURS) {
      state._milestoneAlerted = true;
      webhook.logMilestone(state.accountName, Math.floor(totalHours));
      logger.success('MILESTONE: ' + Math.floor(totalHours) + 'h of cumulative playtime!', state.accountName);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

function stopMilestoneCheck(state) {
  if (state._milestoneCheckInterval) {
    clearInterval(state._milestoneCheckInterval);
    state._milestoneCheckInterval = null;
  }
}

// ========== Server Monitor: verify bot is on Donut SMP ==========

/**
 * Checks if the bot is still connected to Donut SMP by inspecting
 * the server brand, scoreboard, tab list, or chat messages.
 */
function checkServerIdentity(state) {
  if (!state.bot || state.status === 'offline') return;

  try {
    // Check server brand if available (e.g., "donutsmp", "Waterfall", etc.)
    var brand = state.bot.game && state.bot.game.serverBrand;
    if (brand) {
      logger.info('Server brand: "' + brand + '"', state.accountName);
    }

    // Check tab header/footer for donut smp indicators
    var tabHeader = '';
    var tabFooter = '';
    try {
      if (state.bot.tablist) {
        tabHeader = state.bot.tablist.header ? state.bot.tablist.header.toString() : '';
        tabFooter = state.bot.tablist.footer ? state.bot.tablist.footer.toString() : '';
      }
    } catch (_) {}

    var combinedText = ((brand || '') + ' ' + tabHeader + ' ' + tabFooter).toLowerCase();

    // Look for Donut SMP identifiers
    var isDonutSmp = combinedText.includes('donut') ||
                     combinedText.includes('dsmp') ||
                     combinedText.includes('donutsmp');

    if (isDonutSmp) {
      logger.info('Server identity confirmed: Donut SMP ✓', state.accountName);
      // If we were in updating state, we're back now
      if (state._serverUpdating) {
        state._serverUpdating = false;
        logger.success('Server update complete — resuming normal operation.', state.accountName);
        startAntiAfk(state, true);
      }
    } else if (combinedText.trim().length > 0) {
      // We have server info but it doesn't look like Donut SMP
      logger.warn('Server identity mismatch! Expected Donut SMP, got: "' + combinedText.trim().substring(0, 100) + '"', state.accountName);
      logger.info('Will attempt to reconnect to Donut SMP...', state.accountName);
      // Force reconnect to the correct server
      if (state.callbacks.onDisconnect) {
        state.callbacks.onDisconnect(state.accountName, 'Server identity mismatch — reconnecting to Donut SMP');
      }
      state._disconnecting = true;
      try {
        state.bot.quit();
      } catch (_) {}
      scheduleReconnect(state);
    }
    // If no server info is available yet, just wait for next check
  } catch (err) {
    logger.debug('Server identity check error: ' + err.message, state.accountName);
  }
}

/**
 * Starts periodic server identity monitoring.
 * Checks every 30 seconds that we're still on Donut SMP.
 */
function startServerMonitor(state) {
  stopServerMonitor(state);

  // Initial check after 10 seconds
  setTimeout(function () {
    checkServerIdentity(state);
  }, 10000);

  // Then check every 60 seconds
  state.serverMonitorInterval = setInterval(function () {
    if (state.bot && state.status !== 'offline') {
      checkServerIdentity(state);
    } else {
      stopServerMonitor(state);
    }
  }, 60000);

  logger.info('Server monitor started — checking Donut SMP identity every 60s.', state.accountName);
}

/**
 * Stops the server identity monitor.
 */
function stopServerMonitor(state) {
  if (state.serverMonitorInterval) {
    clearInterval(state.serverMonitorInterval);
    state.serverMonitorInterval = null;
  }
}

/**
 * Disconnects the bot gracefully.
 */
function disconnectBot(state) {
  // Accumulate session time before clearing
  if (state._sessionStartTime) {
    state._cumulativeSessionMs += Date.now() - state._sessionStartTime;
    state._sessionStartTime = null;
  }

  state.shouldReconnect = false;
  state._connecting = false;
  state._disconnecting = false;
  state._serverUpdating = false;
  state._mentionFrozen = false;

  // Clear all timers
  stopAntiAfk(state);
  stopServerMonitor(state);
  stopTeleportDetection(state);
  stopPlaytimeReporting(state);
  stopMilestoneCheck(state);
  stopPerformanceOptimizations(state);

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.bot) {
    try {
      state.bot.removeAllListeners();
      state.bot.quit();
    } catch (_) { }
    state.bot = null;
  }

  // Send disconnect webhook
  webhook.logDisconnect(state.accountName, 'Manual disconnect or safety shutdown');

  setStatus(state, 'offline');
  state.reconnectAttempts = 0;
  logger.info('Disconnected.', state.accountName);
}

/**
 * Schedules a reconnect attempt with exponential backoff.
 * Delay: BASE * 2^(attempt-1), capped at MAX_RECONNECT_DELAY (5 min).
 */
function scheduleReconnect(state) {
  if (!state.shouldReconnect) return;

  // Accumulate session time on disconnect
  if (state._sessionStartTime) {
    state._cumulativeSessionMs += Date.now() - state._sessionStartTime;
    state._sessionStartTime = null;
  }

  // Stop all tracking intervals
  stopTeleportDetection(state);
  stopPlaytimeReporting(state);
  stopMilestoneCheck(state);
  stopPerformanceOptimizations(state);

  if (state.reconnectAttempts >= MAX_RETRIES) {
    logger.error('Max reconnect attempts (' + MAX_RETRIES + ') reached. Giving up.', state.accountName);
    setStatus(state, 'offline');
    if (state.callbacks.onStatusChange) {
      state.callbacks.onStatusChange(state.accountName, 'max_retries', 'Max reconnect attempts reached');
    }
    return;
  }

  state.reconnectAttempts++;
  // Exponential backoff: 10s, 20s, 40s, 80s, 160s, 300s(cap), ...
  var delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, state.reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  setStatus(state, 'reconnecting');
  logger.info('Reconnecting in ' + (delay / 1000) + 's (attempt ' + state.reconnectAttempts + '/' + MAX_RETRIES + ')...', state.accountName);

  state.reconnectTimer = setTimeout(function () {
    if (state.shouldReconnect) {
      state._connecting = false; // Reset guard so connectBot can proceed
      connectBot(state);
    }
  }, delay);
}

/**
 * Updates bot status and fires callback.
 */
function setStatus(state, newStatus) {
  var oldStatus = state.status;
  state.status = newStatus;
  if (oldStatus !== newStatus && state.callbacks.onStatusChange) {
    state.callbacks.onStatusChange(state.accountName, newStatus, 'Status: ' + oldStatus + ' -> ' + newStatus);
  }
}

/**
 * Gets info about the bot for status commands.
 */
function getBotInfo(state) {
  var info = {
    account: state.accountName,
    status: state.status,
    health: null,
    food: null,
    position: null,
    reconnectAttempts: state.reconnectAttempts,
    playtime: state.playtime,
    shards: state.shards,
  };

  logger.debug('getBotInfo -> playtime="' + state.playtime + '" shards="' + state.shards + '"', state.accountName);

  if (state.bot && state.status !== 'offline') {
    try {
      info.health = state.bot.health;
      info.food = state.bot.food;
      if (state.bot.entity && state.bot.entity.position) {
        info.position = {
          x: Math.floor(state.bot.entity.position.x),
          y: Math.floor(state.bot.entity.position.y),
          z: Math.floor(state.bot.entity.position.z),
        };
      }
    } catch (_) { }
  }

  return info;
}

/**
 * Sends a chat message from the bot.
 */
function sendChat(state, message) {
  if (!state.bot || state.status === 'offline') {
    logger.warn('Cannot send chat - bot is offline', state.accountName);
    return false;
  }
  state.bot.chat(message);
  logger.info('Sent chat: ' + message, state.accountName);
  return true;
}

module.exports = {
  createBotState,
  connectBot,
  disconnectBot,
  getBotInfo,
  sendChat,
};
