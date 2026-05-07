/**
 * botManager.js - Manages all Minecraft bot instances.
 * Provides a centralized API for starting, stopping, and querying bots.
 */

const fs = require('fs');
const path = require('path');
const { createBotState, connectBot, disconnectBot, getBotInfo, sendChat } = require('./createBot');
const logger = require('../utils/logger');

class BotManager {
  constructor() {
    /** @type {Map<string, import('./createBot').BotState>} */
    this.bots = new Map();
    this.accounts = [];
    this.serverConfig = {
      host: process.env.MC_SERVER_HOST || 'donutsmp.net',
      port: parseInt(process.env.MC_SERVER_PORT) || 25565,
    };
    this.callbacks = {};
    this.proxies = [];
    this.accountsPerProxy = parseInt(process.env.ACCOUNTS_PER_PROXY) || 5;
    this.loadProxies();
  }

  /**
   * Formats a raw proxy string into a URL format.
   * Supports: host:port:user:pass, host:port, or full URL (socks5://..., http://...)
   */
  formatProxy(line) {
    if (!line.includes('://')) {
      const parts = line.split(':');
      if (parts.length === 4) {
        return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      } else if (parts.length === 2) {
        return `http://${parts[0]}:${parts[1]}`;
      }
    }
    return line;
  }

  /**
   * Loads proxies from PROXIES env var first, then falls back to proxies.txt.
   * The PROXIES env var should be semicolon-separated.
   */
  loadProxies() {
    // 1. Try PROXIES env var first (semicolon-separated)
    if (process.env.PROXIES && process.env.PROXIES.trim().length > 0) {
      this.proxies = process.env.PROXIES
        .split(';')
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => this.formatProxy(p));
      logger.info(`Loaded ${this.proxies.length} proxies from PROXIES env var`);
      return;
    }

