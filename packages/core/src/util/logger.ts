import { redactSecrets } from '../errors.js';
import type { Logger, LogLevel } from '../types.js';

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Console logger writing to stderr (safe for MCP stdio) with secret redaction. */
export function createLogger(level: LogLevel = 'warn', prefix = 'webvector'): Logger {
  const threshold = LEVELS[level] ?? 2;
  const emit = (lvl: LogLevel, msg: string, args: unknown[]) => {
    if (LEVELS[lvl] > threshold) return;
    const line = `[${prefix}] ${lvl.toUpperCase()} ${redactSecrets(msg)}`;
    if (args.length)
      console.error(line, ...args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a)));
    else console.error(line);
  };
  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
