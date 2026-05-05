/**
 * webhook.js - Standalone Discord Webhook sender.
 *
 * No Discord.js dependency — pure HTTP POST to Discord webhook URL.
 * Includes a rate-limited queue (1 req/sec) to prevent 429s across 10+ instances.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger');

// ── Webhook queue (rate limit: 1 message per second) ──
const queue = [];
let processing = false;

function getWebhookUrl() {
  return process.env.DISCORD_WEBHOOK_URL || '';
}

/**
 * Sends a raw payload to the Discord webhook.
 * @param {Object} payload - Discord webhook JSON body
 */
function enqueueWebhook(payload) {
  const url = getWebhookUrl();
  if (!url) return; // silently skip if no webhook configured

  queue.push({ url, payload });
  if (!processing) processQueue();
}

async function processQueue() {
  if (queue.length === 0) {
    processing = false;
    return;
  }
  processing = true;
  const { url, payload } = queue.shift();

  try {
    await postJson(url, payload);
  } catch (err) {
    logger.warn('Webhook send failed: ' + err.message);
  }

  // Rate limit: wait 1.1s between sends
  setTimeout(() => processQueue(), 1100);
}

/**
 * Low-level HTTPS/HTTP POST.
 */
function postJson(webhookUrl, data) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(webhookUrl);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const body = JSON.stringify(data);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = mod.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else if (res.statusCode === 429) {
            // Rate limited — re-queue with delay
            const retryAfter = JSON.parse(responseBody || '{}').retry_after || 5;
            logger.warn('Webhook rate limited, retrying in ' + retryAfter + 's');
            setTimeout(() => {
              enqueueWebhook(data);
              resolve();
            }, retryAfter * 1000);
          } else {
            reject(new Error('Webhook HTTP ' + res.statusCode + ': ' + responseBody));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════
// Public API — pre-built embed senders
// ═══════════════════════════════════════════

/**
 * Log a successful login/spawn.
 */
function logLogin(accountName) {
  enqueueWebhook({
    embeds: [{
      title: '✅ Bot Logged In',
      description: `**${accountName}** has successfully spawned into the server.`,
      color: 0x57f287, // green
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot' },
    }],
  });
}

/**
 * Log a disconnect or kick with reason.
 */
function logDisconnect(accountName, reason) {
  enqueueWebhook({
    embeds: [{
      title: '🔌 Bot Disconnected',
      description: `**${accountName}** was disconnected.\n\`\`\`${reason}\`\`\``,
      color: 0xed4245, // red
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot' },
    }],
  });
}

/**
 * Log current playtime (every 12 hours).
 */
function logPlaytime(accountName, playtime, sessionHours) {
  enqueueWebhook({
    embeds: [{
      title: '⏱️ Playtime Report',
      description: `**${accountName}**`,
      color: 0x5865f2, // blurple
      fields: [
        { name: 'Server Playtime', value: playtime || 'N/A', inline: true },
        { name: 'Current Session', value: sessionHours + 'h', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot • 12-hour report' },
    }],
  });
}

/**
 * Log a playtime milestone (72 hours / 3 days).
 */
function logMilestone(accountName, totalHours) {
  enqueueWebhook({
    content: '@everyone',
    embeds: [{
      title: '🏆 Milestone Reached!',
      description: `**${accountName}** has reached **${totalHours} hours** (${Math.floor(totalHours / 24)} days) of cumulative playtime!`,
      color: 0xf0b232, // gold
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot • Milestone Alert' },
    }],
  });
}

/**
 * URGENT: Staff teleport detected.
 */
function alertTeleport(accountName, from, to, distance) {
  enqueueWebhook({
    content: '@everyone **⚠️ URGENT**',
    embeds: [{
      title: '🚨 TELEPORT DETECTED — STAFF ALERT',
      description: `**${accountName}** was teleported **${Math.round(distance)} blocks** instantly!\nBot has been **disconnected** for safety.`,
      color: 0xff0000, // bright red
      fields: [
        { name: 'From', value: `X: ${from.x}  Y: ${from.y}  Z: ${from.z}`, inline: true },
        { name: 'To', value: `X: ${to.x}  Y: ${to.y}  Z: ${to.z}`, inline: true },
        { name: 'Distance', value: `${Math.round(distance)} blocks`, inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot • URGENT' },
    }],
  });
}

/**
 * Alert: Bot's username was mentioned in chat.
 */
function alertMention(accountName, chatMessage) {
  enqueueWebhook({
    content: '@everyone **👀 Bot Mentioned in Chat**',
    embeds: [{
      title: '💬 Username Mentioned in Chat',
      description: `**${accountName}** was mentioned!\nAll movement has been **frozen**.\n\n**Chat Message:**\n\`\`\`${chatMessage}\`\`\``,
      color: 0xe67e22, // orange
      timestamp: new Date().toISOString(),
      footer: { text: 'DSMP AFK Bot • Respond manually via /chat' },
    }],
  });
}

module.exports = {
  logLogin,
  logDisconnect,
  logPlaytime,
  logMilestone,
  alertTeleport,
  alertMention,
};
