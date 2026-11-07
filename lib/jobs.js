// @ts-check
"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  DOWNLOAD_DELAY_MS,
  DOWNLOAD_CONCURRENCY,
  getDownloadsDir,
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
const {
  isSetInOsuSongs,
  handlePostDownload,
  getSettings: getOsuSettings,
} = require('./osu.js');

const jobs = new Map();
let activeJob = null;

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

/**
 * Уведомляет подписчиков об обновлении задачи (с троттлингом для частых байтовых событий).
 * @param {any} job
 * @param {boolean} [immediate=false]
 */
function emitJobUpdate(job, immediate = false) {
  if (!job?.id) return;
  const now = Date.now();
  if (!immediate && job._lastEmit && now - job._lastEmit < 100) {
    if (!job._emitTimer) {
      job._emitTimer = setTimeout(() => {
        job._emitTimer = null;
        job._lastEmit = Date.now();
        jobEvents.emit(`job:${job.id}`, job);
        jobEvents.emit('job', job);
      }, 100);
    }
    return;
  }
  if (job._emitTimer) {
    clearTimeout(job._emitTimer);
    job._emitTimer = null;
  }
  job._lastEmit = now;
  jobEvents.emit(`job:${job.id}`, job);
  jobEvents.emit('job', job);
}

function getActiveJob() {
  return activeJob;
}

function setActiveJob(job) {
  activeJob = job;
}

/**
 * Возвращает путь к файлу сохранения состояния очереди (.state.json).
 * @returns {string}
 */
function getStateFilePath() {
  return path.join(getDownloadsDir(), '.state.json');
}

/**
 * Атомарно записывает данные в файл через временный файл и переименование.
 * @param {string} filePath
 * @param {string} data
 * @returns {Promise<void>}
 */
async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, data, 'utf8');
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch {
      await fs.promises.unlink(filePath).catch(() => {});
      await fs.promises.rename(tempPath, filePath);
    }
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Сериализует объект задачи в плоский JSON-совместимый объект для сохранения на диск.
 * @param {any} job
 * @returns {any}
 */
function serializeJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id,
    method: job.method,
    noVideo: Boolean(job.noVideo),
    collectionId: job.collectionId,
    collectionName: job.collectionName,
    setIds: Array.isArray(job.setIds) ? job.setIds : [],
    doneIds: Array.from(job.doneIds || []),
    skipIds: Array.from(job.skipIds || []),
    errIds: Array.from(job.errIds || []),
    errors: Array.from(job.errorsById?.values() || []),
    extraFailures: Number(job.extraFailures || 0),
    maps: Array.from(job.mapsById?.values() || []).map(m => ({
      id: m.id,
      label: m.label || (m.artist ? `${m.artist} - ${m.title}` : `Набор ${m.id}`),
    })),
    status: job.status,
    message: job.message || '',
    autoResumeCount: Number(job.autoResumeCount || 0),
    retryOnlyIds: job.retryOnlyIds ? Array.from(job.retryOnlyIds) : null,
    createdAt: job.createdAt || Date.now(),
    pausedAt: job.pausedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

/**
 * Восстанавливает объект задачи из сохранённого JSON-объекта.
 * @param {any} data
 * @returns {any}
 */
