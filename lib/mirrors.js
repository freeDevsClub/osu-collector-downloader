// @ts-check
"use strict";

const {
  MIRRORS,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
} = require('./config.js');

const mirrorCooldowns = new Map();

class OAuthDownloadScopeError extends Error {}

class MirrorTransientError extends Error {
  /**
   * @param {any} mirror
   * @param {string} [message]
   */
  constructor(mirror, message) {
    super(message || `HTTP 5xx от ${mirror.label}.`);
    this.mirror = mirror;
  }
}

class MirrorRateLimitError extends Error {
  /**
   * @param {any} mirror
   * @param {number} retryAfterMs
   */
  constructor(mirror, retryAfterMs) {
    super(`HTTP 429 от ${mirror.label}: временное ограничение загрузок.`);
    this.mirror = mirror;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Проверяет, является ли ошибка загрузки с зеркала временной (сеть, 5xx, тайм-аут).
 * @param {any} error
 * @returns {boolean}
 */
function isTransientError(error) {
  if (!error) return false;
  if (error.isMissing || error instanceof MirrorRateLimitError || error instanceof OAuthDownloadScopeError) return false;
  if (error instanceof MirrorTransientError || error.name === 'BodyStalledError') return true;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = error.code || error.cause?.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('fetch failed') ||
         msg.includes('соединение не установлено') ||
         msg.includes('socket hang up') ||
         msg.includes('network error') ||
         msg.includes('econnreset') ||
         msg.includes('etimedout');
}

/**
 * Парсит заголовок Retry-After (секунды или HTTP-Date) в миллисекунды.
 * @param {string | null | undefined} header
 * @returns {number | null}
 */
function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return null; // 0 или отрицательное значение не должны давать кулдаун 0 мс (fallback на DEFAULT)
    return Math.min(seconds * 1000, MIRROR_COOLDOWN_MAX_MS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  const diff = date - Date.now();
  if (diff <= 0) return null;
  return Math.min(diff, MIRROR_COOLDOWN_MAX_MS);
}

/**
 * Возвращает оставшееся время кулдауна зеркала в миллисекундах (0, если доступно).
 * @param {any} mirror
 * @returns {number}
 */
function mirrorCooldownRemaining(mirror) {
  const until = mirrorCooldowns.get(mirror.id) || 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    if (until) mirrorCooldowns.delete(mirror.id);
    return 0;
  }
  return remaining;
}

/**
 * Ближайшее освобождение зеркал: 0, если хотя бы одно зеркало уже доступно.
 * @returns {number}
 */
function mirrorResumeWaitMs() {
  const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
  return cooldowns.length ? Math.min(...cooldowns) : 0;
}

module.exports = {
  MIRRORS,
  mirrorCooldowns,
  OAuthDownloadScopeError,
  MirrorTransientError,
  MirrorRateLimitError,
  isTransientError,
  parseRetryAfter,
  mirrorCooldownRemaining,
  mirrorResumeWaitMs,
};
