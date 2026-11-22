// @ts-check
import { byId, toAny, formatBytes, setStatus, notify } from '../utils.js';
import { api, isSessionConnected } from '../api.js';
import { updateMirrorsFromData } from './mirrors.js';
import { getCollection, collectionPayload } from './collection.js';

export const JOB_STORAGE_KEY = 'osu-collector-downloader.jobId';
export const NOVIDEO_STORAGE_KEY = 'osu-collector-downloader.noVideo';
export const POLL_INTERVAL_MS = 1300;
export const POLL_MAX_FAILURES = 3;

let activeJob = null;
let pausedJob = null;
let lastJobId = null;
/** @type {EventSource | null} */
let jobEventSource = null;
let pollTimer = null;
let pollInFlight = false;
let pollFailures = 0;

let lastRenderedErrorsSignature = null;
let lastRenderedErrorsCount = -1;
let lastMirrorsSignature = null;

export function getActiveJob() {
  return activeJob;
}

export function setActiveJob(id) {
  activeJob = id;
}

export function getPausedJob() {
  return pausedJob;
}

export function setPausedJob(id) {
  pausedJob = id;
}

export function getLastJobId() {
  return lastJobId;
}

export function setLastJobId(id) {
  lastJobId = id;
}

function getMethodInputs() {
  return typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
    ? /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="download-method"]')])
    : [];
}

export function selectedMethod() {
  const methodInputs = getMethodInputs();
  const value = methodInputs.find((input) => input.checked)?.value;
  return value === 'session' ? 'session' : 'mirror';
}

/**
 * @param {string} method
 * @param {boolean} [connected]
 * @returns {boolean}
 */
export function methodReady(method, connected) {
  if (method === 'mirror') return true;
  return connected !== undefined ? connected : isSessionConnected();
}

/**
 * @param {any} [coll]
 * @param {boolean} [connected]
 */
export function updateDownloadButton(coll, connected) {
  const currentColl = coll !== undefined ? coll : getCollection();
  const currentConnected = connected !== undefined ? connected : isSessionConnected();
  const downloadButton = /** @type {HTMLButtonElement | null} */ (byId('download-button'));
  const checkboxNoVideo = /** @type {HTMLInputElement | null} */ (byId('checkbox-novideo'));
  const methodInputs = getMethodInputs();

  const method = selectedMethod();
  const ready = Boolean(currentColl && currentColl.count) && methodReady(method, currentConnected) && !activeJob;
  if (downloadButton) downloadButton.disabled = !ready;
  if (checkboxNoVideo) {
    checkboxNoVideo.disabled = Boolean(activeJob);
  }
  methodInputs.forEach((input) => {
    input.disabled = Boolean(activeJob);
    const option = byId(`option-${input.value}`);
    option?.classList.toggle('selected', input.checked);
    option?.classList.toggle('locked', !methodReady(input.value, currentConnected));
  });
}

/**
 * @param {string | null} id
 */
export function persistJobId(id) {
  try {
    if (typeof localStorage !== 'undefined') {
      if (id) localStorage.setItem(JOB_STORAGE_KEY, id);
      else localStorage.removeItem(JOB_STORAGE_KEY);
    }
  } catch {}
}

export function stopJobStream() {
  if (jobEventSource) {
    jobEventSource.onmessage = null;
    jobEventSource.onerror = null;
    jobEventSource.close();
    jobEventSource = null;
  }
}

export function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * @param {number} [delay=POLL_INTERVAL_MS]
 * @param {{ onJobUpdate?: (job: any) => void, onJobFinished?: (job: any, err?: string) => void }} [callbacks={}]
 */
export function scheduleNextPoll(delay = POLL_INTERVAL_MS, callbacks = {}) {
  stopPolling();
  pollTimer = setTimeout(() => {
    void pollJob(callbacks);
  }, delay);
}

/**
 * @param {string} id
 * @param {{ onJobUpdate?: (job: any) => void, onJobFinished?: (job: any, err?: string) => void }} [callbacks={}]
 */
