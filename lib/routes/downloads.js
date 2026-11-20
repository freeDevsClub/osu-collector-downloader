// @ts-check
"use strict";

const { json, log, HttpError } = require('../config.js');
const { safeErrorMessage, getSession } = require('../security.js');
const { readJson, handleMethodNotAllowed } = require('./helpers.js');
const { createJob } = require('../job.js');
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
  scheduleSaveState,
} = require('../jobs.js');
const {
  cleanupJobPartFiles,
  ensureDiskSpace,
  estimateRequiredDiskSpace,
} = require('../downloader.js');
const { MIRRORS, mirrorCooldownRemaining } = require('../mirrors.js');
const {
  extractCollectionId,
  parseSetIds,
  fallbackMapInfo,
  collectionCache,
} = require('../collector.js');

/**
 * Определяет параметры аутентификации для задачи (зеркала, session).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ method: string }} job
 * @returns {Promise<any>}
 */
async function resolveJobAuth(req, job) {
  if (job.method === 'mirror') {
    return { kind: 'mirror' };
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
 * Обработчик POST /api/downloads (создание и запуск новой загрузки).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleCreateDownload(req, res, url) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const body = await readJson(req);
  const requestedMethod = url.searchParams.get('method') || (typeof body?.method === 'string' ? body.method : null);
  const method = requestedMethod === 'session' ? 'session' : 'mirror';

  let auth;
  try {
    auth = await resolveJobAuth(req, { method });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    return json(res, 401, { error: safeErrorMessage(error) });
  }

  const currentActive = getActiveJob();
  if (currentActive && ['preparing', 'queued', 'running'].includes(currentActive.status)) {
    return json(res, 409, { error: 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».' });
  }

  const noVideoParam = url.searchParams.get('noVideo');
  const noVideo = noVideoParam === '1' || noVideoParam === 'true' || body?.noVideo === true || body?.noVideo === 1 || body?.noVideo === '1';
  let collectionId;
  try {
    collectionId = extractCollectionId(body?.url);
  } catch (extractError) {
    if (extractError instanceof HttpError) return json(res, extractError.status, { error: extractError.message });
    return json(res, 400, { error: safeErrorMessage(extractError) });
  }

  if (currentActive && currentActive.status === 'paused') {
    if (currentActive.collectionId === collectionId) {
      return await resumePausedJobWithSettings(res, currentActive, auth, method, noVideo, 'manual');
    }
    return json(res, 409, { error: `Уже на паузе загрузка другой коллекции («${currentActive.collectionName}») — нажмите «Остановить», чтобы начать новую.` });
  }

  // Проверяем, есть ли уже данные коллекции в кеше памяти
  const cached = collectionCache.get(collectionId);
  let setIds = [];
  let collectionName = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : `Коллекция ${collectionId}`;
  let mapsById = new Map();
  let isPrepared = false;

  if (cached?.data) {
    const cachedSets = parseSetIds(cached.data);
    if (cachedSets.length === 0) {
      return json(res, 400, { error: 'В коллекции нет доступных наборов.' });
    }
    setIds = cachedSets;
    if (typeof cached.data.name === 'string') collectionName = cached.data.name;
    if (cached.data.mapsById) mapsById = cached.data.mapsById;
    else if (cached.data.maps) mapsById = new Map(cached.data.maps.map(m => [m.id, m]));
    else mapsById = new Map(fallbackMapInfo(setIds).map(m => [m.id, m]));
    isPrepared = true;
  }

  const job = createJob({
    method,
    noVideo,
    collectionId,
    collectionName,
    setIds,
    mapsById,
    abortController: new AbortController(),
    status: 'preparing',
    message: isPrepared ? 'Подготовка к загрузке…' : 'Получение списка карт из osu!Collector…',
    _prepared: isPrepared,
  });
  setActiveJob(job);
  jobs.set(job.id, job);

  log('info', 'download.job.created', {
    jobId: job.id,
    method,
    noVideo,
    mirrors: method === 'mirror' ? MIRRORS.map(mirror => mirror.id) : undefined,
    collectionId,
    collectionName: job.collectionName,
    total: setIds.length,
  });

  launchJob(job, auth);
  void scheduleSaveState(true);
  return json(res, 202, safeJobForClient(job));
}

/**
 * Обработчик GET /api/downloads/active (получение активной задачи).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleGetActiveDownload(req, res, url) {
  if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
  const active = getActiveJob();
  if (!active) {
    return json(res, 404, { error: 'Нет активной загрузки.' });
  }
  return json(res, 200, safeJobForClient(active));
}

/**
 * Обработчик GET /api/downloads/events и GET /api/downloads/:id/events (SSE-стриминг прогресса).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleDownloadEvents(req, res, url, params) {
  if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
  const targetId = params?.id || url.searchParams.get('id') || getActiveJob()?.id;
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

  /** @param {any} updatedJob
   *  @param {any} [meta] */
  const onJobUpdate = (updatedJob, meta) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      const isByteTick = Boolean(meta?.byteTick);
      res.write(`data: ${JSON.stringify(safeJobForClient(updatedJob, { byteTick: isByteTick }))}\n\n`);
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
}

/**
 * Обработчик POST /api/downloads/:id/resume (продолжение задачи).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleResumeDownload(req, res, url, params) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const jobId = params?.id;
  if (!jobId) return json(res, 400, { error: 'Не указан идентификатор загрузки.' });
  const job = jobs.get(jobId);
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

  const body = await readJson(req).catch(err => {
    if (err instanceof HttpError && err.status === 413) throw err;
    return {};
  });
  const requestedMethod = url.searchParams.get('method') || (typeof body?.method === 'string' ? body.method : null);
  const method = requestedMethod && ['mirror', 'session'].includes(requestedMethod)
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

/**
 * Обработчик POST /api/downloads/:id/retry-failed (повтор карт с ошибками).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleRetryFailedDownload(req, res, url, params) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const jobId = params?.id;
  if (!jobId) return json(res, 400, { error: 'Не указан идентификатор загрузки.' });
  const job = jobs.get(jobId);
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
  if (requestedMethod && ['mirror', 'session'].includes(requestedMethod)) {
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
        return json(res, 503, {
          error: `Зеркала ещё остывают после ограничения — попробуйте через ${Math.ceil(waitMs / 1000)} с.`
        }, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
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

/**
 * Обработчик POST /api/downloads/:id/cancel (отмена задачи).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleCancelDownload(req, res, url, params) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const jobId = params?.id;
  if (!jobId) return json(res, 400, { error: 'Не указан идентификатор загрузки.' });
  const job = jobs.get(jobId);
  if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });

  if (['preparing', 'running', 'queued', 'paused', 'finished_with_errors'].includes(job.status)) {
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

/**
 * Обработчик GET /api/downloads/:id (получение статуса задачи по ID).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleGetDownload(req, res, url, params) {
  if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
  const jobId = params?.id;
  if (!jobId) return json(res, 400, { error: 'Не указан идентификатор загрузки.' });
  const job = jobs.get(jobId);
  if (!job) return json(res, 404, { error: 'Загрузка не найдена.' });
  return json(res, 200, safeJobForClient(job));
}

/**
 * Регистрирует маршруты загрузок в роутере.
 * Порядок регистрации гарантирует, что статические и суффиксные маршруты
 * сопоставляются до общего /api/downloads/:id.
 * @param {import('../router.js').Router} router
 */
function registerDownloadRoutes(router) {
  // Точные статические маршруты:
  router.exact('/api/downloads', handleCreateDownload);
  router.exact('/api/downloads/active', handleGetActiveDownload);
  router.exact('/api/downloads/events', handleDownloadEvents);

  // Параметризованные подмаршруты (действия над задачей):
  router.pattern('/api/downloads/:id/events', handleDownloadEvents);
  router.pattern('/api/downloads/:id/resume', handleResumeDownload);
  router.pattern('/api/downloads/:id/retry-failed', handleRetryFailedDownload);
  router.pattern('/api/downloads/:id/cancel', handleCancelDownload);

  // Общий маршрут получения задачи по ID:
  router.pattern('/api/downloads/:id', handleGetDownload);
}

module.exports = {
  resolveJobAuth,
  resumePausedJobWithSettings,
  handleCreateDownload,
  handleGetActiveDownload,
  handleDownloadEvents,
  handleResumeDownload,
  handleRetryFailedDownload,
  handleCancelDownload,
  handleGetDownload,
  registerDownloadRoutes,
};

