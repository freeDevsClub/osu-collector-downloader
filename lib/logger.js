// @ts-check
'use strict';

const LOG_DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');

/**
 * Структурированное логирование в формате JSON.
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {string} event
 * @param {Record<string, any>} [details]
 */
function log(level, event, details = {}) {
  if (level === 'debug' && !LOG_DEBUG) return;
  const record = {
    time: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(record));
}

module.exports = {
  log,
  LOG_DEBUG,
};
