/**
 * Validation script — checks that all modules load correctly,
 * exports are correct, and slash commands are properly structured.
 * Does NOT require real Discord/MC credentials.
 */

// Set dummy env vars so dotenv doesn't cause issues
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_CHANNEL_ID = 'test';
process.env.MC_SERVER_HOST = 'localhost';
process.env.MC_SERVER_PORT = '25565';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n🔍 DSMP Bot — Code Validation\n');

// ── 1. Logger ──
console.log('📦 Utils');
test('logger.js loads', () => {
  const logger = require('./src/utils/logger');
  assert(typeof logger.info === 'function', 'logger.info is not a function');
  assert(typeof logger.error === 'function', 'logger.error is not a function');
  assert(typeof logger.success === 'function', 'logger.success is not a function');
  assert(typeof logger.warn === 'function', 'logger.warn is not a function');
  assert(typeof logger.debug === 'function', 'logger.debug is not a function');
  assert(typeof logger.discord === 'function', 'logger.discord is not a function');
  // Test actual call doesn't crash
  logger.info('Test message');
  logger.info('Test with account', 'testAcc');
});

// ── 2. GUI Handler ──
console.log('\n📦 Minecraft - GUI Handler');
test('guiHandler.js loads', () => {
  const gui = require('./src/minecraft/guiHandler');
  assert(typeof gui.clickGuiItem === 'function', 'clickGuiItem not exported');
});

// ── 3. createBot ──
console.log('\n📦 Minecraft - createBot');
test('createBot.js loads', () => {
  const cb = require('./src/minecraft/createBot');
  assert(typeof cb.createBotState === 'function', 'createBotState not exported');
  assert(typeof cb.connectBot === 'function', 'connectBot not exported');
  assert(typeof cb.disconnectBot === 'function', 'disconnectBot not exported');
  assert(typeof cb.getBotInfo === 'function', 'getBotInfo not exported');
  assert(typeof cb.sendChat === 'function', 'sendChat not exported');
});

test('createBotState returns correct structure', () => {
  const cb = require('./src/minecraft/createBot');
  const state = cb.createBotState(
    { name: 'testaccount' },
    { host: 'localhost', port: 25565 },
    {}
  );
  assert(state.accountName === 'testaccount', `accountName should be "testaccount", got "${state.accountName}"`);
  assert(state.status === 'offline', `status should be "offline", got "${state.status}"`);
  assert(state.bot === null, 'bot should be null initially');
  assert(state.reconnectAttempts === 0, 'reconnectAttempts should be 0');
  assert(state.shouldReconnect === true, 'shouldReconnect should be true');
  assert(state.playtime === null, 'playtime should be null initially');
  assert(state.shards === null, 'shards should be null initially');
});

test('getBotInfo works for offline bot', () => {
  const cb = require('./src/minecraft/createBot');
  const state = cb.createBotState(
    { name: 'testuser' },
    { host: 'localhost', port: 25565 },
    {}
  );
  const info = cb.getBotInfo(state);
  assert(info.account === 'testuser', 'account name mismatch');
  assert(info.status === 'offline', 'should be offline');
  assert(info.health === null, 'health should be null when offline');
  assert(info.position === null, 'position should be null when offline');
  assert(info.playtime === null, 'playtime should be null when offline');
  assert(info.shards === null, 'shards should be null when offline');
});

test('disconnectBot works on non-connected bot', () => {
  const cb = require('./src/minecraft/createBot');
  const state = cb.createBotState(
    { name: 'test2' },
    { host: 'localhost', port: 25565 },
    {}
  );
  // Should not throw
  cb.disconnectBot(state);
  assert(state.status === 'offline', 'should be offline after disconnect');
  assert(state.shouldReconnect === false, 'shouldReconnect should be false after disconnect');
});

// ── 4. Bot Manager ──
console.log('\n📦 Minecraft - botManager');
test('botManager.js loads (singleton)', () => {
  const bm = require('./src/minecraft/botManager');
  assert(typeof bm.loadAccounts === 'function', 'loadAccounts not found');
  assert(typeof bm.startBot === 'function', 'startBot not found');
  assert(typeof bm.stopBot === 'function', 'stopBot not found');
  assert(typeof bm.reconnectBot === 'function', 'reconnectBot not found');
  assert(typeof bm.getStatus === 'function', 'getStatus not found');
  assert(typeof bm.chat === 'function', 'chat not found');
  assert(typeof bm.resolveAccounts === 'function', 'resolveAccounts not found');
  assert(typeof bm.getAllAccountNames === 'function', 'getAllAccountNames not found');
  assert(typeof bm.getAllStatuses === 'function', 'getAllStatuses not found');
  assert(typeof bm.setCallbacks === 'function', 'setCallbacks not found');
});

