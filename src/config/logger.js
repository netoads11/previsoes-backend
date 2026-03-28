const COLORS = {
  reset: '\x1b[0m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  green: '\x1b[32m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};

function ts() {
  return new Date().toISOString();
}

function fmt(level, color, msg, meta) {
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `${COLORS.gray}[${ts()}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${msg}${COLORS.gray}${metaStr}${COLORS.reset}`;
}

const logger = {
  info:  (msg, meta) => console.log(fmt('INFO ', COLORS.green,  msg, meta)),
  warn:  (msg, meta) => console.warn(fmt('WARN ', COLORS.yellow, msg, meta)),
  error: (msg, meta) => console.error(fmt('ERROR', COLORS.red,   msg, meta)),
  http:  (msg, meta) => console.log(fmt('HTTP ', COLORS.cyan,   msg, meta)),
};

module.exports = logger;
