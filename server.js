// @ts-check
"use strict";

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  HOST,
  PORT,
  ROOT,
  getDownloadsDir,
  getDataDir,
  MAX_BODY,
  MIRRORS,
  DEFAULT_MIRRORS,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
  getMirrorCooldownDefaultMs,
  getMirrorCooldownMaxMs,
  getMirrorCooldownWaitMaxMs,
  DOWNLOAD_CONCURRENCY,
  buildMirrorUrl,
  log,
  HttpError,
  json,
  formatBytes,
  pluralizeRu,
  formatPluralRu,
} = require('./lib/config.js');

const {
  sessions,
  cookieOptions,
  setTokenCookie,
  getSession,
  pruneSessions,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  activeRedactions,
  safeErrorMessage,
  parseCookies,
  localApiTokenCookie,
  getApiToken,
  setApiToken,
  resetApiToken,
  isApiTokenRequired,
  setApiTokenRequired,
  isInitialCookieGranted,
  setInitialCookieGranted,
  safeCompareTokens,
  extractTokenFromRequest,
  verifyApiToken,
  ensureLocalRequest,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  redirectHostAllowed,
  mirrorRedirectAllowed,
  createPinnedLookup,
} = require('./lib/security.js');

const {
  extractCollectionId,
  parseSetIds,
  fallbackMapInfo,
  fetchMapsetInfo,
  fetchCollection,
  collectionCache,
  pruneCollectionCache,
  setCollectionCache,
  populateMetadataInBackground,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
} = require('./lib/collector.js');

const {
  mirrorCooldowns,
  mirrorCooldownRemaining,
  parseRetryAfter,
  acquireMirrorSlot,
  isMirrorBusy,
  resetMirrorSlots,
} = require('./lib/mirrors.js');

const {
  partPath,
  jobFilePath,
  cleanupJobPartFiles,
  cleanupStalePartFiles,
  STALE_PART_MAX_AGE_MS,
  ensureDiskSpace,
  estimateRequiredDiskSpace,
  appendNoVideo,
  verifyZipFile,
  downloadSet,
  downloadFromMirrors,
  safeDownloadFetch,
} = require('./lib/downloader.js');

const {
  jobs,
  Job,
  JobStateMachine,
  createJob,
  jobEvents,
  emitJobUpdate,
  getActiveJob,
  setActiveJob,
  jobCounters,
  safeJobForClient,
  clearAutoResume,
  resumeJob,
  retryFailedJob,
  getFailedSetIds,
  launchJob,
  pruneJobs,
  getStateFilePath,
  saveStateToDisk,
  loadStateFromDisk,
  scheduleSaveState,
  waitForPendingSaveState,
} = require('./lib/jobs.js');

const osu = require('./lib/osu.js');
const {
  getSettings: getOsuSettings,
  saveSettings: saveOsuSettings,
  classifyCollectionSets,
  getCachedOsuSongs,
  getCachedOsuSongsAsync,
  selectFolderDialog,
} = osu;

const {
  closeStreamOrSocket,
  readJson,
  handleMethodNotAllowed,
  handleApi,
} = require('./lib/routes/index.js');
const {
  resolveJobAuth,
  resumePausedJobWithSettings,
} = require('./lib/routes/downloads.js');


