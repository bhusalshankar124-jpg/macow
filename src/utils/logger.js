/**
 * Logger utility with timestamps and account labels.
 * All console output is routed through here for consistent formatting.
 */

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function formatPrefix(account) {
  if (account) {
    return `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ${COLORS.cyan}[${account}]${COLORS.reset}`;
  }
  return `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ${COLORS.magenta}[SYSTEM]${COLORS.reset}`;
}

const logger = {
  info(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.white}${message}${COLORS.reset}`);
  },

  success(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.green}✔ ${message}${COLORS.reset}`);
  },

  warn(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.yellow}⚠ ${message}${COLORS.reset}`);
  },

  error(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.red}✖ ${message}${COLORS.reset}`);
  },

  debug(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.gray}${message}${COLORS.reset}`);
  },

  discord(message, account = null) {
    console.log(`${formatPrefix(account)} ${COLORS.blue}[DISCORD] ${message}${COLORS.reset}`);
  },
};

module.exports = logger;
