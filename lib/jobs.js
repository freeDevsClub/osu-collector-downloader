// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  DOWNLOAD_DELAY_MS,
  DOWNLOAD_CONCURRENCY,
  getDownloadsDir,
  getDataDir,
  log,
  HttpError,
  formatPluralRu,
  sleepWithSignal,
} = require('./config.js');
const { safeErrorMessage } = require('./security.js');
const { Job, JobStateMachine, JOB_STATUSES, VALID_JOB_TRANSITIONS, createJob } = require('./job.js');
const { MIRRORS, mirrorCooldownRemaining, mirrorResumeWaitMs } = require('./mirrors.js');
const downloader = require('./downloader.js');
const {
  jobFilePath,
  isValidZipOnDisk,
  cleanupJobPartFiles,
  ensureDiskSpace,
  estimateRequiredDiskSpace,
  getCachedDownloadedSetsAsync,
} = downloader;
const {
  isSetInOsuSongs,
  handlePostDownload,
  getSettings: getOsuSettings,
  getCachedOsuSongsAsync,
} = require('./osu.js');
const { fetchCollection, parseSetIds, fallbackMapInfo } = require('./collector.js');

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
        const meta = { byteTick: true };
        jobEvents.emit(`job:${job.id}`, job, meta);
        jobEvents.emit('job', job, meta);
      }, 100);
    }
    return;
  }
  if (job._emitTimer) {
    clearTimeout(job._emitTimer);
    job._emitTimer = null;
  }
  job._lastEmit = now;
  const meta = { byteTick: !immediate };
  jobEvents.emit(`job:${job.id}`, job, meta);
  jobEvents.emit('job', job, meta);
}

function getActiveJob() {
  return activeJob;
}

function setActiveJob(job) {
  activeJob = job;
}

/**
 * Возвращает путь к файлу сохранения состояния очереди (.state.json).
 * Сохраняется в каталоге данных (DATA_DIR / CONFIG_DIR / data).
 * @returns {string}
 */
function getStateFilePath() {
  return path.join(getDataDir(), '.state.json');
}

/**
 * Возвращает устаревший путь к файлу сохранения состояния в каталоге загрузок (для обратной совместимости).
 * @returns {string}
 */
