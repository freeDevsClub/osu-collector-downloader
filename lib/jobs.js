// @ts-check
"use strict";

const fs = require('node:fs');
const path = require('node:path');
const {
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  DOWNLOAD_DELAY_MS,
  DOWNLOAD_CONCURRENCY,
  log,
  HttpError,
  sleep,
  sleepWithSignal,
} = require('./config.js');
const { safeErrorMessage } = require('./security.js');
const {
  MIRRORS,
  mirrorCooldownRemaining,
  mirrorResumeWaitMs,
  resetMirrorSlots,
  OAuthDownloadScopeError,
} = require('./mirrors.js');
const {
  jobFilePath,
  isValidZipOnDisk,
  isNoSpaceError,
  downloadSet,
  downloadFromMirrors,
  cleanupJobPartFiles,
  ensureDiskSpace,
  estimateRequiredDiskSpace,
} = require('./downloader.js');
const { ensureOsuToken } = require('./oauth.js');

const jobs = new Map();
let activeJob = null;

function getActiveJob() {
  return activeJob;
}

function setActiveJob(job) {
  activeJob = job;
}

/**
 * Рассчитывает статистику и процент выполнения задачи.
 * @param {any} job
 * @returns {any}
 */
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

/**
 * Подготавливает безопасный для передачи на фронтенд JSON-снимок состояния задачи.
 * @param {any} job
 * @returns {any}
 */
function safeJobForClient(job) {
  const counters = jobCounters(job);
  const currentMap = job.mapsById.get(job.currentSetId);

  let currentBytes = job.currentBytes ?? 0;
  let currentTotalBytes = job.currentTotalBytes ?? null;
  let currentPercent = job.currentPercent ?? null;
  let currentSetName = currentMap?.label || null;
  let currentMirror = job.currentMirror || null;
  let currentSetId = job.currentSetId ?? null;

  if (job.activeTransfers && job.activeTransfers.size > 0) {
    const transfers = Array.from(job.activeTransfers.values());
    if (transfers.length === 1) {
      const t = transfers[0];
      currentSetId = t.setId;
      currentSetName = t.setName;
      currentMirror = t.mirror;
      currentBytes = t.bytes;
      currentTotalBytes = t.totalBytes;
      currentPercent = t.totalBytes ? Math.min(100, Math.floor(t.bytes / t.totalBytes * 100)) : null;
    } else {
      let sumBytes = 0;
      let sumTotal = 0;
      let allTotalKnown = true;
      const mirrors = [];
      const names = [];

      for (const t of transfers) {
        sumBytes += t.bytes || 0;
        if (Number.isSafeInteger(t.totalBytes) && t.totalBytes > 0) {
          sumTotal += t.totalBytes;
        } else {
          allTotalKnown = false;
        }
        if (t.mirror && !mirrors.includes(t.mirror)) mirrors.push(t.mirror);
        if (t.setName) names.push(t.setName);
      }

      currentBytes = sumBytes;
      currentTotalBytes = allTotalKnown ? sumTotal : null;
      currentPercent = currentTotalBytes ? Math.min(100, Math.floor(currentBytes / currentTotalBytes * 100)) : null;
      currentMirror = mirrors.join(', ');
      currentSetId = transfers[0].setId;
      currentSetName = `${transfers.length} набора параллельно (${names.slice(0, 2).join(' · ')}${names.length > 2 ? '…' : ''})`;
    }
  }

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
    currentSetId,
    currentSetName,
    currentMirror,
    autoResumeAt: job.autoResumeAt || null,
    autoResumeAttempts: job.autoResumeCount || 0,
    currentBytes,
    currentTotalBytes,
    currentPercent,
    status: job.status,
    message: job.message,
    errors: Array.from(job.errorsById?.values() || []).slice(0, 300),
    mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
  };
}

function clearAutoResume(job) {
  if (job.autoResumeTimer) clearTimeout(job.autoResumeTimer);
  job.autoResumeTimer = null;
  job.autoResumeAt = null;
}

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