export function startJobPolling(id, callbacks = {}) {
  activeJob = id;
  pausedJob = null;
  pollFailures = 0;
  persistJobId(id);

  const cancelButton = byId('cancel-button');
  const resumeButton = byId('resume-button');
  const retryFailedButton = byId('retry-failed-button');
  const progressWrap = byId('progress-wrap');

  if (cancelButton) cancelButton.hidden = false;
  if (resumeButton) resumeButton.hidden = true;
  if (retryFailedButton) retryFailedButton.hidden = true;
  progressWrap?.classList.add('visible');

  stopPolling();
  stopJobStream();

  if (typeof window !== 'undefined' && typeof window.EventSource === 'function') {
    try {
      const es = new EventSource(`/api/downloads/${id}/events`);
      jobEventSource = es;

      es.onmessage = (event) => {
        try {
          const job = JSON.parse(event.data);
          pollFailures = 0;
          updateJob(job);
          if (callbacks.onJobUpdate) callbacks.onJobUpdate(job);
          const autoResuming = job.status === 'paused' && Number.isFinite(job.autoResumeAt);
          if (autoResuming) {
            pausedJob = null;
            if (resumeButton) resumeButton.hidden = true;
            if (cancelButton) cancelButton.hidden = false;
            return;
          }
          if (!['preparing', 'queued', 'running'].includes(job.status)) {
            stopJobStream();
            finishJob(job);
            if (callbacks.onJobFinished) callbacks.onJobFinished(job);
          }
        } catch {}
      };

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          stopJobStream();
          if (activeJob) {
            scheduleNextPoll(1000, callbacks);
          }
        }
      };
      return;
    } catch {
      stopJobStream();
    }
  }

  scheduleNextPoll(0, callbacks);
}

/**
 * @param {{ onJobUpdate?: (job: any) => void, onJobFinished?: (job: any, err?: string) => void }} [callbacks={}]
 */
export async function pollJob(callbacks = {}) {
  if (!activeJob || pollInFlight) return;
  pollInFlight = true;
  const downloadStatus = byId('download-status');
  const resumeButton = byId('resume-button');
  const cancelButton = byId('cancel-button');

  try {
    const job = await api(`/api/downloads/${activeJob}`);
    pollFailures = 0;
    updateJob(job);
    if (callbacks.onJobUpdate) callbacks.onJobUpdate(job);

    const autoResuming = job.status === 'paused' && Number.isFinite(job.autoResumeAt);
    if (autoResuming) {
      // Задача продолжится сама — оставляем поллинг и возможность остановить.
      pausedJob = null;
      if (resumeButton) resumeButton.hidden = true;
      if (cancelButton) cancelButton.hidden = false;
      scheduleNextPoll(POLL_INTERVAL_MS, callbacks);
      return;
    }
    if (['preparing', 'queued', 'running'].includes(job.status)) {
      scheduleNextPoll(POLL_INTERVAL_MS, callbacks);
    } else {
      finishJob(job);
      if (callbacks.onJobFinished) callbacks.onJobFinished(job);
    }
  } catch (rawError) {
    const error = toAny(rawError);
    if (error.status === 404 || /не найден/i.test(error.message)) {
      persistJobId(null);
      finishJob(null, 'Загрузка не найдена на сервере.');
      if (callbacks.onJobFinished) callbacks.onJobFinished(null, 'Загрузка не найдена на сервере.');
      return;
    }
    if (pollFailures < POLL_MAX_FAILURES - 1) {
      // Один сбой опроса — не конец задачи: сервер продолжает скачивание, просто плохой ответ.
      pollFailures += 1;
      setStatus(
        downloadStatus,
        `Временный сбой связи (${error.message}) — задача на сервере продолжается, повторяю опрос…`,
        'warn',
      );
      scheduleNextPoll(POLL_INTERVAL_MS, callbacks);
    } else {
      stopPolling();
      if (cancelButton) cancelButton.hidden = true;
      if (resumeButton) resumeButton.hidden = true;
      setStatus(
        downloadStatus,
        `Связь с локальным сервером потеряна (${error.message}). Задача на сервере может продолжать работу — обновите страницу (F5) после восстановления связи.`,
        'error',
      );
      updateDownloadButton();
    }
  } finally {
    pollInFlight = false;
  }
}

/**
 * @param {any} job
 */