function getLegacyStateFilePath() {
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
 * Формирует или возвращает закешированный сериализованный массив метаданных карт задачи.
 * Исключает повторные аллокации тысяч объектов при каждом сохранении прогресса.
 * @param {any} job
 * @returns {Array<any>}
 */
function getSerializedMaps(job) {
  if (!job || !job.mapsById || job.mapsById.size === 0) {
    return [];
  }
  const currentSize = job.mapsById.size;
  const cached = job._cachedSerializedMaps;

  // Если кеш уже построен для того же источника mapsById и размер совпадает:
  if (
    cached &&
    job._cachedMapsSource === job.mapsById &&
    job._cachedMapsSize === currentSize &&
    !job._invalidateMapsCache
  ) {
    // Если все элементы уже были обогащены названиями, повторная проверка не требуется (O(1))
    if (job._cachedEnrichedCount === currentSize) {
      return cached;
    }
    // Если часть элементов ещё ожидает фонового обогащения, проверяем, изменилось ли число обогащённых
    let currentEnrichedCount = 0;
    for (const m of job.mapsById.values()) {
      if (m && m.title != null) currentEnrichedCount++;
    }
    if (currentEnrichedCount === job._cachedEnrichedCount) {
      return cached;
    }
  }

  // Перестраиваем сериализованные метаданные карт
  let enrichedCount = 0;
  const maps = [];
  for (const m of job.mapsById.values()) {
    if (!m) continue;
    if (m.title != null) enrichedCount++;
    maps.push({
      id: Number(m.id),
      label: m.label || [m.artist, m.title].filter(Boolean).join(' — ') || `Набор ${m.id}`,
      title: m.title != null ? String(m.title) : null,
      artist: m.artist != null ? String(m.artist) : null,
      creator: m.creator != null ? String(m.creator) : null,
    });
  }

  job._cachedSerializedMaps = maps;
  job._cachedMapsSource = job.mapsById;
  job._cachedMapsSize = currentSize;
  job._cachedEnrichedCount = enrichedCount;
  job._invalidateMapsCache = false;
  return maps;
}

/**
 * Возвращает статическую неизменную часть метаданных задачи (коллекция, ID, карты).
 * Кешируется на объекте задачи, разделяя статику от динамического прогресса.
 * @param {any} job
 * @returns {any}
 */
function getJobStaticMetadata(job) {
  const maps = getSerializedMaps(job);
  if (
    job._cachedStaticMetadata &&
    job._cachedStaticMetadata.maps === maps &&
    job._cachedStaticMetadata.id === job.id &&
    job._cachedStaticMetadata.method === job.method &&
    job._cachedStaticMetadata.noVideo === Boolean(job.noVideo) &&
    job._cachedStaticMetadata.collectionId === job.collectionId &&
    job._cachedStaticMetadata.collectionName === job.collectionName
  ) {
    return job._cachedStaticMetadata;
  }

  const staticMetadata = {
    id: job.id,
    method: job.method,
    noVideo: Boolean(job.noVideo),
    collectionId: job.collectionId,
    collectionName: job.collectionName,
    setIds: Array.isArray(job.setIds) ? job.setIds : [],
    createdAt: Number(job.createdAt) || Date.now(),
    maps,
  };

  job._cachedStaticMetadata = staticMetadata;
  return staticMetadata;
}

/**
 * Сериализует объект задачи в плоский JSON-совместимый объект для сохранения на диск.
 * @param {any} job
 * @returns {any}
 */
function serializeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const createdAt = Number(job.createdAt) || Date.now();
  if (!job.createdAt) {
    job.createdAt = createdAt;
  }
  const staticMeta = getJobStaticMetadata(job);
  return {
    ...staticMeta,
    doneIds: Array.from(job.doneIds || []),
    skipIds: Array.from(job.skipIds || []),
    errIds: Array.from(job.errIds || []),
    errors: Array.from(job.errorsById?.values() || []),
    postDownloadErrors: Array.from(job.postDownloadErrors?.entries() || []),
    warnings: Array.from(job.warnings || []),
    extraFailures: Number(job.extraFailures || 0),
    status: job.status,
    message: job.message || '',
    autoResumeCount: Number(job.autoResumeCount || 0),
    retryOnlyIds: job.retryOnlyIds ? Array.from(job.retryOnlyIds) : null,
    selectedSetIds: job.selectedSetIds ? Array.from(job.selectedSetIds) : null,
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

  /** @type {Map<number, string>} */
  const postDownloadErrors = new Map();
  if (Array.isArray(data.postDownloadErrors)) {
    for (const item of data.postDownloadErrors) {
      if (Array.isArray(item)) {
        postDownloadErrors.set(Number(item[0]), String(item[1] || ''));
      } else if (item != null) {
        postDownloadErrors.set(Number(item), '');
      }
    }
  }

  const warnings = new Set(Array.isArray(data.warnings) ? data.warnings.map(String) : []);

  /** @type {Map<number, any>} */
  const mapsById = new Map();
  if (Array.isArray(data.maps)) {
    for (const m of data.maps) {
      if (m && m.id != null) {
        const id = Number(m.id);
        let title = m.title != null ? String(m.title) : null;
        let artist = m.artist != null ? String(m.artist) : null;
        const creator = m.creator != null ? String(m.creator) : null;
        let label = typeof m.label === 'string' && m.label.trim() ? m.label.trim() : null;

        // Обратная совместимость с ранее сохранённым .state.json, где не было title и artist:
        // парсим "Artist — Title" или "Artist - Title"
        if (!title && !artist && label && !label.startsWith('Набор ')) {
          const parts = label.split(/\s+[—–-]\s+/, 2);
          if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
            artist = parts[0].trim();
            title = parts[1].trim();
          }
        }

        if (!label) {
          label = [artist, title].filter(Boolean).join(' — ') || `Набор ${id}`;
        }

        mapsById.set(id, { id, label, title, artist, creator });
      }
    }
  }

  let status = data.status || 'paused';
  let message = data.message || '';
  let pausedAt = data.pausedAt || null;

  // Если сервер был перезапущен во время выполнения задачи (preparing, running или queued),
  // она безопасно переводится в статус paused, чтобы пользователь мог нажать «Продолжить».
  if (['preparing', 'running', 'queued'].includes(status)) {
    status = 'paused';
    message = 'Сервер был перезапущен — задача приостановлена. Нажмите «Продолжить».';
    pausedAt = Date.now();
  }

  const job = createJob({
    id: String(data.id),
    method: data.method === 'session' ? 'session' : 'mirror',
    noVideo: Boolean(data.noVideo),
    collectionId: String(data.collectionId || ''),
    collectionName: String(data.collectionName || `Коллекция ${data.collectionId || ''}`),
    setIds: data.setIds.map(Number),
    doneIds,
    skipIds,
    errIds,
    errorsById,
    postDownloadErrors,
    warnings,
    extraFailures: Number(data.extraFailures || (errorsById.has('fatal') ? 1 : 0)),
    mapsById,
    status,
    message,
    autoResumeCount: Number(data.autoResumeCount || 0),
    createdAt: Number(data.createdAt) || Date.now(),
    pausedAt,
    finishedAt: data.finishedAt || null,
    retryOnlyIds:
      Array.isArray(data.retryOnlyIds) && data.retryOnlyIds.length > 0 ? new Set(data.retryOnlyIds.map(Number)) : null,
    selectedSetIds:
      Array.isArray(data.selectedSetIds) && data.selectedSetIds.length > 0
        ? new Set(data.selectedSetIds.map(Number))
        : null,
  });

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

/** @type {Promise<void> | null} */
let currentSavePromise = null;
/** @type {Promise<void> | null} */
let queuedSavePromise = null;
/** @type {NodeJS.Timeout | null} */
let saveStateTimer = null;

async function doSaveState() {
  try {
    const statePath = getStateFilePath();
    const stateData = serializeState();
    await atomicWriteFile(statePath, JSON.stringify(stateData));
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    const level = code === 'ENOENT' ? 'debug' : 'error';
    log(level, 'download.state.save_failed', { error: safeErrorMessage(error) });
  } finally {
    currentSavePromise = null;
  }
}

/**
 * Сохраняет текущее состояние всех задач на диск в файл downloads/.state.json.
 * Сериализует записи: если запись уже идёт, создаёт единую очередь для следующей
 * записи со свежим снимком памяти и ожидает её завершения.
 * @returns {Promise<void>}
 */
function saveStateToDisk() {
  if (queuedSavePromise) {
    return queuedSavePromise;
  }
  if (currentSavePromise) {
    queuedSavePromise = (async () => {
      try {
        await currentSavePromise;
      } catch {}
      queuedSavePromise = null;
      currentSavePromise = doSaveState();
      return currentSavePromise;
    })();
    return queuedSavePromise;
  }
  currentSavePromise = doSaveState();
  return currentSavePromise;
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

const SAVE_STATE_WAIT_TIMEOUT_MS = 5000;

/**
 * Очищает отложенный таймер сохранения и ожидает завершения всех активных и запланированных записей на диск.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<void>}
 */
async function waitForPendingSaveState(timeoutMs = SAVE_STATE_WAIT_TIMEOUT_MS) {
  clearSaveStateTimer();
  let guard = 0;
  while ((currentSavePromise || queuedSavePromise) && guard < 10) {
    guard++;
    const pending = [currentSavePromise, queuedSavePromise].filter(Boolean);
    if (pending.length === 0) break;
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled(pending), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (guard >= 10 && (currentSavePromise || queuedSavePromise)) {
    log('warn', 'jobs.save_state.wait_limit_exceeded', {
      hasCurrent: Boolean(currentSavePromise),
      hasQueued: Boolean(queuedSavePromise),
      guard,
    });
  }
}

/**
 * Устанавливает промисы сохранения для тестирования таймаута и guard-счётчика.
 * @param {Promise<void> | null} current
 * @param {Promise<void> | null} queued
 */
function _setPendingSavePromisesForTest(current, queued) {
  currentSavePromise = current;
  queuedSavePromise = queued;
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
 * Считывает состояние очереди с диска (.state.json) и восстанавливает задачи в память.
 * В первую очередь проверяет DATA_DIR, а при отсутствии — каталог загрузок (legacy fallback).
 * @returns {Promise<boolean>} Возвращает true, если задачи были успешно восстановлены.
 */
async function loadStateFromDisk() {
  const statePath = getStateFilePath();
  let raw = '';
  try {
    raw = await fs.promises.readFile(statePath, 'utf8');
  } catch {
    const legacyPath = getLegacyStateFilePath();
    if (statePath !== legacyPath) {
      try {
        raw = await fs.promises.readFile(legacyPath, 'utf8');
        log('info', 'jobs.state.loaded_legacy', { legacyPath, targetPath: statePath });
      } catch {
        // Файла нет ни в data, ни в downloads
      }
    }
  }
  try {
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
  if (!job) {
    return { downloaded: 0, skipped: 0, failed: 0, completed: 0, deferred: 0 };
  }
  const downloaded = job.doneIds?.size || 0;
  const skipped = job.skipIds?.size || 0;
  let failed = 0;
  if (job.errIds) {
    for (const id of job.errIds) {
      if (!job.doneIds?.has(id) && !job.skipIds?.has(id)) {
        failed += 1;
      }
    }
  }
  let extra = Number(job.extraFailures || 0);
  if (extra === 0 && job.errorsById) {
    for (const key of job.errorsById.keys()) {
      if (typeof key === 'string' && isNaN(Number(key))) {
        extra += 1;
      }
    }
  }
  failed += extra;
  const completed = downloaded + skipped + failed;
  const total = Array.isArray(job.setIds) ? job.setIds.length : 0;
  return {
    downloaded,
    skipped,
    failed,
    completed,
    deferred: Math.max(0, total - completed),
  };
}

/**
 * Подготавливает безопасный для передачи на фронтенд JSON-снимок состояния задачи.
 * @param {any} job
 * @param {{ byteTick?: boolean, omitErrors?: boolean }} [options]
 * @returns {any}
 */
function safeJobForClient(job, options = {}) {
  const isByteTick = Boolean(options?.byteTick);
  const omitErrors = Boolean(options?.omitErrors || isByteTick);
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
      currentMirror = t.waiting ? (t.mirror ? `${t.mirror} (в очереди)` : 'в очереди к зеркалу') : t.mirror;
      currentBytes = t.bytes;
      currentTotalBytes = t.totalBytes;
      currentPercent = t.totalBytes ? Math.min(100, Math.floor((t.bytes / t.totalBytes) * 100)) : null;
    } else {
      let sumBytes = 0;
      let sumTotal = 0;
      let knownBytes = 0;
      let allTotalKnown = true;
      const mirrors = [];
      const names = [];

      for (const t of transfers) {
        sumBytes += t.bytes || 0;
        if (Number.isSafeInteger(t.totalBytes) && t.totalBytes > 0) {
          sumTotal += t.totalBytes;
          knownBytes += t.bytes || 0;
        } else {
          allTotalKnown = false;
        }
        if (t.mirror) {
          const mirrorLabel = t.waiting ? `${t.mirror} (в очереди)` : t.mirror;
          if (!mirrors.includes(mirrorLabel)) mirrors.push(mirrorLabel);
        }
        if (t.setName) names.push(t.setName);
      }

      currentBytes = sumBytes;
      currentTotalBytes = allTotalKnown ? sumTotal : null;
      if (allTotalKnown && currentTotalBytes > 0) {
        currentPercent = Math.min(100, Math.floor((currentBytes / currentTotalBytes) * 100));
      } else if (sumTotal > 0) {
        currentPercent = Math.min(100, Math.floor((knownBytes / sumTotal) * 100));
      } else {
        currentPercent = null;
      }
      currentMirror = mirrors.join(', ');
      currentSetId = transfers[0].setId;
      currentSetName = `${formatPluralRu(transfers.length, 'набор', 'набора', 'наборов')} параллельно (${names.slice(0, 2).join(' · ')}${names.length > 2 ? '…' : ''})`;
    }
  }

  /** @type {Array<{ setId: number, setName: string, mirror: string, bytes: number, totalBytes: number | null, percent: number | null, waiting?: boolean }>} */
  let activeTransfersList = [];
  if (job.activeTransfers && job.activeTransfers.size > 0) {
    activeTransfersList = Array.from(job.activeTransfers.values()).map((t) => ({
      setId: t.setId,
      setName: t.setName || (t.setId ? `Набор ${t.setId}` : 'Без названия'),
      mirror: t.mirror || (t.waitingMirror ? t.waitingMirror : ''),
      bytes: t.bytes || 0,
      totalBytes: t.totalBytes || null,
      percent:
        Number.isFinite(t.totalBytes) && t.totalBytes > 0
          ? Math.min(100, Math.floor(((t.bytes || 0) / t.totalBytes) * 100))
          : null,
      waiting: Boolean(t.waiting),
    }));
  }

  const clientData = {
    id: job.id,
    method: job.method,
    noVideo: Boolean(job.noVideo),
    collectionName: job.collectionName,
    total: Array.isArray(job.setIds) ? job.setIds.length : 0,
    completed: counters.completed,
    downloaded: counters.downloaded,
    skipped: counters.skipped,
    failed: counters.failed,
    deferred: counters.deferred,
    currentSetId,
    currentSetName,
    currentMirror,
    activeTransfers: activeTransfersList,
    autoResumeAt: job.autoResumeAt || null,
    autoResumeAttempts: job.autoResumeCount || 0,
    currentBytes,
    currentTotalBytes,
    currentPercent,
    status: job.status,
    message: job.message,
    canRetryFailed: counters.failed > 0 && !['preparing', 'queued', 'running'].includes(job.status),
    createdAt: job.createdAt || null,
    pausedAt: job.pausedAt || null,
    finishedAt: job.finishedAt || null,
  };

  const warnings = job.warnings
    ? job.warnings instanceof Set
      ? Array.from(job.warnings)
      : Array.isArray(job.warnings)
        ? job.warnings
        : []
    : [];
  if (warnings.length > 0) {
    clientData.warnings = warnings;
  }

  if (!omitErrors) {
    clientData.errors = Array.from(job.errorsById?.values() || []).slice(0, 300);
    clientData.mirrors = MIRRORS.map((mirror) => ({
      id: mirror.id,
      label: mirror.label,
      cooldownMs: mirrorCooldownRemaining(mirror),
    }));
  }

  return clientData;
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
    log('warn', 'download.job.auto_resume.exhausted', {
      jobId: job.id,
      attempts: job.autoResumeCount,
      total: job.setIds.length,
    });
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
  log('info', 'download.job.auto_resume.scheduled', {
    jobId: job.id,
    inMs: delayMs,
    attempt: (job.autoResumeCount || 0) + 1,
    waitMs,
  });
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
  job.errorsById?.delete('fatal');
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
  const promise = runJob(job, auth).catch((error) => {
    log('error', 'download.job.unhandled_rejection', {
      jobId: job?.id,
      error: safeErrorMessage(error),
      stack: error?.stack,
    });
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
      job.extraFailures = Math.max(1, (job.extraFailures || 0) + 1);
      emitJobUpdate(job, true);
      void scheduleSaveState(true);
    }
    if (activeJob === job) {
      activeJob = null;
    }
  });
  job._promise = promise;
  return job;
}

/**
 * Подготавливает коллекцию карт, если она ещё не загружена (получает список карт и метаданные).
 * @param {any} job
 * @returns {Promise<boolean>} true, если подготовка успешна и можно продолжать
 */
async function prepareJobCollection(job) {
  if (job._prepared || (Array.isArray(job.setIds) && job.setIds.length > 0)) {
    job._prepared = true;
    return !(job.status === 'cancelled' || job.abortController?.signal?.aborted);
  }

  job.status = 'preparing';
  job.message = 'Получение списка карт из osu!Collector…';
  emitJobUpdate(job, true);

  try {
    const data = await fetchCollection(job.collectionId, { signal: job.abortController?.signal });
    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return false;
    const setIds = parseSetIds(data);
    let effectiveSetIds = setIds;
    if (job.selectedSetIds && job.selectedSetIds.size > 0) {
      effectiveSetIds = setIds.filter((id) => job.selectedSetIds.has(id));
      if (!effectiveSetIds.length) {
        throw new HttpError(400, 'Ни один из выбранных наборов не найден в коллекции.');
      }
    } else if (!setIds.length) {
      throw new HttpError(400, 'В коллекции нет доступных наборов.');
    }
    job.setIds = effectiveSetIds;
    if (typeof data.name === 'string') {
      job.collectionName = data.name;
    }
    if (data.mapsById) {
      job.mapsById = data.mapsById;
    } else if (data.maps) {
      job.mapsById = new Map(data.maps.map((m) => [m.id, m]));
    } else {
      job.mapsById = new Map(fallbackMapInfo(setIds).map((m) => [m.id, m]));
    }
    delete job._cachedStaticMetadata;
    job._prepared = true;
    emitJobUpdate(job, true);
    void scheduleSaveState(true);
    return true;
  } catch (prepError) {
    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return false;
    job.status = 'finished_with_errors';
    const errMessage = safeErrorMessage(prepError);
    job.message = `Не удалось получить коллекцию: ${errMessage}`;
    job.errorsById?.set('fatal', {
      id: 'fatal',
      name: 'Загрузка коллекции',
      error: errMessage,
    });
    job.extraFailures = Math.max(1, (job.extraFailures || 0) + 1);
    job.finishedAt = Date.now();
    emitJobUpdate(job, true);
    void scheduleSaveState(true);
    if (activeJob === job) activeJob = null;
    return false;
  }
}

/**
 * Проверяет свободное дисковое пространство для загрузки наборов.
 * @param {any} job
 * @returns {Promise<boolean>} true, если проверка пройдена успешно
 */
async function checkJobDiskSpace(job) {
  if (job._spaceChecked) {
    delete job._spaceChecked;
    return !(job.status === 'cancelled' || job.abortController?.signal?.aborted);
  }

  const setsToCheck = job.retryOnlyIds ? Array.from(job.retryOnlyIds) : job.setIds;
  job.status = 'preparing';
  job.message = 'Проверка свободного места на диске…';
  emitJobUpdate(job, true);

  try {
    const osuSettings = getOsuSettings();
    const checkOsu = Boolean(osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting);
    if (checkOsu && osuSettings?.songsDir) {
      await getCachedOsuSongsAsync(osuSettings.songsDir);
    }
    const downloadedSets = await getCachedDownloadedSetsAsync();
    const setsToDownload = setsToCheck.filter((id) => {
      if (job.doneIds?.has(id) || job.skipIds?.has(id)) return false;
      if (downloadedSets.has(id)) return false;
      if (checkOsu && isSetInOsuSongs(id)) return false;
      return true;
    });
    const requiredBytes = setsToDownload.length > 0 ? await estimateRequiredDiskSpace(setsToDownload, job.noVideo) : 0;
    if (requiredBytes > 0) {
      await ensureDiskSpace(requiredBytes);
    }
  } catch (spaceError) {
    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return false;
    job.status = 'finished_with_errors';
    const errMessage = safeErrorMessage(spaceError);
    job.message = `Не удалось запустить загрузку: ${errMessage}`;
    job.errorsById?.set('fatal', {
      id: 'fatal',
      name: 'Дисковое пространство',
      error: errMessage,
    });
    job.extraFailures = Math.max(1, (job.extraFailures || 0) + 1);
    job.finishedAt = Date.now();
    log('error', 'download.job.disk_space_failed', { jobId: job.id, error: errMessage });
    emitJobUpdate(job, true);
    void scheduleSaveState(true);
    if (activeJob === job) activeJob = null;
    return false;
  }

  if (job.status === 'cancelled' || job.abortController?.signal?.aborted) {
    emitJobUpdate(job, true);
    return false;
  }

  return true;
}

/**
 * Создаёт итератор для безопасной выборки следующего ID набора из очереди.
 * @param {readonly number[]} array
 * @param {{ retryOnlyIds?: Set<number> | null, doneIds?: Set<number> | null, skipIds?: Set<number> | null }} [options]
 * @returns {() => number | null}
 */
function createQueueIterator(array, options = {}) {
  let index = 0;
  return function getNextSetId() {
    while (index < array.length) {
      const candidateId = array[index++];
      if (options.retryOnlyIds && !options.retryOnlyIds.has(candidateId)) {
        continue;
      }
      if (!options.doneIds?.has(candidateId) && !options.skipIds?.has(candidateId)) {
        return candidateId;
      }
    }
    return null;
  };
}

/**
 * Проверяет наличие готового файла на диске или в папке Songs osu!,
 * и при наличии помечает набор как пропущенный.
 * @param {number} setId
 * @param {any} job
 * @param {{ isDeferred?: boolean, deferredSetIds?: Set<number> }} [options]
 * @returns {Promise<boolean>} true, если набор уже готов и был пропущен
 */
async function checkAndSkipIfAvailable(setId, job, options = {}) {
  const filePath = jobFilePath(setId);
  const osuSettings = getOsuSettings();
  const requiresPostProcessing = Boolean(
    osuSettings?.valid &&
    osuSettings?.songsDir &&
    osuSettings?.postDownloadAction &&
    osuSettings.postDownloadAction !== 'none',
  );

  try {
    const existing = await fs.promises.stat(filePath);
    if (existing.size > 0) {
      const isComplete = await isValidZipOnDisk(filePath);
      if (isComplete) {
        // Проверяем, требует ли набор повтора стадии пост-обработки
        const isPostDownloadPending = Boolean(
          job.postDownloadErrors?.has(setId) ||
          (job.retryOnlyIds?.has(setId) && requiresPostProcessing && !isSetInOsuSongs(setId)),
        );

        if (isPostDownloadPending) {
          log('info', 'map.post_download.retrying', { jobId: job.id, beatmapsetId: setId });
          try {
            await handlePostDownload(setId, job);
            job.postDownloadErrors?.delete(setId);
            job.doneIds.add(setId);
            job.skipIds.delete(setId);
            job.errIds.delete(setId);
            job.errorsById?.delete(setId);
            if (options.isDeferred) {
              options.deferredSetIds?.delete(setId);
            }
            emitJobUpdate(job, true);
            log('info', 'map.post_download.retry_succeeded', { jobId: job.id, beatmapsetId: setId });
            return true;
          } catch (postError) {
            log('warn', 'map.post_download.retry_failed', {
              jobId: job.id,
              beatmapsetId: setId,
              error: safeErrorMessage(postError),
            });
            job.doneIds.delete(setId);
            job.skipIds.delete(setId);
            job.errIds.add(setId);
            job.postDownloadErrors?.set(setId, safeErrorMessage(postError));
            const postMapInfo = job.mapsById?.get(setId);
            const mapName = postMapInfo?.title
              ? `${postMapInfo.artist || ''} - ${postMapInfo.title}`.trim()
              : `Набор ${setId}`;
            job.errorsById?.set(setId, {
              id: setId,
              name: mapName,
              error: safeErrorMessage(postError),
              isPostDownload: true,
            });
            if (options.isDeferred) {
              options.deferredSetIds?.delete(setId);
            }
            emitJobUpdate(job, true);
            return true;
          }
        }

        job.skipIds.add(setId);
        job.errIds.delete(setId);
        job.errorsById?.delete(setId);
        job.postDownloadErrors?.delete(setId);
        if (options.isDeferred) {
          options.deferredSetIds?.delete(setId);
        }
        emitJobUpdate(job, true);
        log('info', 'map.download.skipped', {
          jobId: job.id,
          beatmapsetId: setId,
          reason: 'file already exists',
          sizeBytes: existing.size,
        });
        return true;
      } else {
        log('warn', 'map.download.existing_file_unverified', {
          jobId: job.id,
          beatmapsetId: setId,
          file: path.basename(filePath),
          sizeBytes: existing.size,
        });
      }
    }
  } catch {}

  if (osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting && isSetInOsuSongs(setId)) {
    job.skipIds.add(setId);
    job.errIds.delete(setId);
    job.errorsById?.delete(setId);
    job.postDownloadErrors?.delete(setId);
    if (options.isDeferred) {
      options.deferredSetIds?.delete(setId);
    }
    emitJobUpdate(job, true);
    log('info', 'map.download.skipped', {
      jobId: job.id,
      beatmapsetId: setId,
      reason: 'already installed in osu! Songs',
    });
    return true;
  }

  return false;
}

/**
 * Обрабатывает загрузку одного набора карт: трекинг трансфера, вызов зеркала/API,
 * пост-обработку и обработку ошибок (ENOSPC, 429, остывание).
 * @param {number} setId
 * @param {{
 *   job: any,
 *   auth: any,
 *   workerIndex?: number,
 *   isDeferred?: boolean,
 *   stopContext: { stopAfterCurrent: boolean, stopForCooldown: boolean, stopForNoSpace: boolean },
 *   deferredSetIds?: Set<number>
 * }} options
 * @returns {Promise<void>}
 */
async function processSetDownload(
  setId,
  { job, auth, workerIndex = 0, isDeferred = false, stopContext, deferredSetIds },
) {
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

  if (!job.activeTransfers || job.activeTransfers.size <= 1) {
    job.currentSetId = setId;
    job.currentBytes = 0;
    job.currentTotalBytes = null;
    job.currentPercent = 0;
  }
  emitJobUpdate(job, true);

  try {
    if (auth.kind === 'mirror') {
      await downloader.downloadFromMirrors(setId, job, { workerIndex });
    } else {
      await downloader.downloadSet(setId, auth, job);
    }

    if (isDeferred) {
      deferredSetIds?.delete(setId);
    }

    try {
      await handlePostDownload(setId, job);
      job.postDownloadErrors?.delete(setId);
    } catch (postError) {
      log('warn', 'map.post_download.failed', {
        jobId: job.id,
        beatmapsetId: setId,
        error: safeErrorMessage(postError),
      });
      job.doneIds.delete(setId);
      job.errIds.add(setId);
      job.postDownloadErrors?.set(setId, safeErrorMessage(postError));
      const postMapInfo = job.mapsById?.get(setId);
      const mapName = postMapInfo?.title
        ? `${postMapInfo.artist || ''} - ${postMapInfo.title}`.trim()
        : `Набор ${setId}`;
      job.errorsById?.set(setId, {
        id: setId,
        name: mapName,
        error: safeErrorMessage(postError),
        isPostDownload: true,
      });
    }
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (job.status !== 'cancelled' && !job.abortController?.signal?.aborted) {
      if (downloader.isNoSpaceError(error)) {
        job.message = `Набор ${setId}: на диске закончилось свободное место (ENOSPC). Загрузка приостановлена — освободите место и нажмите «Продолжить».`;
        stopContext.stopForNoSpace = true;
        log('error', 'download.job.enospc', { jobId: job.id, beatmapsetId: setId, error: safeErrorMessage(error) });
      } else if (isDeferred && (err.allCooldown || err.deferSet)) {
        job.message = `Набор ${setId}: зеркала остывают — загрузка приостановлена.`;
        stopContext.stopForCooldown = true;
        log('warn', 'download.job.deferred_final_pause', {
          jobId: job.id,
          beatmapsetId: setId,
          error: safeErrorMessage(error),
        });
      } else if (err.allCooldown) {
        job.message = `Все зеркала временно ограничили загрузки (HTTP 429). Загрузка приостановлена — повторите позже, готовые файлы будут пропущены.`;
        stopContext.stopForCooldown = true;
        log('warn', 'download.job.all_cooldown', {
          jobId: job.id,
          beatmapsetId: setId,
          error: safeErrorMessage(error),
        });
      } else if (err.deferSet) {
        deferredSetIds?.add(setId);
        if (!job.activeTransfers || job.activeTransfers.size <= 1) {
          job.message = `Набор ${setId}: часть зеркал остывает — откладываю набор в конец очереди.`;
        }
        log('info', 'download.job.set_deferred', {
          jobId: job.id,
          beatmapsetId: setId,
          error: safeErrorMessage(error),
        });
      } else {
        job.errIds.add(setId);
        if (isDeferred) {
          deferredSetIds?.delete(setId);
        }
        const errMessage = safeErrorMessage(error);
        if (!job.activeTransfers || job.activeTransfers.size <= 1) {
          job.message = `Набор ${setId}: ${errMessage}`;
        }
        job.errorsById?.set(setId, {
          id: setId,
          name: job.mapsById?.get(setId)?.label || `Набор ${setId}`,
          error: errMessage,
        });
        log('error', 'map.download.failed', { jobId: job.id, beatmapsetId: setId, error: errMessage });
      }
    }
  } finally {
    job.activeTransfers?.delete(setId);
    if (!job.activeTransfers || job.activeTransfers.size === 0) {
      job.currentSetId = null;
      job.currentMirror = null;
      job.currentBytes = 0;
      job.currentTotalBytes = null;
      job.currentPercent = 0;
    }
    emitJobUpdate(job, true);
    void scheduleSaveState(false);
  }
}

/**
 * Запускает пул параллельных воркеров скачивания.
 * @param {{
 *   job: any,
 *   auth: any,
 *   getNextSetId: () => number | null,
 *   isDeferred?: boolean,
 *   concurrency?: number,
 *   stopContext: { stopAfterCurrent: boolean, stopForCooldown: boolean, stopForNoSpace: boolean },
 *   deferredSetIds?: Set<number>
 * }} options
 * @returns {Promise<void>}
 */
async function runDownloadPool({
  job,
  auth,
  getNextSetId,
  isDeferred = false,
  concurrency = 1,
  stopContext,
  deferredSetIds,
}) {
  async function worker(workerIndex) {
    let lastWorkerRequest = 0;

    while (true) {
      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopContext.stopAfterCurrent || stopContext.stopForCooldown || stopContext.stopForNoSpace) break;

      let setId = null;
      const totalCandidates = Math.max(Array.isArray(job?.setIds) ? job.setIds.length : 0, deferredSetIds?.size || 0);
      const maxCandidates = totalCandidates > 0 ? totalCandidates + 1 : 1000;
      let guard = 0;
      /** @type {number | null} */
      let candidateId = null;
      while (guard < maxCandidates) {
        guard++;
        if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
        if (stopContext.stopAfterCurrent || stopContext.stopForCooldown || stopContext.stopForNoSpace) break;

        candidateId = getNextSetId();
        if (candidateId == null) break;
        const skipped = await checkAndSkipIfAvailable(candidateId, job, { isDeferred, deferredSetIds });
        if (!skipped) {
          setId = candidateId;
          break;
        }
      }
      if (guard >= maxCandidates && setId == null && candidateId != null) {
        log('warn', 'job.worker.skip_loop_guard_exceeded', {
          jobId: job?.id,
          workerIndex,
          maxCandidates,
        });
      }
      if (setId == null) break;

      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopContext.stopAfterCurrent || stopContext.stopForCooldown || stopContext.stopForNoSpace) break;

      if (auth.kind !== 'mirror') {
        const delay = DOWNLOAD_DELAY_MS - (Date.now() - lastWorkerRequest);
        if (lastWorkerRequest && delay > 0) {
          await sleepWithSignal(delay, job.abortController?.signal);
        }
      }

      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) break;
      if (stopContext.stopAfterCurrent || stopContext.stopForCooldown || stopContext.stopForNoSpace) break;

      await processSetDownload(setId, {
        job,
        auth,
        workerIndex,
        isDeferred,
        stopContext,
        deferredSetIds,
      });

      lastWorkerRequest = Date.now();
    }
  }

  const workerPromises = [];
  for (let i = 0; i < concurrency; i++) {
    workerPromises.push(worker(i));
  }
  await Promise.all(workerPromises);
}

