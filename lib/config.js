// @ts-check
"use strict";

const path = require('node:path');

/**
 * @typedef {'queued' | 'running' | 'paused' | 'finished' | 'finished_with_errors' | 'cancelled'} JobStatus
 *
 * @typedef {Object} BeatmapSet
 * @property {number} id
 * @property {string} [title]
 * @property {string} [artist]
 * @property {string} [creator]
 * @property {string} [label]
 * @property {Object} [covers]
 * @property {string} [covers.cover]
 * @property {string} [covers.card]
 * @property {string} [covers.list]
 *
 * @typedef {Object} Mirror
 * @property {string} id
 * @property {string} label
 * @property {(id: number | string, opts?: { noVideo?: boolean } | boolean) => string} build
 *
 * @typedef {Object} JobCounters
 * @property {number} total
 * @property {number} done
 * @property {number} skip
 * @property {number} error
 * @property {number} percent
 *
 * @typedef {Object} Job
 * @property {string} id
 * @property {JobStatus} status
 * @property {string | null} [error]
 * @property {string} [message]
 * @property {number} collectionId
 * @property {string} collectionName
 * @property {boolean} [noVideo]
 * @property {number} total
 * @property {number[]} [setIds]
 * @property {Set<number>} doneIds
 * @property {Set<number>} skipIds
 * @property {Set<number>} errIds
 * @property {Map<number | string, Object>} errorsById
 * @property {Map<number, any>} mapsById
 * @property {Map<number, any>} [activeTransfers]
 * @property {number | null} [currentSetId]
 * @property {number | null} [currentBeatmapsetId]
 * @property {string | null} [currentMirror]
 * @property {number} [currentBytes]
 * @property {number | null} [currentTotalBytes]
 * @property {number} [currentPercent]
 * @property {AbortController | null} [abortController]
 * @property {NodeJS.Timeout | null} [autoResumeTimer]
 * @property {number} [autoResumeAttempt]
 * @property {number | null} [autoResumeAt]
 * @property {number | null} [pausedAt]
 * @property {number | null} [finishedAt]
 * @property {number} [createdAt]
 *
 * @typedef {Object} AuthContext
 * @property {string | null} [session]
 * @property {'session' | 'mirror'} kind
 * @property {Mirror} [mirror]
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const ROOT = path.resolve(__dirname, '..');

function getDownloadsDir() {
  const env = process.env.DOWNLOADS_DIR;
  return (env && env !== 'undefined') ? path.resolve(env) : path.join(ROOT, 'downloads');
}

const SESSION_COOKIE = 'osu_session';
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];

const tokenCookie = 'osu_collector_token';
const localApiTokenCookie = 'osu_local_token';
const MAX_BODY = 64 * 1024;
const MAX_OSZ_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 МБ максимальный размер скачиваемого .osz
const DOWNLOAD_DELAY_MS = Math.max(0, Number(process.env.DOWNLOAD_DELAY_MS ?? 1100));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DOWNLOAD_CONCURRENCY ?? 3)));
const USER_AGENT = process.env.USER_AGENT || 'osu-collector-local-downloader/1.0';

/**
 * Формирует URL загрузки с зеркала с учётом параметра noVideo.
 * @param {string} basePattern
 * @param {number | string} id
 * @param {{ noVideo?: boolean } | boolean} [opts]
 * @returns {string}
 */
function buildMirrorUrl(basePattern, id, opts) {
  const isNoVideo = typeof opts === 'boolean' ? opts : Boolean(opts?.noVideo);
  const base = basePattern.replace('{id}', String(id));
  if (!isNoVideo) return base;
  return base.includes('?') ? `${base}&noVideo=1` : `${base}?noVideo=1`;
}

const DEFAULT_MIRRORS = [
  { id: 'osudirect', label: 'osu.direct', build: (id, opts) => buildMirrorUrl('https://osu.direct/d/{id}', id, opts) },
  { id: 'hinamizawa', label: 'Hinamizawa', build: (id, opts) => buildMirrorUrl('https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}', id, opts) },
  { id: 'osudl', label: 'osu!dl', build: (id, opts) => buildMirrorUrl('https://osudl.org/s/{id}', id, opts) },
];

function initMirrors() {
  if (process.env.OSU_MIRRORS) {
    try {
      const parsed = JSON.parse(process.env.OSU_MIRRORS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m, idx) => ({
          id: String(m.id || `mirror_${idx}`),
          label: String(m.label || m.id || `Зеркало ${idx + 1}`),
          build: typeof m.url === 'string'
            ? ((id, opts) => buildMirrorUrl(m.url, id, opts))
            : (m.build || ((id, opts) => buildMirrorUrl('https://osu.direct/d/{id}', id, opts))),
        }));
      }
    } catch {
      const templates = process.env.OSU_MIRRORS.split(',').map(s => s.trim()).filter(Boolean);
      if (templates.length > 0) {
        return templates.map((tmpl, idx) => {
          let host = `mirror_${idx}`;
          try { host = new URL(tmpl.replace('{id}', '1')).hostname; } catch {}
          const pattern = tmpl.includes('{id}') ? tmpl : `${tmpl.replace(/\/+$/, '')}/{id}`;
          return {
            id: `mirror_${idx}`,
            label: host,
            build: (id, opts) => buildMirrorUrl(pattern, id, opts),
          };
        });
      }
    }
  }
  return DEFAULT_MIRRORS;
}

const MIRRORS = initMirrors();

