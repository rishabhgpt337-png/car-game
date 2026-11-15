// Tiny dependency-free structured logger with levels and timestamps.

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(scope) {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = ORDER[configured] ?? ORDER.info;

  const write = (level, args) => {
    if (ORDER[level] < threshold) return;
    const stamp = new Date().toISOString();
    const prefix = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}