/**
 * Вычисляет счётчики и переводит задачу в финальный статус (paused, finished_with_errors, finished).
 * @param {any} job
 * @param {{ stopAfterCurrent: boolean, stopForCooldown: boolean, stopForNoSpace: boolean }} stopContext
 */
function finalizeJobStatus(job, stopContext) {
  const counters = jobCounters(job);
  if (job.status !== 'cancelled') {
    if (counters.deferred && !stopContext.stopAfterCurrent) {
      job.status = 'paused';
      const processed = counters.downloaded + counters.skipped;
      const failedNote = counters.failed ? `, с ошибками: ${counters.failed}` : '';
      if (stopContext.stopForNoSpace) {
        job.message = `На диске закончилось свободное место — получено ${processed} из ${job.setIds.length}${failedNote}. Освободите место на диске и нажмите «Продолжить».`;
        clearAutoResume(job);
      } else {
        job.message = `Зеркала временно ограничили загрузки — получено ${processed} из ${job.setIds.length}${failedNote}.`;
        scheduleAutoResume(job);
        if (job.autoResumeAt)
          job.message += ' Загрузка продолжится автоматически после паузы зеркал, готовые файлы будут пропущены.';
        else job.message += ' Нажмите «Продолжить», когда пауза зеркал закончится: готовые файлы будут пропущены.';
      }
    } else if (counters.failed) {
      job.status = 'finished_with_errors';
      job.message = `Готово с ошибками: ${counters.failed} из ${job.setIds.length}.${counters.deferred ? ' Часть наборов отложена — нажмите «Продолжить» позже.' : ''}`;
    } else {
      job.status = 'finished';
      const baseMessage =
        counters.downloaded === 0 && counters.skipped > 0
          ? 'Все наборы уже есть в вашей библиотеке.'
          : 'Все доступные наборы загружены.';
      const hasWarnings = Boolean(job.warnings && (job.warnings.size > 0 || job.warnings.length > 0));
      if (hasWarnings) {
        job.message = `${baseMessage} Внимание: интеграция с osu! была пропущена из-за неверного пути к папке Songs.`;
      } else {
        job.message = baseMessage;
      }
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
    if (job.retryOnlyIds) {
      for (const id of job.retryOnlyIds) {
        if (!job.doneIds?.has(id) && !job.skipIds?.has(id) && !job.errIds?.has(id)) {
          job.errIds?.add(id);
          if (job.errorsById && !job.errorsById.has(id)) {
            const name = job.mapsById?.get(id)?.label || `Набор ${id}`;
            const reason = job.status === 'cancelled' ? 'Загрузка отменена' : 'Загрузка не завершена';
            job.errorsById.set(id, { id, name, error: reason });
          }
        }
      }
      delete job.retryOnlyIds;
    }
  }
  log(
    job.status === 'finished' ? 'info' : job.status === 'paused' || job.status === 'cancelled' ? 'warn' : 'error',
    'download.job.finished',
    {
      jobId: job.id,
      status: job.status,
      total: job.setIds.length,
      ...counters,
    },
  );
}

/**
 * Основной цикл фонового процесса скачивания наборов задачи.
 * @param {any} job
 * @param {any} auth
 * @returns {Promise<void>}
 */
async function runJob(job, auth) {
  // Откладываем выполнение на следующий микротик, чтобы синхронный запуск (launchJob/retryFailedJob)
  // успел вернуть статус клиенту в HTTP-ответе до перехода задачи в 'running'.
  await Promise.resolve();
  try {
    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) {
      return;
    }

    if (!job.abortController) {
      job.abortController = new AbortController();
    }

    // 1. Подготовка: получение списка карт коллекции osu!Collector, если он ещё не загружен
    const prepOk = await prepareJobCollection(job);
    if (!prepOk) return;

    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) {
      return;
    }

    // 2. Проверка свободного места на диске
    const spaceOk = await checkJobDiskSpace(job);
    if (!spaceOk) return;

    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) {
      emitJobUpdate(job, true);
      return;
    }

    job.status = 'running';
    job.message = 'Загрузка beatmap-наборов…';
    job.activeTransfers = new Map();
    if (!job.abortController) job.abortController = new AbortController();
    log('info', 'download.job.started', { jobId: job.id, method: job.method, total: job.setIds.length });
    emitJobUpdate(job, true);

    const stopContext = {
      stopAfterCurrent: false,
      stopForCooldown: false,
      stopForNoSpace: false,
    };
    const deferredSetIds = new Set();
    const setsToCheck = job.retryOnlyIds ? Array.from(job.retryOnlyIds) : job.setIds;
    const concurrency = job.method === 'mirror' && auth.kind === 'mirror' ? Math.max(1, DOWNLOAD_CONCURRENCY) : 1;
    const actualConcurrency = Math.min(concurrency, setsToCheck.length || 1);

    // 3. Основной проход скачивания
    const getNextSetId = createQueueIterator(job.setIds, {
      retryOnlyIds: job.retryOnlyIds,
      doneIds: job.doneIds,
      skipIds: job.skipIds,
    });

    await runDownloadPool({
      job,
      auth,
      getNextSetId,
      isDeferred: false,
      concurrency: actualConcurrency,
      stopContext,
      deferredSetIds,
    });

    // 4. Второй проход: пробуем заново наборы, которые были отложены из-за остывания зеркал
    if (
      job.status !== 'cancelled' &&
      !job.abortController?.signal?.aborted &&
      !stopContext.stopAfterCurrent &&
      !stopContext.stopForCooldown &&
      !stopContext.stopForNoSpace &&
      deferredSetIds.size > 0
    ) {
      log('info', 'download.job.retry_deferred_started', { jobId: job.id, count: deferredSetIds.size });
      const deferredArray = Array.from(deferredSetIds);
      const getNextDeferredSetId = createQueueIterator(deferredArray, {
        doneIds: job.doneIds,
        skipIds: job.skipIds,
      });
      const actualDeferredConcurrency = Math.min(concurrency, deferredArray.length || 1);

      await runDownloadPool({
        job,
        auth,
        getNextSetId: getNextDeferredSetId,
        isDeferred: true,
        concurrency: actualDeferredConcurrency,
        stopContext,
        deferredSetIds,
      });
    }

    // 5. Финализация статуса задачи
    finalizeJobStatus(job, stopContext);
  } catch (fatalError) {
    job.status = 'finished_with_errors';
    const errMessage = safeErrorMessage(fatalError);
    job.message = `Критический сбой задачи: ${errMessage}`;
    job.errorsById?.set('fatal', {
      id: 'fatal',
      name: 'Системный сбой',
      error: errMessage,
    });
    job.extraFailures = Math.max(1, (job.extraFailures || 0) + 1);
    job.finishedAt = Date.now();
    delete job.pausedAt;
    if (job.retryOnlyIds) {
      delete job.retryOnlyIds;
    }
    log('error', 'download.job.fatal_error', {
      jobId: job.id,
      error: errMessage,
      stack: /** @type {any} */ (fatalError)?.stack,
    });
  } finally {
    if (job.retryOnlyIds && job.status !== 'paused') {
      for (const id of job.retryOnlyIds) {
        if (!job.doneIds?.has(id) && !job.skipIds?.has(id) && !job.errIds?.has(id)) {
          job.errIds?.add(id);
          if (job.errorsById && !job.errorsById.has(id)) {
            const name = job.mapsById?.get(id)?.label || `Набор ${id}`;
            const reason = job.status === 'cancelled' ? 'Загрузка отменена' : 'Загрузка не завершена';
            job.errorsById.set(id, { id, name, error: reason });
          }
        }
      }
      delete job.retryOnlyIds;
    }
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
  if (job.errorsById?.has('fatal') || (job.extraFailures || 0) > 0) {
    if (Array.isArray(job.setIds)) {
      for (const id of job.setIds) {
        if (Number.isSafeInteger(id) && id > 0 && !job.doneIds?.has(id) && !job.skipIds?.has(id)) {
          failed.add(id);
        }
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
    job.errIds?.delete(id);
    job.errorsById?.delete(id);
  }
  job.retryOnlyIds = new Set(failedIds);

  delete job.finishedAt;
  delete job.pausedAt;
  job.message = `Повторная попытка для ${formatPluralRu(failedIds.length, 'набора', 'наборов', 'наборов')} с ошибками…`;
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
    if (
      ['finished', 'finished_with_errors', 'cancelled'].includes(job.status) &&
      job.finishedAt &&
      now - job.finishedAt > 30 * 60 * 1000
    ) {
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
  getLegacyStateFilePath,
  serializeJob,
  deserializeJob,
  serializeState,
  saveStateToDisk,
  loadStateFromDisk,
  scheduleSaveState,
  clearSaveStateTimer,
  waitForPendingSaveState,
  _setPendingSavePromisesForTest,
  Job,
  JobStateMachine,
  JOB_STATUSES,
  VALID_JOB_TRANSITIONS,
  createJob,
  createQueueIterator,
  checkAndSkipIfAvailable,
  processSetDownload,
  runDownloadPool,
  finalizeJobStatus,
  prepareJobCollection,
  checkJobDiskSpace,
};
