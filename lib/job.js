// @ts-check
"use strict";

const crypto = require('node:crypto');

/**
 * @typedef {'preparing' | 'queued' | 'running' | 'paused' | 'finished' | 'finished_with_errors' | 'cancelled'} JobStatus
 */

/** @type {readonly JobStatus[]} */
const JOB_STATUSES = Object.freeze([
  'preparing',
  'queued',
  'running',
  'paused',
  'finished',
  'finished_with_errors',
  'cancelled',
]);

/**
 * Граф допустимых переходов между статусами задачи.
 * @type {Readonly<Record<JobStatus, readonly JobStatus[]>>}
 */
const VALID_JOB_TRANSITIONS = Object.freeze({
  preparing: /** @type {readonly JobStatus[]} */ (Object.freeze(['queued', 'running', 'paused', 'finished_with_errors', 'cancelled'])),
  queued: /** @type {readonly JobStatus[]} */ (Object.freeze(['preparing', 'running', 'paused', 'finished', 'finished_with_errors', 'cancelled'])),
  running: /** @type {readonly JobStatus[]} */ (Object.freeze(['paused', 'finished', 'finished_with_errors', 'cancelled'])),
  paused: /** @type {readonly JobStatus[]} */ (Object.freeze(['queued', 'preparing', 'running', 'cancelled', 'finished_with_errors'])),
  finished: /** @type {readonly JobStatus[]} */ (Object.freeze(['queued'])),
  finished_with_errors: /** @type {readonly JobStatus[]} */ (Object.freeze(['queued', 'cancelled'])),
  cancelled: /** @type {readonly JobStatus[]} */ (Object.freeze([])),
});

/**
 * Машина состояний жизненного цикла задачи скачивания.
 */
class JobStateMachine {
  /**
   * Проверяет, допустим ли переход из текущего статуса в целевой.
   * Переход в тот же статус всегда считается допустимым (идемпотентным).
   * @param {JobStatus} currentStatus
   * @param {JobStatus} targetStatus
   * @returns {boolean}
   */
  static isValidTransition(currentStatus, targetStatus) {
    if (currentStatus === targetStatus) return true;
    const allowed = VALID_JOB_TRANSITIONS[currentStatus];
    return Array.isArray(allowed) && allowed.includes(targetStatus);
  }

  /**
   * Возвращает список допустимых следующих статусов для указанного статуса.
   * @param {JobStatus} status
   * @returns {readonly JobStatus[]}
   */
  static getAllowedTransitions(status) {
    return VALID_JOB_TRANSITIONS[status] || [];
  }
}

/**
 * Нормализованная модель задачи скачивания с единой схемой по умолчанию
 * и валидацией переходов статуса через машину состояний.
 */
class Job {
  /** @type {string} */
  id;
  /** @type {'mirror' | 'session'} */
  method;
  /** @type {boolean} */
  noVideo;
  /** @type {string | number} */
  collectionId;
  /** @type {string} */
  collectionName;
  /** @type {number[]} */
  setIds;
  /** @type {Set<number>} */
  doneIds;
  /** @type {Set<number>} */
  skipIds;
  /** @type {Set<number>} */
  errIds;
  /** @type {Map<number | string, any>} */
  errorsById;
  /** @type {number} */
  extraFailures;
  /** @type {Map<number, any>} */
  mapsById;
  /** @type {Map<number, any>} */
  activeTransfers;
  /** @type {number} */
  currentBytes;
  /** @type {number | null} */
  currentTotalBytes;
  /** @type {number} */
  currentPercent;
  /** @type {string | null} */
  currentMirror;
  /** @type {number | null} */
  currentSetId;
  /** @type {string | null} */
  currentSetName;
  /** @type {string} */
  message;
  /** @type {number | null} */
  autoResumeAt;
  /** @type {number} */
  autoResumeCount;
  /** @type {NodeJS.Timeout | null} */
  autoResumeTimer;
  /** @type {AbortController | null} */
  abortController;
  /** @type {number} */
  createdAt;
  /** @type {number | null} */
  pausedAt;
  /** @type {number | null} */
  finishedAt;
  /** @type {Set<number> | null} */
  retryOnlyIds;