export function updateJob(job) {
  if (job?.id) lastJobId = job.id;
  if (Array.isArray(job.mirrors)) {
    const mirrorsSig = job.mirrors.map((m) => `${m.id}:${m.cooldownMs > 0 ? 1 : 0}`).join('|');
    if (mirrorsSig !== lastMirrorsSignature) {
      lastMirrorsSignature = mirrorsSig;
      updateMirrorsFromData(job.mirrors);
    }
  }

  const checkboxNoVideo = /** @type {HTMLInputElement | null} */ (byId('checkbox-novideo'));
  if (checkboxNoVideo && typeof job.noVideo === 'boolean' && activeJob) {
    checkboxNoVideo.checked = job.noVideo;
  }

  const methodInputs = getMethodInputs();
  if (job?.method && activeJob) {
    const targetInput = methodInputs.find((input) => input.value === job.method);
    if (targetInput && !targetInput.checked) {
      targetInput.checked = true;
      updateDownloadButton();
    }
  }

  const retryFailedButton = /** @type {HTMLButtonElement | null} */ (byId('retry-failed-button'));
  if (retryFailedButton) {
    const isRunning = ['preparing', 'queued', 'running'].includes(job.status);
    const canRetry = Boolean(!isRunning && (job.canRetryFailed ?? job.failed > 0));
    retryFailedButton.hidden = !canRetry;
    if (canRetry) {
      retryFailedButton.textContent = job.failed ? `Повторить ошибки (${job.failed})` : 'Повторить ошибки';
    }
  }

  const total = job.total || 0;
  const percent = total ? Math.round((job.completed / total) * 100) : 0;
  const currentPercent = Number.isFinite(job.currentPercent) ? job.currentPercent : null;

  const progressBarEl = byId('progress-bar');
  const progressPercentEl = byId('progress-percent');
  const progressTrackEl = byId('progress-track');
  const progressLabelEl = byId('progress-label');

  if (progressBarEl) progressBarEl.style.setProperty('--progress', `${percent}%`);
  if (progressPercentEl) progressPercentEl.textContent = `${percent}%`;
  if (progressTrackEl) progressTrackEl.setAttribute('aria-valuenow', String(percent));
  if (progressLabelEl) {
    let statusPrefix = 'Загрузка…';
    if (job.status === 'preparing') statusPrefix = 'Подготовка…';
    else if (job.status === 'queued') statusPrefix = 'В очереди ·';
    else if (job.status === 'paused') statusPrefix = 'Пауза ·';
    else if (job.status === 'finished') statusPrefix = 'Завершено ·';
    else if (job.status === 'finished_with_errors') statusPrefix = 'Завершено с ошибками ·';
    else if (job.status === 'cancelled') statusPrefix = 'Остановлено ·';

    progressLabelEl.textContent =
      total > 0 ? `${statusPrefix} ${job.completed} из ${total}` : job.message || statusPrefix;
  }

  // Обновление выпадающего списка активных параллельных загрузок
  const transfersListEl = byId('transfers-list');
  const transfersChevronEl = byId('transfers-chevron');
  const transfersDetailsEl = /** @type {HTMLDetailsElement | null} */ (byId('transfers-details'));

  /** @type {Array<{ setId?: number, setName?: string, mirror?: string, bytes?: number, totalBytes?: number | null, percent?: number | null }>} */
  const activeTransfers =
    Array.isArray(job.activeTransfers) && job.activeTransfers.length > 0
      ? job.activeTransfers
      : (job.currentSetId || job.currentSetName) && ['preparing', 'running', 'queued'].includes(job.status)
        ? [
            {
              setId: job.currentSetId,
              setName: job.currentSetName || `Набор ${job.currentSetId}`,
              mirror: job.currentMirror || '',
              bytes: job.currentBytes || 0,
              totalBytes: job.currentTotalBytes,
              percent: currentPercent,
            },
          ]
        : [];

  if (transfersChevronEl) {
    transfersChevronEl.hidden =
      activeTransfers.length === 0 && !['preparing', 'running', 'queued'].includes(job.status);
  }

  if (transfersListEl && transfersDetailsEl) {
    if (activeTransfers.length === 0) {
      if (transfersDetailsEl.open) {
        transfersListEl.innerHTML = '<div class="transfer-empty">Нет активных загрузок в данный момент</div>';
      } else {
        transfersListEl.replaceChildren();
      }
    } else {
      transfersListEl.replaceChildren();
      for (const t of activeTransfers) {
        const item = document.createElement('div');
        item.className = 'transfer-item';

        const head = document.createElement('div');
        head.className = 'transfer-item-head';

        const title = document.createElement('span');
        title.className = 'transfer-item-title';
        title.textContent = t.setName || (t.setId ? `Набор ${t.setId}` : 'Без названия');
        title.title = title.textContent;
        head.appendChild(title);

        if (t.mirror) {
          const mirror = document.createElement('span');
          mirror.className = 'transfer-item-mirror';
          mirror.textContent = t.mirror;
          head.appendChild(mirror);
        }
        item.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'transfer-item-meta';

        const bytesSpan = document.createElement('span');
        bytesSpan.textContent = t.totalBytes
          ? `${formatBytes(t.bytes || 0)} / ${formatBytes(t.totalBytes)}`
          : `${formatBytes(t.bytes || 0)} загружено`;
        meta.appendChild(bytesSpan);

        if (t.percent !== null && t.percent !== undefined) {
          const percentSpan = document.createElement('span');
          percentSpan.textContent = `${t.percent}%`;
          meta.appendChild(percentSpan);
        }
        item.appendChild(meta);

        const track = document.createElement('div');
        track.className = 'transfer-item-track';
        const bar = document.createElement('div');
        bar.className = 'transfer-item-bar';
        bar.style.setProperty('--progress', `${t.percent ?? 0}%`);
        track.appendChild(bar);
        item.appendChild(track);

        transfersListEl.appendChild(item);
      }
    }
  }

  const transferBar = byId('transfer-bar');
  if (transferBar) transferBar.style.setProperty('--progress', `${currentPercent ?? 0}%`);
  const transferTrack = byId('transfer-track');
  if (transferTrack) transferTrack.setAttribute('aria-valuenow', String(currentPercent ?? 0));
  const transferBytesEl = byId('transfer-bytes');
  if (transferBytesEl) {
    transferBytesEl.textContent = job.currentTotalBytes
      ? `${formatBytes(job.currentBytes)} / ${formatBytes(job.currentTotalBytes)}${currentPercent === null ? '' : ` · ${currentPercent}%`}`
      : `${formatBytes(job.currentBytes)} загружено${currentPercent === null ? ' · размер неизвестен' : ` · ${currentPercent}%`}`;
  }
  const transferLabelEl = byId('transfer-label');
  if (transferLabelEl) {
    transferLabelEl.textContent =
      (job.currentSetName || (job.currentSetId ? `Набор ${job.currentSetId}` : 'Прогресс текущего набора')) +
      (job.currentMirror ? ` · ${job.currentMirror}` : '') +
      (job.noVideo ? ' · без видео' : '');
  }

  const dlCountEl = byId('downloaded-count');
  if (dlCountEl) dlCountEl.textContent = String(job.downloaded);
  const skipCountEl = byId('skipped-count');
  if (skipCountEl) skipCountEl.textContent = String(job.skipped);
  const failCountEl = byId('failed-count');
  if (failCountEl) failCountEl.textContent = String(job.failed);

  const failedDetails = byId('failed-details');
  const failedList = byId('failed-list');
  const failedCountSpan = byId('failed-summary-count');
  if (failedDetails && failedList && failedCountSpan) {
    if (Array.isArray(job.errors)) {
      const errorCount = job.errors.length;
      if (errorCount > 0) {
        failedDetails.hidden = false;
        failedCountSpan.textContent = String(errorCount);
        const lastErr = job.errors[errorCount - 1];
        const firstErr = job.errors[0];
        const errorsSig = `${errorCount}:${firstErr?.id}:${lastErr?.id}:${lastErr?.error}`;
        if (errorsSig !== lastRenderedErrorsSignature) {
          lastRenderedErrorsSignature = errorsSig;
          lastRenderedErrorsCount = errorCount;
          failedList.replaceChildren();
          for (const err of job.errors) {
            const item = document.createElement('div');
            item.className = 'failed-item';
            const title = document.createElement('div');
            title.className = 'failed-item-title';
            title.textContent = err.name || `Набор ${err.id}`;
            const reason = document.createElement('div');
            reason.className = 'failed-item-reason';
            reason.textContent = err.error || 'Ошибка загрузки';
            item.append(title, reason);
            failedList.append(item);
          }
        }
      } else if (lastRenderedErrorsCount !== 0) {
        failedDetails.hidden = true;
        failedList.replaceChildren();
        lastRenderedErrorsSignature = '';
        lastRenderedErrorsCount = 0;
      }
    }
  }

  const hasWarnings = Array.isArray(job.warnings) && job.warnings.length > 0;
  const tone =
    job.failed && job.status === 'finished_with_errors'
      ? 'error'
      : job.status === 'paused' || (job.status === 'finished' && hasWarnings)
        ? 'warn'
        : job.status === 'finished'
          ? 'success'
          : '';
  const autoResume =
    job.status === 'paused' && Number.isFinite(job.autoResumeAt)
      ? ` Автовозобновление через ${Math.max(0, Math.ceil((job.autoResumeAt - Date.now()) / 1000))} с.`
      : '';
  const downloadStatus = byId('download-status');
  setStatus(downloadStatus, `${job.message || 'Загрузка…'}${autoResume}`, tone);
}