function deserializeJob(data) {
  if (!data || typeof data !== 'object' || !data.id || !Array.isArray(data.setIds)) {
    return null;
  }
  const doneIds = new Set(Array.isArray(data.doneIds) ? data.doneIds.map(Number) : []);
  const skipIds = new Set(Array.isArray(data.skipIds) ? data.skipIds.map(Number) : []);
  const errIds = new Set(Array.isArray(data.errIds) ? data.errIds.map(Number) : []);

  /** @type {Map<string|number, any>} */
  const errorsById = new Map();
  if (Array.isArray(data.errors)) {
    for (const err of data.errors) {
      if (err && err.id != null) {
        errorsById.set(err.id, err);
      }
    }
  }

  /** @type {Map<number, any>} */
  const mapsById = new Map();
  if (Array.isArray(data.maps)) {
    for (const m of data.maps) {
      if (m && m.id != null) {
        mapsById.set(Number(m.id), m);
      }
    }
  }

  let status = data.status || 'paused';
  let message = data.message || '';
  let pausedAt = data.pausedAt || null;

  // Если сервер был перезапущен во время выполнения задачи (running или queued),
  // она безопасно переводится в статус paused, чтобы пользователь мог нажать «Продолжить».
  if (['running', 'queued'].includes(status)) {
    status = 'paused';
    message = 'Сервер был перезапущен — задача приостановлена. Нажмите «Продолжить».';
    pausedAt = Date.now();
  }

  const job = {
    id: String(data.id),
    method: data.method === 'session' ? 'session' : data.method === 'oauth' ? 'oauth' : 'mirror',
    noVideo: Boolean(data.noVideo),
    collectionId: String(data.collectionId || ''),
    collectionName: String(data.collectionName || `Коллекция ${data.collectionId || ''}`),
    setIds: data.setIds.map(Number),
    doneIds,
    skipIds,
    errIds,
    errorsById,
    extraFailures: Number(data.extraFailures || 0),
    mapsById,
    currentBytes: 0,
    currentTotalBytes: null,
    currentPercent: 0,
    currentMirror: null,
    currentSetId: null,
    status,
    message,
    autoResumeAt: null,
    autoResumeCount: Number(data.autoResumeCount || 0),
    autoResumeTimer: null,
    abortController: null,
    activeTransfers: new Map(),
    createdAt: data.createdAt || Date.now(),
    pausedAt,
    finishedAt: data.finishedAt || null,
  };

  if (Array.isArray(data.retryOnlyIds) && data.retryOnlyIds.length > 0) {
    job.retryOnlyIds = new Set(data.retryOnlyIds.map(Number));
  }

  return job;
}

/**
 * Формирует полный снимок очереди задач для записи в файл состояния.
 * @returns {any}
 */
function serializeState() {
  const serializedJobs = [];
  for (const job of jobs.values()) {
    const s = serializeJob(job);
    if (s) serializedJobs.push(s);
  }
  return {
    version: 1,
    savedAt: Date.now(),
    activeJobId: activeJob?.id || null,
    jobs: serializedJobs,
  };
}

let isSaving = false;
let pendingSave = false;
/** @type {NodeJS.Timeout | null} */
let saveStateTimer = null;

/**
 * Сохраняет текущее состояние всех задач на диск в файл downloads/.state.json.
 * @returns {Promise<void>}
 */
async function saveStateToDisk() {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  try {
    do {
      pendingSave = false;
      const statePath = getStateFilePath();
      const stateData = serializeState();
      await atomicWriteFile(statePath, JSON.stringify(stateData, null, 2));
    } while (pendingSave);
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    const level = (code === 'ENOENT') ? 'debug' : 'error';
    log(level, 'download.state.save_failed', { error: safeErrorMessage(error) });
  } finally {
    isSaving = false;
  }
}

/**
 * Очищает отложенный таймер сохранения состояния.
 */
function clearSaveStateTimer() {
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
  }
}

/**
 * Планирует сохранение состояния очереди на диск (с троттлингом до 1 с при потоковом скачивании).
 * @param {boolean} [immediate=false]
 * @returns {Promise<void>}
 */
async function scheduleSaveState(immediate = false) {
  if (immediate) {
    clearSaveStateTimer();
    return saveStateToDisk();
  }
  if (saveStateTimer) return;
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    void saveStateToDisk();
  }, 1000);
  if (saveStateTimer && typeof saveStateTimer.unref === 'function') {
    saveStateTimer.unref();
  }
}

/**
 * Считывает состояние очереди с диска (downloads/.state.json) и восстанавливает задачи в память.
 * @returns {Promise<boolean>} Возвращает true, если задачи были успешно восстановлены.
 */