  // Служебные поля для событий, кеширования и управления выполнением:
  /** @type {number} */
  _lastEmit;
  /** @type {NodeJS.Timeout | null} */
  _emitTimer;
  /** @type {any} */
  _cachedSerializedMaps;
  /** @type {any} */
  _cachedStaticMetadata;
  /** @type {boolean} */
  _prepared;
  /** @type {((immediate?: boolean) => void) | null} */
  notifyUpdate;
  /** @type {Promise<any> | null} */
  _promise;

  /** @type {JobStatus} */
  #status;

  /**
   * @param {Record<string, any>} [options={}]
   */
  constructor(options = {}) {
    this.id = String(options.id || crypto.randomBytes(16).toString('hex'));
    this.method = options.method === 'session' ? 'session' : 'mirror';
    this.noVideo = Boolean(options.noVideo);
    this.collectionId = options.collectionId != null ? options.collectionId : '';
    this.collectionName = typeof options.collectionName === 'string' && options.collectionName.trim()
      ? options.collectionName.trim()
      : (this.collectionId ? `Коллекция ${this.collectionId}` : 'Коллекция');

    this.setIds = Array.isArray(options.setIds) ? options.setIds.map(Number) : [];
    this.doneIds = options.doneIds instanceof Set
      ? options.doneIds
      : new Set(Array.isArray(options.doneIds) ? options.doneIds.map(Number) : []);
    this.skipIds = options.skipIds instanceof Set
      ? options.skipIds
      : new Set(Array.isArray(options.skipIds) ? options.skipIds.map(Number) : []);
    this.errIds = options.errIds instanceof Set
      ? options.errIds
      : new Set(Array.isArray(options.errIds) ? options.errIds.map(Number) : []);

    /** @type {Map<number | string, any>} */
    this.errorsById = options.errorsById instanceof Map
      ? options.errorsById
      : new Map();
    if (!(options.errorsById instanceof Map) && Array.isArray(options.errors)) {
      for (const err of options.errors) {
        if (err && err.id != null) {
          this.errorsById.set(err.id, err);
        }
      }
    }

    this.extraFailures = Number(options.extraFailures || (this.errorsById.has('fatal') ? 1 : 0));
    this.mapsById = options.mapsById instanceof Map ? options.mapsById : new Map();
    this.activeTransfers = options.activeTransfers instanceof Map ? options.activeTransfers : new Map();

    this.currentBytes = Number(options.currentBytes || 0);
    this.currentTotalBytes = options.currentTotalBytes != null ? Number(options.currentTotalBytes) : null;
    this.currentPercent = Number(options.currentPercent || 0);
    this.currentMirror = options.currentMirror || null;
    this.currentSetId = options.currentSetId != null ? Number(options.currentSetId) : null;
    this.currentSetName = options.currentSetName || null;

    this.message = typeof options.message === 'string' ? options.message : '';
    this.autoResumeAt = options.autoResumeAt != null ? Number(options.autoResumeAt) : null;
    this.autoResumeCount = Number(options.autoResumeCount || 0);
    this.autoResumeTimer = options.autoResumeTimer || null;
    this.abortController = options.abortController || null;

    this.createdAt = Number(options.createdAt) || Date.now();
    this.pausedAt = options.pausedAt != null ? Number(options.pausedAt) : null;
    this.finishedAt = options.finishedAt != null ? Number(options.finishedAt) : null;
    this.retryOnlyIds = options.retryOnlyIds instanceof Set
      ? options.retryOnlyIds
      : (Array.isArray(options.retryOnlyIds) ? new Set(options.retryOnlyIds.map(Number)) : null);

    this._lastEmit = 0;
    this._emitTimer = null;
    this._cachedSerializedMaps = null;
    this._cachedStaticMetadata = null;
    this._prepared = Boolean(options._prepared);
    this.notifyUpdate = typeof options.notifyUpdate === 'function' ? options.notifyUpdate : null;
    this._promise = options._promise || null;

    const initialStatus = options.status || 'preparing';
    if (!JOB_STATUSES.includes(initialStatus)) {
      throw new Error(`Недопустимый начальный статус задачи: «${initialStatus}»`);
    }
    this.#status = initialStatus;
  }

