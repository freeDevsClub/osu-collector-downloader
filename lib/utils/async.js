// @ts-check
'use strict';

/**
 * Асинхронная пауза на указанное число миллисекунд.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Асинхронная пауза с поддержкой отмены по AbortSignal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    const err = signal.reason || new Error('Загрузка отменена');
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason || new Error('Загрузка отменена'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

/**
 * Объединяет массив AbortSignal в единый сигнал.
 * @param {(AbortSignal | undefined | null)[]} signals
 * @returns {AbortSignal}
 */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

module.exports = {
  sleep,
  sleepWithSignal,
  anySignal,
};
