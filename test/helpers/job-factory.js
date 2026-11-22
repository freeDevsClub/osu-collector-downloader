// @ts-check
'use strict';

const { createJob, Job } = require('../../lib/job.js');

/**
 * @typedef {import('../../lib/job.js').JobStatus} JobStatus
 */

/**
 * Создает нормализованный экземпляр Job для тестов с безопасными значениями по умолчанию.
 * Защищает тесты от дрейфа структуры и рассинхронизации полей объекта задачи.
 * @param {Record<string, any>} [overrides]
 * @returns {Job}
 */
function createTestJob(overrides = {}) {
  /** @type {Record<string, any>} */
  const defaults = {
    id: `job_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    method: 'mirror',
    collectionId: 'test_col_1',
    collectionName: 'Test Collection',
    status: 'preparing',
    setIds: [],
    doneIds: [],
    skipIds: [],
    errIds: [],
    errorsById: new Map(),
    mapsById: new Map(),
    activeTransfers: new Map(),
    extraFailures: 0,
    currentBytes: 0,
    currentTotalBytes: null,
    currentPercent: 0,
    currentMirror: null,
    message: '',
  };

  /** @type {Record<string, any>} */
  const opts = { ...defaults, ...overrides };

  // Если переданы mapsById в виде массива пар или объекта
  if (opts.mapsById && !(opts.mapsById instanceof Map)) {
    if (Array.isArray(opts.mapsById)) {
      opts.mapsById = new Map(opts.mapsById);
    } else if (typeof opts.mapsById === 'object') {
      opts.mapsById = new Map(Object.entries(opts.mapsById).map(([k, v]) => [Number(k) || k, v]));
    }
  }

  // Если переданы errorsById в виде массива пар или объекта
  if (opts.errorsById && !(opts.errorsById instanceof Map)) {
    if (Array.isArray(opts.errorsById)) {
      opts.errorsById = new Map(opts.errorsById);
    } else if (typeof opts.errorsById === 'object') {
      opts.errorsById = new Map(Object.entries(opts.errorsById).map(([k, v]) => [Number(k) || k, v]));
    }
  }

  // Если переданы activeTransfers в виде массива пар или объекта
  if (opts.activeTransfers && !(opts.activeTransfers instanceof Map)) {
    if (Array.isArray(opts.activeTransfers)) {
      opts.activeTransfers = new Map(opts.activeTransfers);
    } else if (typeof opts.activeTransfers === 'object') {
      opts.activeTransfers = new Map(Object.entries(opts.activeTransfers).map(([k, v]) => [Number(k) || k, v]));
    }
  }

  // Если переданы postDownloadErrors в виде массива пар или объекта
  if (opts.postDownloadErrors && !(opts.postDownloadErrors instanceof Map)) {
    if (Array.isArray(opts.postDownloadErrors)) {
      opts.postDownloadErrors = new Map(
        opts.postDownloadErrors.map((item) =>
          Array.isArray(item) ? [Number(item[0]), String(item[1] || '')] : [Number(item), ''],
        ),
      );
    } else if (typeof opts.postDownloadErrors === 'object') {
      opts.postDownloadErrors = new Map(
        Object.entries(opts.postDownloadErrors).map(([k, v]) => [Number(k), String(v || '')]),
      );
    }
  }

  // Если переданы warnings в виде массива
  if (opts.warnings && !(opts.warnings instanceof Set)) {
    opts.warnings = new Set(Array.isArray(opts.warnings) ? opts.warnings.map(String) : []);
  }

  return createJob(opts);
}

/**
 * Создает задачу в статусе running.
 * @param {Record<string, any>} [overrides]
 * @returns {Job}
 */
function createRunningTestJob(overrides = {}) {
  return createTestJob({ status: 'running', ...overrides });
}

/**
 * Создает задачу в статусе paused.
 * @param {Record<string, any>} [overrides]
 * @returns {Job}
 */
function createPausedTestJob(overrides = {}) {
  return createTestJob({ status: 'paused', ...overrides });
}

/**
 * Создает задачу в статусе finished.
 * @param {Record<string, any>} [overrides]
 * @returns {Job}
 */
function createFinishedTestJob(overrides = {}) {
  return createTestJob({ status: 'finished', ...overrides });
}

module.exports = {
  createTestJob,
  createRunningTestJob,
  createPausedTestJob,
  createFinishedTestJob,
  Job,
};