/**
 * @param {any} job
 * @param {string} [errorMessage='']
 */
export function finishJob(job, errorMessage = '') {
  lastRenderedErrorsSignature = null;
  lastRenderedErrorsCount = -1;
  lastMirrorsSignature = null;
  stopJobStream();
  stopPolling();
  activeJob = null;
  if (job?.id) lastJobId = job.id;

  const resumeButton = byId('resume-button');
  const cancelButton = byId('cancel-button');
  const retryFailedButton = /** @type {HTMLButtonElement | null} */ (byId('retry-failed-button'));
  const downloadStatus = byId('download-status');

  const canResume =
    (job?.status === 'paused' || (job?.status === 'finished_with_errors' && (job.deferred || 0) > 0)) &&
    !errorMessage &&
    !Number.isFinite(job.autoResumeAt);
  if (canResume) {
    pausedJob = job.id;
    if (resumeButton) resumeButton.hidden = false;
    if (cancelButton) cancelButton.hidden = false;
    persistJobId(job.id);
  } else {
    pausedJob = null;
    if (resumeButton) resumeButton.hidden = true;
    if (cancelButton) cancelButton.hidden = true;
    persistJobId(null);
  }

  const canRetry = Boolean(
    job && (job.canRetryFailed ?? job.failed > 0) && !['preparing', 'queued', 'running'].includes(job.status),
  );
  if (retryFailedButton) {
    retryFailedButton.hidden = !canRetry;
    if (canRetry) {
      retryFailedButton.textContent = job.failed ? `Повторить ошибки (${job.failed})` : 'Повторить ошибки';
    }
  }

  if (job && ['finished', 'finished_with_errors'].includes(job.status)) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('osu-collector-downloader.lastSummary', JSON.stringify(job));
      }
    } catch {}
  }

  if (errorMessage) setStatus(downloadStatus, errorMessage, 'error');
  else if (job?.status === 'finished') {
    if (Array.isArray(job?.warnings) && job.warnings.length > 0) {
      setStatus(
        downloadStatus,
        job.message || 'Готово! Файлы находятся в папке downloads (интеграция с osu! пропущена).',
        'warn',
      );
      notify('Внимание: карты скачаны в downloads, но интеграция с osu! пропущена. Проверьте настройки папки osu!.');
    } else {
      setStatus(downloadStatus, 'Готово! Файлы находятся в папке downloads.', 'success');
    }
  } else if (job?.status === 'paused')
    setStatus(
      downloadStatus,
      job.message || 'Зеркала временно ограничили загрузки — нажмите «Продолжить» позже.',
      'warn',
    );
  else if (job?.status === 'finished_with_errors')
    setStatus(downloadStatus, `${job.message} Успешные загрузки лежат в папке downloads.`, 'error');
  else if (job?.status === 'cancelled')
    setStatus(downloadStatus, 'Загрузка остановлена. Уже скачанные файлы сохранены.');

  updateDownloadButton();

  if (typeof document !== 'undefined') {
    const activeEl = document.activeElement;
    if (
      typeof HTMLElement !== 'undefined' &&
      activeEl instanceof HTMLElement &&
      activeEl !== document.body &&
      activeEl !== document.documentElement
    ) {
      activeEl.blur();
    }
  }
  if (typeof window !== 'undefined' && typeof window.focus === 'function') {
    try {
      window.focus();
    } catch {}
  }
}

