
"use strict";

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const ROOT = __dirname;
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const SESSION_COOKIE = 'osu_session';
const ZIP_SIGNATURES = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x50, 0x4b, 0x07, 0x08])];
const jobs = new Map();
const sessions = new Map();
const oauthConfig = { clientId: null, clientSecret: null };
const oauthToken = { accessToken: null, refreshToken: null, expiresAt: 0, scope: null, kind: null };
const oauthStates = new Map();
const tokenCookie = 'osu_collector_token';
const OAUTH_AUTHORIZE_ENDPOINT = 'https://osu.ppy.sh/oauth/authorize';
const OAUTH_TOKEN_ENDPOINT = 'https://osu.ppy.sh/oauth/token';
const OSU_API_BASE = 'https://osu.ppy.sh/api/v2';
const CALLBACK_URL = (process.env.OSU_OAUTH_CALLBACK || `http://127.0.0.1:${PORT}/oauth/callback`).replace(/\/+$/, '');
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const DOWNLOAD_DELAY_MS = 1100;
const USER_AGENT = 'osu-collector-local-downloader/1.0';
const MIRRORS = [
  { id: 'osudirect', label: 'osu.direct', build: id => `https://osu.direct/d/${id}` },
  { id: 'hinamizawa', label: 'Hinamizawa', build: id => `https://mirror.hinamizawa.ai/api/v1/hinai/d/${id}` },
  { id: 'osudl', label: 'osu!dl', build: id => `https://osudl.org/s/${id}` },
];
const MIRROR_COOLDOWN_DEFAULT_MS = 60 * 1000;
const MIRROR_COOLDOWN_MAX_MS = 15 * 60 * 1000;
const MIRROR_COOLDOWN_WAIT_MAX_MS = 30 * 1000;
const AUTO_RESUME_GRACE_MS = 1000;
const AUTO_RESUME_MAX_ATTEMPTS = 8;
const mirrorCooldowns = new Map();

const LOG_DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');

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
  constructor(status, message) {
    super(message);
    this.httpStatus = status;
    this.status = status;
  }
}

function safeErrorMessage(error) {
  let message = String(error?.message || error || 'Unknown error').replace(/[\r\n\t]/g, ' ');
  if (oauthConfig.clientSecret) message = message.split(oauthConfig.clientSecret).join('[redacted]');
  for (const secret of [oauthToken.accessToken, oauthToken.refreshToken]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  for (const entry of sessions.values()) {
    if (entry.value) message = message.split(entry.value).join('[redacted]');
  }
  return message.slice(0, 300);
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

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function ensureLocalRequest(req, res) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  const localHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
  const localOrigin = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}` || origin === `http://[::1]:${PORT}`;
  if (!localHost || !localOrigin) {
    json(res, 403, { error: 'Доступ разрешён только с этого компьютера.' });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Ожидался JSON-объект в теле запроса.');
  }
  return parsed;
}

function extractCollectionId(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Укажите ссылку на коллекцию osu!Collector.');
  if (/^\d+$/.test(value.trim())) return value.trim();
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, 'Введите URL коллекции osu!Collector или её числовой ID.');
  }
  const match = url.pathname.match(/^\/collections\/(\d+)(?:\/|$)/);
  if (url.protocol !== 'https:' || !['osucollector.com', 'www.osucollector.com'].includes(url.hostname) || !match) {
    throw new HttpError(400, 'Нужна HTTPS-ссылка формата https://osucollector.com/collections/123/name.');
  }
  return match[1];
}

// Счётчики задачи выводятся из наборов-идентификаторов: каждый набор учтён ровно один раз,
// поэтому статус/прогресс одни и те же и после возобновления, и в логах.
function jobCounters(job) {
  const downloaded = job.doneIds.size;
  const skipped = job.skipIds.size;
  let failed = 0;
  for (const id of job.errIds) {
    if (!job.doneIds.has(id) && !job.skipIds.has(id)) {
      failed += 1;
    }
  }
  failed += (job.extraFailures || 0);
  const completed = downloaded + skipped + failed;
  return {
    downloaded,
    skipped,
    failed,
    completed,
    deferred: Math.max(0, job.setIds.length - completed),
  };
}

function safeJobForClient(job) {
  const counters = jobCounters(job);
  const currentMap = job.mapsById.get(job.currentSetId);
  return {
    id: job.id,
    method: job.method,
    collectionName: job.collectionName,
    total: job.setIds.length,
    completed: counters.completed,
    downloaded: counters.downloaded,
    skipped: counters.skipped,
    failed: counters.failed,
    deferred: counters.deferred,
    currentSetId: job.currentSetId,
    currentSetName: currentMap?.label || null,
    currentMirror: job.currentMirror || null,
    autoResumeAt: job.autoResumeAt || null,
    autoResumeAttempts: job.autoResumeCount || 0,
    currentBytes: job.currentBytes,
    currentTotalBytes: job.currentTotalBytes,
    currentPercent: job.currentPercent,
    status: job.status,
    message: job.message,
    errors: Array.from(job.errorsById?.values() || []).slice(0, 300),
    mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function parseSetIds(data) {
  if (!data || !Array.isArray(data.beatmapsets)) throw new HttpError(502, 'osu!Collector вернул неожиданный формат коллекции.');
  return [...new Set(data.beatmapsets.map(set => set && set.id).filter(id => Number.isSafeInteger(id) && id > 0))];
}

function fallbackMapInfo(setIds) {
  return setIds.map(id => ({ id, label: `Набор ${id}`, title: null, artist: null, creator: null }));
}

const PAGINATION_PAGE_LIMIT = 100;

async function fetchMapsetInfo(collectionId, setIds) {
  const infoById = new Map();
  const wanted = new Set(setIds);
  if (wanted.size === 0) return [];
  let cursor = null;
  const cursors = new Set();
  let hasMore = false;

  for (let page = 0; page < PAGINATION_PAGE_LIMIT; page++) {
    const url = new URL(`https://osucollector.com/api/collections/${collectionId}/beatmapsV2`);
    url.searchParams.set('perPage', '100');
    if (cursor !== null) url.searchParams.set('cursor', String(cursor));
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, `osu!Collector beatmapsV2 ответил HTTP ${response.status}.`);
    }
    const data = await response.json();
    if (!Array.isArray(data.beatmaps)) throw new HttpError(502, 'osu!Collector вернул неожиданный формат beatmapsV2.');

    // O(1) сопоставление по Set, собранному один раз перед циклом
    for (const beatmap of data.beatmaps) {
      const id = beatmap?.beatmapset_id ?? beatmap?.beatmapset?.id;
      if (!Number.isSafeInteger(id) || !wanted.has(id) || infoById.has(id)) continue;
      const title = beatmap.beatmapset?.title || beatmap.beatmapset?.title_unicode || null;
      const artist = beatmap.beatmapset?.artist || beatmap.beatmapset?.artist_unicode || null;
      const creator = beatmap.beatmapset?.creator || null;
      const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${id}`;
      infoById.set(id, { id, label, title, artist, creator });
    }

    if (infoById.size >= wanted.size) break;

    hasMore = Boolean(data.hasMore);
    if (!data.hasMore) break;
    if (data.nextPageCursor == null || cursors.has(data.nextPageCursor)) {
      throw new HttpError(502, 'osu!Collector вернул некорректный курсор пагинации.');
    }
    cursors.add(data.nextPageCursor);
    cursor = data.nextPageCursor;
  }

  if (hasMore && infoById.size < wanted.size) {
    // Сообщаем, что длинная коллекция обрезана по лимиту страниц пагинации
    log('warn', 'collection.mapinfo.truncated', { collectionId, pages: PAGINATION_PAGE_LIMIT, named: infoById.size, totalWanted: setIds.length });
  }

  return setIds.map(id => infoById.get(id) || fallbackMapInfo([id])[0]);
}

// Короткий кеш коллекций (10 минут) с ограничением размера и защитой от сохранения деградированных данных.
const collectionCache = new Map();
const inFlightCollections = new Map();
const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_COLLECTION_CACHE_ENTRIES = 20;

function pruneCollectionCache() {
  const now = Date.now();
  for (const [id, entry] of collectionCache) {
    if (now - entry.fetchedAt > COLLECTION_CACHE_TTL_MS) {
      collectionCache.delete(id);
    }
  }
}

function setCollectionCache(collectionId, data) {
  pruneCollectionCache();
  while (collectionCache.size >= MAX_COLLECTION_CACHE_ENTRIES) {
    const oldestKey = collectionCache.keys().next().value;
    if (oldestKey === undefined) break;
    collectionCache.delete(oldestKey);
  }
  collectionCache.set(collectionId, { data, fetchedAt: Date.now() });
}

async function fetchCollection(collectionId) {
  const cached = collectionCache.get(collectionId);
  if (cached && Date.now() - cached.fetchedAt < COLLECTION_CACHE_TTL_MS) {
    // Обновляем порядок использования в LRU-кеше
    collectionCache.delete(collectionId);
    collectionCache.set(collectionId, cached);
    log('info', 'collection.cache.hit', { collectionId, ageMs: Date.now() - cached.fetchedAt });
    return cached.data;
  }
  if (cached) collectionCache.delete(collectionId);

  if (inFlightCollections.has(collectionId)) {
    log('info', 'collection.fetch.inflight_join', { collectionId });
    return inFlightCollections.get(collectionId);
  }

  const fetchPromise = (async () => {
    const startedAt = Date.now();
    log('info', 'collection.fetch.started', { collectionId });
    try {
      const response = await fetch(`https://osucollector.com/api/collections/${collectionId}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status === 404 ? 404 : 502, `osu!Collector ответил HTTP ${response.status}.`);
      }
      const data = await response.json();
      const setIds = parseSetIds(data);
      if (Array.isArray(data.beatmapsets) && setIds.length < data.beatmapsets.length) {
        log('info', 'collection.mapinfo.deduplicated', { collectionId, totalInCollection: data.beatmapsets.length, uniqueSets: setIds.length });
      } else if (typeof data.beatmapCount === 'number' && data.beatmapCount > 0 && setIds.length === 0) {
        log('warn', 'collection.mapinfo.empty', { collectionId, beatmapCount: data.beatmapCount });
      }

      let namesFetched = false;
      try {
        data.maps = await fetchMapsetInfo(collectionId, setIds);
        namesFetched = true;
      } catch (error) {
        log('warn', 'collection.map_names.unavailable', { collectionId, error: safeErrorMessage(error) });
        data.maps = fallbackMapInfo(setIds);
      }

      log('info', 'collection.fetch.succeeded', { collectionId, setCount: setIds.length, namedSetCount: data.maps.filter(map => map.title || map.artist).length, durationMs: Date.now() - startedAt });
      // Сохраняем в кеш только полноценные данные с названиями, чтобы не блокировать получение названий при временных сбоях
      if (namesFetched) {
        setCollectionCache(collectionId, data);
      }
      return data;
    } catch (error) {
      log('error', 'collection.fetch.failed', { collectionId, durationMs: Date.now() - startedAt, error: safeErrorMessage(error) });
      throw error;
    }
  })();

  inFlightCollections.set(collectionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightCollections.delete(collectionId);
  }
}