  /**
   * Текущий статус выполнения задачи.
   * @returns {JobStatus}
   */
  get status() {
    return this.#status;
  }

  /**
   * Мутирует статус через валидацию машины состояний.
   * @param {JobStatus} newStatus
   */
  set status(newStatus) {
    this.transitionTo(newStatus);
  }

  /**
   * Проверяет, допустим ли переход в указанный целевой статус.
   * @param {JobStatus} targetStatus
   * @returns {boolean}
   */
  canTransitionTo(targetStatus) {
    return JobStateMachine.isValidTransition(this.#status, targetStatus);
  }

  /**
   * Выполняет переход в целевой статус с валидацией допустимости.
   * @param {JobStatus} targetStatus
   * @param {{ silent?: boolean, force?: boolean }} [options={}]
   * @returns {boolean} Возвращает true, если статус изменился; false, если переход отклонён или статус не изменился.
   */
  transitionTo(targetStatus, options = {}) {
    if (!JOB_STATUSES.includes(targetStatus)) {
      throw new Error(`Неизвестный статус задачи: «${targetStatus}»`);
    }

    if (this.#status === targetStatus) {
      return false;
    }

    if (!options.force && !this.canTransitionTo(targetStatus)) {
      // Если задача уже в терминальном состоянии cancelled, фоновые асинхронные завершения
      // не должны ломать приложение выбросом исключения:
      if (this.#status === 'cancelled' || options.silent) {
        return false;
      }
      throw new Error(`Недопустимый переход состояния задачи ${this.id}: «${this.#status}» → «${targetStatus}»`);
    }

    const previousStatus = this.#status;
    this.#status = targetStatus;

    if (targetStatus === 'paused') {
      this.pausedAt = Date.now();
      this.finishedAt = null;
    } else if (['finished', 'finished_with_errors'].includes(targetStatus)) {
      this.finishedAt = Date.now();
      this.pausedAt = null;
      this.clearAutoResume();
    } else if (targetStatus === 'cancelled') {
      this.finishedAt = Date.now();
      this.pausedAt = null;
      this.clearAutoResume();
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort();
      }
    } else if (['queued', 'running', 'preparing'].includes(targetStatus)) {
      this.finishedAt = null;
      this.pausedAt = null;
    }

    return true;
  }

  /**
   * Возвращает общее количество наборов в задаче.
   * @returns {number}
   */
  get total() {
    return Array.isArray(this.setIds) ? this.setIds.length : 0;
  }

  /**
   * Очищает таймер автоматического возобновления задачи.
   */
  clearAutoResume() {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
    this.autoResumeAt = null;
  }

  /**
   * Проверяет, активна ли задача в данный момент (готовится, в очереди или скачивается).
   * @returns {boolean}
   */
  isActive() {
    return ['preparing', 'queued', 'running'].includes(this.#status);
  }

  /**
   * Проверяет, завершена ли задача окончательно (успешно, с ошибками или отменена).
   * @returns {boolean}
   */
  isTerminal() {
    return ['finished', 'finished_with_errors', 'cancelled'].includes(this.#status);
  }

  /**
   * Проверяет, находится ли задача на паузе.
   * @returns {boolean}
   */
  isPaused() {
    return this.#status === 'paused';
  }

  /**
   * Проверяет, была ли задача отменена.
   * @returns {boolean}
   */
  isCancelled() {
    return this.#status === 'cancelled';
  }
}

/**
 * Фабричная функция создания нормализованного экземпляра задачи.
 * @param {Record<string, any>} [options]
 * @returns {Job}
 */
function createJob(options) {
  return new Job(options);
}

module.exports = {
  JOB_STATUSES,
  VALID_JOB_TRANSITIONS,
  JobStateMachine,
  Job,
  createJob,
};
