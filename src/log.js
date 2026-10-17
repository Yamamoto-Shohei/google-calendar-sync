const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  const want = (process.env.GCAL_SYNC_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[want] ?? LEVELS.info;
}

function emit(level, stream, prefix, args) {
  if (LEVELS[level] < threshold()) return;
  stream.write(`${prefix}${args.join(' ')}\n`);
}

export const log = {
  debug: (...args) => emit('debug', process.stderr, '  · ', args),
  info: (...args) => emit('info', process.stdout, '', args),
  warn: (...args) => emit('warn', process.stderr, 'WARN  ', args),
  error: (...args) => emit('error', process.stderr, 'ERROR ', args),
};
