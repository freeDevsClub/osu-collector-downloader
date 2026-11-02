"use strict";
const byId = id => document.getElementById(id);
const collectionForm = byId('collection-form');
const sessionForm = byId('session-form');
const oauthForm = byId('oauth-form');
const collectionUrl = byId('collection-url');
const previewButton = byId('preview-button');
const downloadButton = byId('download-button');
const cancelButton = byId('cancel-button');
const resumeButton = byId('resume-button');
const collectionCard = byId('collection-card');
const collectionStatus = byId('collection-status');
const downloadStatus = byId('download-status');
const progressWrap = byId('progress-wrap');
const progressBar = byId('progress-bar');
const progressLabel = byId('progress-label');
const progressPercent = byId('progress-percent');
const progressTrack = byId('progress-track');
const transferBar = byId('transfer-bar');
const transferTrack = byId('transfer-track');
const sessionInput = byId('session-cookie');
const methodInputs = [...document.querySelectorAll('input[name="download-method"]')];
const JOB_STORAGE_KEY = 'osu-collector-downloader.jobId';
const POLL_INTERVAL_MS = 1300;
const POLL_MAX_FAILURES = 3;

let mapListRenderId = 0;

let collection = null;
let activeJob = null;
let pausedJob = null;
let pollTimer = null;
let pollInFlight = false;
let pollFailures = 0;
let sessionConnected = false;
let oauthState = { configured: false, connected: false, callbackUrl: '' };
let mirrorStatus = [];

function setStatus(element, text = '', tone = '') {
  element.textContent = text;
  element.className = `status${tone ? ` ${tone}` : ''}`;
}

