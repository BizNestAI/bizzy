export const log = {
  info:  (...a) => console.log('[INFO]', ...a),
  warn:  (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
  debug: (...a) => process.env.DEBUG ? console.debug('[DEBUG]', ...a) : null,
};