function redirectHostAllowed(url) {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host === 'ppy.sh' || host.endsWith('.ppy.sh'));
}

function mirrorRedirectAllowed(url) {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IP literal hosts (including private ranges) are refused: a mirror must redirect to a public hostname.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return false;
  return true;
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

class OAuthDownloadScopeError extends Error {}

class MirrorTransientError extends Error {
  constructor(mirror, message) {
    super(message || `HTTP 5xx от ${mirror.label}.`);
    this.mirror = mirror;
  }
}

class MirrorRateLimitError extends Error {
  constructor(mirror, retryAfterMs) {
    super(`HTTP 429 от ${mirror.label}: временное ограничение загрузок.`);
    this.mirror = mirror;
    this.retryAfterMs = retryAfterMs;
  }
}

function isTransientError(error) {
  if (!error) return false;
  if (error.isMissing || error instanceof MirrorRateLimitError || error instanceof OAuthDownloadScopeError) return false;
  if (error instanceof MirrorTransientError || error instanceof BodyStalledError) return true;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MIRROR_COOLDOWN_MAX_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), MIRROR_COOLDOWN_MAX_MS);
}

function mirrorCooldownRemaining(mirror) {
  const until = mirrorCooldowns.get(mirror.id) || 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    if (until) mirrorCooldowns.delete(mirror.id);
    return 0;
  }
  return remaining;
}

// Ближайшее освобождение зеркал: 0, если хотя бы одно зеркало уже доступно.
function mirrorResumeWaitMs() {
  const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
  return cooldowns.length ? Math.min(...cooldowns) : 0;
}

function clearAutoResume(job) {
  if (job.autoResumeTimer) clearTimeout(job.autoResumeTimer);
  job.autoResumeTimer = null;
  job.autoResumeAt = null;
}

function launchJob(job, auth) {
  runJob(job, auth).catch(error => {
    log('error', 'download.job.unhandled_rejection', { jobId: job?.id, error: safeErrorMessage(error), stack: error?.stack });
    if (job) {
      if (!['finished', 'finished_with_errors', 'cancelled', 'paused'].includes(job.status)) {
        job.status = 'finished_with_errors';
      }
      job.finishedAt = Date.now();
      delete job.pausedAt;
      job.message = `Критический сбой задачи: ${safeErrorMessage(error)}`;
      job.errorsById?.set('fatal', {
        id: 'fatal',
        name: 'Системный сбой',
        error: safeErrorMessage(error),
      });
    }
    if (activeJob === job) {
      activeJob = null;
    }
  });
}

function resumeJob(job, auth, trigger = 'manual') {
  clearAutoResume(job);
  if (activeJob && activeJob !== job && ['queued', 'running'].includes(activeJob.status)) {
    log('warn', 'download.job.resume_conflict', { jobId: job.id, activeJobId: activeJob.id });
    return;
  }
  activeJob = job;
  job.status = 'queued';
  // doneIds/skipIds/errIds не сбрасываются: прогресс продолжает накапливаться, а готовые файлы пропускаются.
  job.extraFailures = 0;
  job.currentBytes = 0;
  job.currentTotalBytes = null;
  job.currentPercent = 0;
  job.currentSetId = null;
  job.currentMirror = null;
  job.abortController = null;
  job.message = trigger === 'auto' ? 'Пауза зеркал закончилась — продолжаю загрузку.' : 'Продолжение загрузки…';
  delete job.finishedAt;
  log('info', trigger === 'auto' ? 'download.job.auto_resumed' : 'download.job.resumed', {
    jobId: job.id,
    method: job.method,
    total: job.setIds.length,
    attempt: job.autoResumeCount || 0,
  });
  launchJob(job, auth);
}

// Приостановленную из-за лимитов зеркал задачу возобновляем сами, когда остынет ближайшее зеркало.
function scheduleAutoResume(job) {
  clearAutoResume(job);
  if (job.method !== 'mirror' || job.status !== 'paused') return;
  if ((job.autoResumeCount || 0) >= AUTO_RESUME_MAX_ATTEMPTS) {
    log('warn', 'download.job.auto_resume.exhausted', { jobId: job.id, attempts: job.autoResumeCount, total: job.setIds.length });
    return;
  }
  const waitMs = mirrorResumeWaitMs();
  const delayMs = (waitMs > 0 ? waitMs : 1000) + AUTO_RESUME_GRACE_MS;
  job.autoResumeAt = Date.now() + delayMs;
  job.autoResumeTimer = setTimeout(() => {
    job.autoResumeTimer = null;
    job.autoResumeAt = null;
    if (job.status !== 'paused') return;
    if (activeJob && activeJob !== job && ['queued', 'running'].includes(activeJob.status)) {
      log('warn', 'download.job.auto_resume.aborted_active_job', { jobId: job.id, activeJobId: activeJob.id });
      return;
    }
    if (mirrorResumeWaitMs() > 0) {
      scheduleAutoResume(job);
      return;
    }
    job.autoResumeCount = (job.autoResumeCount || 0) + 1;
    log('info', 'download.job.auto_resume', { jobId: job.id, inMs: delayMs, attempt: job.autoResumeCount });
    resumeJob(job, { kind: 'mirror' }, 'auto');
  }, delayMs);
  log('info', 'download.job.auto_resume.scheduled', { jobId: job.id, inMs: delayMs, attempt: (job.autoResumeCount || 0) + 1, waitMs });
}