test('botManager loads accounts.json', () => {
  const bm = require('./src/minecraft/botManager');
  bm.loadAccounts();
  assert(bm.accounts.length === 3, `Expected 3 accounts, got ${bm.accounts.length}`);
});

test('resolveAccounts("all") returns all names', () => {
  const bm = require('./src/minecraft/botManager');
  const all = bm.resolveAccounts('all');
  assert(all.length === 3, `Expected 3, got ${all.length}`);
});

test('resolveAccounts("acc1") returns just acc1', () => {
  const bm = require('./src/minecraft/botManager');
  const result = bm.resolveAccounts('acc1');
  assert(result.length === 1 && result[0] === 'acc1', 'Should return ["acc1"]');
});

test('getStatus returns offline for unstarted bot', () => {
  const bm = require('./src/minecraft/botManager');
  const status = bm.getStatus('acc1');
  assert(status !== null, 'Should find acc1');
  assert(status.status === 'offline', `Expected offline, got ${status.status}`);
});

test('stopBot on unstarted bot returns error message', () => {
  const bm = require('./src/minecraft/botManager');
  const result = bm.stopBot('acc1');
  assert(result.includes('not running'), `Expected "not running", got "${result}"`);
});

test('chat on offline bot returns error', () => {
  const bm = require('./src/minecraft/botManager');
  const result = bm.chat('acc1', 'hello');
  assert(result.includes('not online'), `Expected "not online", got "${result}"`);
});

// ── 5. Discord Commands ──
console.log('\n📦 Discord Commands');
const expectedCommands = ['status', 'start', 'stop', 'reconnect', 'chat', 'list', 'pos'];

for (const cmdName of expectedCommands) {
  test(`/${cmdName} command loads`, () => {
    const cmd = require(`./src/discord/commands/${cmdName}`);
    assert(cmd.data, `${cmdName} missing "data" property`);
    assert(typeof cmd.execute === 'function', `${cmdName} missing "execute" function`);
    assert(cmd.data.name === cmdName, `Command name mismatch: expected "${cmdName}", got "${cmd.data.name}"`);

    // Verify it serializes to JSON (Discord API format)
    const json = cmd.data.toJSON();
    assert(json.name === cmdName, 'JSON serialization failed');
    assert(typeof json.description === 'string' && json.description.length > 0, 'Missing description');
  });
}

test('/chat has 2 required options', () => {
  const cmd = require('./src/discord/commands/chat');
  const json = cmd.data.toJSON();
  assert(json.options.length === 2, `Expected 2 options, got ${json.options.length}`);
  assert(json.options[0].required === true, 'account should be required');
  assert(json.options[1].required === true, 'message should be required');
});

test('/status has optional "account" option', () => {
  const cmd = require('./src/discord/commands/status');
  const json = cmd.data.toJSON();
  assert(json.options.length === 1, `Expected 1 option, got ${json.options.length}`);
  assert(json.options[0].required === false, 'account should be optional');
});

test('/list has no options', () => {
  const cmd = require('./src/discord/commands/list');
  const json = cmd.data.toJSON();
  assert(!json.options || json.options.length === 0, 'list should have no options');
});

// ── 6. Discord Client ──
console.log('\n📦 Discord Client');
test('client.js loads (DiscordBot class)', () => {
  const DiscordBot = require('./src/discord/client');
  assert(typeof DiscordBot === 'function', 'Should export a class/constructor');
  const instance = new DiscordBot();
  assert(typeof instance.loadCommands === 'function', 'loadCommands missing');
  assert(typeof instance.start === 'function', 'start missing');
  assert(typeof instance.setupEvents === 'function', 'setupEvents missing');
  assert(typeof instance.setupMinecraftCallbacks === 'function', 'setupMinecraftCallbacks missing');
});

test('DiscordBot.loadCommands() loads all 7 commands', () => {
  const DiscordBot = require('./src/discord/client');
  const bot = new DiscordBot();
  bot.loadCommands();
  assert(bot.commands.size === 7, `Expected 7 commands, got ${bot.commands.size}`);
});

// ── Results ──
console.log(`\n${'═'.repeat(45)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(45)}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('  🎉 All validations passed! Code is structurally sound.\n');
  process.exit(0);
}