const server = http.createServer(async (req, res) => {
  /** @type {any} */ (req).res = res;
  const requestStartedAt = Date.now();
  res.on('finish', () => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const isExpectedNotFound = req.method === 'GET' && requestUrl.pathname === '/api/downloads/active' && res.statusCode === 404;
    const level = res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 && !isExpectedNotFound) ? 'warn' : 'debug';
    log(level, 'http.request.completed', {
      method: req.method,
      path: requestUrl.pathname,
      status: res.statusCode,
      durationMs: Date.now() - requestStartedAt,
    });
  });

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (!ensureLocalRequest(req, res, { url })) return;

  if (bootstrapPromise) {
    try {
      await bootstrapPromise;
    } catch (bootErr) {
      log('error', 'server.bootstrap_pending_failed', { error: safeErrorMessage(bootErr) });
      return json(res, 503, { error: 'Сервер инициализируется, повторите запрос позже.' });
    }
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/favicon.ico') {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
        return res.end('Method not allowed');
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (['/', '/index.html', '/app.js', '/style.css'].includes(url.pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
        return res.end('Method not allowed');
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (url.searchParams.has('token')) {
          const providedToken = url.searchParams.get('token') || '';
          if (safeCompareTokens(providedToken, getApiToken())) {
            res.writeHead(302, {
              'Location': '/',
              'Set-Cookie': `${localApiTokenCookie}=${getApiToken()}; ${cookieOptions(req, 60 * 60 * 24)}`,
              'Cache-Control': 'no-store',
            });
            return res.end();
          }
          return json(res, 403, { error: 'Недействительный токен авторизации.' });
        }
      }

      const asset = url.pathname === '/app.js'
        ? 'app.js'
        : url.pathname === '/style.css'
          ? 'style.css'
          : 'index.html';
      const content = await fs.promises.readFile(path.join(ROOT, asset));
      const contentType = asset.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8';

      const cookies = parseCookies(req.headers.cookie);
      const hasValidTokenCookie = safeCompareTokens(cookies[localApiTokenCookie], getApiToken());
      /** @type {Record<string, string>} */
      const extraHeaders = {};
      if ((url.pathname === '/' || url.pathname === '/index.html') && !hasValidTokenCookie && !isInitialCookieGranted()) {
        setInitialCookieGranted(true);
        extraHeaders['Set-Cookie'] = `${localApiTokenCookie}=${getApiToken()}; ${cookieOptions(req, 60 * 60 * 24)}`;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        ...extraHeaders,
      });
      return res.end(content);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  } catch (error) {
    const err = /** @type {any} */ (error);
    log('error', 'http.request.failed', { method: req.method, path: url.pathname, error: safeErrorMessage(error) });
    const status = (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599)
      ? err.status
      : (typeof err?.httpStatus === 'number' && err.httpStatus >= 400 && err.httpStatus <= 599)
        ? err.httpStatus
        : 500;
    const isPayloadTooLarge = status === 413;
    const extraHeaders = isPayloadTooLarge ? { 'Connection': 'close' } : {};
    json(res, status, { error: safeErrorMessage(error) || 'Внутренняя ошибка.' }, extraHeaders);
    if (isPayloadTooLarge) {
      closeStreamOrSocket(req);
    }
  }
});

// Периодическая очистка устаревших кешей и сессий
setInterval(() => {
  pruneCollectionCache();
  pruneSessions();
  pruneJobs();
}, 60 * 1000).unref();

/** @type {Promise<void> | null} */
let bootstrapPromise = null;

function resetBootstrap() {
  bootstrapPromise = null;
}

/**
 * Инициализирует файловую систему и восстанавливает сохранённое состояние задач с диска.
 * @returns {Promise<void>}
 */
function bootstrapServer() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await fs.promises.mkdir(getDataDir(), { recursive: true });
      await fs.promises.mkdir(getDownloadsDir(), { recursive: true });
      await cleanupStalePartFiles();
      await loadStateFromDisk();
      const osuSettings = getOsuSettings();
      if (osuSettings?.valid && osuSettings?.songsDir) {
        await getCachedOsuSongsAsync(osuSettings.songsDir).catch(() => {});
      }
    })();
  }
  return bootstrapPromise;
}

function bootstrapAfterListen() {
  return bootstrapServer();
}

/**
 * Выполняет инициализацию хранилища с диска и запускает прослушивание входящих HTTP-подключений.
 * @param {number} [port]
 * @param {string} [host]
 * @param {{ requireToken?: boolean }} [options]
 * @returns {Promise<import('node:http').Server>}
 */