async function loadStateFromDisk() {
  const statePath = getStateFilePath();
  try {
    const raw = await fs.promises.readFile(statePath, 'utf8');
    if (!raw.trim()) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.jobs)) return false;

    let restoredCount = 0;
    let foundActive = null;

    for (const item of data.jobs) {
      const job = deserializeJob(item);
      if (job) {
        jobs.set(job.id, job);
        restoredCount++;
        if (data.activeJobId && job.id === data.activeJobId) {
          foundActive = job;
        } else if (!foundActive && ['queued', 'running', 'paused'].includes(job.status)) {
          foundActive = job;
        }
      }
    }

    if (foundActive) {
      setActiveJob(foundActive);
    } else if (data.activeJobId && jobs.has(data.activeJobId)) {
      setActiveJob(jobs.get(data.activeJobId));
    }

    log('info', 'download.state.loaded', {
      file: statePath,
      jobsCount: restoredCount,
      activeJobId: getActiveJob()?.id || null,
    });

    // Сохраняем актуализированное состояние (перевод незавершённых задач в paused)
    await scheduleSaveState(true);
    return true;
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err.code === 'ENOENT') {
      return false; // Файл ещё не создан — нормальная ситуация при первом запуске
    }
    log('warn', 'download.state.corrupted', { file: statePath, error: safeErrorMessage(error) });
    return false;
  }
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
  const currentMap = job.mapsById?.get(job.currentSetId);

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
    noVideo: Boolean(job.noVideo),
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
    canRetryFailed: counters.failed > 0 && !['queued', 'running'].includes(job.status),
    mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
  };
}

function clearAutoResume(job) {
  if (job.autoResumeTimer) clearTimeout(job.autoResumeTimer);
  job.autoResumeTimer = null;
  job.autoResumeAt = null;
  emitJobUpdate(job, true);
  void scheduleSaveState(false);
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
  emitJobUpdate(job, true);
  void scheduleSaveState(false);
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
  job.notifyUpdate = (immediate = false) => emitJobUpdate(job, immediate);
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
  emitJobUpdate(job, true);
  void scheduleSaveState(true);
  log('info', trigger === 'auto' ? 'download.job.auto_resumed' : 'download.job.resumed', {
    jobId: job.id,
    method: job.method,
    total: job.setIds.length,
    attempt: job.autoResumeCount || 0,
  });
  launchJob(job, auth);
}

