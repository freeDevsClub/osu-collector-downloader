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
 * @property {(id: number | string) => string} build
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
 * @property {number} [pausedAt]
 * @property {number} [finishedAt]
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} AuthContext
 * @property {string | null} [token]
 * @property {string | null} [cookie]
 * @property {'oauth' | 'cookie' | 'mirror' | 'guest'} kind
 * @property {Mirror} [mirror]
 *
 * @typedef {Object} OauthState
 * @property {string} nonce
 * @property {number} expiresAt
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const ROOT = path.resolve(__dirname, '..');

function getDownloadsDir() {
  return process.env.DOWNLOADS_DIR ? path.resolve(process.env.DOWNLOADS_DIR) : path.join(ROOT, 'downloads');
}

const SESSION_COOKIE = 'osu_session';
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];

const tokenCookie = 'osu_collector_token';
const OAUTH_STATE_COOKIE = 'osu_oauth_state';
const OAUTH_AUTHORIZE_ENDPOINT = 'https://osu.ppy.sh/oauth/authorize';
const OAUTH_TOKEN_ENDPOINT = 'https://osu.ppy.sh/oauth/token';
const OSU_API_BASE = 'https://osu.ppy.sh/api/v2';
const CALLBACK_URL = (process.env.OSU_OAUTH_CALLBACK || `http://127.0.0.1:${PORT}/oauth/callback`).replace(/\/+$/, '');
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const DOWNLOAD_DELAY_MS = Math.max(0, Number(process.env.DOWNLOAD_DELAY_MS ?? 1100));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DOWNLOAD_CONCURRENCY ?? 3)));
const USER_AGENT = process.env.USER_AGENT || 'osu-collector-local-downloader/1.0';

const DEFAULT_MIRRORS = [
  { id: 'osudirect', label: 'osu.direct', build: id => `https://osu.direct/d/${id}` },
  { id: 'hinamizawa', label: 'Hinamizawa', build: id => `https://mirror.hinamizawa.ai/api/v1/hinai/d/${id}` },
  { id: 'osudl', label: 'osu!dl', build: id => `https://osudl.org/s/${id}` },
];

function initMirrors() {
  if (process.env.OSU_MIRRORS) {
    try {
      const parsed = JSON.parse(process.env.OSU_MIRRORS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m, idx) => ({
          id: String(m.id || `mirror_${idx}`),
          label: String(m.label || m.id || `Зеркало ${idx + 1}`),
          build: typeof m.url === 'string' ? (id => m.url.replace('{id}', id)) : (m.build || (id => `https://osu.direct/d/${id}`)),
        }));
      }
    } catch {
      const templates = process.env.OSU_MIRRORS.split(',').map(s => s.trim()).filter(Boolean);
      if (templates.length > 0) {
        return templates.map((tmpl, idx) => {
          let host = `mirror_${idx}`;
          try { host = new URL(tmpl.replace('{id}', '1')).hostname; } catch {}
          return {
            id: `mirror_${idx}`,
            label: host,
            build: id => (tmpl.includes('{id}') ? tmpl.replace('{id}', id) : `${tmpl.replace(/\/+$/, '')}/${id}`),
          };
        });
      }
    }
  }
  return DEFAULT_MIRRORS;
}

const MIRRORS = initMirrors();
const MIRROR_COOLDOWN_DEFAULT_MS = Math.max(1000, Number(process.env.MIRROR_COOLDOWN_DEFAULT_MS ?? 60 * 1000));
const MIRROR_COOLDOWN_MAX_MS = Math.max(MIRROR_COOLDOWN_DEFAULT_MS, Number(process.env.MIRROR_COOLDOWN_MAX_MS ?? 15 * 60 * 1000));
const MIRROR_COOLDOWN_WAIT_MAX_MS = Math.max(1000, Number(process.env.MIRROR_COOLDOWN_WAIT_MAX_MS ?? 30 * 1000));
const AUTO_RESUME_GRACE_MS = 1000;
const AUTO_RESUME_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_RESUME_MAX_ATTEMPTS ?? 8));

const LOG_DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');
const ENABLE_OAUTH = /^(1|true|yes)$/i.test(process.env.ENABLE_OAUTH || '');

const CONNECT_TIMEOUT_MS = 15000;
const READ_CHUNK_TIMEOUT_MS = 30000;
const CHUNK_SIZE = 64 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const PAGE_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.PAGE_FETCH_TIMEOUT_MS ?? 20000));
const PAGINATION_PAGE_LIMIT = Math.max(1, Number(process.env.PAGINATION_PAGE_LIMIT ?? 50));
const PAGINATION_DELAY_MS = Math.max(0, Number(process.env.PAGINATION_DELAY_MS ?? 350));
const MAPSET_FETCH_BUDGET_MS = Math.max(1000, Number(process.env.MAPSET_FETCH_BUDGET_MS ?? 15000));
const COLLECTION_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

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
    /** @type {number} */
    this.httpStatus = status;
    /** @type {number} */
    this.status = status;
    /** @type {number | undefined} */
    this.upstreamStatus = undefined;
    /** @type {string | null | undefined} */
    this.oauthError = undefined;
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
  OAUTH_STATE_COOKIE,
  OAUTH_AUTHORIZE_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
  OSU_API_BASE,
  CALLBACK_URL,
  OAUTH_STATE_TTL_MS,
  MAX_BODY,
  DOWNLOAD_DELAY_MS,
  DOWNLOAD_CONCURRENCY,
  USER_AGENT,
  DEFAULT_MIRRORS,
  initMirrors,
  MIRRORS,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  LOG_DEBUG,
  ENABLE_OAUTH,
  CONNECT_TIMEOUT_MS,
  READ_CHUNK_TIMEOUT_MS,
  CHUNK_SIZE,
  REDIRECT_STATUSES,
  PAGE_FETCH_TIMEOUT_MS,
  PAGINATION_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  MAPSET_FETCH_BUDGET_MS,
  COLLECTION_CACHE_MAX_AGE_MS,
  log,
  HttpError,
  sleep,
  sleepWithSignal,
  anySignal,
  formatBytes,
  json,
};
