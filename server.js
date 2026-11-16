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
  MAX_BODY,
  ENABLE_OAUTH,
  isOAuthEnabled,
  CALLBACK_URL,
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
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  activeRedactions,
  safeErrorMessage,
  parseCookies,
  ensureLocalRequest,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  redirectHostAllowed,
  mirrorRedirectAllowed,
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
  ensureDiskSpace,
  estimateRequiredDiskSpace,
  appendNoVideo,
  verifyZipFile,
  downloadSet,
  downloadFromMirrors,
} = require('./lib/downloader.js');

const {
  jobs,
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

const {
  sessions,
  oauthConfig,
  oauthToken,
  oauthStates,
  cookieOptions,
  setTokenCookie,
  getSession,
  oauthConfigured,
  buildAuthorizeUrl,
  oauthStatus,
  storeOsuToken,
  ensureOsuToken,
  handleOauthCallback,
  pruneSessionsAndOauth,
} = require('./lib/oauth.js');

const {
  getSettings: getOsuSettings,
  saveSettings: saveOsuSettings,
  classifyCollectionSets,
  getCachedOsuSongs,
  getCachedOsuSongsAsync,
  selectFolderDialog,
} = require('./lib/osu.js');

/**
 * Читает тело HTTP-запроса с лимитом размера и парсит его как JSON.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
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

/**
 * Определяет параметры аутентификации для задачи (зеркала, session, oauth).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ method: string }} job
 * @returns {Promise<any>}
 */
async function resolveJobAuth(req, job) {
  if (job.method === 'mirror') {
    return { kind: 'mirror' };
  }
  if (job.method === 'oauth') {
    if (!isOAuthEnabled()) {
      throw new HttpError(403, 'OAuth-метод отключён на сервере (запустите с ENABLE_OAUTH=1).');
    }
    const token = await ensureOsuToken();
    return { kind: 'oauth', token };
  }
  const session = getSession(req);
  if (!session) {
    throw new HttpError(401, 'Сначала сохраните cookie osu_session в приложении.');
  }
  return { kind: 'session', session };
}

/**
 * Возобновляет приостановленную задачу с обновлением настроек method и noVideo,
 * проверяя остывание зеркал и требуемое место на диске.
 * @param {import('node:http').ServerResponse} res
 * @param {any} job
 * @param {any} auth
 * @param {string} method
 * @param {boolean} noVideo
 * @param {'manual' | 'auto'} [trigger='manual']
 * @returns {Promise<void>}
 */
async function resumePausedJobWithSettings(res, job, auth, method, noVideo, trigger = 'manual') {
  job.method = method;
  job.noVideo = noVideo;
  if (job.method === 'mirror') {
    const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
    if (cooldowns.length === MIRRORS.length) {
      const waitMs = Math.min(...cooldowns);
      if (waitMs > 1000) {
        log('warn', 'download.job.resume_deferred', { jobId: job.id, waitMs });
        return json(res, 503, {
          error: `Зеркала ещё остывают после ограничения — попробуйте через ${Math.ceil(waitMs / 1000)} с.`
        }, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
      }
    }
  }
  try {
    const pendingIds = job.setIds.filter((/** @type {number} */ id) => {
      if (job.retryOnlyIds && !job.retryOnlyIds.has(id)) return false;
      return !job.doneIds?.has(id) && !job.skipIds?.has(id);
    });
    const requiredBytes = await estimateRequiredDiskSpace(pendingIds, job.noVideo, { job });
    if (requiredBytes > 0) {
      await ensureDiskSpace(requiredBytes);
    }
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    return json(res, 507, { error: safeErrorMessage(error) });
  }
  job.autoResumeCount = 0;
  job._spaceChecked = true;
  resumeJob(job, auth, trigger);
  return json(res, 202, safeJobForClient(job));
}

/**
 * Отправляет ответ 405 Method Not Allowed с заголовком Allow.
 * Для запросов OPTIONS возвращает 204 No Content со списком поддерживаемых методов.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} allowed
 */
function handleMethodNotAllowed(req, res, allowed) {
  const allowHeader = allowed.join(', ');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Allow': allowHeader,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  return json(res, 405, { error: 'Метод не поддерживается.' }, { 'Allow': allowHeader });
}

/**
 * Маршрутизатор API-запросов.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleApi(req, res, url) {
  if (url.pathname === '/api/osu/settings') {
    if (req.method === 'GET') {
      return json(res, 200, getOsuSettings());
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      try {
        const updated = await saveOsuSettings(body);
        return json(res, 200, updated);
      } catch (err) {
        return json(res, 400, { error: safeErrorMessage(err) });
      }
    }
    return handleMethodNotAllowed(req, res, ['GET', 'POST']);
  }

  if (url.pathname === '/api/osu/rescan') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const settings = getOsuSettings();
    if (!settings.valid || !settings.songsDir) {
      return json(res, 400, { error: 'Директория Songs не настроена или недоступна.' });
    }
    const songs = await getCachedOsuSongsAsync(settings.songsDir, true);
    settings.songsCount = songs.size;
    return json(res, 200, { count: songs.size, songsCount: songs.size });
  }

  if (url.pathname === '/api/osu/check') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const body = await readJson(req);
    const setIds = Array.isArray(body?.setIds) ? body.setIds : [];
    const classification = classifyCollectionSets(setIds);
    return json(res, 200, classification);
  }

  if (url.pathname === '/api/osu/browse') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return handleMethodNotAllowed(req, res, ['GET', 'POST']);
    }
    let initialPath = '';
    if (req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      initialPath = typeof body?.initialPath === 'string' ? body.initialPath : '';
    } else {
      initialPath = url.searchParams.get('initialPath') || '';
    }
    try {
      const selected = await selectFolderDialog(initialPath);
      return json(res, 200, { path: selected, cancelled: !selected });
    } catch (err) {
      log('warn', 'osu.browse.failed', { error: safeErrorMessage(err) });
      return json(res, 500, { error: safeErrorMessage(err) });
    }
  }

  if (url.pathname === '/api/mirrors') {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    return json(res, 200, {
      mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
    });
  }

  if (url.pathname === '/api/oauth/status') {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    const status = oauthStatus();
    const oauthActive = isOAuthEnabled();
    return json(res, 200, {
      enabled: oauthActive,
      configured: oauthActive ? status.configured : false,
      connected: oauthActive ? status.connected : false,
      kind: oauthActive ? status.kind : null,
      scope: oauthActive ? status.scope : null,
      expiresAt: oauthActive ? status.expiresAt : null,
      clientId: oauthActive ? status.clientId : null,
      callbackUrl: status.callbackUrl,
    });
  }

  if (url.pathname === '/api/oauth/config') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    if (!isOAuthEnabled()) {
      return json(res, 403, { error: 'OAuth-авторизация отключена на сервере (запустите с ENABLE_OAUTH=1).' });
    }
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
    if (replacingSecret || !oauthConfig.clientSecret) {
      if (oauthConfig.clientSecret && oauthConfig.clientSecret !== clientSecret) {
        removeRedaction(oauthConfig.clientSecret);
      }
      oauthConfig.clientSecret = clientSecret;
      addRedaction(clientSecret);
    }
    if (changed) {
      removeRedaction(oauthToken.accessToken);
      removeRedaction(oauthToken.refreshToken);
      oauthToken.accessToken = null;
      oauthToken.refreshToken = null;
      oauthToken.expiresAt = 0;
      oauthToken.kind = null;
      oauthToken.scope = null;
    }
    log('info', 'oauth.config.saved', { clientId, changed });
    return json(res, 200, oauthStatus());
  }

  if (url.pathname === '/api/oauth/start') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    if (!isOAuthEnabled()) {
      return json(res, 403, { error: 'OAuth-авторизация отключена на сервере (запустите с ENABLE_OAUTH=1).' });
    }
    const body = await readJson(req);
    const requestedClientId = typeof body.clientId === 'string' || Number.isSafeInteger(body.clientId) ? String(body.clientId || '').trim() : '';
    const clientId = requestedClientId || oauthConfig.clientId;
    if (!oauthConfigured()) return json(res, 400, { error: 'Сначала сохраните Client ID и Client Secret.' });
    const state = crypto.randomBytes(24).toString('hex');
    const nonce = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, { nonce, expiresAt: Date.now() + 10 * 60 * 1000 });
    log('info', 'oauth.authorize.started', { callback: CALLBACK_URL, scope: 'public identify' });
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.setHeader('Set-Cookie', `osu_oauth_state=${nonce}; Path=/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
    return json(res, 200, { authorizeUrl: buildAuthorizeUrl(state) });
  }

  if (url.pathname === '/api/oauth/disconnect') {
    if (req.method !== 'DELETE') return handleMethodNotAllowed(req, res, ['DELETE']);
    if (!isOAuthEnabled()) {
      return json(res, 403, { error: 'OAuth-авторизация отключена на сервере.' });
    }
    removeRedaction(oauthToken.accessToken);
    removeRedaction(oauthToken.refreshToken);
    oauthToken.accessToken = null;
    oauthToken.refreshToken = null;
    oauthToken.expiresAt = 0;
    oauthToken.kind = null;
    oauthToken.scope = null;
    oauthStates.clear();
    res.setHeader('Set-Cookie', `osu_oauth_state=; Path=/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=0`);
    log('info', 'oauth.disconnected');
    return json(res, 200, oauthStatus());
  }

  if (url.pathname === '/api/session') {
    if (req.method === 'GET') {
      return json(res, 200, { connected: Boolean(getSession(req)) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const session = typeof body.session === 'string' ? body.session.trim() : '';
      if (session.length < 20 || session.length > 4096 || /[;\r\n]/.test(session)) {
        return json(res, 400, { error: 'Проверьте значение cookie osu_session.' });
      }
      const cookies = parseCookies(req.headers.cookie);
      const existingToken = cookies['osu_collector_token'];
      if (existingToken) {
        const existing = sessions.get(existingToken);
        if (existing) {
          removeRedaction(existing.value);
          sessions.delete(existingToken);
        }
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { value: session, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      addRedaction(session);
      log('info', 'session.saved');
      setTokenCookie(res, req, token);
      return json(res, 200, { connected: true });
    }
    if (req.method === 'DELETE') {
      const token = parseCookies(req.headers.cookie)['osu_collector_token'];
      if (token) {
        const entry = sessions.get(token);
        if (entry) removeRedaction(entry.value);
        sessions.delete(token);
      }
      log('info', 'session.cleared', { hadSession: Boolean(token) });
      res.setHeader('Set-Cookie', `osu_collector_token=; ${cookieOptions(req, 0)}`);
      return json(res, 200, { connected: false });
    }
    return handleMethodNotAllowed(req, res, ['GET', 'POST', 'DELETE']);
  }

  if (url.pathname === '/api/collections') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const body = await readJson(req);
    const collectionId = extractCollectionId(body?.url);
    const data = await fetchCollection(collectionId);
    const { installedSetIds, downloadedSetIds } = classifyCollectionSets(data.setIds);
    return json(res, 200, {
      id: data.id,
      name: data.name,
      uploader: data.uploader,
      count: data.count,
      beatmapCount: data.beatmapCount,
      maps: data.maps,
      setIds: data.setIds,
      metadataComplete: Boolean(data.metadataComplete),
      metadataDegraded: Boolean(data.metadataDegraded),
      metadataProgress: Number(data.metadataProgress || 0),
      installedSetIds,
      downloadedSetIds,
    });
  }

  const collectionMatch = url.pathname.match(/^\/api\/collections\/([0-9]+)$/);
  if (collectionMatch) {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    const collectionId = collectionMatch[1];
    const data = await fetchCollection(collectionId);
    const { installedSetIds, downloadedSetIds } = classifyCollectionSets(data.setIds);
    return json(res, 200, {
      id: data.id,
      name: data.name,
      uploader: data.uploader,
      count: data.count,
      beatmapCount: data.beatmapCount,
      maps: data.maps,
      setIds: data.setIds,
      metadataComplete: Boolean(data.metadataComplete),
      metadataDegraded: Boolean(data.metadataDegraded),
      metadataProgress: Number(data.metadataProgress || 0),
      installedSetIds,
      downloadedSetIds,
    });
  }

  if (url.pathname === '/api/downloads') {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const body = await readJson(req);
    const requestedMethod = url.searchParams.get('method') || (typeof body?.method === 'string' ? body.method : null);
    const method = requestedMethod === 'oauth' ? 'oauth' : requestedMethod === 'session' ? 'session' : 'mirror';

    let auth;
    try {
      auth = await resolveJobAuth(req, { method });
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      return json(res, 401, { error: safeErrorMessage(error) });
    }

    const currentActive = getActiveJob();
    if (currentActive && ['queued', 'running'].includes(currentActive.status)) {
      return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
    }

    const noVideoParam = url.searchParams.get('noVideo');
    const noVideo = noVideoParam === '1' || noVideoParam === 'true' || body?.noVideo === true || body?.noVideo === 1 || body?.noVideo === '1';
    const collectionId = extractCollectionId(body?.url);
    if (currentActive && currentActive.status === 'paused') {
      if (currentActive.collectionId === collectionId) {
        return await resumePausedJobWithSettings(res, currentActive, auth, method, noVideo, 'manual');
      }
      return json(res, 409, { error: `Уже на паузе загрузка другой коллекции («${currentActive.collectionName}») — нажмите «Остановить», чтобы начать новую.` });
    }

    const data = await fetchCollection(collectionId);
    const setIds = parseSetIds(data);
    if (!setIds.length) return json(res, 400, { error: 'В коллекции нет доступных наборов.' });

    const activeCheck = getActiveJob();
    if (activeCheck && ['queued', 'running', 'paused'].includes(activeCheck.status)) {
      if (activeCheck.status === 'paused' && activeCheck.collectionId === collectionId) {
        return await resumePausedJobWithSettings(res, activeCheck, auth, method, noVideo, 'manual');
      }
      return json(res, 409, { error: 'Уже идёт (или на паузе) другая загрузка — дождитесь её или нажмите «Остановить».' });
    }

    const job = {
      id: crypto.randomBytes(16).toString('hex'),
      method,
      noVideo,
      collectionId,
      collectionName: typeof data.name === 'string' ? data.name : `Коллекция ${collectionId}`,
      setIds,
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: data.mapsById || new Map((data.maps || fallbackMapInfo(setIds)).map((/** @type {any} */ map) => [map.id, map])),
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
      createdAt: Date.now(),
    };
    setActiveJob(job);
    jobs.set(job.id, job);

    try {
      const requiredBytes = await estimateRequiredDiskSpace(setIds, noVideo, { job });
      if (requiredBytes > 0) {
        await ensureDiskSpace(requiredBytes);
      }
    } catch (error) {
      jobs.delete(job.id);
      if (getActiveJob() === job) setActiveJob(null);
      throw error;
    }

    log('info', 'download.job.created', { jobId: job.id, method, noVideo, mirrors: method === 'mirror' ? MIRRORS.map(mirror => mirror.id) : undefined, collectionId, collectionName: job.collectionName, total: setIds.length });
    job._spaceChecked = true;
    launchJob(job, auth);
    void scheduleSaveState(true);
    return json(res, 202, safeJobForClient(job));
  }

  const resumeMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)\/resume$/);
  if (resumeMatch) {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const job = jobs.get(resumeMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    const currentActive = getActiveJob();
    if (currentActive && currentActive !== job && ['queued', 'running'].includes(currentActive.status)) {
      return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
    }
    if (['queued', 'running'].includes(job.status)) {
      return json(res, 409, { error: 'Задача уже выполняется.' });
    }
    const counters = jobCounters(job);
    if (job.status !== 'paused' && !(job.status === 'finished_with_errors' && counters.deferred > 0)) {
      return json(res, 409, { error: 'Продолжить можно только приостановленную загрузку.' });
    }

    const body = await readJson(req).catch(() => ({}));
    const requestedMethod = url.searchParams.get('method') || (typeof body?.method === 'string' ? body.method : null);
    const method = requestedMethod && ['mirror', 'session', 'oauth'].includes(requestedMethod)
      ? requestedMethod
      : job.method;
    const noVideoParam = url.searchParams.get('noVideo');
    const noVideo = noVideoParam !== null
      ? (noVideoParam === '1' || noVideoParam === 'true')
      : (typeof body?.noVideo === 'boolean' ? body.noVideo : job.noVideo);

    job.method = method;
    let auth;
    try {
      auth = await resolveJobAuth(req, job);
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      return json(res, 401, { error: safeErrorMessage(error) });
    }

    return await resumePausedJobWithSettings(res, job, auth, method, noVideo, 'manual');
  }

  const retryFailedMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)\/retry-failed$/);
  if (retryFailedMatch) {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const job = jobs.get(retryFailedMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    const currentActive = getActiveJob();
    if (currentActive && currentActive !== job && ['queued', 'running'].includes(currentActive.status)) {
      return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
    }
    const failedIds = getFailedSetIds(job);
    if (failedIds.length === 0) {
      return json(res, 400, { error: 'В этой задаче нет ошибок для повторной загрузки.' });
    }
    if (['queued', 'running'].includes(job.status)) {
      return json(res, 409, { error: 'Задача уже выполняется — дождитесь её завершения или остановите её.' });
    }

    const requestedMethod = url.searchParams.get('method');
    if (requestedMethod && ['mirror', 'session', 'oauth'].includes(requestedMethod)) {
      job.method = requestedMethod;
    }
    const noVideoParam = url.searchParams.get('noVideo');
    if (noVideoParam !== null) {
      job.noVideo = noVideoParam === '1' || noVideoParam === 'true';
    }

    let auth;
    try {
      auth = await resolveJobAuth(req, job);
    } catch (authError) {
      if (authError instanceof HttpError) return json(res, authError.status, { error: authError.message });
      return json(res, 401, { error: safeErrorMessage(authError) });
    }

    if (job.method === 'mirror') {
      const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
      if (cooldowns.length === MIRRORS.length) {
        const waitMs = Math.min(...cooldowns);
        if (waitMs > 1000) {
          log('warn', 'download.job.retry_deferred', { jobId: job.id, waitMs });
          return json(res, 503, { error: `Зеркала ещё остывают после ограничения — попробуйте через ${Math.ceil(waitMs / 1000)} с.` }, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
        }
      }
    }

    try {
      const requiredBytes = await estimateRequiredDiskSpace(failedIds, job.noVideo, { job });
      if (requiredBytes > 0) {
        await ensureDiskSpace(requiredBytes);
      }
    } catch (spaceError) {
      if (spaceError instanceof HttpError) return json(res, spaceError.status, { error: spaceError.message });
      return json(res, 507, { error: safeErrorMessage(spaceError) });
    }

    job.autoResumeCount = 0;
    job._spaceChecked = true;
    retryFailedJob(job, auth);
    return json(res, 202, safeJobForClient(job));
  }

  if (url.pathname === '/api/downloads/active') {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    const active = getActiveJob();
    if (!active) {
      return json(res, 404, { error: 'Нет активной загрузки.' });
    }
    return json(res, 200, safeJobForClient(active));
  }

  const eventsMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)\/events$/);
  if (eventsMatch || url.pathname === '/api/downloads/events') {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    const targetId = eventsMatch ? eventsMatch[1] : (url.searchParams.get('id') || getActiveJob()?.id);
    if (!targetId) {
      return json(res, 400, { error: 'Не указан идентификатор загрузки.' });
    }
    const job = jobs.get(targetId);
    if (!job) {
      return json(res, 404, { error: 'Загрузка не найдена.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`retry: 1500\n\ndata: ${JSON.stringify(safeJobForClient(job))}\n\n`);

    /** @param {any} updatedJob */
    const onJobUpdate = (updatedJob) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(safeJobForClient(updatedJob))}\n\n`);
      } catch {}
      if (['finished', 'finished_with_errors', 'cancelled'].includes(updatedJob.status)) {
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
        }, 1000);
      }
    };

    jobEvents.on(`job:${job.id}`, onJobUpdate);

    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      try {
        const hasCooldowns = MIRRORS.some(m => mirrorCooldownRemaining(m) > 0);
        if (job.status === 'paused' || hasCooldowns) {
          res.write(`data: ${JSON.stringify(safeJobForClient(job))}\n\n`);
        } else {
          res.write(': ping\n\n');
        }
      } catch {
        clearInterval(timer);
      }
    }, 1000);
    timer.unref();

    const cleanup = () => {
      clearInterval(timer);
      jobEvents.off(`job:${job.id}`, onJobUpdate);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)\/cancel$/);
  if (cancelMatch) {
    if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
    const job = jobs.get(cancelMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    if (['running', 'queued', 'paused', 'finished_with_errors'].includes(job.status)) {
      job.status = 'cancelled';
      clearAutoResume(job);
      job.abortController?.abort();
      if (job.retryOnlyIds) {
        for (const id of job.retryOnlyIds) {
          if (!job.doneIds?.has(id) && !job.skipIds?.has(id) && !job.errIds?.has(id)) {
            job.errIds?.add(id);
            if (job.errorsById && !job.errorsById.has(id)) {
              const name = job.mapsById?.get(id)?.label || `Набор ${id}`;
              job.errorsById.set(id, { id, name, error: 'Загрузка отменена' });
            }
          }
        }
        delete job.retryOnlyIds;
      }
      job.message = 'Загрузка остановлена.';
      job.finishedAt = Date.now();
      if (getActiveJob() === job) setActiveJob(null);
      emitJobUpdate(job, true);
      void scheduleSaveState(true);
      log('warn', 'download.job.cancelled', { jobId: job.id, completed: jobCounters(job).completed, total: job.setIds.length });
      void cleanupJobPartFiles(job);
    }
    return json(res, 200, safeJobForClient(job));
  }

  const jobMatch = url.pathname.match(/^\/api\/downloads\/([a-f0-9]+)$/);
  if (jobMatch) {
    if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
    return json(res, 200, safeJobForClient(job));
  }

  return json(res, 404, { error: 'API-маршрут не найден.' });
}

const server = http.createServer(async (req, res) => {
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

  if (!ensureLocalRequest(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (bootstrapPromise) {
    try {
      await bootstrapPromise;
    } catch (bootErr) {
      log('error', 'server.bootstrap_pending_failed', { error: safeErrorMessage(bootErr) });
      return json(res, 503, { error: 'Сервер инициализируется, повторите запрос позже.' });
    }
  }

  try {
    if (url.pathname === '/oauth/callback') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET' });
        return res.end('Method not allowed');
      }
      return await handleOauthCallback(req, res, url);
    }

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/favicon.ico') {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
        return res.end('Method not allowed');
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (['/', '/index.html', '/app.js'].includes(url.pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
        return res.end('Method not allowed');
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
    json(res, status, { error: safeErrorMessage(error) || 'Внутренняя ошибка.' });
  }
});

// Периодическая очистка устаревших кешей и сессий
setInterval(() => {
  pruneCollectionCache();
  pruneSessionsAndOauth();
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
 * @returns {Promise<import('node:http').Server>}
 */
async function startServer(port = PORT, host = HOST) {
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
        url: `http://${host}:${port}`,
        node: process.version,
        downloadsDirectory: getDownloadsDir(),
        oauthCallback: CALLBACK_URL,
        oauthEnabled: ENABLE_OAUTH,
        oauthConfigured: oauthConfigured(),
        downloadMirrors: MIRRORS.map(mirror => mirror.id),
      });
      log('info', 'server.hint', { hint: `Скачивание идёт через зеркала: ${MIRRORS.map(mirror => mirror.label).join(', ')}.${ENABLE_OAUTH ? ' OAuth включён.' : ' OAuth отключён флагом (ENABLE_OAUTH=1 для включения).'}` });
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
      oauthStates.clear();
      for (const job of jobs.values()) {
        if (['queued', 'running'].includes(job.status)) {
          job.status = 'paused';
          job.message = 'Сервер остановлен — задача приостановлена. Нажмите «Продолжить» при следующем запуске.';
          job.pausedAt = Date.now();
        }
        job.abortController?.abort();
        clearAutoResume(job);
      }
      await waitForPendingSaveState().catch(() => {});
      await saveStateToDisk().catch(() => {});
      await cleanupStalePartFiles().catch(() => {});
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
  getDownloadsDir,
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
  redirectHostAllowed,
  downloadFromMirrors,
  downloadSet,
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
  oauthConfig,
  oauthToken,
  oauthStates,
  storeOsuToken,
  pruneSessionsAndOauth,
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
};