function launchJob(job, auth) {
  setActiveJob(job);
  job.notifyUpdate = (immediate = false) => emitJobUpdate(job, immediate);
  emitJobUpdate(job, true);
  void scheduleSaveState(true);
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
      emitJobUpdate(job, true);
      void scheduleSaveState(true);
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
    if (job.status === 'cancelled') {
      return;
    }
    const setsToCheck = job.retryOnlyIds ? Array.from(job.retryOnlyIds) : job.setIds;
    try {
      const osuSettings = getOsuSettings();
      const checkOsu = Boolean(osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting);
      const setsToDownload = setsToCheck.filter(id => {
        if (job.doneIds?.has(id) || job.skipIds?.has(id)) return false;
        const filePath = jobFilePath(id);
        try {
          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return false;
        } catch {}
        if (checkOsu && isSetInOsuSongs(id)) return false;
        return true;
      });
      const requiredBytes = setsToDownload.length > 0 ? await estimateRequiredDiskSpace(setsToDownload, job.noVideo) : 0;
      if (requiredBytes > 0) {
        await ensureDiskSpace(requiredBytes);
      }
    } catch (spaceError) {
      job.status = 'finished_with_errors';
      const errMessage = safeErrorMessage(spaceError);
      job.message = `Не удалось запустить загрузку: ${errMessage}`;
      job.finishedAt = Date.now();
      log('error', 'download.job.disk_space_failed', { jobId: job.id, error: errMessage });
      if (activeJob === job) activeJob = null;
      return;
    }

    if (job.status === 'cancelled') {
      emitJobUpdate(job, true);
      return;
    }

    job.status = 'running';
    job.message = 'Загрузка beatmap-наборов…';
    job.activeTransfers = new Map();
    job.abortController = new AbortController();
    log('info', 'download.job.started', { jobId: job.id, method: job.method, total: job.setIds.length });
    emitJobUpdate(job, true);

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
        if (job.retryOnlyIds && !job.retryOnlyIds.has(candidateId)) {
          continue;
        }
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
            emitJobUpdate(job, true);
            log('info', 'map.download.skipped', { jobId: job.id, beatmapsetId: setId, reason: 'file already exists', sizeBytes: existing.size });
            continue;
          } else {
            log('warn', 'map.download.existing_file_unverified', { jobId: job.id, beatmapsetId: setId, file: path.basename(filePath), sizeBytes: existing.size });
          }
        }
      } catch {}

      const osuSettings = getOsuSettings();
      if (osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting && isSetInOsuSongs(setId)) {
        job.skipIds.add(setId);
        job.errIds.delete(setId);
        job.errorsById?.delete(setId);
        emitJobUpdate(job, true);
        log('info', 'map.download.skipped', { jobId: job.id, beatmapsetId: setId, reason: 'already installed in osu! Songs' });
        continue;
      }

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
      emitJobUpdate(job, true);

      try {
        if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
        if (auth.kind === 'mirror') await downloadFromMirrors(setId, job, { workerIndex });
        else await downloadSet(setId, auth, job);

        try {
          await handlePostDownload(setId, job);
        } catch (postError) {
          log('warn', 'map.post_download.failed', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(postError) });
        }
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
              name: job.mapsById?.get(setId)?.label || `Набор ${setId}`,
              error: errMessage,
            });
            if (error instanceof OAuthDownloadScopeError) stopAfterCurrent = true;
            log('error', 'map.download.failed', { jobId: job.id, beatmapsetId: setId, error: errMessage });
          }
        }
      } finally {
        job.activeTransfers?.delete(setId);
        lastWorkerRequest = Date.now();
        emitJobUpdate(job, true);
        void scheduleSaveState(false);
      }
    }
  }

  const workerPromises = [];
  const actualConcurrency = Math.min(concurrency, setsToCheck.length || 1);
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

          const osuSettings = getOsuSettings();
          if (osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting && isSetInOsuSongs(setId)) {
            job.skipIds.add(setId);
            job.errIds.delete(setId);
            job.errorsById?.delete(setId);
            deferredSetIds.delete(setId);
            emitJobUpdate(job, true);
            continue;
          }

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
          emitJobUpdate(job, true);

          try {
            if (auth.kind === 'oauth') auth.token = await ensureOsuToken();
            if (auth.kind === 'mirror') await downloadFromMirrors(setId, job, { workerIndex });
            else await downloadSet(setId, auth, job);
            deferredSetIds.delete(setId);

            try {
              await handlePostDownload(setId, job);
            } catch (postError) {
              log('warn', 'map.post_download.failed', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(postError) });
            }
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
                  name: job.mapsById?.get(setId)?.label || `Набор ${setId}`,
                  error: errMessage,
                });
                if (error instanceof OAuthDownloadScopeError) { stopAfterCurrent = true; break; }
                log('error', 'map.download.failed', { jobId: job.id, beatmapsetId: setId, error: errMessage });
              }
            }
          } finally {
            job.activeTransfers?.delete(setId);
            lastDeferredRequest = Date.now();
            emitJobUpdate(job, true);
            void scheduleSaveState(false);
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
        job.message = counters.downloaded === 0 && counters.skipped > 0
          ? 'Все наборы уже есть в вашей библиотеке.'
          : 'Все доступные наборы загружены.';
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
    emitJobUpdate(job, true);
    await scheduleSaveState(true);
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
    emitJobUpdate(job, true);
    await scheduleSaveState(true);
  } finally {
    if (job.retryOnlyIds) {
      for (const id of job.retryOnlyIds) {
        if (!job.doneIds?.has(id) && !job.skipIds?.has(id) && !job.errIds?.has(id)) {
          job.errIds?.add(id);
          if (job.errorsById && !job.errorsById.has(id)) {
            const name = job.mapsById?.get(id)?.label || `Набор ${id}`;
            job.errorsById.set(id, { id, name, error: 'Загрузка отменена или не завершена' });
          }
        }
      }
    }
    delete job.retryOnlyIds;
    job.currentSetId = null;
    job.currentMirror = null;
    job.abortController = null;
    if (job.activeTransfers) job.activeTransfers.clear();
    await cleanupJobPartFiles(job).catch(() => {});
    if (activeJob === job && !['queued', 'running', 'paused'].includes(job.status)) {
      activeJob = null;
    }
    emitJobUpdate(job, true);
    await scheduleSaveState(true);
  }
}