    // 2. Fall back to proxies.txt
    const proxiesPath = path.join(process.cwd(), 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
      try {
        const raw = fs.readFileSync(proxiesPath, 'utf-8');
        this.proxies = raw.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'))
          .map(line => this.formatProxy(line));
        logger.info(`Loaded ${this.proxies.length} proxies from proxies.txt`);
      } catch (err) {
        logger.error(`Failed to parse proxies.txt: ${err.message}`);
      }
    }
  }

  /**
   * Adds a proxy to the list (appended at the end).
   * @param {string} proxyStr - Raw proxy string
   * @returns {string} result message
   */
  addProxy(proxyStr) {
    const formatted = this.formatProxy(proxyStr.trim());
    this.proxies.push(formatted);
    logger.info(`Added proxy #${this.proxies.length}: ${formatted}`);
    return `✅ Added proxy **#${this.proxies.length}**\n\`${this.maskProxy(formatted)}\``;
  }

  /**
   * Removes a proxy by 0-based index.
   * @param {number} index
   * @returns {string} result message
   */
  removeProxy(index) {
    if (index < 0 || index >= this.proxies.length) {
      return `❌ Invalid index. Use \`/proxy list\` to see available proxies (1-${this.proxies.length}).`;
    }
    const removed = this.proxies.splice(index, 1)[0];
    logger.info(`Removed proxy #${index + 1}: ${removed}`);
    return `🗑️ Removed proxy **#${index + 1}**: \`${this.maskProxy(removed)}\`\n${this.proxies.length} proxy(ies) remaining.`;
  }

  /**
   * Clears all proxies.
   * @returns {string} result message
   */
  clearProxies() {
    const count = this.proxies.length;
    this.proxies = [];
    logger.info(`Cleared all ${count} proxies`);
    return `🗑️ Cleared **${count}** proxy(ies). Bots will connect directly until new proxies are added.`;
  }

  /**
   * Masks sensitive parts of a proxy URL for display.
   */
  maskProxy(proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      const host = parsed.hostname;
      const port = parsed.port;
      // Mask last octet of IP and password
      const maskedHost = host.replace(/\.\d+$/, '.***');
      const maskedUser = parsed.username ? parsed.username.substring(0, 4) + '***' : '';
      const maskedPass = parsed.password ? '****' : '';
      if (maskedUser) {
        return `${parsed.protocol}//${maskedUser}:${maskedPass}@${maskedHost}:${port}`;
      }
      return `${parsed.protocol}//${maskedHost}:${port}`;
    } catch (_) {
      // If not a valid URL, mask roughly
      return proxyUrl.substring(0, 12) + '***';
    }
  }

  /**
   * Returns masked proxy list for safe display.
   * @returns {string[]}
   */
  getProxiesMasked() {
    return this.proxies.map(p => this.maskProxy(p));
  }

  /**
   * Calculates which proxy string to use for an account based on chunk size.
   */
  getProxyForAccount(accountName) {
    if (this.proxies.length > 0) {
      const index = this.accounts.findIndex(a => this.getAccountName(a) === accountName);
      if (index !== -1) {
        const proxyIndex = Math.floor(index / this.accountsPerProxy) % this.proxies.length;
        const proxyStr = this.proxies[proxyIndex];
        logger.info(`Account ${accountName} assigned proxy ${proxyStr} (Index: ${index}, ProxyIndex: ${proxyIndex})`);
        return proxyStr;
      }
    }
    // Fallback to global proxy if proxies.txt is empty
    return process.env.PROXY_URL || null;
  }

  /**
   * Loads accounts from accounts.json.
   */
  loadAccounts() {
    const accountsPath = path.join(process.cwd(), 'accounts.json');
    if (!fs.existsSync(accountsPath)) {
      logger.error('accounts.json not found! Please create it with your account credentials.');
      return;
    }

    try {
      const raw = fs.readFileSync(accountsPath, 'utf-8');
      this.accounts = JSON.parse(raw);
      logger.info(`Loaded ${this.accounts.length} account(s) from accounts.json`);
    } catch (err) {
      logger.error(`Failed to parse accounts.json: ${err.message}`);
    }
  }

  /**
   * Sets Discord callbacks for chat forwarding and alerts.
   * @param {Object} callbacks
   */
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Gets the short account name from a config entry.
   */
  getAccountName(accountConfig) {
    return accountConfig.name;
  }

  /**
   * Gets all known account names.
   * @returns {string[]}
   */
  getAllAccountNames() {
    return this.accounts.map((a) => this.getAccountName(a));
  }

  /**
   * Resolves account parameter: returns array of account names to act on.
   * @param {string} accountParam - "all" or a specific account name
   * @returns {string[]}
   */
  resolveAccounts(accountParam) {
    if (!accountParam || accountParam.toLowerCase() === 'all') {
      return this.getAllAccountNames();
    }
    return [accountParam];
  }

  /**
   * Starts a specific account's bot.
   * @param {string} accountName
   * @param {boolean} useProxy
   * @returns {string} result message
   */
  startBot(accountName, useProxy = false) {
    // Check if already running
    if (this.bots.has(accountName)) {
      const existing = this.bots.get(accountName);
      if (existing.status !== 'offline') {
        return `⚠️ **${accountName}** is already ${existing.status}.`;
      }
    }

    // Find account config
    const accountConfig = this.accounts.find((a) => this.getAccountName(a) === accountName);
    if (!accountConfig) {
      return `❌ Account **${accountName}** not found in accounts.json.`;
    }

    const state = createBotState(accountConfig, this.serverConfig, {
      onChatMessage: (acct, username, message) => {
        if (this.callbacks.onChatMessage) {
          this.callbacks.onChatMessage(acct, username, message);
        }
      },
      onStatusChange: (acct, status, detail) => {
        if (this.callbacks.onStatusChange) {
          this.callbacks.onStatusChange(acct, status, detail);
        }
      },
      onDisconnect: (acct, reason) => {
        if (this.callbacks.onDisconnect) {
          this.callbacks.onDisconnect(acct, reason);
        }
      },
      onAfkReached: (acct) => {
        if (this.callbacks.onAfkReached) {
          this.callbacks.onAfkReached(acct);
        }
      },
      onDeviceCode: (acct, data) => {
        if (this.callbacks.onDeviceCode) {
          this.callbacks.onDeviceCode(acct, data);
        }
      },
      onTeleportDetected: (acct, from, to, distance) => {
        if (this.callbacks.onTeleportDetected) {
          this.callbacks.onTeleportDetected(acct, from, to, distance);
        }
      },
      onMentionDetected: (acct, chatMessage) => {
        if (this.callbacks.onMentionDetected) {
          this.callbacks.onMentionDetected(acct, chatMessage);
        }
      },
    }, useProxy ? this.getProxyForAccount(accountName) : null);

    this.bots.set(accountName, state);
    connectBot(state);
    return `🚀 **${accountName}** is now connecting...`;
  }

  /**
   * Stops a specific account's bot.
   * @param {string} accountName
   * @returns {string} result message
   */
  stopBot(accountName) {
    const state = this.bots.get(accountName);
    if (!state) {
      return `❌ **${accountName}** is not running.`;
    }

    disconnectBot(state);
    this.bots.delete(accountName);
    return `🛑 **${accountName}** has been disconnected.`;
  }

  /**
   * Force reconnects a specific bot.
   * @param {string} accountName
   * @returns {string}
   */
  async reconnectBot(accountName) {
    // Stop if running
    const state = this.bots.get(accountName);
    const useProxy = state ? !!state.proxyUrl : false;
    
    if (state) {
      disconnectBot(state);
      this.bots.delete(accountName);
      // Wait for the server to fully release the old session
      await new Promise((r) => setTimeout(r, 4000));
    }

    // Re-start
    return this.startBot(accountName, useProxy);
  }

  /**
   * Gets status info for a bot.
   * @param {string} accountName
   * @returns {Object|null}
   */
  getStatus(accountName) {
    const state = this.bots.get(accountName);
    if (!state) {
      // Find in accounts list
      const accountConfig = this.accounts.find((a) => this.getAccountName(a) === accountName);
      if (accountConfig) {
        return {
          account: accountName,
          status: 'offline',
          health: null,
          food: null,
          position: null,
          reconnectAttempts: 0,
          playtime: null,
          shards: null,
        };
      }
      return null;
    }
    return getBotInfo(state);
  }

  /**
   * Gets status info for all bots.
   * @returns {Object[]}
   */
  getAllStatuses() {
    return this.getAllAccountNames().map((name) => this.getStatus(name));
  }

  /**
   * Sends a chat message from a specific bot.
   * @param {string} accountName
   * @param {string} message
   * @returns {string}
   */
  chat(accountName, message) {
    const state = this.bots.get(accountName);
    if (!state || state.status === 'offline') {
      return `❌ **${accountName}** is not online.`;
    }

    const success = sendChat(state, message);
    if (success) {
      return `💬 **${accountName}**: ${message}`;
    }
    return `❌ Failed to send chat from **${accountName}**.`;
  }

  /**
   * Automates buying a spawner from the shop and sending a TPA request.
   * @param {string} accountName
   * @param {string} targetUser
   * @returns {Promise<string>}
   */
  async buySpawners(accountName, targetUser, count = 1) {
    const state = this.bots.get(accountName);
    if (!state || state.status === 'offline') {
      return `❌ **${accountName}** is not online.`;
    }

    const bot = state.bot;
    const { clickGuiItemInWindow, flattenChatComponent, extractComponentText } = require('./guiHandler');
    logger.info(`Starting buy spawners sequence for ${accountName} (x${count})...`, accountName);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /**
     * Helper: waits for a fresh windowOpen event.
     */
    function waitForNewWindow(timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          bot.removeListener('windowOpen', onOpen);
          resolve(null);
        }, timeoutMs);
        function onOpen(win) {
          clearTimeout(timer);
          logger.info(`New window opened: "${win.title || 'Untitled'}" with ${win.slots.length} slots`, accountName);
          resolve(win);
        }
        bot.once('windowOpen', onOpen);
      });
    }

    try {
      // Step 1: Send /shop and wait for the Shop GUI
      const shopWindowPromise = waitForNewWindow(10000);
      bot.chat('/shop');
      logger.info('Executed /shop, waiting for Shop GUI...', accountName);

      const shopWindow = await shopWindowPromise;
      if (!shopWindow) {
        return `❌ **${accountName}**: Shop GUI did not open.`;
      }

      // Step 2: Click shard icon
      await sleep(500);
      const shardShopPromise = waitForNewWindow(10000);
      logger.info('Looking for Shard icon in Shop...', accountName);
      let success = await clickGuiItemInWindow(bot, shopWindow, 'shard', accountName);
      if (!success) {
        return `❌ **${accountName}**: Could not find Shard icon in Shop GUI.`;
      }

      // Step 3: Wait for Shard Shop
      logger.info('Waiting for Shard Shop GUI to open...', accountName);
      let currentShardShop = await shardShopPromise;
      if (!currentShardShop) {
        return `❌ **${accountName}**: Shard Shop GUI did not open.`;
      }

      // Step 4: Buy logic
      let bought = 0;

      // Click Skeleton Spawner in the Shard Shop
      await sleep(500);
      logger.info('Looking for Skeleton Spawner in Shard Shop...', accountName);

      // Pre-register for confirmation window BEFORE clicking
      const confirmWindowPromise = waitForNewWindow(10000);

      success = await clickGuiItemInWindow(bot, currentShardShop, 'skeleton', accountName);
      if (!success) {
        return `❌ **${accountName}**: Could not find Skeleton in Shard Shop.`;
      }

      // Wait for the confirmation window
      const confirmWindow = await confirmWindowPromise;
      if (!confirmWindow) {
        // No confirm window = direct purchase (bought 1)
        logger.info('No confirmation window — skeleton was purchased directly.', accountName);
        bought = 1;
      } else {
        // Step 5: Click confirm button `count` times in the same window
        await sleep(500);
        logger.info(`Confirmation window opened. Clicking confirm ${count} time(s)...`, accountName);

        // Find the confirm button slot once
        let confirmSlot = null;
        for (let s = 0; s < confirmWindow.slots.length; s++) {
          const slot = confirmWindow.slots[s];
          if (!slot) continue;
          let slotText = '';
          if (slot.customName) slotText += flattenChatComponent(slot.customName) + ' ';
          if (slot.displayName) slotText += flattenChatComponent(slot.displayName) + ' ';
          if (slot.name) slotText += String(slot.name) + ' ';
          slotText += extractComponentText(slot) + ' ';
          slotText = slotText.toLowerCase();

          if (slotText.includes('confirm') || slotText.includes('yes') || slotText.includes('buy')) {
            confirmSlot = s;
            logger.success(`Found confirm button in slot ${s}`, accountName);
            break;
          }
        }

        if (confirmSlot === null) {
          logger.warn('Could not find confirm button in confirmation window.', accountName);
          try { bot.closeWindow(confirmWindow); } catch (_) {}
          return `❌ **${accountName}**: Could not find confirm button.`;
        }

        // Click confirm `count` times with delay between each
        for (let i = 0; i < count; i++) {
          try {
            await bot.clickWindow(confirmSlot, 0, 0);
            bought++;
            logger.success(`Purchase ${bought}/${count} — clicked confirm!`, accountName);
          } catch (err) {
            logger.error(`Failed to click confirm on purchase ${i + 1}: ${err.message}`, accountName);
            break;
          }
          // Small delay between purchases
          if (i < count - 1) await sleep(500);
        }
      }

      logger.success(`Bought ${bought}/${count} skeleton spawners!`, accountName);

      // Close any remaining window
      await sleep(1000);
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) {}
      await sleep(500);

      // Step 5: Send TPA
      logger.info(`Sending TPA request to ${targetUser}...`, accountName);
      bot.chat(`/tpa ${targetUser}`);

      return `✅ **${accountName}**: Bought **${bought}/${count}** Skeleton Spawner(s) and sent TPA to **${targetUser}**!`;
    } catch (err) {
      logger.error(`Error during buySpawners: ${err.message}`, accountName);
      return `❌ **${accountName}**: Error during purchase sequence: ${err.message}`;
    }
  }

  /**
   * Removes an account entirely — stops bot, clears auth cache, removes from accounts.json.
   * @param {string} accountName
   * @returns {string} result message
   */
  removeAccount(accountName) {
    // Check if the account exists
    const accountIndex = this.accounts.findIndex((a) => this.getAccountName(a) === accountName);
    if (accountIndex === -1) {
      return `❌ Account **${accountName}** not found in accounts.json.`;
    }

    // 1. Stop the bot if it's running
    if (this.bots.has(accountName)) {
      const { disconnectBot } = require('./createBot');
      disconnectBot(this.bots.get(accountName));
      this.bots.delete(accountName);
    }

    // 2. Clear the auth cache (unlink Microsoft account)
    const profilesFolder = path.join(process.cwd(), 'auth_cache', accountName);
    if (fs.existsSync(profilesFolder)) {
      try {
        const files = fs.readdirSync(profilesFolder);
        for (const file of files) {
          fs.unlinkSync(path.join(profilesFolder, file));
        }
        fs.rmdirSync(profilesFolder);
        logger.info(`Cleared auth cache for ${accountName}`);
      } catch (err) {
        logger.error(`Failed to clear auth cache: ${err.message}`);
      }
    }

    // 3. Remove from accounts array and save to accounts.json
    this.accounts.splice(accountIndex, 1);
    try {
      const accountsPath = path.join(process.cwd(), 'accounts.json');
      fs.writeFileSync(accountsPath, JSON.stringify(this.accounts, null, 2), 'utf-8');
      logger.info(`Removed ${accountName} from accounts.json`);
    } catch (err) {
      logger.error(`Failed to update accounts.json: ${err.message}`);
      return `⚠️ Stopped **${accountName}** and cleared auth, but failed to update accounts.json: ${err.message}`;
    }

    return `🗑️ **${accountName}** has been removed — bot stopped, auth tokens cleared, and account deleted from config.`;
  }

  /**
   * Starts all accounts with a 5-minute staggered delay between each.
   * Returns an array of result messages as they connect.
   * @param {boolean} useProxy
   * @returns {Promise<string[]>}
   */
  async startAllStaggered(useProxy = false) {
    const names = this.getAllAccountNames();
    const results = [];
    const STAGGER_DELAY = 5 * 60 * 1000; // 5 minutes between each account

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const result = this.startBot(name, useProxy);
      results.push(result);
      logger.info(`Started ${name} (${i + 1}/${names.length})`);

      // Wait 5 minutes before starting the next account (skip delay after last)
      if (i < names.length - 1) {
        logger.info(`Waiting 5 minutes before starting next account...`);
        await new Promise((r) => setTimeout(r, STAGGER_DELAY));
      }
    }

    return results;
  }

  /**
   * Starts all accounts (immediate, no delay — used for single accounts).
   * @param {boolean} useProxy
   * @returns {string[]}
   */
  startAll(useProxy = false) {
    return this.getAllAccountNames().map((name) => this.startBot(name, useProxy));
  }

  /**
   * Stops all accounts.
   * @returns {string[]}
   */
  stopAll() {
    return this.getAllAccountNames().map((name) => this.stopBot(name));
  }

  /**
   * Reconnects all accounts.
   * @returns {string[]}
   */
  reconnectAll() {
    return this.getAllAccountNames().map((name) => this.reconnectBot(name));
  }
}

// Singleton instance
const botManager = new BotManager();
module.exports = botManager;