export async function restoreJob() {
  const progressWrap = byId('progress-wrap');
  const downloadStatus = byId('download-status');

  let storedId = null;
  try {
    if (typeof localStorage !== 'undefined') {
      storedId = localStorage.getItem(JOB_STORAGE_KEY);
    }
  } catch {}

  if (!storedId) {
    try {
      const active = await api('/api/downloads/active');
      if (active?.id) {
        storedId = active.id;
        persistJobId(storedId);
      }
    } catch {}
  }
  if (!storedId) return;

  try {
    const job = await api(`/api/downloads/${storedId}`);
    if (['preparing', 'queued', 'running'].includes(job.status)) {
      startJobPolling(job.id);
      updateJob(job);
    } else if (job.status === 'paused') {
      progressWrap?.classList.add('visible');
      updateJob(job);
      if (Number.isFinite(job.autoResumeAt)) {
        startJobPolling(job.id);
      } else {
        finishJob(job);
      }
    } else {
      persistJobId(null);
      progressWrap?.classList.add('visible');
      updateJob(job);
      finishJob(job);
    }
  } catch (rawError) {
    const error = toAny(rawError);
    if (error.status === 404 || /не найден|404/i.test(error.message)) {
      persistJobId(null);
      try {
        if (typeof localStorage !== 'undefined') {
          const lastRaw = localStorage.getItem('osu-collector-downloader.lastSummary');
          if (lastRaw) {
            const lastJob = JSON.parse(lastRaw);
            if (lastJob && lastJob.id === storedId) {
              progressWrap?.classList.add('visible');
              updateJob(lastJob);
              finishJob(lastJob);
              setStatus(
                downloadStatus,
                `${lastJob.message || 'Загрузка завершена.'} (сохранено локально)`,
                lastJob.failed ? 'error' : 'success',
              );
              return;
            }
          }
        }
      } catch {}
    } else {
      setStatus(downloadStatus, `Сервер помнит незавершённую задачу, но не отвечает: ${error.message}`, 'warn');
    }
  }
}

