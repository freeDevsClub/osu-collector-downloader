// @ts-check
"use strict";

const {
  MIRRORS,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
  DOWNLOAD_DELAY_MS,
  sleepWithSignal,
} = require('./config.js');

const mirrorCooldowns = new Map();
const mirrorLocks = new Map();

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

/**
 * @typedef {Object} MirrorWaiter
 * @property {(value?: any) => void} resolve
 * @property {(err: any) => void} reject
 * @property {AbortSignal} [signal]
 * @property {() => void} [abortListener]
 *
 * @typedef {Object} MirrorLock
 * @property {number} active
 * @property {number} lastRequestAt
 * @property {MirrorWaiter[]} waiters
 */

/**
 * @param {string} mirrorId
 * @returns {MirrorLock}
 */
function getMirrorLock(mirrorId) {
  let lock = mirrorLocks.get(mirrorId);
  if (!lock) {
    lock = {
      active: 0,
      lastRequestAt: 0,
      waiters: [],
    };
    mirrorLocks.set(mirrorId, lock);
  }
  return lock;
}

/**
 * Проверяет, выполняет ли зеркало запрос в данный момент.
 * @param {any} mirror
 * @returns {boolean}
 */
function isMirrorBusy(mirror) {
  if (!mirror?.id) return false;
  const lock = mirrorLocks.get(mirror.id);
  return !!(lock && lock.active > 0);
}

/**
 * Сбрасывает состояние блокировок зеркал (для тестов и завершения задач).
 */
function resetMirrorSlots() {
  for (const lock of mirrorLocks.values()) {
    while (lock.waiters.length > 0) {
      const w = lock.waiters.shift();
      if (w?.signal && w.abortListener) {
        w.signal.removeEventListener('abort', w.abortListener);
      }
      w?.reject(new Error('Сброс слотов зеркал'));
    }
  }
  mirrorLocks.clear();
}

/**
 * Захватывает слот зеркала (не более 1 одновременного запроса на зеркало).
 * Гарантирует соблюдение интервала DOWNLOAD_DELAY_MS между запросами к одному зеркалу.
 * @param {any} mirror
 * @param {AbortSignal} [signal]
 * @returns {Promise<() => void>} функция освобождения слота
 */
async function acquireMirrorSlot(mirror, signal) {
  if (signal?.aborted) {
    throw signal.reason || new Error('Загрузка отменена');
  }

  const lock = getMirrorLock(mirror.id);

  if (lock.active > 0) {
    await new Promise((resolve, reject) => {
      /** @type {MirrorWaiter} */
      const waiter = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          const idx = lock.waiters.indexOf(waiter);
          if (idx !== -1) {
            lock.waiters.splice(idx, 1);
          }
          reject(signal.reason || new Error('Загрузка отменена'));
        };
        waiter.abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      lock.waiters.push(waiter);
    });
  } else {
    lock.active = 1;
  }

  const elapsed = Date.now() - lock.lastRequestAt;
  const delay = DOWNLOAD_DELAY_MS - elapsed;
  if (lock.lastRequestAt > 0 && delay > 0) {
    try {
      await sleepWithSignal(delay, signal);
    } catch (err) {
      releaseMirrorSlot(mirror);
      throw err;
    }
  }

  lock.lastRequestAt = Date.now();

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    lock.lastRequestAt = Date.now();
    releaseMirrorSlot(mirror);
  };
}

/**
 * Освобождает слот зеркала и передаёт его следующему ожидающему.
 * @param {any} mirror
 */
function releaseMirrorSlot(mirror) {
  const lock = getMirrorLock(mirror.id);

  while (lock.waiters.length > 0) {
    const next = lock.waiters.shift();
    if (next) {
      if (next.signal && next.abortListener) {
        next.signal.removeEventListener('abort', next.abortListener);
      }
      if (next.signal?.aborted) {
        continue;
      }
      next.resolve();
      return;
    }
  }
  lock.active = 0;
}

module.exports = {
  MIRRORS,
  mirrorCooldowns,
  mirrorLocks,
  OAuthDownloadScopeError,
  MirrorTransientError,
  MirrorRateLimitError,
  isTransientError,
  parseRetryAfter,
  mirrorCooldownRemaining,
  mirrorResumeWaitMs,
  isMirrorBusy,
  acquireMirrorSlot,
  releaseMirrorSlot,
  resetMirrorSlots,
};
