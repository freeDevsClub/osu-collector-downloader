// @ts-check
'use strict';

/**
 * Ошибка, у которой известен HTTP-статус ответа клиенту (400, 401, 403, 404, 409, 413, 502…).
 */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
    /** @type {number | undefined} */
    this.upstreamStatus = undefined;
  }

  /**
   * Псевдоним для обратной совместимости с кодом, обращающимся к httpStatus.
   * @returns {number}
   */
  get httpStatus() {
    return this.status;
  }

  set httpStatus(value) {
    this.status = value;
  }
}

module.exports = {
  HttpError,
};
