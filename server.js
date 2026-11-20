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
  MIRRORS,
  log,
  json,
} = require('./lib/config.js');

const {
  sessions,
  pruneSessions,
  cookieOptions,
  safeErrorMessage,
  parseCookies,
  localApiTokenCookie,
  getApiToken,
  setApiTokenRequired,
  isInitialCookieGranted,
  setInitialCookieGranted,
  safeCompareTokens,
  ensureLocalRequest,
} = require('./lib/security.js');

const {
  pruneCollectionCache,
} = require('./lib/collector.js');

const {
  cleanupStalePartFiles,
} = require('./lib/downloader.js');

const {
  jobs,
  pruneJobs,
  saveStateToDisk,
  loadStateFromDisk,
  waitForPendingSaveState,
  clearAutoResume,
} = require('./lib/jobs.js');

const {
  getSettings: getOsuSettings,
  getCachedOsuSongsAsync,
} = require('./lib/osu.js');

const {
  closeStreamOrSocket,
  handleApi,
} = require('./lib/routes/index.js');


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

    const isStaticAsset = ['/', '/index.html', '/app.js', '/style.css'].includes(url.pathname) || url.pathname.startsWith('/public/');
    if (isStaticAsset) {
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

      const rawAsset = (url.pathname === '/' || url.pathname === '/index.html')
        ? 'index.html'
        : url.pathname === '/app.js'
          ? 'app.js'
          : url.pathname === '/style.css'
            ? 'style.css'
            : url.pathname.replace(/^\/+/, '');
      const filePath = path.resolve(ROOT, rawAsset);
      const rel = path.relative(ROOT, filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Forbidden');
      }

      let content;
      try {
        content = await fs.promises.readFile(filePath);
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not found');
        }
        throw err;
      }

      const contentType = rawAsset.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : rawAsset.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : rawAsset.endsWith('.json')
            ? 'application/json; charset=utf-8'
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
  startServer,
  bootstrapServer,
  resetBootstrap,
  bootstrapAfterListen,
  handleApi,
};