function notify(text) {
  const toast = byId('toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(url, options = {}) {
  // Таймаут на каждый запрос: зависший локальный сервер не должен оставлять вечное «Ищем…».
  const timeoutMs = options.timeoutMs ?? 20000;
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка запроса (${response.status})`);
  return data;
}

function selectedMethod() {
  const value = methodInputs.find(input => input.checked)?.value;
  return value === 'session' || value === 'oauth' ? value : 'mirror';
}

function methodReady(method) {
  if (method === 'mirror') return true;
  return method === 'oauth' ? oauthState.connected : sessionConnected;
}

function updateDownloadButton() {
  const method = selectedMethod();
  const ready = Boolean(collection && collection.count) && methodReady(method) && !activeJob;
  downloadButton.disabled = !ready;
  methodInputs.forEach(input => {
    const option = byId(`option-${input.value}`);
    option?.classList.toggle('selected', input.checked);
    option?.classList.toggle('locked', !methodReady(input.value));
  });
}

methodInputs.forEach(input => {
  input.addEventListener('change', updateDownloadButton);
});

function renderOauthStatus(status) {
  oauthState = {
    configured: Boolean(status.configured),
    connected: Boolean(status.connected),
    callbackUrl: status.callbackUrl || '',
  };
  const dot = byId('oauth-dot');
  const text = byId('oauth-text');
  dot.classList.toggle('connected', oauthState.connected);
  if (oauthState.connected) text.textContent = `Токен получен${status.kind === 'authorization_code' ? ' для вашего аккаунта' : ' (клиентские учётные данные)'}`;
  else if (oauthState.configured) text.textContent = 'Приложение сохранено — войдите через osu!';
  else text.textContent = 'OAuth-приложение не настроено';
  byId('oauth-disconnect').hidden = !oauthState.connected;
  byId('oauth-authorize').disabled = !oauthState.configured || oauthState.connected;
  byId('oauth-authorize').textContent = oauthState.connected ? 'Подключено' : 'Войти через osu!';
  const clientIdInput = byId('oauth-client-id');
  const secretInput = byId('oauth-client-secret');
  if (oauthState.configured) {
    clientIdInput.value = status.clientId || '';
    clientIdInput.required = true;
    secretInput.required = false;
    secretInput.placeholder = 'Секрет сохранён; заполните, чтобы заменить';
  } else {
    clientIdInput.required = true;
    secretInput.required = true;
  }
  if (oauthState.callbackUrl) byId('oauth-callback-code').textContent = oauthState.callbackUrl;
  updateDownloadButton();
}

function renderSessionState(connected) {
  sessionConnected = connected;
  byId('session-dot').classList.toggle('connected', connected);
  byId('session-text').textContent = connected ? 'Сессия сохранена до перезапуска' : 'Сессия не добавлена';
  byId('session-clear').hidden = !connected;
  sessionInput.required = !connected;
  sessionInput.placeholder = connected ? 'Сессия сохранена в памяти приложения' : 'Вставьте значение cookie osu_session';
  updateDownloadButton();
}

function renderMapList(setIds, maps) {
  // Список потенциально огромный (5000 выборок) — не рендерим всё за один проход, чтобы не завис браузер.
  // Защита от гонки: если пользователь повторно нажал «Показать карты», старый рендер прерывается.
  const renderId = ++mapListRenderId;
  const list = byId('map-list');
  list.replaceChildren();
  const mapsById = new Map((maps || []).map(map => [map.id, map]));
  const CHUNK_SIZE = 250;
  let index = 0;
  const renderChunk = () => {
    if (renderId !== mapListRenderId) return;
    const fragment = document.createDocumentFragment();
    for (const id of setIds.slice(index, index + CHUNK_SIZE)) {
      const map = mapsById.get(id);
      const item = document.createElement('span');
      item.className = 'map-id';
      const title = document.createElement('span');
      title.className = 'map-title';
      title.textContent = map?.label || `Набор ${id}`;
      item.append(title);
      if (map?.creator) {
        const artist = document.createElement('span');
        artist.className = 'map-artist';
        artist.textContent = `mapper: ${map.creator}`;
        item.append(artist);
      }
      fragment.append(item);
    }
    index += CHUNK_SIZE;
    list.append(fragment);
    if (index < setIds.length) {
      const idle = window.requestIdleCallback || (cb => setTimeout(cb, 0));
      idle(() => {
        if (renderId === mapListRenderId) renderChunk();
      });
    }
  };
  renderChunk();
}

function renderCollection(data) {
  collection = data;
  byId('collection-name').textContent = data.name;
  byId('collection-uploader').textContent = data.uploader ? `Автор: ${data.uploader}` : '';
  byId('collection-count').textContent = `${data.count} ${data.count === 1 ? 'набор' : 'наборов'}`;
  byId('collection-meta').replaceChildren();
  const metadata = [`${data.beatmapCount} карт`, `ID ${data.id}`];
  for (const text of metadata) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    byId('collection-meta').append(chip);
  }
  renderMapList(data.setIds || [], data.maps);
  collectionCard.classList.add('visible');
  updateDownloadButton();
  setStatus(collectionStatus, `Найдено ${data.count} уникальных наборов карт.`, 'success');
}

collectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const value = collectionUrl.value.trim();
  if (!value) return;
  previewButton.disabled = true;
  previewButton.textContent = 'Ищем…';
  collectionCard.classList.remove('visible');
  setStatus(collectionStatus, 'Получаю данные коллекции…');
  try {
    const data = await api('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ url: value }),
      timeoutMs: 60000,
    });
    renderCollection(data);
  } catch (error) {
    if (error.name === 'TimeoutError') {
      setStatus(collectionStatus, 'Время ожидания ответа истекло. Возможно, коллекция слишком большая или сервер osu!Collector перегружен.', 'error');
    } else {
      setStatus(collectionStatus, error.message, 'error');
    }
  } finally {
    previewButton.disabled = false;
    previewButton.textContent = 'Показать карты';
  }
});

sessionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const session = sessionInput.value.trim();
  if (!session) return;
  const button = byId('session-save');
  button.disabled = true;
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ session }) });
    sessionInput.value = '';
    renderSessionState(true);
    notify('Сессия сохранена только в памяти приложения.');
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
byId('session-clear').addEventListener('click', async () => {
  try {
    await api('/api/session', { method: 'DELETE' });
    renderSessionState(false);
    notify('Сессия удалена.');
  } catch (error) {
    notify(error.message);
  }
});

// Загружаем ту коллекцию, что открыта в предпросмотре, а не то, что осталось в поле ввода:
// после показа списка пользователь мог отредактировать текст в input.
function collectionPayload() {
  return collection?.id ? { url: String(collection.id) } : { url: collectionUrl.value.trim() };
}

downloadButton.addEventListener('click', async () => {
  if (!collection) return;
  const method = selectedMethod();
  if (!methodReady(method)) {
    setStatus(downloadStatus, method === 'oauth' ? 'Сначала подключите OAuth-приложение и войдите через osu!.' : 'Сначала сохраните cookie osu_session.', 'error');
    return;
  }
  downloadButton.disabled = true;
  setStatus(downloadStatus, 'Создаю задачу загрузки…');
  progressWrap.classList.add('visible');
  try {
    const job = await api(`/api/downloads?method=${method}`, {
      method: 'POST',
      body: JSON.stringify(collectionPayload()),
      // Создание задачи запрашивает коллекцию у osu!Collector — даём больше 20 секунд по умолчанию.
      timeoutMs: 60000,
    });
    pausedJob = null;
    resumeButton.hidden = true;
    startJobPolling(job.id);
    updateJob(job);
    void loadMirrors();
  } catch (error) {
    if (error.name === 'TimeoutError') {
      setStatus(downloadStatus, 'Локальный сервер не ответил вовремя — задача могла создаться; обновите страницу, чтобы вернуться к ней.', 'warn');
      downloadButton.disabled = false;
      return;
    }
    setStatus(downloadStatus, error.message, 'error');
    if (pausedJob) {
      resumeButton.hidden = false;
      cancelButton.hidden = false;
    }
    if (method === 'oauth') {
      try { await loadOauthStatus(); } catch {}
    }
    downloadButton.disabled = false;
    updateDownloadButton();
  }
});

function persistJobId(id) {
  try {
    if (id) localStorage.setItem(JOB_STORAGE_KEY, id);
    else localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {}
}

function startJobPolling(id) {
  activeJob = id;
  pausedJob = null;
  pollFailures = 0;
  persistJobId(id);
  cancelButton.hidden = false;
  resumeButton.hidden = true;
  progressWrap.classList.add('visible');
  scheduleNextPoll(0);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

// setTimeout-цепочка вместо setInterval: следующий опрос ставится после ответа, запросы не наслаиваются.
function scheduleNextPoll(delay = POLL_INTERVAL_MS) {
  stopPolling();
  pollTimer = setTimeout(() => { void pollJob(); }, delay);
}

async function pollJob() {
  if (!activeJob || pollInFlight) return;
  pollInFlight = true;
  try {
    const job = await api(`/api/downloads/${activeJob}`);
    pollFailures = 0;
    updateJob(job);
    const autoResuming = job.status === 'paused' && Number.isFinite(job.autoResumeAt);
    if (autoResuming) {
      // Задача продолжится сама — оставляем поллинг и возможность остановить.
      pausedJob = null;
      resumeButton.hidden = true;
      cancelButton.hidden = false;
      scheduleNextPoll();
      return;
    }
    if (['queued', 'running'].includes(job.status)) {
      scheduleNextPoll();
    } else {
      finishJob(job);
    }
  } catch (error) {
    if (error.status === 404 || /не найден/i.test(error.message)) {
      persistJobId(null);
      finishJob(null, 'Загрузка не найдена на сервере.');
      return;
    }
    if (pollFailures < POLL_MAX_FAILURES - 1) {
      // Один сбой опроса — не конец задачи: сервер продолжает скачивание, просто плохой ответ.
      pollFailures += 1;
      setStatus(downloadStatus, `Временный сбой связи (${error.message}) — задача на сервере продолжается, повторяю опрос…`, 'warn');
      scheduleNextPoll();
    } else {
      stopPolling();
      cancelButton.hidden = true;
      resumeButton.hidden = true;
      setStatus(downloadStatus, `Связь с локальным сервером потеряна (${error.message}). Задача на сервере может продолжать работу — обновите страницу (F5) после восстановления связи.`, 'error');
      updateDownloadButton();
    }
  } finally {
    pollInFlight = false;
  }
}

function updateJob(job) {
  if (Array.isArray(job.mirrors)) {
    updateMirrorsFromData(job.mirrors);
  }
  const total = job.total || 0;
  const percent = total ? Math.round(job.completed / total * 100) : 0;
  const currentPercent = Number.isFinite(job.currentPercent) ? job.currentPercent : null;
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressTrack.setAttribute('aria-valuenow', String(percent));
  progressLabel.textContent = job.currentSetName
    ? `${job.currentSetName} · ${job.completed} из ${total}`
    : job.currentSetId ? `Набор ${job.currentSetId} · ${job.completed} из ${total}` : `${job.completed} из ${total}`;
  transferBar.style.width = `${currentPercent ?? 0}%`;
  transferTrack.setAttribute('aria-valuenow', String(currentPercent ?? 0));
  byId('transfer-bytes').textContent = job.currentTotalBytes
    ? `${formatBytes(job.currentBytes)} / ${formatBytes(job.currentTotalBytes)}${currentPercent === null ? '' : ` · ${currentPercent}%`}`
    : `${formatBytes(job.currentBytes)} загружено${currentPercent === null ? ' · размер неизвестен' : ` · ${currentPercent}%`}`;
  byId('transfer-label').textContent = (job.currentSetName || (job.currentSetId ? `Набор ${job.currentSetId}` : 'Прогресс текущего набора')) + (job.currentMirror ? ` · ${job.currentMirror}` : '');
  byId('downloaded-count').textContent = String(job.downloaded);
  byId('skipped-count').textContent = String(job.skipped);
  byId('failed-count').textContent = String(job.failed);
  const tone = job.failed && job.status === 'finished_with_errors' ? 'error' : job.status === 'paused' ? 'warn' : job.status === 'finished' ? 'success' : '';
  const autoResume = job.status === 'paused' && Number.isFinite(job.autoResumeAt)
    ? ` Автовозобновление через ${Math.max(0, Math.ceil((job.autoResumeAt - Date.now()) / 1000))} с.`
    : '';
  setStatus(downloadStatus, `${job.message || 'Загрузка…'}${autoResume}`, tone);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 Б';
  if (value < 1024) return `${Math.round(value)} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function renderMirrors() {
  if (document.visibilityState !== 'visible') return; // фоновая вкладка не нуждается в обновлениях
  const container = byId('mirror-status');
  container.replaceChildren();
  const now = Date.now();
  for (const mirror of mirrorStatus) {
    const row = document.createElement('div');
    row.className = 'mirror-row';
    const cooling = mirror.cooldownUntil > now;
    const dot = document.createElement('span');
    dot.className = `session-dot${cooling ? ' cooling' : ' connected'}`;
    const name = document.createElement('span');
    name.className = 'mirror-name';
    name.textContent = mirror.label;
    const state = document.createElement('span');
    state.className = `mirror-state${cooling ? ' cooling' : ''}`;
    state.textContent = cooling ? `пауза ${Math.ceil((mirror.cooldownUntil - now) / 1000)} с` : 'доступно';
    row.append(dot, name, state);
    container.append(row);
  }
}

function updateMirrorsFromData(mirrors) {
  mirrorStatus = (mirrors || []).map(mirror => ({
    id: mirror.id,
    label: mirror.label,
    cooldownUntil: mirror.cooldownMs > 0 ? Date.now() + mirror.cooldownMs : 0,
  }));
  renderMirrors();
}

async function loadMirrors() {
  try {
    const data = await api('/api/mirrors');
    if (Array.isArray(data.mirrors)) {
      updateMirrorsFromData(data.mirrors);
    }
  } catch {}
}

function hasActiveCooldowns() {
  const now = Date.now();
  return mirrorStatus.some(m => m.cooldownUntil && m.cooldownUntil > now);
}

function finishJob(job, errorMessage = '') {
  stopPolling();
  activeJob = null;
  const canResume = (job?.status === 'paused' || (job?.status === 'finished_with_errors' && (job.deferred || 0) > 0)) && !errorMessage && !Number.isFinite(job.autoResumeAt);
  if (canResume) {
    pausedJob = job.id;
    resumeButton.hidden = false;
    cancelButton.hidden = false;
    persistJobId(job.id);
  } else {
    pausedJob = null;
    resumeButton.hidden = true;
    cancelButton.hidden = true;
    persistJobId(null);
  }
  if (errorMessage) setStatus(downloadStatus, errorMessage, 'error');
  else if (job?.status === 'finished') setStatus(downloadStatus, 'Готово! Файлы находятся в папке downloads.', 'success');
  else if (job?.status === 'paused') setStatus(downloadStatus, job.message || 'Зеркала временно ограничили загрузки — нажмите «Продолжить» позже.', 'warn');
  else if (job?.status === 'finished_with_errors') setStatus(downloadStatus, `${job.message} Успешные загрузки лежат в папке downloads.`, 'error');
  else if (job?.status === 'cancelled') setStatus(downloadStatus, 'Загрузка остановлена. Уже скачанные файлы сохранены.');
  updateDownloadButton();
}

resumeButton.addEventListener('click', async () => {
  if (!pausedJob) return;
  resumeButton.disabled = true;
  try {
    const job = await api(`/api/downloads/${pausedJob}/resume`, { method: 'POST', body: '{}' });
    startJobPolling(job.id);
    updateJob(job);
    void loadMirrors();
  } catch (error) {
    setStatus(downloadStatus, error.message, 'warn');
    void loadMirrors();
  } finally {
    resumeButton.disabled = false;
  }
});
cancelButton.addEventListener('click', async () => {
  const targetId = activeJob || pausedJob;
  if (!targetId) return;
  cancelButton.disabled = true;
  try {
    const job = await api(`/api/downloads/${targetId}/cancel`, { method: 'POST', body: '{}' });
    finishJob(job);
  } catch (error) {
    notify(error.message);
  } finally {
    cancelButton.disabled = false;
  }
});

async function loadOauthStatus() {
  const status = await api('/api/oauth/status');
  renderOauthStatus(status);
  return status;
}

oauthForm.addEventListener('submit', async event => {
  event.preventDefault();
  const clientId = byId('oauth-client-id').value.trim();
  const clientSecret = byId('oauth-client-secret').value.trim();
  if (!clientId || (!clientSecret && !oauthState.configured)) {
    setStatus(byId('oauth-status'), 'Укажите Client ID и Client Secret.', 'error');
    return;
  }
  const button = byId('oauth-save');
  button.disabled = true;
  button.textContent = 'Сохраняю…';
  try {
    const status = await api('/api/oauth/config', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    byId('oauth-client-secret').value = '';
    renderOauthStatus(status);
    setStatus(byId('oauth-status'), 'Приложение сохранено. Теперь войдите через osu!.', 'success');
    notify('OAuth-приложение сохранено только в памяти приложения.');
  } catch (error) {
    setStatus(byId('oauth-status'), error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Сохранить';
  }
});

byId('oauth-authorize').addEventListener('click', async () => {
  const button = byId('oauth-authorize');
  button.disabled = true;
  try {
    const { authorizeUrl } = await api('/api/oauth/start', { method: 'POST', body: '{}' });
    window.location.assign(authorizeUrl);
  } catch (error) {
    setStatus(byId('oauth-status'), error.message, 'error');
    button.disabled = false;
  }
});

byId('oauth-disconnect').addEventListener('click', async () => {
  try {
    const status = await api('/api/oauth/disconnect', { method: 'DELETE' });
    renderOauthStatus(status);
    setStatus(byId('oauth-status'), 'Токен отозван локально.', '');
    notify('Доступ OAuth отключён.');
  } catch (error) {
    notify(error.message);
  }
});

// Реактивация задачи после перезагрузки страницы: jobId живёт в localStorage.
async function restoreJob() {
  let storedId = null;
  try {
    storedId = localStorage.getItem(JOB_STORAGE_KEY);
  } catch {}
  if (!storedId) return;
  try {
    const job = await api(`/api/downloads/${storedId}`);
    if (['queued', 'running'].includes(job.status) || (job.status === 'paused')) {
      startJobPolling(job.id);
      updateJob(job);
    } else {
      persistJobId(null);
    }
  } catch (error) {
    if (error.status === 404 || /не найден|404/i.test(error.message)) persistJobId(null);
    else setStatus(downloadStatus, `Сервер помнит незавершённую задачу, но не отвечает: ${error.message}`, 'warn');
  }
}

// Отсчёт пауз зеркал перерисовывается каждую секунду только при наличии активных кулдаунов.
setInterval(() => {
  if (hasActiveCooldowns()) renderMirrors();
}, 1000);

// Фоновый опрос зеркал запускается только при открытой вкладке и если есть активная задача или активные кулдауны.
setInterval(() => {
  if (document.visibilityState === 'visible' && (activeJob || hasActiveCooldowns())) {
    void loadMirrors();
  }
}, 4000);

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const oauthResult = params.get('oauth');
  const oauthError = params.get('oauth_error');
  if (oauthResult || oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Запросы не блокируют друг друга: сбой OAuth не скрывает cookie-сессию
  const [sessionRes, oauthRes] = await Promise.allSettled([
    api('/api/session'),
    loadOauthStatus(),
    loadMirrors(),
  ]);

  if (sessionRes.status === 'fulfilled') {
    renderSessionState(Boolean(sessionRes.value?.connected));
  } else {
    renderSessionState(false);
  }

  if (oauthRes.status === 'fulfilled') {
    const status = oauthRes.value;
    if (oauthResult === 'connected') {
      setStatus(byId('oauth-status'), 'Авторизация osu! прошла успешно — можно скачивать.', 'success');
      notify('Вы вошли через osu!.');
    } else if (oauthError) {
      setStatus(byId('oauth-status'), `Авторизация не завершена: ${oauthError}`, 'error');
    } else if (status && !status.connected && status.configured) {
      setStatus(byId('oauth-status'), 'Приложение сохранено, но токен ещё не получен.', '');
    }
  }

  if (sessionRes.status === 'rejected' && oauthRes.status === 'rejected') {
    const error = sessionRes.reason;
    if (error?.name === 'TimeoutError') {
      setStatus(collectionStatus, 'Локальный сервер не отвечает — он запущен?', 'error');
    } else {
      setStatus(collectionStatus, `Не удалось подключиться к локальному серверу: ${error?.message || 'ошибка сети'}`, 'error');
    }
  }

  updateDownloadButton();
  await restoreJob();
}

initialize();
