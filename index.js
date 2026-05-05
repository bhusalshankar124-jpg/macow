/**
 * DSMP Bot — Entry Point
 *
 * Multi-account Minecraft AFK bot controlled via Discord slash commands.
 * Loads environment config, initializes the bot manager, and starts the Discord client.
 */

require('dotenv').config();

const logger = require('./src/utils/logger');
const botManager = require('./src/minecraft/botManager');
const DiscordBot = require('./src/discord/client');

// ── Validate environment ──
const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CHANNEL_ID'];
const missing = requiredEnv.filter((key) => !process.env[key]);

if (missing.length > 0) {
  logger.error(`Missing required environment variables: ${missing.join(', ')}`);
  logger.error('Please fill in your .env file and try again.');
  process.exit(1);
}

// ── Banner ──
console.log(`
\x1b[36m╔═══════════════════════════════════════════╗
║          DSMP Multi-Account AFK Bot       ║
║       Discord + Mineflayer Controller     ║
╚═══════════════════════════════════════════╝\x1b[0m
`);

async function main() {
  // 1. Load Minecraft accounts
  botManager.loadAccounts();

  if (botManager.accounts.length === 0) {
    logger.error('No accounts found! Please add accounts to accounts.json');
    process.exit(1);
  }

  logger.info(`Server target: ${process.env.MC_SERVER_HOST || 'donutsmp.net'}:${process.env.MC_SERVER_PORT || 25565}`);

  // 2. Start Discord bot
  const discord = new DiscordBot();

  try {
    await discord.start();
    logger.success('All systems online! Use Discord slash commands to control bots.');
    logger.info('Commands: /start, /stop, /reconnect, /status, /list, /pos, /chat');
  } catch (err) {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
  }
}

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  logger.warn('Shutting down...');
  botManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warn('Shutting down...');
  botManager.stopAll();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  const msg = err.message || String(err);
  if (msg.includes('ENOSPC')) {
    logger.error('DISK FULL (ENOSPC) — free space on this server! Run: df -h && sudo journalctl --vacuum-size=50M && pm2 flush');
  } else {
    logger.error(`Unhandled rejection: ${msg}`);
  }
});

main();