function resumeJob(job, auth, trigger = 'manual') {
  clearAutoResume(job);
  if (activeJob && activeJob !== job && ['queued', 'running'].includes(activeJob.status)) {
    log('warn', 'download.job.resume_conflict', { jobId: job.id, activeJobId: activeJob.id });
    return;
  }
  activeJob = job;
  job.status = 'queued';
  job.extraFailures = 0;
  job.currentBytes = 0;
  job.currentTotalBytes = null;
  job.currentPercent = 0;
  job.currentSetId = null;
  job.currentMirror = null;
  job.abortController = null;
  if (job.activeTransfers) job.activeTransfers.clear();
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

/**
 * Основной цикл фонового процесса скачивания наборов задачи.
 * @param {any} job
 * @param {any} auth
 * @returns {Promise<void>}
 */
async function runJob(job, auth) {
  try {
    const requiredBytes = await estimateRequiredDiskSpace(job.setIds);
    await ensureDiskSpace(requiredBytes);
  } catch (spaceError) {
    job.status = 'finished_with_errors';
    const errMessage = safeErrorMessage(spaceError);
    job.message = `Не удалось запустить загрузку: ${errMessage}`;
    job.finishedAt = Date.now();
    log('error', 'download.job.disk_space_failed', { jobId: job.id, error: errMessage });
    if (activeJob === job) activeJob = null;
    return;
  }

  job.status = 'running';
  job.message = 'Загрузка beatmap-наборов…';
  job.activeTransfers = new Map();
  job.abortController = new AbortController();
  log('info', 'download.job.started', { jobId: job.id, method: job.method, total: job.setIds.length });

  let stopAfterCurrent = false;
  let stopForCooldown = false;
  let stopForNoSpace = false;
  const deferredSetIds = new Set();

  const concurrency = (job.method === 'mirror' && auth.kind === 'mirror')
    ? Math.max(1, DOWNLOAD_CONCURRENCY)
    : 1;

  let queueIndex = 0;

  async function runWorker(workerIndex) {
    let lastWorkerRequest = 0;

    while (true) {
      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;

      let setId = null;
      while (queueIndex < job.setIds.length) {
        const candidateId = job.setIds[queueIndex++];
        if (!job.doneIds.has(candidateId) && !job.skipIds.has(candidateId)) {
          setId = candidateId;
          break;
        }
      }
      if (setId == null) break;

      const filePath = jobFilePath(setId);
      try {
        const existing = await fs.promises.stat(filePath);
        if (existing.size > 0) {
          const isComplete = await isValidZipOnDisk(filePath);
          if (isComplete) {
            job.skipIds.add(setId);
            job.errIds.delete(setId);
            job.errorsById?.delete(setId);
            log('info', 'map.download.skipped', { jobId: job.id, beatmapsetId: setId, reason: 'file already exists', sizeBytes: existing.size });
            continue;
          } else {
            log('warn', 'map.download.existing_file_unverified', { jobId: job.id, beatmapsetId: setId, file: path.basename(filePath), sizeBytes: existing.size });
          }
        }
      } catch {}

      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;

      if (auth.kind !== 'mirror') {
        const delay = DOWNLOAD_DELAY_MS - (Date.now() - lastWorkerRequest);
        if (lastWorkerRequest && delay > 0) {
          await sleepWithSignal(delay, job.abortController?.signal);
        }
      }

      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;

      const mapInfo = job.mapsById?.get(setId);
      /** @type {any} */
      const transferEntry = {
        setId,
        setName: mapInfo?.label || `Набор ${setId}`,
        mirror: null,
        bytes: 0,
        totalBytes: null,
      };
      job.activeTransfers?.set(setId, transferEntry);

      job.currentSetId = setId;
      job.currentBytes = 0;
      job.currentTotalBytes = null;
      job.currentPercent = 0;

      try {
        if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
        if (auth.kind === 'mirror') await downloadFromMirrors(setId, job, { workerIndex });
        else await downloadSet(setId, auth, job);
      } catch (error) {
        const err = /** @type {any} */ (error);
        if (job.status !== 'cancelled' && !job.abortController?.signal?.aborted) {
          if (isNoSpaceError(error)) {
            job.message = `Набор ${setId}: на диске закончилось свободное место (ENOSPC). Загрузка приостановлена — освободите место и нажмите «Продолжить».`;
            stopForNoSpace = true;
            log('error', 'download.job.enospc', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
          } else if (err.allCooldown) {
            job.message = `Все зеркала временно ограничили загрузки (HTTP 429). Загрузка приостановлена — повторите позже, готовые файлы будут пропущены.`;
            stopForCooldown = true;
            log('warn', 'download.job.all_cooldown', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
          } else if (err.deferSet) {
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
        job.activeTransfers?.delete(setId);
        lastWorkerRequest = Date.now();
      }
    }
  }

  try {
    const workerPromises = [];
    const actualConcurrency = Math.min(concurrency, job.setIds.length || 1);
    for (let i = 0; i < actualConcurrency; i++) {
      workerPromises.push(runWorker(i));
    }
    await Promise.all(workerPromises);

    // Второй проход: пробуем заново наборы, которые были отложены из-за остывания зеркал
    if (job.status !== 'cancelled' && !job.abortController?.signal?.aborted && !stopAfterCurrent && !stopForCooldown && !stopForNoSpace && deferredSetIds.size > 0) {
      log('info', 'download.job.retry_deferred_started', { jobId: job.id, count: deferredSetIds.size });
      const deferredQueue = Array.from(deferredSetIds);
      let deferredQueueIndex = 0;

      async function runDeferredWorker(workerIndex) {
        let lastDeferredRequest = 0;
        while (true) {
          if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
          if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;

          let setId = null;
          while (deferredQueueIndex < deferredQueue.length) {
            const candidateId = deferredQueue[deferredQueueIndex++];
            if (!job.doneIds.has(candidateId) && !job.skipIds.has(candidateId)) {
              setId = candidateId;
              break;
            }
          }
          if (setId == null) break;

          if (auth.kind !== 'mirror') {
            const delay = DOWNLOAD_DELAY_MS - (Date.now() - lastDeferredRequest);
            if (lastDeferredRequest && delay > 0) {
              await sleepWithSignal(delay, job.abortController?.signal);
            }
          }

          if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
          if (stopAfterCurrent || stopForCooldown || stopForNoSpace) break;

          const mapInfo = job.mapsById?.get(setId);
          /** @type {any} */
          const transferEntry = {
            setId,
            setName: mapInfo?.label || `Набор ${setId}`,
            mirror: null,
            bytes: 0,
            totalBytes: null,
          };
          job.activeTransfers?.set(setId, transferEntry);

          job.currentSetId = setId;
          job.currentBytes = 0;
          job.currentTotalBytes = null;
          job.currentPercent = 0;

          try {
            if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
            if (auth.kind === 'mirror') await downloadFromMirrors(setId, job, { workerIndex });
            else await downloadSet(setId, auth, job);
            deferredSetIds.delete(setId);
          } catch (error) {
            const err = /** @type {any} */ (error);
            if (job.status !== 'cancelled' && !job.abortController?.signal?.aborted) {
              if (isNoSpaceError(error)) {
                job.message = `Набор ${setId}: на диске закончилось свободное место (ENOSPC). Загрузка приостановлена — освободите место и нажмите «Продолжить».`;
                stopForNoSpace = true;
                log('error', 'download.job.enospc', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
                break;
              } else if (err.allCooldown || err.deferSet) {
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
            job.activeTransfers?.delete(setId);
            lastDeferredRequest = Date.now();
          }
        }
      }

      const deferredPromises = [];
      const actualDeferredConcurrency = Math.min(concurrency, deferredQueue.length || 1);
      for (let i = 0; i < actualDeferredConcurrency; i++) {
        deferredPromises.push(runDeferredWorker(i));
      }
      await Promise.all(deferredPromises);
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
    log('error', 'download.job.fatal_error', { jobId: job.id, error: errMessage, stack: /** @type {any} */ (fatalError)?.stack });
  } finally {
    job.currentSetId = null;
    job.currentMirror = null;
    job.abortController = null;
    if (job.activeTransfers) job.activeTransfers.clear();
    await cleanupJobPartFiles(job).catch(() => {});
    if (activeJob === job && !['queued', 'running', 'paused'].includes(job.status)) {
      activeJob = null;
    }
  }
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (['finished', 'finished_with_errors', 'cancelled'].includes(job.status) && job.finishedAt && now - job.finishedAt > 30 * 60 * 1000) {
      if (activeJob === job) activeJob = null;
      jobs.delete(id);
    }
  }
}

module.exports = {
  jobs,
  getActiveJob,
  setActiveJob,
  jobCounters,
  safeJobForClient,
  clearAutoResume,
  scheduleAutoResume,
  resumeJob,
  launchJob,
  runJob,
  pruneJobs,
};