function authHeaders(auth, requestUrl, referer) {
  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' };
  if (referer && auth.kind !== 'mirror') headers.Referer = referer;
  const host = new URL(requestUrl).hostname;
  if (host === 'osu.ppy.sh' && auth.kind === 'session') {
    headers.Cookie = `${SESSION_COOKIE}=${auth.session}`;
  } else if (host === 'osu.ppy.sh' && auth.kind === 'oauth' && auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  return headers;
}

let activeJob = null; // Одна активная задача на процесс — иначе удваиваются лимиты и риск 429 на зеркалах.

function partPath(jobId, setId) {
  return path.join(DOWNLOADS_DIR, `${setId}.${jobId}.part`);
}

function jobFilePath(setId) {
  return path.join(DOWNLOADS_DIR, `${setId}.osz`);
}

// Очистка .part-файлов конкретной задачи (по id в имени) — при завершении, отмене и на SIGINT.
async function cleanupJobPartFiles(job) {
  const marker = `.${job.id}.part`;
  try {
    const entries = await fs.promises.readdir(DOWNLOADS_DIR);
    for (const entry of entries) {
      if (entry.endsWith(marker)) {
        await fs.promises.rm(path.join(DOWNLOADS_DIR, entry), { force: true });
        log('debug', 'downloads.part_cleanup', { jobId: job.id, file: entry });
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', 'downloads.part_cleanup.failed', { jobId: job.id, error: safeErrorMessage(error) });
  }
}

// .part-файлы пережитка процесса ничего не доканчены — чистим их при старте и по завершении задачи.
async function cleanupStalePartFiles() {
  try {
    const entries = await fs.promises.readdir(DOWNLOADS_DIR);
    for (const entry of entries) {
      if (entry.endsWith('.part')) {
        await fs.promises.rm(path.join(DOWNLOADS_DIR, entry), { force: true });
        log('debug', 'downloads.part_cleanup', { file: entry });
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', 'downloads.part_cleanup.failed', { error: safeErrorMessage(error) });
  }
}

// Проверка свободного места перед стартом: крупные коллекции весят десятки ГБ.
async function ensureDiskSpace(reserveBytes) {
  const minimumBytes = Math.max(Number(reserveBytes) || 0, 0) + 100 * 1024 * 1024; // запас 100 МБ
  try {
    // Гарантируем наличие папки downloads, чтобы statfs не падал с ENOENT на первом запуске проекта
    await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
    let stats;
    try {
      stats = await fs.promises.statfs(DOWNLOADS_DIR);
    } catch {
      stats = await fs.promises.statfs(ROOT);
    }
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(freeBytes) && freeBytes < minimumBytes) {
      throw new HttpError(507, `На диске мало места: свободно ${formatBytes(freeBytes)}, нужно хотя бы ${formatBytes(minimumBytes)}.`);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // statfs может не поддерживаться на некоторых ФС — не блокируем загрузку, только лог.
    log('warn', 'downloads.disk_space.check_failed', { error: safeErrorMessage(error) });
  }
}

// Оценка требуемого места с учётом уже скачанных файлов (чтобы не требовать место под 4000 уже существующих файлов)
async function estimateRequiredDiskSpace(setIds) {
  let missingCount = 0;
  for (const id of setIds) {
    try {
      const stat = await fs.promises.stat(jobFilePath(id));
      if (stat.size <= 0) missingCount++;
    } catch {
      missingCount++;
    }
  }
  return missingCount * 10 * 1024 * 1024; // ~10 МБ на отсутствующий набор
}

function isNoSpaceError(error) {
  if (!error) return false;
  if (error.code === 'ENOSPC' || error.cause?.code === 'ENOSPC') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('enospc') || msg.includes('no space left on device') || msg.includes('на диске мало места') || msg.includes('диск переполнен') || msg.includes('недостаточно места');
}

// Таймаут без данных (нет ни байта за N секунд) — отличаем зависшее соединение от медленного, но живого.
const CONNECT_TIMEOUT_MS = 60 * 1000;   // соединение, заголовки, редиректы и каждый запрос токена
const BODY_STALL_TIMEOUT_MS = 90 * 1000; // «замолчал» во время передачи тела

class BodyStalledError extends Error {}

async function readChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BodyStalledError(`Нет данных от сервера дольше, чем ${Math.round(timeoutMs / 1000)} с — соединение зависло.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyZipFile(handle, totalSize) {
  if (totalSize < 22) return false;
  const readSize = Math.min(totalSize, 65557);
  const buffer = Buffer.alloc(readSize);
  const position = totalSize - readSize;
  const { bytesRead } = await handle.read(buffer, 0, readSize, position);
  if (bytesRead < 22) return false;
  const slice = buffer.subarray(0, bytesRead);
  for (let i = slice.length - 22; i >= 0; i--) {
    if (slice[i] === 0x50 && slice[i + 1] === 0x4b && slice[i + 2] === 0x05 && slice[i + 3] === 0x06) {
      const commentLen = slice.readUInt16LE(i + 20);
      // EOCD может иметь хвостовой паддинг (выравнивание секторов, оверлеи)
      if (i + 22 + commentLen <= slice.length) {
        return true;
      }
    }
    // Проверяем ZIP64 locator (0x50, 0x4b, 0x06, 0x07) или ZIP64 EOCD record (0x50, 0x4b, 0x06, 0x06)
    if (slice[i] === 0x50 && slice[i + 1] === 0x4b && slice[i + 2] === 0x06 && (slice[i + 3] === 0x06 || slice[i + 3] === 0x07)) {
      return true;
    }
  }
  return false;
}

async function isValidZipOnDisk(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    return await verifyZipFile(handle, stat.size);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function streamBodyToFile(reader, firstChunk, tempPath, job, expectedBytes, readTimeoutMs) {
  let handle;
  try {
    handle = await fs.promises.open(tempPath, 'wx+');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      try {
        handle = await fs.promises.open(tempPath, 'wx+');
      } catch (retryError) {
        throw new HttpError(500, `Не удалось создать временный файл: ${safeErrorMessage(retryError)}`);
      }
    } else if (error?.code === 'EEXIST') {
      throw new Error('Временный файл уже существует.');
    } else {
      throw error;
    }
  }
  let received = 0;
  try {
    // Через первый чанк образец: буфер данных -> поток -> файл. далее следующий read начинаем только после записи
    // предыдущего (естественный backpressure на socket), а в памяти держим один-два чанка.
    let chunk = firstChunk || null; // первый чанк уже прочитан ради проверки сигнатуры ZIP
    for (;;) {
      if (!chunk) {
        const next = await readChunkWithTimeout(reader, readTimeoutMs);
        if (next.done) break;
        chunk = next.value;
      }
      received += chunk.byteLength;
      if (Number.isSafeInteger(expectedBytes) && received > expectedBytes) {
        throw new Error(`Сервер отдал больше, чем обещал в Content-Length (${formatBytes(expectedBytes)}).`);
      }
      job.currentBytes = received;
      job.currentPercent = job.currentTotalBytes ? Math.min(100, Math.floor(received / job.currentTotalBytes * 100)) : null;
      await handle.write(chunk);
      chunk = null;
    }
    if (Number.isSafeInteger(expectedBytes) && received !== expectedBytes) {
      throw new Error(`Файл усечён на стороне зеркала: получено ${formatBytes(received)} из обещанных ${formatBytes(expectedBytes)}.`);
    }
    if (!received) throw new Error('Тело ответа пустое.');
    const validZip = await verifyZipFile(handle, received);
    if (!validZip) {
      throw new Error('Файл усечён: отсутствует сигнатура окончания ZIP-архива (EOCD). Возможно, соединение оборвалось.');
    }
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
  return received;
}

async function downloadSet(setId, auth, job) {
  const referer = `https://osu.ppy.sh/beatmapsets/${setId}`;
  let url = auth.kind === 'oauth'
    ? `${OSU_API_BASE}/beatmapsets/${setId}/download?noVideo=1`
    : auth.kind === 'mirror'
      ? auth.mirror.build(setId)
      : `https://osu.ppy.sh/beatmapsets/${setId}/download`;
  const tempPath = partPath(job.id, setId);
  const finalPath = jobFilePath(setId);
  log('info', 'map.download.started', { jobId: job.id, beatmapsetId: setId, method: auth.kind, mirror: auth.mirror?.id || null });

  let response;
  for (let redirectCount = 0; redirectCount <= 8; redirectCount++) {
    // Свежий таймаут на соединение и заголовки для каждого запроса в цепочке: длинная передача тела в него не входит.
    const connect = new AbortController();
    const connectTimer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        redirect: 'manual',
        headers: authHeaders(auth, url, referer),
        signal: job.abortController ? anySignal([job.abortController.signal, connect.signal]) : connect.signal,
      });
    } catch (error) {
      if (connect.signal.aborted) {
        const timeoutError = new Error(`Соединение не установлено за ${Math.round(CONNECT_TIMEOUT_MS / 1000)} с.`);
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }
      if (job.status === 'cancelled') return;
      throw error;
    } finally {
      clearTimeout(connectTimer); // после получения headers таймаут не должен убивать длинную передачу
    }
    if (!REDIRECT_STATUSES.includes(response.status)) break;
    const location = response.headers.get('location');
    // Освобождаем тело промежуточного ответа перед переходом по редиректу,
    // чтобы undici мог вернуть сокет в пул keep-alive и не удерживал соединение открытым.
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error('Сервер загрузки вернул пустое перенаправление.');
    const nextUrl = new URL(location, url);
    if (!(auth.kind === 'mirror' ? mirrorRedirectAllowed(nextUrl) : redirectHostAllowed(nextUrl))) {
      throw new Error(auth.kind === 'mirror' ? `Зеркало перенаправило на небезопасный URL (${nextUrl.hostname}).` : `osu! вернул небезопасный URL загрузки (${nextUrl.hostname}).`);
    }
    log('debug', 'map.download.redirected', { jobId: job.id, beatmapsetId: setId, status: response.status, host: nextUrl.hostname });
    url = nextUrl.href;
  }
  if (!response || REDIRECT_STATUSES.includes(response.status)) {
    await response?.body?.cancel().catch(() => {});
    throw new Error('Слишком много перенаправлений загрузки.');
  }
  if (!response.ok || !response.body) {
    const detail = await responsePreview(response);
    if (auth.kind === 'mirror') {
      if (response.status === 429) {
        throw new MirrorRateLimitError(auth.mirror, parseRetryAfter(response.headers.get('retry-after')) ?? MIRROR_COOLDOWN_DEFAULT_MS);
      }
      if (response.status >= 500 || response.status === 408 || response.status === 425) {
        throw new MirrorTransientError(auth.mirror, `HTTP ${response.status} от ${auth.mirror.label}.`);
      }
      const missing = response.status === 404 || response.status === 410;
      const error = new Error(`HTTP ${response.status} от ${auth.mirror.label}${missing ? ' (набора там нет)' : ''}. ${detail}`.trim());
      if (missing) error.isMissing = true; // окончательный «нет на зеркале», не транзиентный сбой
      throw error;
    }
    if (auth.kind === 'oauth' && response.status === 403) {
      if (/invalid scope\(s\) provided/i.test(detail)) {
        throw new OAuthDownloadScopeError('osu! отклонил API-загрузку: обычному OAuth-приложению не выдан нужный scope. Загрузка остановлена; выберите способ «Cookie osu_session». Добавлять scope lazer или * не нужно — osu! не предлагает их для обычных OAuth-приложений.');
      }
      throw new HttpError(502, `HTTP 403: osu! ограничивает API-загрузку клиентом lazer; обычные OAuth-приложения не имеют доступа. ${detail}`.trim());
    }
    if (auth.kind === 'oauth' && response.status === 401) {
      throw new HttpError(401, `HTTP 401: osu! отклонил OAuth-токен; войдите через osu! повторно. ${detail}`.trim());
    }
    if (response.status === 429) throw new HttpError(429, 'osu! временно ограничил загрузки — попробуйте позже.');
    throw new HttpError(502, `osu! ответил HTTP ${response.status}. ${detail}`.trim());
  }
  log('debug', 'map.download.response.received', { jobId: job.id, beatmapsetId: setId, status: response.status, contentType: response.headers.get('content-type') || 'unknown' });

  const contentEncoding = (response.headers.get('content-encoding') || '').toLowerCase().trim();
  const isEncoded = contentEncoding.length > 0 && contentEncoding !== 'identity';
  const contentLength = Number(response.headers.get('content-length'));
  const expectedBytes = !isEncoded && Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
  job.currentTotalBytes = expectedBytes;
  job.currentBytes = 0;
  job.currentPercent = expectedBytes ? 0 : null;
  const reader = response.body.getReader();
  let first;
  try {
    first = await readChunkWithTimeout(reader, BODY_STALL_TIMEOUT_MS);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (first.done || !ZIP_SIGNATURES.some(signature => Buffer.from(first.value.subarray(0, signature.length)).equals(signature))) {
    await reader.cancel().catch(() => {});
    const where = auth.kind === 'oauth' ? 'OAuth-токен' : auth.kind === 'mirror' ? `зеркало ${auth.mirror.label}` : 'сессия osu!';
    throw new Error(`Ответ не является .osz: вместо файла пришла другая страница (${where}). Возможно, авторизация устарела.`);
  }

  if (job.status === 'cancelled') {
    await reader.cancel().catch(() => {});
    return;
  }
  try {
    const received = await streamBodyToFile(reader, first.value, tempPath, job, expectedBytes, BODY_STALL_TIMEOUT_MS);
    await fs.promises.rename(tempPath, finalPath);
    job.doneIds.add(setId);
    job.errIds.delete(setId);
    job.errorsById?.delete(setId);
    job.currentPercent = 100;
    log('info', 'map.download.succeeded', { jobId: job.id, beatmapsetId: setId, sizeBytes: received, expectedBytes, file: path.relative(ROOT, finalPath) });
  } catch (error) {
    await reader.cancel().catch(() => {}); // закрываем сокет при любой ошибке (ENOSPC, EIO, BodyStalled)
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const MIRROR_TRANSIENT_RETRIES = 2;

async function downloadFromMirrors(setId, job) {
  const failures = new Map();
  let rateLimited = 0;   // сколько зеркал остудились 429 в этом проходе
  let transientRetries = 0;
  const missingMirrors = new Set();
  const transientMirrors = new Set();

  for (let attempt = 0; attempt < 3; attempt++) {
    transientMirrors.clear();

    for (const mirror of MIRRORS) {
      if (job.status === 'cancelled') return;
      if (missingMirrors.has(mirror.id)) {
        // Набора на этом зеркале точно нет (404/410) — повторно не запрашиваем
        continue;
      }
      const cooldown = mirrorCooldownRemaining(mirror);
      if (cooldown > 0) {
        log('debug', 'map.download.mirror.skipped_cooldown', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, cooldownMs: cooldown });
        continue;
      }
      job.currentMirror = mirror.label;
      job.currentBytes = 0;
      job.currentTotalBytes = null;
      job.currentPercent = 0;
      try {
        await downloadSet(setId, { kind: 'mirror', mirror }, job);
        return;
      } catch (error) {
        job.currentBytes = 0;
        job.currentTotalBytes = null;
        job.currentPercent = 0;
        if (job.status === 'cancelled') return;
        if (error instanceof MirrorRateLimitError) {
          // 429 — аварька зеркала, не ошибка набора: зеркало остывает и не блокирует остальную коллекцию.
          mirrorCooldowns.set(mirror.id, Date.now() + error.retryAfterMs);
          rateLimited += 1;
          log('warn', 'map.download.mirror.cooldown', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, cooldownMs: error.retryAfterMs });
          continue;
        }
        if (error.isMissing) {
          missingMirrors.add(mirror.id);
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
          log('debug', 'map.download.mirror.missing', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
          continue;
        }
        if (isTransientError(error)) {
          transientMirrors.add(mirror.id);
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
          log('warn', 'map.download.mirror.transient', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
          continue;
        }
        failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
        log('warn', 'map.download.mirror.failed', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
      }
    }

    // Если все зеркала ответили 404 (набора нет нигде) — не ждём и не повторяем!
    if (missingMirrors.size === MIRRORS.length) break;

    // Повторяем только если были временные сбои (5xx, сеть) и не все зеркала на кулдауне
    const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
    const hasTransient = transientMirrors.size > 0;
    if (!hasTransient || cooldowns.length === MIRRORS.length || transientRetries >= MIRROR_TRANSIENT_RETRIES) {
      break;
    }

    // Backoff: 1.5 с → 3 с.
    transientRetries += 1;
    const backoffMs = 1500 * transientRetries;
    job.message = `Зеркала отдали временные ошибки — жду ${Math.ceil(backoffMs / 1000)} с и пробую ещё раз.`;
    log('info', 'map.download.transient.wait', { jobId: job.id, beatmapsetId: setId, backoffMs, attempt: transientRetries });
    await sleep(backoffMs);
    if (job.status === 'cancelled') return;
  }

  let cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);

  // Если ВСЕ зеркала сейчас на кулдауне — ждём освобождения ближайшего (до MIRROR_COOLDOWN_WAIT_MAX_MS) и повторяем
  if (cooldowns.length === MIRRORS.length) {
    const waitMs = Math.min(...cooldowns);
    if (waitMs > 0 && waitMs <= MIRROR_COOLDOWN_WAIT_MAX_MS) {
      log('info', 'map.download.all_mirrors_cooldown.wait', { jobId: job.id, beatmapsetId: setId, waitMs });
      job.message = `Все зеркала на паузе — жду ${Math.ceil(waitMs / 1000)} с…`;
      await sleep(waitMs + 500);
      if (job.status === 'cancelled') return;
      for (const mirror of MIRRORS) {
        if (job.status === 'cancelled') return;
        if (missingMirrors.has(mirror.id)) continue;
        if (mirrorCooldownRemaining(mirror) > 0) continue;
        job.currentMirror = mirror.label;
        job.currentBytes = 0;
        job.currentTotalBytes = null;
        job.currentPercent = 0;
        try {
          await downloadSet(setId, { kind: 'mirror', mirror }, job);
          return;
        } catch (error) {
          job.currentBytes = 0;
          job.currentTotalBytes = null;
          job.currentPercent = 0;
          if (job.status === 'cancelled') return;
          if (error instanceof MirrorRateLimitError) {
            mirrorCooldowns.set(mirror.id, Date.now() + error.retryAfterMs);
            continue;
          }
          if (error.isMissing) {
            missingMirrors.add(mirror.id);
          }
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
        }
      }
    }
  }

  cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
  const allCooldown = cooldowns.length === MIRRORS.length;
  const allMissing = missingMirrors.size === MIRRORS.length;

  if (allCooldown) {
    const error = new Error('Все зеркала временно ограничили загрузки (HTTP 429).');
    error.allCooldown = true;
    error.retryLater = true;
    throw error;
  }

  if (cooldowns.length > 0 && !allMissing) {
    // Часть зеркал остывает — откладываем этот набор в конец очереди, не блокируя остальные наборы
    const error = new Error(`зеркало(а) остывают/отдают 429 — набор отложен: ${[...failures.values()].filter(Boolean).join('; ') || 'зеркала остывали'}`);
    error.deferSet = true;
    throw error;
  }
  const detail = [...failures.values()].filter(Boolean).join('; ');
  if (!detail) {
    const error = new Error('ни одно зеркало не ответило (все на cooldown) — набор отложен');
    error.allCooldown = true;
    error.retryLater = true;
    throw error;
  }
  if (allMissing) {
    throw new Error(`набора нет ни на одном зеркале (404): ${detail}`);
  }
  throw new Error(`ни одно зеркало не отдало файл — ${detail}${rateLimited ? '; часть зеркал ограничила загрузки (HTTP 429)' : ''}`);
}

async function runJob(job, auth) {
  activeJob = job;
  try {
  job.status = 'running';
  if (auth.kind === 'oauth') {
    try {
      auth.token = await ensureOsuToken();
    } catch (error) {
      job.extraFailures += 1;
      job.status = 'finished_with_errors';
      const errMessage = safeErrorMessage(error);
      job.message = errMessage;
      job.errorsById?.set('oauth', {
        id: 'oauth',
        name: 'OAuth авторизация',
        error: errMessage,
      });
      job.finishedAt = Date.now();
      log('error', 'download.job.finished', { jobId: job.id, status: job.status, stage: 'oauth_token', error: errMessage });
      return;
    }
  }
  job.message = auth.kind === 'mirror' ? 'Загрузка через зеркала началась.' : 'Загрузка началась.';
  job.currentMirror = null;
  let lastRequest = 0;
  let stopAfterCurrent = false;
  let stopForCooldown = false;
  let stopForNoSpace = false;
  const deferredSetIds = new Set();
  for (const setId of job.setIds) {
    if (job.status === 'cancelled') break;
    if (job.doneIds.has(setId) || job.skipIds.has(setId)) continue; // уже учтён, не дублируем
    const filePath = jobFilePath(setId);
    try {
      const existing = await fs.promises.stat(filePath);
      if (existing.size > 0) {
        const isComplete = await isValidZipOnDisk(filePath);
        if (isComplete) {
          job.currentSetId = setId;
          job.currentBytes = existing.size;
          job.currentTotalBytes = existing.size;
          job.currentPercent = 100;
          job.skipIds.add(setId);
          job.errIds.delete(setId);
          job.errorsById?.delete(setId);
          log('info', 'map.download.skipped', { jobId: job.id, beatmapsetId: setId, reason: 'file already exists', sizeBytes: existing.size });
          continue;
        } else {
          // Не удаляем файл заранее: он может быть валидным (с нестандартным хвостом/ZIP64) или положен вручную.
          // Если загрузка замены в .part пройдёт успешно, он будет атомарно заменён через fs.promises.rename.
          // Если загрузка сорвётся (404/кулдаун/сеть), локальный файл пользователя не будет уничтожен.
          log('warn', 'map.download.existing_file_unverified', { jobId: job.id, beatmapsetId: setId, file: path.basename(filePath), sizeBytes: existing.size });
        }
      }
    } catch {}

    const delay = DOWNLOAD_DELAY_MS - (Date.now() - lastRequest);
    if (lastRequest && delay > 0) await sleep(delay);
    if (job.status === 'cancelled') break;
    job.currentSetId = setId;
    job.currentBytes = 0;
    job.currentTotalBytes = null;
    job.currentPercent = 0;
    job.abortController = new AbortController();
    try {
      if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
      if (auth.kind === 'mirror') await downloadFromMirrors(setId, job);
      else await downloadSet(setId, auth, job);
    } catch (error) {
      if (job.status !== 'cancelled') {
        if (isNoSpaceError(error)) {
          job.message = `Набор ${setId}: на диске закончилось свободное место (ENOSPC). Загрузка приостановлена — освободите место и нажмите «Продолжить».`;
          stopForNoSpace = true;
          log('error', 'download.job.enospc', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
        } else if (error.allCooldown) {
          job.message = `Все зеркала временно ограничили загрузки (HTTP 429). Загрузка приостановлена — повторите позже, готовые файлы будут пропущены.`;
          stopForCooldown = true;
          log('warn', 'download.job.all_cooldown', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
        } else if (error.deferSet) {
          deferredSetIds.add(setId);
          job.message = `Набор ${setId}: часть зеркал остывает — откладываю набор в конец очереди.`;
          log('info', 'download.job.set_deferred', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
        } else {
          job.errIds.add(setId);
          const errMessage = safeErrorMessage(error);
          job.message = `Набор ${setId}: ${errMessage}`;
          job.errorsById?.set(setId, {
            id: setId,
            name: job.mapsById.get(setId)?.label || `Набор ${setId}`,
            error: errMessage,
          });
          if (error instanceof OAuthDownloadScopeError) stopAfterCurrent = true;
          log('error', 'map.download.failed', { jobId: job.id, beatmapsetId: setId, error: errMessage });
        }
      }
    } finally {
      job.abortController = null;
    }
    lastRequest = Date.now();
    if (job.status === 'cancelled') break;
    if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;
  }

  // Второй проход: пробуем заново наборы, которые были отложены из-за остывания зеркал
  if (job.status !== 'cancelled' && !stopAfterCurrent && !stopForCooldown && !stopForNoSpace && deferredSetIds.size > 0) {
    log('info', 'download.job.retry_deferred_started', { jobId: job.id, count: deferredSetIds.size });
    for (const setId of deferredSetIds) {
      if (job.status === 'cancelled') break;
      if (job.doneIds.has(setId) || job.skipIds.has(setId)) continue;
      const delay = DOWNLOAD_DELAY_MS - (Date.now() - lastRequest);
      if (lastRequest && delay > 0) await sleep(delay);
      if (job.status === 'cancelled') break;
      job.currentSetId = setId;
      job.currentBytes = 0;
      job.currentTotalBytes = null;
      job.currentPercent = 0;
      job.abortController = new AbortController();
      try {
        if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
        if (auth.kind === 'mirror') await downloadFromMirrors(setId, job);
        else await downloadSet(setId, auth, job);
        deferredSetIds.delete(setId);
      } catch (error) {
        if (job.status !== 'cancelled') {
          if (isNoSpaceError(error)) {
            job.message = `Набор ${setId}: на диске закончилось свободное место (ENOSPC). Загрузка приостановлена — освободите место и нажмите «Продолжить».`;
            stopForNoSpace = true;
            log('error', 'download.job.enospc', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
            break;
          } else if (error.allCooldown || error.deferSet) {
            job.message = `Набор ${setId}: зеркала остывают — загрузка приостановлена.`;
            stopForCooldown = true;
            log('warn', 'download.job.deferred_final_pause', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
            break;
          } else {
            job.errIds.add(setId);
            deferredSetIds.delete(setId);
            const errMessage = safeErrorMessage(error);
            job.message = `Набор ${setId}: ${errMessage}`;
            job.errorsById?.set(setId, {
              id: setId,
              name: job.mapsById.get(setId)?.label || `Набор ${setId}`,
              error: errMessage,
            });
            if (error instanceof OAuthDownloadScopeError) { stopAfterCurrent = true; break; }
            log('error', 'map.download.failed', { jobId: job.id, beatmapsetId: setId, error: errMessage });
          }
        }
      } finally {
        job.abortController = null;
      }
      lastRequest = Date.now();
      if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;
    }
  }
  const counters = jobCounters(job);
  if (job.status !== 'cancelled') {
    if (counters.deferred && !stopAfterCurrent) {
      job.status = 'paused';
      const processed = counters.downloaded + counters.skipped;
      const failedNote = counters.failed ? `, с ошибками: ${counters.failed}` : '';
      if (stopForNoSpace) {
        job.message = `На диске закончилось свободное место — получено ${processed} из ${job.setIds.length}${failedNote}. Освободите место на диске и нажмите «Продолжить».`;
        clearAutoResume(job);
      } else {
        job.message = `Зеркала временно ограничили загрузки — получено ${processed} из ${job.setIds.length}${failedNote}.`;
        scheduleAutoResume(job);
        if (job.autoResumeAt) job.message += ' Загрузка продолжится автоматически после паузы зеркал, готовые файлы будут пропущены.';
        else job.message += ' Нажмите «Продолжить», когда пауза зеркал закончится: готовые файлы будут пропущены.';
      }
    } else if (counters.failed) {
      job.status = 'finished_with_errors';
      job.message = `Готово с ошибками: ${counters.failed} из ${job.setIds.length}.${counters.deferred ? ' Часть наборов отложена — нажмите «Продолжить» позже.' : ''}`;
    } else {
      job.status = 'finished';
      job.message = 'Все доступные наборы загружены.';
    }
  }
  job.currentSetId = null;
  job.currentMirror = null;
  if (job.status === 'paused') {
    job.pausedAt = Date.now();
    delete job.finishedAt;
  } else {
    job.finishedAt = Date.now();
    delete job.pausedAt;
  }
  log(job.status === 'finished' ? 'info' : job.status === 'paused' || job.status === 'cancelled' ? 'warn' : 'error', 'download.job.finished', {
    jobId: job.id,
    status: job.status,
    total: job.setIds.length,
    ...counters,
  });
  } catch (fatalError) {
    job.status = 'finished_with_errors';
    const errMessage = safeErrorMessage(fatalError);
    job.message = `Критический сбой задачи: ${errMessage}`;
    job.errorsById?.set('fatal', {
      id: 'fatal',
      name: 'Системный сбой',
      error: errMessage,
    });
    job.finishedAt = Date.now();
    delete job.pausedAt;
    log('error', 'download.job.fatal_error', { jobId: job.id, error: errMessage, stack: fatalError?.stack });
  } finally {
    job.currentSetId = null;
    job.currentMirror = null;
    job.abortController = null;
    await cleanupJobPartFiles(job).catch(() => {});
    if (activeJob === job && !['queued', 'running', 'paused'].includes(job.status)) {
      activeJob = null;
    }
  }
}

function cookieOptions(req, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function setTokenCookie(res, req, token) {
  res.setHeader('Set-Cookie', `${tokenCookie}=${token}; ${cookieOptions(req, 60 * 60 * 6)}`);
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[tokenCookie];
  const entry = token ? sessions.get(token) : null;
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return entry.value;
}

function oauthConfigured() {
  return Boolean(oauthConfig.clientId && oauthConfig.clientSecret);
}

function buildAuthorizeUrl(state) {
  const url = new URL(OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', String(oauthConfig.clientId));
  url.searchParams.set('redirect_uri', CALLBACK_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'public identify');
  if (state) url.searchParams.set('state', state);
  return url.href;
}

function oauthStatus() {
  const connected = Boolean((oauthToken.accessToken && oauthToken.expiresAt > Date.now()) || oauthToken.refreshToken);
  return {
    configured: oauthConfigured(),
    connected,
    kind: oauthToken.kind,
    scope: oauthToken.scope,
    expiresAt: connected ? oauthToken.expiresAt : null,
    clientId: oauthConfig.clientId,
    callbackUrl: CALLBACK_URL,
    authorizeUrl: oauthConfigured() ? buildAuthorizeUrl() : null,
  };
}

function clientIdPayload() {
  const numeric = Number(oauthConfig.clientId);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : oauthConfig.clientId;
}

function storeOsuToken(data, kind) {
  const expiresInSeconds = Number(data.expires_in);
  oauthToken.accessToken = data.access_token;
  oauthToken.refreshToken = data.refresh_token || null;
  oauthToken.scope = typeof data.scope === 'string' ? data.scope : null;
  oauthToken.kind = kind;
  oauthToken.expiresAt = Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600) * 1000;
}

async function postOsuToken(payload, event, kind) {
  const startedAt = Date.now();
  const form = new URLSearchParams({
    client_id: String(clientIdPayload()),
    client_secret: oauthConfig.clientSecret,
    ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)),
  });
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = (data.error_description || data.error || raw.replace(/\s+/g, ' ').slice(0, 200) || `HTTP ${response.status}`).slice(0, 300);
    const safeDetail = safeErrorMessage(detail);
    log('error', event, { grant: payload.grant_type, status: response.status, durationMs: Date.now() - startedAt, detail: safeDetail });
    const err = new HttpError(response.status === 400 || response.status === 401 ? 502 : response.status, `osu! отклонил запрос токена (HTTP ${response.status}): ${safeDetail}`);
    err.status = response.status;
    err.upstreamStatus = response.status;
    err.oauthError = data.error || null;
    throw err;
  }
  if (!data.access_token) {
    log('error', event, { grant: payload.grant_type, durationMs: Date.now() - startedAt, detail: 'no access_token in response' });
    throw new HttpError(502, 'osu! вернул ответ без access_token.');
  }
  storeOsuToken(data, kind);
  log('info', event, {
    grant: payload.grant_type,
    scope: oauthToken.scope,
    expiresInSeconds: Math.round((oauthToken.expiresAt - Date.now()) / 1000),
    hasRefreshToken: Boolean(oauthToken.refreshToken),
    durationMs: Date.now() - startedAt,
  });
  return oauthToken;
}

let oauthTokenSync = null;

async function ensureOsuToken() {
  if (!oauthConfigured()) throw new HttpError(400, 'OAuth-приложение не настроено: укажите Client ID и Client Secret.');
  if (oauthToken.accessToken && oauthToken.expiresAt > Date.now() + 5000) return oauthToken.accessToken;
  // Single-flight: параллельные вызовы ждут один и тот же refresh, иначе osu! видит повторный
  // use уже ротированного refresh_token и начинает отзывать сессию.
  if (oauthTokenSync) return oauthTokenSync;

  if (!oauthToken.refreshToken) throw new HttpError(401, 'OAuth-токен истёк или ещё не получен — авторизуйтесь через osu! заново.');

  oauthTokenSync = (async () => {
    try {
      await postOsuToken({ grant_type: 'refresh_token', refresh_token: oauthToken.refreshToken, scope: oauthToken.scope || 'public identify' }, 'oauth.token.refreshed', oauthToken.kind);
      return oauthToken.accessToken;
    } catch (error) {
      // Временные сбои (сеть/таймаут/5xx) не трогают refresh-токен: он всё ещё может быть валиден.
      // Только явный отказ провайдера (4xx) означает, что refresh скомпрометирован/просрочен.
      const status = error?.upstreamStatus ?? error?.status ?? (error instanceof HttpError ? error.httpStatus : null);
      const isInvalidGrant = error?.oauthError === 'invalid_grant' || /invalid_grant/i.test(error?.message || '');
      const permanent = (typeof status === 'number' && status >= 400 && status < 500) || isInvalidGrant;
      if (permanent) {
        oauthToken.accessToken = null;
        oauthToken.refreshToken = null;
        oauthToken.expiresAt = 0;
        oauthToken.kind = null;
        oauthToken.scope = null;
      }
      log('warn', 'oauth.token.refresh_failed', { error: safeErrorMessage(error), permanent, upstreamStatus: error?.upstreamStatus || null });
      throw new HttpError(permanent ? 401 : 503, permanent
        ? 'Не удалось обновить OAuth-токен — войдите через osu! повторно.'
        : `osu! недоступен при обновлении OAuth-токена — попробуйте позже. ${safeErrorMessage(error)}`);
    } finally {
      oauthTokenSync = null;
    }
  })();
  return oauthTokenSync;
}

async function responsePreview(response, limit = 300) {
  try {
    if (!response.body) return '';
    const reader = response.body.getReader();
    let text = '';
    try {
      while (Buffer.byteLength(text, 'utf8') < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  } catch {
    await response.body?.cancel().catch(() => {});
    return '';
  }
}

async function handleOauthCallback(req, res, url) {
  const finish = (query, status = 302) => {
    res.writeHead(status, { Location: `/?${query}`, 'Cache-Control': 'no-store' });
    res.end();
  };
  const fail = reason => {
    log('warn', 'oauth.callback.failed', { reason: safeErrorMessage(reason) });
    finish(`oauth_error=${encodeURIComponent(safeErrorMessage(reason))}`);
  };

  const providerError = url.searchParams.get('error');
  if (providerError) return fail(url.searchParams.get('error_description') || providerError);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail('В ответе osu! нет code или state.');
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!expiresAt || expiresAt <= Date.now()) return fail('Некорректный или просроченный параметр state — повторите вход.');
  if (!oauthConfigured()) return fail('OAuth-приложение больше не настроено.');

  try {
    await postOsuToken({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL }, 'oauth.token.issued', 'authorization_code');
    finish('oauth=connected');
  } catch (error) {
    fail(error.message);
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/mirrors') {
    return json(res, 200, {
      mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/oauth/status') {
    const status = oauthStatus();
    return json(res, 200, { configured: status.configured, connected: status.connected, kind: status.kind, scope: status.scope, expiresAt: status.expiresAt, clientId: status.clientId, callbackUrl: status.callbackUrl });
  }
  if (req.method === 'POST' && url.pathname === '/api/oauth/config') {
    const body = await readJson(req);
    const requestedClientId = typeof body.clientId === 'string' || Number.isSafeInteger(body.clientId) ? String(body.clientId || '').trim() : '';
    const clientId = requestedClientId || oauthConfig.clientId;
    const suppliedSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    const replacingSecret = suppliedSecret.length > 0;
    const clientSecret = replacingSecret ? suppliedSecret : oauthConfig.clientSecret;
    if (!clientId || !/^\d{1,16}$/.test(clientId)) return json(res, 400, { error: 'Укажите числовой Client ID из настроек osu!.' });
    if (!clientSecret || clientSecret.length > 256 || /[\s;\r\n]/.test(clientSecret)) return json(res, 400, { error: 'Укажите Client Secret вашего OAuth-приложения.' });
    if (oauthConfig.clientId && oauthConfig.clientId !== clientId && !replacingSecret) return json(res, 400, { error: 'При смене Client ID укажите соответствующий ему Client Secret.' });
    const changed = oauthConfig.clientId !== clientId || (replacingSecret && oauthConfig.clientSecret !== clientSecret);
    oauthConfig.clientId = clientId;
    if (replacingSecret || !oauthConfig.clientSecret) oauthConfig.clientSecret = clientSecret;
    if (changed) {
      oauthToken.accessToken = null;
      oauthToken.refreshToken = null;
      oauthToken.expiresAt = 0;
      oauthToken.kind = null;
      oauthToken.scope = null;
    }
    log('info', 'oauth.config.saved', { clientId, changed });
    return json(res, 200, oauthStatus());
  }
  if (req.method === 'POST' && url.pathname === '/api/oauth/start') {
    if (!oauthConfigured()) return json(res, 400, { error: 'Сначала сохраните Client ID и Client Secret.' });
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    log('info', 'oauth.authorize.started', { callback: CALLBACK_URL, scope: 'public identify' });
    return json(res, 200, { authorizeUrl: buildAuthorizeUrl(state) });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/oauth/disconnect') {
    oauthToken.accessToken = null;
    oauthToken.refreshToken = null;
    oauthToken.expiresAt = 0;
    oauthToken.kind = null;
    oauthToken.scope = null;
    oauthStates.clear();
    log('info', 'oauth.disconnected');
    return json(res, 200, oauthStatus());
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const body = await readJson(req);
    const session = typeof body.session === 'string' ? body.session.trim() : '';
    if (session.length < 20 || session.length > 4096 || /[;\r\n]/.test(session)) {
      return json(res, 400, { error: 'Проверьте значение cookie osu_session.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { value: session, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    log('info', 'session.saved');
    setTokenCookie(res, req, token);
    return json(res, 200, { connected: true });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/session') {
    const token = parseCookies(req.headers.cookie)[tokenCookie];
    if (token) sessions.delete(token);
    log('info', 'session.cleared', { hadSession: Boolean(token) });
    res.setHeader('Set-Cookie', `${tokenCookie}=; ${cookieOptions(req, 0)}`);
    return json(res, 200, { connected: false });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    return json(res, 200, { connected: Boolean(getSession(req)) });
  }
  if (req.method === 'POST' && url.pathname === '/api/collections') {
    const body = await readJson(req);
    const collectionId = extractCollectionId(body?.url);
    const data = await fetchCollection(collectionId);
    const setIds = parseSetIds(data);
    return json(res, 200, {
      id: data.id,
      name: typeof data.name === 'string' ? data.name : `Коллекция ${collectionId}`,
      uploader: data.uploader && typeof data.uploader.username === 'string' ? data.uploader.username : null,
      count: setIds.length,
      beatmapCount: data.beatmapCount ?? setIds.length,
      maps: data.maps || fallbackMapInfo(setIds),
      setIds,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/downloads') {
    const requestedMethod = url.searchParams.get('method');
    const method = requestedMethod === 'oauth' ? 'oauth' : requestedMethod === 'session' ? 'session' : 'mirror';
    let auth;
    if (method === 'mirror') {
      auth = { kind: 'mirror' };
    } else if (method === 'oauth') {
      try {
        const token = await ensureOsuToken();
        auth = { kind: 'oauth', token };
      } catch (error) {
        log('warn', 'download.job.rejected', { reason: 'oauth token unavailable', error: safeErrorMessage(error) });
        return json(res, 401, { error: safeErrorMessage(error) });
      }
    } else {
      const session = getSession(req);
      if (!session) {
        log('warn', 'download.job.rejected', { reason: 'osu session is not set' });
        return json(res, 401, { error: 'Сначала сохраните cookie osu_session в приложении.' });
      }
      auth = { kind: 'session', session };
    }
    if (activeJob && ['queued', 'running'].includes(activeJob.status)) {
      return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
    }
    const body = await readJson(req);
    const collectionId = extractCollectionId(body?.url);
    if (activeJob && activeJob.status === 'paused') {
      if (activeJob.collectionId === collectionId) {
        activeJob.autoResumeCount = 0;
        resumeJob(activeJob, auth, 'manual');
        return json(res, 202, safeJobForClient(activeJob));
      }
      return json(res, 409, { error: `Уже на паузе загрузка другой коллекции («${activeJob.collectionName}») — нажмите «Остановить», чтобы начать новую.` });
    }
    const data = await fetchCollection(collectionId);
    const setIds = parseSetIds(data);
    if (!setIds.length) return json(res, 400, { error: 'В коллекции нет доступных наборов.' });
    // Одна активная задача на процесс: повторная проверка после асинхронного fetchCollection
    if (activeJob && ['queued', 'running', 'paused'].includes(activeJob.status)) {
      if (activeJob.status === 'paused' && activeJob.collectionId === collectionId) {
        activeJob.autoResumeCount = 0;
        resumeJob(activeJob, auth, 'manual');
        return json(res, 202, safeJobForClient(activeJob));
      }
      return json(res, 409, { error: 'Уже идёт (или на паузе) другая загрузка — дождитесь её или нажмите «Остановить».' });
    }
    const job = {
      id: crypto.randomBytes(16).toString('hex'),
      method,
      collectionId,
      collectionName: typeof data.name === 'string' ? data.name : `Коллекция ${collectionId}`,
      setIds,
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map((data.maps || fallbackMapInfo(setIds)).map(map => [map.id, map])),
      currentBytes: 0,
      currentTotalBytes: null,
      currentPercent: 0,
      currentMirror: null,
      autoResumeAt: null,
      autoResumeCount: 0,
      autoResumeTimer: null,
      abortController: null,
      currentSetId: null,
      status: 'queued',
      message: 'Загрузка в очереди.',
    };
    activeJob = job;
    jobs.set(job.id, job);
    try {
      const requiredBytes = await estimateRequiredDiskSpace(setIds);
      await ensureDiskSpace(requiredBytes); // проверка диска с учётом уже имеющихся на диске наборов
    } catch (error) {
      jobs.delete(job.id);
      if (activeJob === job) activeJob = null;
      throw error;
    }
    log('info', 'download.job.created', { jobId: job.id, method, mirrors: method === 'mirror' ? MIRRORS.map(mirror => mirror.id) : undefined, collectionId, collectionName: job.collectionName, total: setIds.length });
    launchJob(job, auth);
    return json(res, 202, safeJobForClient(job));
  }
  const resumeMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)\/resume$/);
  if (req.method === 'POST' && resumeMatch) {
    const job = jobs.get(resumeMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    if (activeJob && activeJob !== job && ['queued', 'running'].includes(activeJob.status)) {
      return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
    }
    const counters = jobCounters(job);
    if (job.status !== 'paused' && !(job.status === 'finished_with_errors' && counters.deferred > 0)) {
      return json(res, 409, { error: 'Продолжить можно только приостановленную загрузку.' });
    }
    let auth;
    if (job.method === 'mirror') {
      const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
      if (cooldowns.length === MIRRORS.length) {
        const waitMs = Math.min(...cooldowns);
        if (waitMs > 1000) {
          log('warn', 'download.job.resume_deferred', { jobId: job.id, waitMs });
          // Это состояние апстрима (зеркала остывают), а не лимит нашего API — 503 с Retry-After.
          return json(res, 503, { error: `Зеркала ещё остывают после ограничения — попробуйте через ${Math.ceil(waitMs / 1000)} с.` }, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
        }
      }
      auth = { kind: 'mirror' };
    } else if (job.method === 'oauth') {
      try {
        auth = { kind: 'oauth', token: await ensureOsuToken() };
      } catch (error) {
        return json(res, 401, { error: safeErrorMessage(error) });
      }
    } else {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: 'Сначала сохраните cookie osu_session в приложении.' });
      auth = { kind: 'session', session };
    }
    try {
      const requiredBytes = await estimateRequiredDiskSpace(job.setIds);
      await ensureDiskSpace(requiredBytes);
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.httpStatus, { error: error.message });
      return json(res, 507, { error: safeErrorMessage(error) });
    }
    job.autoResumeCount = 0;
    resumeJob(job, auth);
    return json(res, 202, safeJobForClient(job));
  }
  const jobMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)(?:\/cancel)?$/);
  if (req.method === 'GET' && jobMatch && !url.pathname.endsWith('/cancel')) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    return json(res, 200, safeJobForClient(job));
  }
  if (req.method === 'POST' && jobMatch && url.pathname.endsWith('/cancel')) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    // Итоговое сообщение («Готово!» и т.п.) не перетираем: отменять можно только активную задачу.
    if (['running', 'queued', 'paused'].includes(job.status)) {
      job.status = 'cancelled';
      clearAutoResume(job);
      job.abortController?.abort();
      job.message = 'Загрузка остановлена.';
      job.finishedAt = Date.now();
      if (activeJob === job) activeJob = null;
      log('warn', 'download.job.cancelled', { jobId: job.id, completed: jobCounters(job).completed, total: job.setIds.length });
      void cleanupJobPartFiles(job);
    }
    return json(res, 200, safeJobForClient(job));
  }
  return json(res, 404, { error: 'API-маршрут не найден.' });
}

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  res.on('finish', () => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    // Успешные запросы не захламляют консоль: их видно только с DEBUG=1.
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log(level, 'http.request.completed', {
      method: req.method,
      path: requestUrl.pathname,
      status: res.statusCode,
      durationMs: Date.now() - requestStartedAt,
    });
  });
  if (!ensureLocalRequest(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === '/oauth/callback') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method not allowed');
      }
      return await handleOauthCallback(req, res, url);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!['GET', 'HEAD'].includes(req.method) || !['/', '/index.html', '/app.js'].includes(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const asset = url.pathname === '/app.js' ? 'app.js' : 'index.html';
    const content = await fs.promises.readFile(path.join(ROOT, asset));
    res.writeHead(200, {
      'Content-Type': asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(content);
  } catch (error) {
    log('error', 'http.request.failed', { method: req.method, path: url.pathname, error: safeErrorMessage(error) });
    const status = (typeof error?.httpStatus === 'number')
      ? error.httpStatus
      : (typeof error?.status === 'number' && error.status >= 400 && error.status <= 599)
        ? error.status
        : 500;
    json(res, status, { error: safeErrorMessage(error) || 'Внутренняя ошибка.' });
  }
});

setInterval(() => {
  const now = Date.now();
  pruneCollectionCache();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [state, expiresAt] of oauthStates) {
    if (expiresAt <= now) oauthStates.delete(state);
  }
  for (const [id, job] of jobs) {
    // Приостановленные, выполняющиеся и находящиеся в очереди задачи не удаляются
    if (['queued', 'running', 'paused'].includes(job.status)) continue;
    if (job.finishedAt && now - job.finishedAt > 24 * 60 * 60 * 1000) {
      clearAutoResume(job);
      if (activeJob === job) activeJob = null;
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();

async function bootstrapAfterListen() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  await cleanupStalePartFiles(); // .part-файлы прошлого запуска процесса уже ни к чему не привязаны
}

server.listen(PORT, HOST, () => {
  log('info', 'server.started', {
    url: `http://${HOST}:${PORT}`,
    node: process.version,
    downloadsDirectory: DOWNLOADS_DIR,
    oauthCallback: CALLBACK_URL,
    oauthConfigured: oauthConfigured(),
    downloadMirrors: MIRRORS.map(mirror => mirror.id),
  });
  log('info', 'server.hint', { hint: `Скачивание идёт через зеркала: ${MIRRORS.map(mirror => mirror.label).join(', ')}. OAuth-логика сохранена в коде, но метод скрыт в интерфейсе.` });
});

void bootstrapAfterListen();

server.on('error', error => {
  log('error', 'server.failed', { error: safeErrorMessage(error), port: PORT });
  // EADDRINUSE должен валить процесс ненулевым кодом, а не висеть с «успешным» ранее выведенным URL.
  if (error?.code === 'EADDRINUSE') process.exit(1);
});

process.on('unhandledRejection', reason => {
  log('error', 'process.unhandled_rejection', { error: safeErrorMessage(reason), stack: reason?.stack });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const token of sessions.keys()) sessions.delete(token);
    oauthStates.clear();
    for (const job of jobs.values()) {
      job.abortController?.abort();
      clearAutoResume(job);
    }
    server.closeIdleConnections?.();
    server.close(() => process.exit(0));
    // Подстраховка: не зависаем на держащихся соединениях (длительные загрузки, keep-alive).
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
