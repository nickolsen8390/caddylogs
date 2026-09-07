import { config } from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, scope, msg, extra) {
  if ((LEVELS[level] ?? 2) > threshold) return;
  const line = { t: new Date().toISOString(), level, scope, msg };
  if (extra !== undefined) line.data = extra;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export function logger(scope) {
  return {
    error: (m, e) => emit('error', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
  };
}