/**
 * @param {{ loadMirrors?: () => Promise<void> }} [options={}]
 */
export function initDownloadsUi(options = {}) {
  const downloadButton = /** @type {HTMLButtonElement | null} */ (byId('download-button'));
  const cancelButton = /** @type {HTMLButtonElement | null} */ (byId('cancel-button'));
  const resumeButton = /** @type {HTMLButtonElement | null} */ (byId('resume-button'));
  const retryFailedButton = /** @type {HTMLButtonElement | null} */ (byId('retry-failed-button'));
  const checkboxNoVideo = /** @type {HTMLInputElement | null} */ (byId('checkbox-novideo'));
  const sessionInput = /** @type {HTMLInputElement | null} */ (byId('session-cookie'));
  const sessionAdvancedDetails = /** @type {HTMLDetailsElement | null} */ (byId('session-advanced-details'));
  const downloadStatus = byId('download-status');
  const progressWrap = byId('progress-wrap');

  const methodInputs = getMethodInputs();

  if (checkboxNoVideo && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(NOVIDEO_STORAGE_KEY);
      if (saved !== null) {
        checkboxNoVideo.checked = saved === 'true';
      }
    } catch {}
    checkboxNoVideo.addEventListener('change', () => {
      try {
        localStorage.setItem(NOVIDEO_STORAGE_KEY, String(checkboxNoVideo.checked));
      } catch {}
    });
  }

  methodInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.value === 'session' && input.checked && !isSessionConnected()) {
        if (sessionAdvancedDetails) sessionAdvancedDetails.open = true;
        sessionInput?.focus();
        notify('Для скачивания с аккаунтом добавьте cookie osu_session в блоке ниже.');
      }
      updateDownloadButton();
    });
  });

  downloadButton?.addEventListener('click', async () => {
    const currentColl = getCollection();
    if (!currentColl) return;
    const method = selectedMethod();
    if (!methodReady(method)) {
      setStatus(downloadStatus, 'Сначала сохраните cookie osu_session.', 'error');
      return;
    }
    downloadButton.disabled = true;
    setStatus(downloadStatus, 'Создаю задачу загрузки…');
    progressWrap?.classList.add('visible');
    try {
      const noVideo = Boolean(checkboxNoVideo?.checked);
      const job = await api(`/api/downloads?method=${method}${noVideo ? '&noVideo=1' : ''}`, {
        method: 'POST',
        body: JSON.stringify({ ...collectionPayload(), noVideo }),
        timeoutMs: 15000,
      });
      pausedJob = null;
      if (resumeButton) resumeButton.hidden = true;
      if (retryFailedButton) retryFailedButton.hidden = true;
      if (cancelButton) cancelButton.hidden = false;
      startJobPolling(job.id);
      updateJob(job);
      if (options.loadMirrors) void options.loadMirrors();
    } catch (rawError) {
      const error = toAny(rawError);
      if (error.name === 'TimeoutError') {
        setStatus(
          downloadStatus,
          'Локальный сервер не ответил вовремя — задача могла создаться; обновите страницу, чтобы вернуться к ней.',
          'warn',
        );
        downloadButton.disabled = false;
        return;
      }
      setStatus(downloadStatus, error.message, 'error');
      if (pausedJob) {
        if (resumeButton) resumeButton.hidden = false;
        if (cancelButton) cancelButton.hidden = false;
      }
      downloadButton.disabled = false;
      updateDownloadButton();
    }
  });

  resumeButton?.addEventListener('click', async () => {
    if (!pausedJob) return;
    const method = selectedMethod();
    if (!methodReady(method)) {
      setStatus(downloadStatus, 'Сначала сохраните cookie osu_session.', 'error');
      return;
    }
    resumeButton.disabled = true;
    try {
      const noVideo = Boolean(checkboxNoVideo?.checked);
      const job = await api(`/api/downloads/${pausedJob}/resume?method=${method}${noVideo ? '&noVideo=1' : ''}`, {
        method: 'POST',
        body: JSON.stringify({ method, noVideo }),
      });
      startJobPolling(job.id);
      updateJob(job);
      if (options.loadMirrors) void options.loadMirrors();
    } catch (rawError) {
      setStatus(downloadStatus, toAny(rawError).message, 'warn');
      if (options.loadMirrors) void options.loadMirrors();
    } finally {
      resumeButton.disabled = false;
    }
  });

  if (retryFailedButton) {
    retryFailedButton.addEventListener('click', async () => {
      const targetId = activeJob || pausedJob || lastJobId;
      if (!targetId) return;
      const method = selectedMethod();
      if (!methodReady(method)) {
        setStatus(downloadStatus, 'Сначала сохраните cookie osu_session.', 'error');
        return;
      }
      retryFailedButton.disabled = true;
      setStatus(downloadStatus, 'Перезапуск загрузки наборов с ошибками…');
      try {
        const noVideo = Boolean(checkboxNoVideo?.checked);
        const job = await api(
          `/api/downloads/${targetId}/retry-failed?method=${method}${noVideo ? '&noVideo=1' : ''}`,
          {
            method: 'POST',
            body: JSON.stringify({ noVideo }),
          },
        );
        pausedJob = null;
        if (resumeButton) resumeButton.hidden = true;
        retryFailedButton.hidden = true;
        if (cancelButton) cancelButton.hidden = false;
        startJobPolling(job.id);
        updateJob(job);
        if (options.loadMirrors) void options.loadMirrors();
      } catch (rawError) {
        const error = toAny(rawError);
        setStatus(downloadStatus, error.message, 'warn');
        if (options.loadMirrors) void options.loadMirrors();
      } finally {
        retryFailedButton.disabled = false;
      }
    });
  }

  cancelButton?.addEventListener('click', async () => {
    const targetId = activeJob || pausedJob;
    if (!targetId) return;
    cancelButton.disabled = true;
    try {
      const job = await api(`/api/downloads/${targetId}/cancel`, { method: 'POST', body: '{}' });
      updateJob(job);
      finishJob(job);
    } catch (rawError) {
      notify(toAny(rawError).message);
    } finally {
      cancelButton.disabled = false;
    }
  });
}