async function startServer(port = PORT, host = HOST, options = {}) {
  const requireToken = options.requireToken ?? true;
  setApiTokenRequired(requireToken);
  await bootstrapServer();
  return new Promise((resolve, reject) => {
    const onError = (/** @type {any} */ error) => {
      log('error', 'server.failed', { error: safeErrorMessage(error), port });
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      log('info', 'server.started', {
        url: `http://${host}:${port}/?token=${getApiToken()}`,
        node: process.version,
        downloadsDirectory: getDownloadsDir(),
        dataDirectory: getDataDir(),
        downloadMirrors: MIRRORS.map(mirror => mirror.id),
      });
      log('info', 'server.hint', { hint: `Скачивание идёт через зеркала: ${MIRRORS.map(mirror => mirror.label).join(', ')}.` });
      resolve(server);
    });
  });
}

if (require.main === module) {
  server.on('error', (/** @type {any} */ error) => {
    log('error', 'server.failed', { error: safeErrorMessage(error), port: PORT });
    if (error?.code === 'EADDRINUSE') process.exit(1);
  });

  process.on('unhandledRejection', (/** @type {any} */ reason) => {
    log('error', 'process.unhandled_rejection', { error: safeErrorMessage(reason), stack: reason?.stack });
  });

  let isShuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      for (const token of sessions.keys()) sessions.delete(token);
      for (const job of jobs.values()) {
        if (['preparing', 'queued', 'running'].includes(job.status)) {
          job.status = 'paused';
          job.message = 'Сервер остановлен — задача приостановлена. Нажмите «Продолжить» при следующем запуске.';
          job.pausedAt = Date.now();
        }
        job.abortController?.abort();
        clearAutoResume(job);
      }
      await waitForPendingSaveState().catch(() => {});
      await saveStateToDisk().catch(() => {});
      const activeIds = new Set(Array.from(jobs.keys()));
      await cleanupStalePartFiles({ activeJobIds: activeIds }).catch(() => {});
      server.closeIdleConnections?.();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }

  startServer().catch((error) => {
    log('error', 'server.bootstrap_failed', { error: safeErrorMessage(error), stack: error?.stack });
    process.exit(1);
  });
}

module.exports = {
  server,
  Job,
  JobStateMachine,
  createJob,
  getDownloadsDir,
  getDataDir,
  extractCollectionId,
  parseRetryAfter,
  verifyZipFile,
  jobCounters,
  formatBytes,
  safeErrorMessage,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  mirrorRedirectAllowed,
  createPinnedLookup,
  redirectHostAllowed,
  downloadFromMirrors,
  downloadSet,
  safeDownloadFetch,
  cleanupJobPartFiles,
  cleanupStalePartFiles,
  STALE_PART_MAX_AGE_MS,
  fetchMapsetInfo,
  fetchCollection,
  populateMetadataInBackground,
  collectionCache,
  pruneCollectionCache,
  setCollectionCache,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
  parseSetIds,
  fallbackMapInfo,
  MIRRORS,
  DEFAULT_MIRRORS,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
  getMirrorCooldownDefaultMs,
  getMirrorCooldownMaxMs,
  getMirrorCooldownWaitMaxMs,
  mirrorCooldowns,
  acquireMirrorSlot,
  isMirrorBusy,
  resetMirrorSlots,
  DOWNLOAD_CONCURRENCY,
  buildMirrorUrl,
  appendNoVideo,
  retryFailedJob,
  getFailedSetIds,
  jobEvents,
  emitJobUpdate,
  jobs,
  sessions,
  pruneSessions,
  activeRedactions,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  HttpError,
  pluralizeRu,
  formatPluralRu,
  loadStateFromDisk,
  saveStateToDisk,
  scheduleSaveState,
  resolveJobAuth,
  resumePausedJobWithSettings,
  getStateFilePath,
  bootstrapAfterListen,
  bootstrapServer,
  resetBootstrap,
  startServer,
  waitForPendingSaveState,
  handleMethodNotAllowed,
  handleApi,
  readJson,
  closeStreamOrSocket,
  localApiTokenCookie,
  getApiToken,
  setApiToken,
  resetApiToken,
  isApiTokenRequired,
  setApiTokenRequired,
  isInitialCookieGranted,
  setInitialCookieGranted,
  safeCompareTokens,
  extractTokenFromRequest,
  verifyApiToken,
};