function getMirrorCooldownDefaultMs() {
  return Math.max(1000, Number(process.env.MIRROR_COOLDOWN_DEFAULT_MS ?? 60 * 1000));
}

function getMirrorCooldownMaxMs() {
  const envMax = process.env.MIRROR_COOLDOWN_MAX_MS ? Number(process.env.MIRROR_COOLDOWN_MAX_MS) : null;
  if (envMax !== null && !isNaN(envMax)) {
    return Math.max(1000, envMax);
  }
  return Math.max(getMirrorCooldownDefaultMs(), 15 * 60 * 1000);
}

function getMirrorCooldownWaitMaxMs() {
  return Math.max(0, Number(process.env.MIRROR_COOLDOWN_WAIT_MAX_MS ?? 30 * 1000));
}

const MIRROR_COOLDOWN_DEFAULT_MS = getMirrorCooldownDefaultMs();
const MIRROR_COOLDOWN_MAX_MS = getMirrorCooldownMaxMs();
const MIRROR_COOLDOWN_WAIT_MAX_MS = getMirrorCooldownWaitMaxMs();
const AUTO_RESUME_GRACE_MS = 1000;
const AUTO_RESUME_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_RESUME_MAX_ATTEMPTS ?? 8));

const LOG_DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');

const CONNECT_TIMEOUT_MS = 15000;
const READ_CHUNK_TIMEOUT_MS = 30000;
const CHUNK_SIZE = 64 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const PAGE_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.PAGE_FETCH_TIMEOUT_MS ?? 20000));
const PAGINATION_PAGE_LIMIT = Math.max(1, Number(process.env.PAGINATION_PAGE_LIMIT ?? 250));
const PAGINATION_DELAY_MS = Math.max(0, Number(process.env.PAGINATION_DELAY_MS ?? 350));
const MAPSET_FETCH_BUDGET_MS = Math.max(50, Number(process.env.MAPSET_FETCH_BUDGET_MS ?? 60000));
const COLLECTION_CACHE_TTL_MS = Math.max(1000, Number(process.env.COLLECTION_CACHE_TTL_MS ?? 10 * 60 * 1000));
const COLLECTION_CACHE_DEGRADED_TTL_MS = Math.max(1000, Number(process.env.COLLECTION_CACHE_DEGRADED_TTL_MS ?? 2 * 60 * 1000));
const COLLECTION_CACHE_MAX_AGE_MS = COLLECTION_CACHE_TTL_MS;
const isTestEnv = Boolean(
  process.env.NODE_ENV === 'test' ||
  process.execArgv.includes('--test') ||
  process.env.NODE_TEST_CONTEXT
);
const INITIAL_PAGE_WAIT_MS = Math.max(0, Number(process.env.INITIAL_PAGE_WAIT_MS ?? (isTestEnv ? 30 : 1200)));

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

// Ошибка, у которой известен HTTP-статус ответа клиенту (413, 502 …).
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
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

/**
 * Форматирует объём данных в человекочитаемый вид (Б, КБ, МБ, ГБ).
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const ruPluralRules = new Intl.PluralRules('ru-RU');

/**
 * Склоняет существительное с числительным согласно правилам русского языка.
 * @param {number} count
 * @param {string} one - форма для 1 (например, "набор")
 * @param {string} few - форма для 2-4 (например, "набора")
 * @param {string} many - форма для 5-20 (например, "наборов")
 * @returns {string}
 */
function pluralizeRu(count, one, few, many) {
  const rule = ruPluralRules.select(Math.abs(count));
  switch (rule) {
    case 'one':
      return one;
    case 'few':
      return few;
    case 'many':
    default:
      return many;
  }
}

/**
 * Возвращает строку с числом и правильно склонённым существительным (например, "1 набор", "2 набора", "5 наборов").
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function formatPluralRu(count, one, few, many) {
  return `${count} ${pluralizeRu(count, one, few, many)}`;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

module.exports = {
  HOST,
  PORT,
  ROOT,
  getDownloadsDir,
  SESSION_COOKIE,
  ZIP_SIGNATURES,
  tokenCookie,
  localApiTokenCookie,
  isTestEnv,
  MAX_BODY,
  MAX_OSZ_DOWNLOAD_BYTES,
  DOWNLOAD_DELAY_MS,
  DOWNLOAD_CONCURRENCY,
  USER_AGENT,
  buildMirrorUrl,
  DEFAULT_MIRRORS,
  initMirrors,
  MIRRORS,
  getMirrorCooldownDefaultMs,
  getMirrorCooldownMaxMs,
  getMirrorCooldownWaitMaxMs,
  get MIRROR_COOLDOWN_DEFAULT_MS() { return getMirrorCooldownDefaultMs(); },
  get MIRROR_COOLDOWN_MAX_MS() { return getMirrorCooldownMaxMs(); },
  get MIRROR_COOLDOWN_WAIT_MAX_MS() { return getMirrorCooldownWaitMaxMs(); },
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  LOG_DEBUG,
  CONNECT_TIMEOUT_MS,
  READ_CHUNK_TIMEOUT_MS,
  CHUNK_SIZE,
  REDIRECT_STATUSES,
  PAGE_FETCH_TIMEOUT_MS,
  PAGINATION_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  MAPSET_FETCH_BUDGET_MS,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
  COLLECTION_CACHE_MAX_AGE_MS,
  INITIAL_PAGE_WAIT_MS,
  log,
  HttpError,
  sleep,
  sleepWithSignal,
  anySignal,
  formatBytes,
  pluralizeRu,
  formatPluralRu,
  json,
};
