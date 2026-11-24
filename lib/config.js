// @ts-check
'use strict';

const path = require('node:path');
const { log, LOG_DEBUG } = require('./logger.js');
const { HttpError } = require('./errors.js');
const { formatBytes, pluralizeRu, formatPluralRu } = require('./utils/format.js');
const { sleep, sleepWithSignal, anySignal } = require('./utils/async.js');
const { json, readJson, closeStreamOrSocket } = require('./utils/http.js');

/**
 * @typedef {'preparing' | 'queued' | 'running' | 'paused' | 'finished' | 'finished_with_errors' | 'cancelled'} JobStatus
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
 * @property {'mirror' | 'session'} [method]
 * @property {JobStatus} status
 * @property {string | null} [error]
 * @property {string} [message]
 * @property {string | number} collectionId
 * @property {string} collectionName
 * @property {boolean} [noVideo]
 * @property {number[]} [setIds]
 * @property {Set<number>} doneIds
 * @property {Set<number>} skipIds
 * @property {Set<number>} errIds
 * @property {Map<number | string, Object>} errorsById
 * @property {number} [extraFailures]
 * @property {Map<number, any>} mapsById
 * @property {Map<number, any>} [activeTransfers]
 * @property {number | null} [currentSetId]
 * @property {string | null} [currentSetName]
 * @property {string | null} [currentMirror]
 * @property {number} [currentBytes]
 * @property {number | null} [currentTotalBytes]
 * @property {number} [currentPercent]
 * @property {AbortController | null} [abortController]
 * @property {NodeJS.Timeout | null} [autoResumeTimer]
 * @property {number} [autoResumeCount]
 * @property {number | null} [autoResumeAt]
 * @property {number | null} [pausedAt]
 * @property {number | null} [finishedAt]
 * @property {number} [createdAt]
 * @property {Set<number> | null} [retryOnlyIds]
 *
 * @typedef {Object} AuthContext
 * @property {string | null} [session]
 * @property {'session' | 'mirror'} kind
 * @property {Mirror} [mirror]
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');
const ROOT = path.resolve(__dirname, '..');

function getDownloadsDir() {
  const env = process.env.DOWNLOADS_DIR;
  return env && env !== 'undefined' ? path.resolve(env) : path.join(ROOT, 'downloads');
}

/**
 * Возвращает путь к директории хранения данных и настроек приложения (state, settings).
 * Настраивается через переменные окружения DATA_DIR или CONFIG_DIR.
 * По умолчанию используется каталог 'data' в корне проекта.
 * @returns {string}
 */
function getDataDir() {
  const env = process.env.DATA_DIR || process.env.CONFIG_DIR;
  return env && env !== 'undefined' ? path.resolve(env) : path.join(ROOT, 'data');
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
  if (/([?&])noVideo=[^&]*/i.test(base)) return base;
  return base.includes('?') ? `${base}&noVideo=1` : `${base}?noVideo=1`;
}

const DEFAULT_MIRRORS = [
  { id: 'osudirect', label: 'osu.direct', build: (id, opts) => buildMirrorUrl('https://osu.direct/d/{id}', id, opts) },
  {
    id: 'hinamizawa',
    label: 'Hinamizawa',
    build: (id, opts) => buildMirrorUrl('https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}', id, opts),
  },
  { id: 'osudl', label: 'osu!dl', build: (id, opts) => buildMirrorUrl('https://osudl.org/s/{id}', id, opts) },
  {
    id: 'sayobot',
    label: 'Sayobot',
    // Sayobot использует путь /novideo/ или /full/ вместо query-параметра noVideo=1.
    // CDN Sayobot (tc1.sayobot.cn) отдаёт файлы через нестандартный порт 25225 — разрешаем его явно.
    allowedRedirectPorts: ['443', '25225'],
    build: (id, opts) => {
      const isNoVideo = typeof opts === 'boolean' ? opts : Boolean(opts?.noVideo);
      const path = isNoVideo ? 'novideo' : 'full';
      return `https://txy1.sayobot.cn/beatmaps/download/${path}/${id}`;
    },
  },
];

