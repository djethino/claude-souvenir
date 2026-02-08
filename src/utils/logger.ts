/**
 * Logger that outputs ONLY to stderr (stdout is reserved for MCP JSON-RPC).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = (process.env.RECALL_LOG_LEVEL as LogLevel) || 'warn';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, ...args: unknown[]): string {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = `[recall ${timestamp} ${level.toUpperCase()}]`;
  const message = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  return `${prefix} ${message}`;
}

export const logger = {
  debug(...args: unknown[]) {
    if (shouldLog('debug')) console.error(formatMessage('debug', ...args));
  },
  info(...args: unknown[]) {
    if (shouldLog('info')) console.error(formatMessage('info', ...args));
  },
  warn(...args: unknown[]) {
    if (shouldLog('warn')) console.error(formatMessage('warn', ...args));
  },
  error(...args: unknown[]) {
    if (shouldLog('error')) console.error(formatMessage('error', ...args));
  },
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
};