/**
 * Возвращает список ID наборов, которые завершились ошибкой и не были скачаны.
 * @param {any} job
 * @returns {number[]}
 */
function getFailedSetIds(job) {
  if (!job) return [];
  const failed = new Set();
  if (job.errIds) {
    for (const id of job.errIds) {
      if (Number.isSafeInteger(id) && id > 0 && !job.doneIds?.has(id) && !job.skipIds?.has(id)) {
        failed.add(id);
      }
    }
  }
  if (job.errorsById) {
    for (const key of job.errorsById.keys()) {
      const numId = Number(key);
      if (Number.isSafeInteger(numId) && numId > 0 && !job.doneIds?.has(numId) && !job.skipIds?.has(numId)) {
        failed.add(numId);
      }
    }
  }
  return Array.from(failed);
}

/**
 * Перезапускает скачивание исключительно для наборов с ошибками.
 * @param {any} job
 * @param {any} auth
 * @returns {any}
 */
function retryFailedJob(job, auth) {
  clearAutoResume(job);
  const failedIds = getFailedSetIds(job);
  if (failedIds.length === 0) {
    throw new HttpError(400, 'В этой задаче нет ошибок для повторной загрузки.');
  }
  if (activeJob && activeJob !== job && ['queued', 'running'].includes(activeJob.status)) {
    throw new HttpError(409, 'Уже идёт другая загрузка — дождитесь её или нажмите «Остановить».');
  }
  if (['queued', 'running'].includes(job.status)) {
    throw new HttpError(409, 'Задача уже выполняется.');
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

  job.errorsById?.delete('fatal');
  for (const id of failedIds) {
    job.errIds.delete(id);
    job.errorsById?.delete(id);
  }
  job.retryOnlyIds = new Set(failedIds);

  delete job.finishedAt;
  delete job.pausedAt;
  job.message = `Повторная попытка для ${failedIds.length} ${failedIds.length === 1 ? 'набора' : 'наборов'} с ошибками…`;
  job.notifyUpdate = (immediate = false) => emitJobUpdate(job, immediate);
  emitJobUpdate(job, true);
  log('info', 'download.job.retry_failed', {
    jobId: job.id,
    count: failedIds.length,
    failedIds,
  });

  launchJob(job, auth);
  void scheduleSaveState(true);
  return job;
}

function pruneJobs() {
  const now = Date.now();
  let modified = false;
  for (const [id, job] of jobs) {
    if (['finished', 'finished_with_errors', 'cancelled'].includes(job.status) && job.finishedAt && now - job.finishedAt > 30 * 60 * 1000) {
      if (activeJob === job) activeJob = null;
      jobs.delete(id);
      modified = true;
    }
  }
  if (modified) {
    void scheduleSaveState(true);
  }
}

module.exports = {
  jobs,
  jobEvents,
  emitJobUpdate,
  getActiveJob,
  setActiveJob,
  jobCounters,
  safeJobForClient,
  clearAutoResume,
  scheduleAutoResume,
  resumeJob,
  retryFailedJob,
  getFailedSetIds,
  launchJob,
  runJob,
  pruneJobs,
  getStateFilePath,
  serializeJob,
  deserializeJob,
  serializeState,
  saveStateToDisk,
  loadStateFromDisk,
  scheduleSaveState,
  clearSaveStateTimer,
};