function initMirrors() {
  if (process.env.OSU_MIRRORS) {
    try {
      const parsed = JSON.parse(process.env.OSU_MIRRORS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m, idx) => ({
          id: String(m.id || `mirror_${idx}`),
          label: String(m.label || m.id || `Зеркало ${idx + 1}`),
          build:
            typeof m.url === 'string'
              ? (id, opts) => buildMirrorUrl(m.url, id, opts)
              : m.build || ((id, opts) => buildMirrorUrl('https://osu.direct/d/{id}', id, opts)),
        }));
      }
    } catch {
      const templates = process.env.OSU_MIRRORS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (templates.length > 0) {
        return templates.map((tmpl, idx) => {
          let host = `mirror_${idx}`;
          try {
            host = new URL(tmpl.replace('{id}', '1')).hostname;
          } catch {}
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

const AUTO_RESUME_GRACE_MS = 1000;
const AUTO_RESUME_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_RESUME_MAX_ATTEMPTS ?? 8));

const MIRROR_SLOT_TIMEOUT_MS = Math.max(5000, Number(process.env.MIRROR_SLOT_TIMEOUT_MS ?? 30000));
const CONNECT_TIMEOUT_MS = 15000;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const PAGE_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.PAGE_FETCH_TIMEOUT_MS ?? 20000));
const PAGINATION_PAGE_LIMIT = Math.max(1, Number(process.env.PAGINATION_PAGE_LIMIT ?? 250));
const PAGINATION_DELAY_MS = Math.max(0, Number(process.env.PAGINATION_DELAY_MS ?? 350));
const MAPSET_FETCH_BUDGET_MS = Math.max(50, Number(process.env.MAPSET_FETCH_BUDGET_MS ?? 60000));
const COLLECTION_CACHE_TTL_MS = Math.max(1000, Number(process.env.COLLECTION_CACHE_TTL_MS ?? 10 * 60 * 1000));
const COLLECTION_CACHE_DEGRADED_TTL_MS = Math.max(
  1000,
  Number(process.env.COLLECTION_CACHE_DEGRADED_TTL_MS ?? 2 * 60 * 1000),
);
const STALE_PART_MAX_AGE_MS = Math.max(1000, Number(process.env.STALE_PART_MAX_AGE_MS ?? 24 * 60 * 60 * 1000));
const isTestEnv = Boolean(
  process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || process.env.NODE_TEST_CONTEXT,
);
const INITIAL_PAGE_WAIT_MS = Math.max(0, Number(process.env.INITIAL_PAGE_WAIT_MS ?? (isTestEnv ? 30 : 1200)));
const DEFERRED_RETRY_DELAY_MS = 2500;
function getDeferredRetryDelayMs() {
  const envVal = Number(process.env.DEFERRED_RETRY_DELAY_MS);
  if (Number.isFinite(envVal) && envVal >= 0) return envVal;
  return isTestEnv ? 20 : DEFERRED_RETRY_DELAY_MS;
}

module.exports = {
  HOST,
  PORT,
  ROOT,
  getDownloadsDir,
  getDataDir,
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
  get MIRROR_COOLDOWN_DEFAULT_MS() {
    return getMirrorCooldownDefaultMs();
  },
  get MIRROR_COOLDOWN_MAX_MS() {
    return getMirrorCooldownMaxMs();
  },
  get MIRROR_COOLDOWN_WAIT_MAX_MS() {
    return getMirrorCooldownWaitMaxMs();
  },
  getDeferredRetryDelayMs,
  get DEFERRED_RETRY_DELAY_MS() {
    return getDeferredRetryDelayMs();
  },
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  LOG_DEBUG,
  MIRROR_SLOT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  REDIRECT_STATUSES,
  PAGE_FETCH_TIMEOUT_MS,
  PAGINATION_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  MAPSET_FETCH_BUDGET_MS,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
  STALE_PART_MAX_AGE_MS,
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
  readJson,
  closeStreamOrSocket,
  get setMirrorsForTest() {
    return require('./mirrors.js').setMirrorsForTest;
  },
  get resetMirrorsForTest() {
    return require('./mirrors.js').resetMirrorsForTest;
  },
};
