import { env } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

// Field names that hold secrets. Deliberately not plain /token/, so token *counts* still log.
const SECRET_KEYS =
  /(api[-_]?key|secret|password|passwd|authorization|cookie|access[-_]?token|refresh[-_]?token|^token$|^key$)/i;

/** Serialize errors and mask anything that looks like a secret. */
function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, stack: v.stack };
    else out[k] = v;
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(context: Fields): Logger;
}

function createLogger(context: Fields = {}): Logger {
  const threshold = LEVELS[env.LOG_LEVEL];

  const write = (level: Level, msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const data = sanitize({ ...context, ...fields });
    const time = new Date().toISOString();
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

    if (env.isProduction) {
      stream.write(JSON.stringify({ time, level, msg, ...data }) + '\n');
      return;
    }
    const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    stream.write(
      `${COLORS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${extra}\n`,
    );
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

export const logger = createLogger();
