// @ts-check
"use strict";

/**
 * @param {string} id
 * @returns {any}
 */
const byId = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);

/**
 * @param {unknown} err
 * @returns {any}
 */
const toAny = err => /** @type {any} */ (err);

const ruPluralRules = new Intl.PluralRules('ru-RU');

/**
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function pluralizeRu(count, one, few, many) {
  const rule = ruPluralRules.select(Math.abs(count));
  switch (rule) {
    case 'one':
      return one;
    case 'few':
      return few;
    case 'many':
    default:
      return many;
  }
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function formatPluralRu(count, one, few, many) {
  return `${count} ${pluralizeRu(count, one, few, many)}`;
}

const collectionForm = byId('collection-form');
const sessionForm = byId('session-form');
const collectionUrl = byId('collection-url');
const previewButton = byId('preview-button');
const downloadButton = byId('download-button');
const cancelButton = byId('cancel-button');
const resumeButton = byId('resume-button');
const retryFailedButton = byId('retry-failed-button');
const collectionCard = byId('collection-card');
const collectionStatus = byId('collection-status');
const downloadStatus = byId('download-status');
const progressWrap = byId('progress-wrap');
const progressBar = byId('progress-bar');
const progressLabel = byId('progress-label');
const progressPercent = byId('progress-percent');
const progressTrack = byId('progress-track');
const transfersDetails = /** @type {HTMLDetailsElement | null} */ (byId('transfers-details'));
const transfersList = byId('transfers-list');
const transfersChevron = byId('transfers-chevron');
const transferBar = byId('transfer-bar');
const transferTrack = byId('transfer-track');
const sessionInput = byId('session-cookie');
const sessionRiskConfirm = /** @type {HTMLInputElement | null} */ (byId('session-risk-confirm'));
const sessionAdvancedDetails = /** @type {HTMLDetailsElement | null} */ (byId('session-advanced-details'));
const checkboxNoVideo = /** @type {HTMLInputElement | null} */ (byId('checkbox-novideo'));
/** @type {HTMLInputElement[]} */
const methodInputs = typeof document !== 'undefined' ? /** @type {any} */ ([...document.querySelectorAll('input[name="download-method"]')]) : [];
const osuPathInput = /** @type {HTMLInputElement | null} */ (byId('osu-path-input'));
const osuPathBrowse = byId('osu-path-browse');
const osuPathSave = byId('osu-path-save');
const osuDot = byId('osu-dot');
const osuText = byId('osu-text');
const osuRescan = byId('osu-rescan');
const osuStatus = byId('osu-status');
const checkboxCheckExisting = /** @type {HTMLInputElement | null} */ (byId('checkbox-check-existing'));
/** @type {HTMLInputElement[]} */
const postActionInputs = typeof document !== 'undefined' ? /** @type {any} */ ([...document.querySelectorAll('input[name="post-download-action"]')]) : [];
const JOB_STORAGE_KEY = 'osu-collector-downloader.jobId';
const NOVIDEO_STORAGE_KEY = 'osu-collector-downloader.noVideo';
const POLL_INTERVAL_MS = 1300;
const POLL_MAX_FAILURES = 3;

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

let mapListRenderId = 0;
const mapElementsById = new Map();
/** @type {Array<{ item: HTMLElement, title: HTMLElement, creator: HTMLElement | null, badge: HTMLElement | null, currentId: number | undefined }>} */
let mapListByIndex = [];
let metadataPollTimer = null;
let metadataPollInFlight = false;
let pollingCollectionId = null;

let lastRenderedErrorsSignature = null;
let lastRenderedErrorsCount = -1;
let lastMirrorsSignature = null;

let collection = null;
let activeJob = null;
let pausedJob = null;
let lastJobId = null;
/** @type {EventSource | null} */
let jobEventSource = null;
let pollTimer = null;
let pollInFlight = false;
let pollFailures = 0;
let sessionConnected = false;
let mirrorStatus = [];
let osuSettings = {
  osuPath: '',
  songsDir: null,
  valid: false,
  songsCount: 0,
  checkExisting: true,
  postDownloadAction: 'none',
};

function setStatus(element, text = '', tone = '') {
  if (!element) return;
  element.textContent = text;
  element.className = `status${tone ? ` ${tone}` : ''}`;
}

let notifyTimer = null;
function notify(text) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => toast.classList.remove('show'), 3200);
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
  if (!response.ok) {
    if (response.status === 401) {
      notify(data.error || 'Требуется авторизация. Откройте приложение по ссылке из консоли.');
    }
    const err = /** @type {any} */ (new Error(data.error || `Ошибка запроса (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return data;
}

function selectedMethod() {
  const value = methodInputs.find(input => input.checked)?.value;
  return value === 'session' ? 'session' : 'mirror';
}

function methodReady(method) {
  if (method === 'mirror') return true;
  return sessionConnected;
}

function updateDownloadButton() {
  const method = selectedMethod();
  const ready = Boolean(collection && collection.count) && methodReady(method) && !activeJob;
  if (downloadButton) downloadButton.disabled = !ready;
  if (checkboxNoVideo) {
    checkboxNoVideo.disabled = Boolean(activeJob);
  }
  methodInputs.forEach(input => {
    input.disabled = Boolean(activeJob);
    const option = byId(`option-${input.value}`);
    option?.classList.toggle('selected', input.checked);
    option?.classList.toggle('locked', !methodReady(input.value));
  });
}

function updateSessionSaveButton() {
  const button = /** @type {HTMLButtonElement | null} */ (byId('session-save'));
  if (!button) return;
  const val = sessionInput ? sessionInput.value.trim() : '';
  const cleanVal = val.toLowerCase().startsWith('osu_session=') ? val.slice('osu_session='.length).trim() : val;
  const validLength = cleanVal.length >= 20 && cleanVal.length <= 1024;
  const confirmed = Boolean(sessionRiskConfirm?.checked);
  button.disabled = !validLength || !confirmed;
}

sessionInput?.addEventListener('input', updateSessionSaveButton);
sessionRiskConfirm?.addEventListener('change', updateSessionSaveButton);

methodInputs.forEach(input => {
  input.addEventListener('change', () => {
    if (input.value === 'session' && input.checked && !sessionConnected) {
      if (sessionAdvancedDetails) sessionAdvancedDetails.open = true;
      sessionInput?.focus();
      notify('Для скачивания с аккаунтом добавьте cookie osu_session в блоке ниже.');
    }
    updateDownloadButton();
  });
});

function renderSessionState(connected) {
  sessionConnected = connected;
  byId('session-dot')?.classList.toggle('connected', connected);
  const textEl = byId('session-text');
  if (textEl) {
    textEl.textContent = connected ? 'Сессия сохранена в памяти (до 6 ч или до перезапуска)' : 'Сессия не добавлена';
  }
  const clearBtn = byId('session-clear');
  if (clearBtn) clearBtn.hidden = !connected;
  if (sessionInput) {
    sessionInput.placeholder = connected ? 'Сессия активна в памяти (вставьте новую для замены)' : 'Вставьте значение cookie osu_session';
  }
  if (sessionRiskConfirm) {
    sessionRiskConfirm.checked = false;
  }
  updateSessionSaveButton();
  updateDownloadButton();
}

function renderOsuSettings(settings, updateInput = true) {
  osuSettings = {
    osuPath: settings?.osuPath || '',
    songsDir: settings?.songsDir || null,
    valid: Boolean(settings?.valid),
    songsCount: Number(settings?.songsCount || 0),
    checkExisting: settings?.checkExisting !== undefined ? Boolean(settings.checkExisting) : true,
    postDownloadAction: ['none', 'move', 'extract', 'copy'].includes(settings?.postDownloadAction)
      ? settings.postDownloadAction
      : 'none',
  };

  if (updateInput && osuPathInput && document.activeElement !== osuPathInput) {
    osuPathInput.value = osuSettings.osuPath;
  }
  if (checkboxCheckExisting) {
    checkboxCheckExisting.checked = osuSettings.checkExisting;
  }
  postActionInputs.forEach(input => {
    input.checked = input.value === osuSettings.postDownloadAction;
    const option = byId(`option-action-${input.value}`);
    option?.classList.toggle('selected', input.checked);
  });

  const extraDetails = /** @type {HTMLDetailsElement | null} */ (byId('extra-actions-details'));
  if (extraDetails && (osuSettings.postDownloadAction === 'move' || osuSettings.postDownloadAction === 'copy')) {
    extraDetails.open = true;
  }

  if (osuDot) {
    osuDot.className = `session-dot${osuSettings.valid ? ' connected' : ''}`;
  }
  if (osuText) {
    if (osuSettings.valid && osuSettings.songsDir) {
      osuText.textContent = `Подключено: найдено ${formatPluralRu(osuSettings.songsCount, 'набор', 'набора', 'наборов')} карт`;
    } else if (osuSettings.osuPath) {
      osuText.textContent = 'Папка Songs не найдена по указанному пути';
    } else {
      osuText.textContent = 'Путь к игре osu! не настроен';
    }
  }
}

async function loadOsuSettings() {
  try {
    const data = await api('/api/osu/settings');
    renderOsuSettings(data);
    return data;
  } catch {
    renderOsuSettings(null);
  }
}

/**
 * @param {boolean | { osuPath?: string, checkExisting?: boolean, postDownloadAction?: string }} [patchOrToast=true]
 * @param {boolean} [maybeToast]
 */
async function saveOsuSettings(patchOrToast = true, maybeToast) {
  /** @type {{ osuPath?: string, checkExisting?: boolean, postDownloadAction?: string }} */
  let patch = {};
  let showToast = true;

  if (typeof patchOrToast === 'object' && patchOrToast !== null) {
    patch = patchOrToast;
    showToast = maybeToast !== undefined ? Boolean(maybeToast) : false;
  } else {
    showToast = Boolean(patchOrToast);
    patch = {
      osuPath: osuPathInput ? osuPathInput.value.trim() : osuSettings.osuPath,
      checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
      postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
    };
  }

  const isPathUpdate = patch.osuPath !== undefined;

  if (isPathUpdate && osuPathSave) osuPathSave.disabled = true;
  setStatus(osuStatus, isPathUpdate ? 'Сохраняю настройки osu!…' : 'Обновляю настройки…');
  try {
    const data = await api('/api/osu/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    renderOsuSettings(data, isPathUpdate);
    if (isPathUpdate) {
      if (data.valid) {
        setStatus(osuStatus, `Настройки сохранены. Найдено ${formatPluralRu(data.songsCount, 'набор', 'набора', 'наборов')} карт в osu! Songs.`, 'success');
        if (showToast) notify(`osu! Songs подключена (${formatPluralRu(data.songsCount, 'набор', 'набора', 'наборов')}).`);
      } else {
        setStatus(osuStatus, 'Путь сохранён (папка osu! отключена).', '');
        if (showToast) notify('Настройки osu! обновлены.');
      }
    } else {
      setStatus(osuStatus, 'Настройки osu! сохранены.', 'success');
      if (showToast) notify('Настройки osu! сохранены.');
    }
    await recheckCollectionOsu();
  } catch (err) {
    if (!isPathUpdate) {
      if (checkboxCheckExisting) {
        checkboxCheckExisting.checked = osuSettings.checkExisting;
      }
      postActionInputs.forEach(input => {
        input.checked = input.value === osuSettings.postDownloadAction;
        const option = byId(`option-action-${input.value}`);
        option?.classList.toggle('selected', input.checked);
      });
    }
    const message = toAny(err).message;
    setStatus(osuStatus, message, 'error');
    if (showToast) notify(`Ошибка: ${message}`);
  } finally {
    if (isPathUpdate && osuPathSave) osuPathSave.disabled = false;
  }
}

async function rescanOsuSongs() {
  if (osuRescan) osuRescan.disabled = true;
  setStatus(osuStatus, 'Сканирую папку osu! Songs…');
  try {
    const data = await api('/api/osu/rescan', { method: 'POST' });
    osuSettings.songsCount = Number(data.count || 0);
    renderOsuSettings(osuSettings, false);
    setStatus(osuStatus, `Сканирование завершено: найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт.`, 'success');
    notify(`Найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт в osu! Songs.`);
    await recheckCollectionOsu();
  } catch (err) {
    const message = toAny(err).message;
    setStatus(osuStatus, message, 'error');
    notify(message);
  } finally {
    if (osuRescan) osuRescan.disabled = false;
  }
}

async function recheckCollectionOsu() {
  if (!collection || !Array.isArray(collection.setIds) || collection.setIds.length === 0) return;
  try {
    const data = await api('/api/osu/check', {
      method: 'POST',
      body: JSON.stringify({ setIds: collection.setIds }),
    });
    collection.installedSetIds = data.installedSetIds || [];
    collection.downloadedSetIds = data.downloadedSetIds || [];
    collection.installedSet = new Set(collection.installedSetIds.map(Number));
    collection.downloadedSet = new Set(collection.downloadedSetIds.map(Number));

    let chipInst = byId('chip-installed');
    if (collection.installedSetIds.length > 0) {
      if (!chipInst) {
        chipInst = document.createElement('span');
        chipInst.id = 'chip-installed';
        chipInst.className = 'chip chip-installed';
        byId('collection-meta')?.append(chipInst);
      }
      chipInst.textContent = `В игре: ${collection.installedSetIds.length} из ${collection.count}`;
    } else if (chipInst) {
      chipInst.remove();
    }

    let chipDown = byId('chip-downloads');
    if (collection.downloadedSetIds.length > 0) {
      if (!chipDown) {
        chipDown = document.createElement('span');
        chipDown.id = 'chip-downloads';
        chipDown.className = 'chip chip-downloads';
        byId('collection-meta')?.append(chipDown);
      }
      chipDown.textContent = `В downloads: ${collection.downloadedSetIds.length}`;
    } else if (chipDown) {
      chipDown.remove();
    }

    refreshMapListBadges();
    updateDownloadButton();
  } catch {}
}

function updateMapBadge(badge, id) {
  if (!badge || !id) return;
  const numId = Number(id);
  if (collection) {
    if (!collection.installedSet && Array.isArray(collection.installedSetIds)) {
      collection.installedSet = new Set(collection.installedSetIds.map(Number));
    }
    if (!collection.downloadedSet && Array.isArray(collection.downloadedSetIds)) {
      collection.downloadedSet = new Set(collection.downloadedSetIds.map(Number));
    }
  }
  const isInstalled = collection?.installedSet
    ? collection.installedSet.has(numId)
    : collection?.installedSetIds?.includes(numId);
  const isDownloaded = collection?.downloadedSet
    ? collection.downloadedSet.has(numId)
    : collection?.downloadedSetIds?.includes(numId);
  if (isInstalled) {
    badge.className = 'badge-tag tag-installed';
    badge.textContent = 'В игре';
    badge.title = 'Набор уже установлен в папке osu! Songs';
  } else if (isDownloaded) {
    badge.className = 'badge-tag tag-downloaded';
    badge.textContent = 'Скачано';
    badge.title = 'Файл .osz уже скачан в downloads/';
  } else {
    badge.className = 'badge-tag tag-new';
    badge.textContent = 'Новый';
    badge.title = 'Набор ещё не скачан';
  }
}

function refreshMapListBadges() {
  if (!collection) return;
  for (const [id, elements] of mapElementsById.entries()) {
    if (elements?.badge) {
      updateMapBadge(elements.badge, id);
    }
  }
}

function renderMapList(maps = []) {
  // Список потенциально огромный (5000 выборок) — не рендерим всё за один проход, чтобы не завис браузер.
  // Защита от гонки: если пользователь повторно нажал «Показать карты», старый рендер прерывается.
  const renderId = ++mapListRenderId;
  const list = byId('map-list');
  list.replaceChildren();
  mapElementsById.clear();
  mapListByIndex = [];
  const CHUNK_SIZE = 250;
  let index = 0;
  const renderChunk = () => {
    if (renderId !== mapListRenderId) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(maps.length, index + CHUNK_SIZE);
    for (let i = index; i < end; i++) {
      const map = maps[i];
      const isPending = !map?.title && !map?.artist;
      const item = document.createElement('li');
      item.className = 'map-id map-item' + (isPending ? ' is-pending' : '');
      const head = document.createElement('div');
      head.className = 'map-item-head';
      const title = document.createElement('span');
      title.className = 'map-title';
      title.textContent = isPending ? `Набор ${map?.id ?? ''}` : (map?.label || `Набор ${map?.id ?? ''}`);
      head.append(title);
      const badge = document.createElement('span');
      updateMapBadge(badge, map?.id);
      head.append(badge);
      item.append(head);
      let creator = null;
      if (map?.creator) {
        creator = document.createElement('span');
        creator.className = 'map-creator';
        creator.textContent = `маппер: ${map.creator}`;
        item.append(creator);
      }
      const record = { item, title, creator, badge, currentId: map?.id };
      mapListByIndex[i] = record;
      if (map?.id) {
        mapElementsById.set(map.id, record);
      }
      fragment.append(item);
    }
    index += CHUNK_SIZE;
    list.append(fragment);
    if (index < maps.length) {
      const idle = window.requestIdleCallback || (cb => setTimeout(cb, 0));
      idle(() => {
        if (renderId === mapListRenderId) renderChunk();
      });
    }
  };
  renderChunk();
}

function updateMapListLabels(maps = [], offset = 0) {
  for (let i = 0; i < maps.length; i++) {
    const map = maps[i];
    if (!map) continue;
    const elements = mapListByIndex[offset + i];
    if (!elements) continue;

    // Если у этой строки изменился setId (при перестановке незаполненных элементов)
    if (elements.currentId !== map.id) {
      if (elements.currentId) mapElementsById.delete(elements.currentId);
      elements.currentId = map.id;
      if (map.id) mapElementsById.set(map.id, elements);
    }

    const isPending = !map.title && !map.artist;
    if (isPending) {
      elements.item.classList.add('is-pending');
    } else {
      elements.item.classList.remove('is-pending');
    }

    const expectedLabel = map.label || `Набор ${map.id}`;
    if (elements.title.textContent !== expectedLabel) {
      elements.title.textContent = expectedLabel;
    }
    if (elements.badge) {
      updateMapBadge(elements.badge, map.id);
    }
    if (map.creator) {
      const creatorText = `маппер: ${map.creator}`;
      if (elements.creator) {
        if (elements.creator.textContent !== creatorText) {
          elements.creator.textContent = creatorText;
        }
      } else {
        const creator = document.createElement('span');
        creator.className = 'map-creator';
        creator.textContent = creatorText;
        elements.item.append(creator);
        elements.creator = creator;
      }
    } else if (elements.creator) {
      elements.creator.remove();
      elements.creator = null;
    }
  }
}

function updateMetadataBadge(data) {
  let chip = byId('metadata-chip');
  if (data.metadataComplete) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'metadata-chip';
    byId('collection-meta').append(chip);
  }
  const totalCount = data.count || collection?.count || 0;
  if (data.metadataDegraded) {
    chip.className = 'chip chip-warn';
    chip.textContent = `Часть названий недоступна (${data.metadataProgress || 0}/${totalCount})`;
    return;
  }
  chip.className = 'chip loading';
  chip.textContent = `Загрузка названий (${data.metadataProgress || 0}/${totalCount})…`;
}

function stopMetadataPolling() {
  if (metadataPollTimer) {
    clearTimeout(metadataPollTimer);
    metadataPollTimer = null;
  }
  metadataPollInFlight = false;
  pollingCollectionId = null;
}

function startMetadataPolling(collectionId) {
  stopMetadataPolling();
  pollingCollectionId = String(collectionId);
  scheduleNextMetadataPoll(1200);
}

function scheduleNextMetadataPoll(delay = 1200) {
  if (metadataPollTimer) clearTimeout(metadataPollTimer);
  metadataPollTimer = setTimeout(() => { void pollMetadata(); }, delay);
}

async function pollMetadata() {
  if (!pollingCollectionId || metadataPollInFlight) return;
  metadataPollInFlight = true;
  try {
    const currentProgress = Number(collection?.metadataProgress || 0);
    const data = await api(`/api/collections/${pollingCollectionId}?poll=1&since=${currentProgress}`);
    if (!pollingCollectionId || String(data.id) !== pollingCollectionId) return;

    if (collection && String(collection.id) === pollingCollectionId) {
      collection.metadataComplete = data.metadataComplete;
      collection.metadataProgress = data.metadataProgress;
      if (Array.isArray(data.installedSetIds)) {
        collection.installedSetIds = data.installedSetIds;
        collection.installedSet = new Set(data.installedSetIds.map(Number));
      }
      if (Array.isArray(data.downloadedSetIds)) {
        collection.downloadedSetIds = data.downloadedSetIds;
        collection.downloadedSet = new Set(data.downloadedSetIds.map(Number));
      }

      if (Array.isArray(data.maps) && data.maps.length > 0) {
        const offset = Number(data.offset) || 0;
        if (!Array.isArray(collection.maps)) collection.maps = [];
        for (let i = 0; i < data.maps.length; i++) {
          collection.maps[offset + i] = data.maps[i];
        }
      }
    }

    updateMetadataBadge(data);
    if (Array.isArray(data.maps) && data.maps.length > 0) {
      updateMapListLabels(data.maps, Number(data.offset) || 0);
    }

    if (data.metadataComplete || data.metadataDegraded) {
      stopMetadataPolling();
      return;
    }
    scheduleNextMetadataPoll(1200);
  } catch {
    if (pollingCollectionId) {
      scheduleNextMetadataPoll(2500);
    }
  } finally {
    metadataPollInFlight = false;
  }
}

function renderCollection(data) {
  collection = data;
  collection.installedSet = new Set((data.installedSetIds || []).map(Number));
  collection.downloadedSet = new Set((data.downloadedSetIds || []).map(Number));
  byId('collection-name').textContent = data.name;
  byId('collection-uploader').textContent = data.uploader ? `Автор: ${data.uploader}` : '';
  byId('collection-count').textContent = formatPluralRu(data.count, 'набор', 'набора', 'наборов');
  byId('collection-meta').replaceChildren();
  const metadata = [formatPluralRu(data.beatmapCount, 'карта', 'карты', 'карт'), `ID ${data.id}`];
  for (const text of metadata) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    byId('collection-meta').append(chip);
  }
  if (Array.isArray(data.installedSetIds) && data.installedSetIds.length > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-installed';
    chip.id = 'chip-installed';
    chip.textContent = `В игре: ${data.installedSetIds.length} из ${data.count}`;
    byId('collection-meta').append(chip);
  }
  if (Array.isArray(data.downloadedSetIds) && data.downloadedSetIds.length > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-downloads';
    chip.id = 'chip-downloads';
    chip.textContent = `В downloads: ${data.downloadedSetIds.length}`;
    byId('collection-meta').append(chip);
  }
  updateMetadataBadge(data);

  renderMapList(data.maps || (data.setIds || []).map(id => ({ id })));
  collectionCard.classList.add('visible');
  updateDownloadButton();

  const installedCount = data.installedSetIds?.length || 0;
  if (installedCount === data.count && data.count > 0) {
    setStatus(collectionStatus, `Все ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт из этой коллекции уже есть в osu! Songs.`, 'success');
  } else if (installedCount > 0) {
    setStatus(collectionStatus, `Найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} (${installedCount} уже в osu!, ${data.count - installedCount} новых).`, 'success');
  } else {
    setStatus(collectionStatus, `Найдено ${formatPluralRu(data.count, 'уникальный набор', 'уникальных набора', 'уникальных наборов')} карт.`, 'success');
  }

  if (!data.metadataComplete && !data.metadataDegraded) {
    startMetadataPolling(data.id);
  } else {
    stopMetadataPolling();
  }
  updateMetadataBadge(data);
}

collectionForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const value = collectionUrl.value.trim();
  if (!value) return;
  stopMetadataPolling();
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
  } catch (rawError) {
    const error = toAny(rawError);
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

if (osuPathBrowse) {
  osuPathBrowse.addEventListener('click', async () => {
    if (osuPathBrowse.disabled) return;
    osuPathBrowse.disabled = true;
    const originalText = osuPathBrowse.textContent;
    osuPathBrowse.textContent = 'Выбор…';
    setStatus(osuStatus, 'Открыт Проводник — выберите папку osu! или Songs…');
    try {
      const currentVal = osuPathInput ? osuPathInput.value.trim() : osuSettings.osuPath;
      /** @type {any} */
      const data = await api('/api/osu/browse', {
        method: 'POST',
        body: JSON.stringify({ initialPath: currentVal }),
        timeoutMs: 190000,
      });
      if (data && data.path) {
        if (osuPathInput) {
          osuPathInput.value = data.path;
        }
        await saveOsuSettings({
          osuPath: data.path,
          checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
          postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
        }, true);
      } else {
        setStatus(osuStatus, 'Выбор папки отменён.', '');
      }
    } catch (err) {
      const message = toAny(err).message;
      setStatus(osuStatus, `Не удалось открыть Проводник: ${message}`, 'error');
    } finally {
      osuPathBrowse.disabled = false;
      osuPathBrowse.textContent = originalText;
    }
  });
}

if (osuPathSave) {
  osuPathSave.addEventListener('click', () => {
    const osuPath = osuPathInput ? osuPathInput.value.trim() : '';
    void saveOsuSettings({
      osuPath,
      checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
      postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
    }, true);
  });
}
if (osuPathInput) {
  osuPathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const osuPath = osuPathInput.value.trim();
      void saveOsuSettings({
        osuPath,
        checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
        postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
      }, true);
    }
  });
}
if (osuRescan) {
  osuRescan.addEventListener('click', () => { void rescanOsuSongs(); });
}
if (checkboxCheckExisting) {
  checkboxCheckExisting.addEventListener('change', () => {
    void saveOsuSettings({ checkExisting: checkboxCheckExisting.checked }, false);
  });
}
postActionInputs.forEach(input => {
  input.addEventListener('change', () => {
    postActionInputs.forEach(i => {
      byId(`option-action-${i.value}`)?.classList.toggle('selected', i.checked);
    });
    void saveOsuSettings({ postDownloadAction: input.value }, false);
  });
});

sessionForm?.addEventListener('submit', async event => {
  event.preventDefault();
  let session = sessionInput ? sessionInput.value.trim() : '';
  if (session.toLowerCase().startsWith('osu_session=')) {
    session = session.slice('osu_session='.length).trim();
  }
  if (!session) return;
  if (!sessionRiskConfirm?.checked) {
    notify('Подтвердите понимание рисков безопасности перед сохранением.');
    return;
  }
  if (session.length < 20 || session.length > 1024 || !/^[a-zA-Z0-9%_\-\.=/+|]+$/.test(session)) {
    notify('Некорректный формат cookie. Ожидается токен сессии osu.ppy.sh (без пробелов и спецсимволов).');
    return;
  }
  const button = /** @type {HTMLButtonElement | null} */ (byId('session-save'));
  if (button) button.disabled = true;
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ session }) });
    if (sessionInput) sessionInput.value = '';
    renderSessionState(true);
    notify('Сессия сохранена в оперативной памяти (до 6 часов либо до перезапуска).');
  } catch (rawError) {
    notify(toAny(rawError).message);
  } finally {
    updateSessionSaveButton();
  }
});
byId('session-clear')?.addEventListener('click', async () => {
  try {
    await api('/api/session', { method: 'DELETE' });
    renderSessionState(false);
    notify('Сессия удалена из памяти приложения.');
  } catch (rawError) {
    notify(toAny(rawError).message);
  }
});

// Загружаем ту коллекцию, что открыта в предпросмотре, а не то, что осталось в поле ввода:
// после показа списка пользователь мог отредактировать текст в input.
function collectionPayload() {
  return collection?.id ? { url: String(collection.id) } : { url: collectionUrl ? collectionUrl.value.trim() : '' };
}

downloadButton?.addEventListener('click', async () => {
  if (!collection) return;
  const method = selectedMethod();
  if (!methodReady(method)) {
    setStatus(downloadStatus, 'Сначала сохраните cookie osu_session.', 'error');
    return;
  }
  downloadButton.disabled = true;
  setStatus(downloadStatus, 'Создаю задачу загрузки…');
  progressWrap.classList.add('visible');
  try {
    const noVideo = Boolean(checkboxNoVideo?.checked);
    const job = await api(`/api/downloads?method=${method}${noVideo ? '&noVideo=1' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ ...collectionPayload(), noVideo }),
      // Создание задачи запрашивает коллекцию у osu!Collector — даём больше 20 секунд по умолчанию.
      timeoutMs: 60000,
    });
    pausedJob = null;
    resumeButton.hidden = true;
    if (retryFailedButton) retryFailedButton.hidden = true;
    startJobPolling(job.id);
    updateJob(job);
    void loadMirrors();
  } catch (rawError) {
    const error = toAny(rawError);
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

function stopJobStream() {
  if (jobEventSource) {
    jobEventSource.onmessage = null;
    jobEventSource.onerror = null;
    jobEventSource.close();
    jobEventSource = null;
  }
}

function startJobPolling(id) {
  activeJob = id;
  pausedJob = null;
  pollFailures = 0;
  persistJobId(id);
  if (cancelButton) cancelButton.hidden = false;
  if (resumeButton) resumeButton.hidden = true;
  if (retryFailedButton) retryFailedButton.hidden = true;
  progressWrap.classList.add('visible');

  stopPolling();
  stopJobStream();

  if (typeof window.EventSource === 'function') {
    try {
      const es = new EventSource(`/api/downloads/${id}/events`);
      jobEventSource = es;

      es.onmessage = event => {
        try {
          const job = JSON.parse(event.data);
          pollFailures = 0;
          updateJob(job);
          const autoResuming = job.status === 'paused' && Number.isFinite(job.autoResumeAt);
          if (autoResuming) {
            pausedJob = null;
            resumeButton.hidden = true;
            cancelButton.hidden = false;
            return;
          }
          if (!['queued', 'running'].includes(job.status)) {
            stopJobStream();
            finishJob(job);
          }
        } catch {}
      };

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          stopJobStream();
          if (activeJob) {
            scheduleNextPoll(1000);
          }
        }
      };
      return;
    } catch {
      stopJobStream();
    }
  }

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
  } catch (rawError) {
    const error = toAny(rawError);
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
  if (job?.id) lastJobId = job.id;
  if (Array.isArray(job.mirrors)) {
    const mirrorsSig = job.mirrors.map(m => `${m.id}:${m.cooldownMs > 0 ? 1 : 0}`).join('|');
    if (mirrorsSig !== lastMirrorsSignature) {
      lastMirrorsSignature = mirrorsSig;
      updateMirrorsFromData(job.mirrors);
    }
  }
  if (checkboxNoVideo && typeof job.noVideo === 'boolean' && activeJob) {
    checkboxNoVideo.checked = job.noVideo;
  }
  if (job?.method && activeJob) {
    const targetInput = methodInputs.find(input => input.value === job.method);
    if (targetInput && !targetInput.checked) {
      targetInput.checked = true;
      updateDownloadButton();
    }
  }
  if (retryFailedButton) {
    const isRunning = ['queued', 'running'].includes(job.status);
    const canRetry = Boolean(!isRunning && (job.canRetryFailed ?? (job.failed > 0)));
    retryFailedButton.hidden = !canRetry;
    if (canRetry) {
      retryFailedButton.textContent = job.failed ? `Повторить ошибки (${job.failed})` : 'Повторить ошибки';
    }
  }
  const total = job.total || 0;
  const percent = total ? Math.round(job.completed / total * 100) : 0;
  const currentPercent = Number.isFinite(job.currentPercent) ? job.currentPercent : null;
  const progressBarEl = byId('progress-bar') || progressBar;
  const progressPercentEl = byId('progress-percent') || progressPercent;
  const progressTrackEl = byId('progress-track') || progressTrack;
  const progressLabelEl = byId('progress-label') || progressLabel;

  if (progressBarEl) progressBarEl.style.setProperty('--progress', `${percent}%`);
  if (progressPercentEl) progressPercentEl.textContent = `${percent}%`;
  if (progressTrackEl) progressTrackEl.setAttribute('aria-valuenow', String(percent));
  if (progressLabelEl) {
    let statusPrefix = 'Загрузка…';
    if (job.status === 'queued') statusPrefix = 'Подготовка…';
    else if (job.status === 'paused') statusPrefix = 'Пауза ·';
    else if (job.status === 'finished') statusPrefix = 'Завершено ·';
    else if (job.status === 'finished_with_errors') statusPrefix = 'Завершено с ошибками ·';
    else if (job.status === 'cancelled') statusPrefix = 'Остановлено ·';

    progressLabelEl.textContent = total > 0 ? `${statusPrefix} ${job.completed} из ${total}` : statusPrefix;
  }

  // Обновление выпадающего списка активных параллельных загрузок
  const transfersListEl = byId('transfers-list');
  const transfersChevronEl = byId('transfers-chevron');
  const transfersDetailsEl = /** @type {HTMLDetailsElement | null} */ (byId('transfers-details'));

  /** @type {Array<{ setId?: number, setName?: string, mirror?: string, bytes?: number, totalBytes?: number | null, percent?: number | null }>} */
  const activeTransfers = Array.isArray(job.activeTransfers) && job.activeTransfers.length > 0
    ? job.activeTransfers
    : ((job.currentSetId || job.currentSetName) && ['running', 'queued'].includes(job.status))
      ? [{
          setId: job.currentSetId,
          setName: job.currentSetName || `Набор ${job.currentSetId}`,
          mirror: job.currentMirror || '',
          bytes: job.currentBytes || 0,
          totalBytes: job.currentTotalBytes,
          percent: currentPercent,
        }]
      : [];

  if (transfersChevronEl) {
    transfersChevronEl.hidden = activeTransfers.length === 0 && !['running', 'queued'].includes(job.status);
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
  if (transferBar) transferBar.style.setProperty('--progress', `${currentPercent ?? 0}%`);
  if (transferTrack) transferTrack.setAttribute('aria-valuenow', String(currentPercent ?? 0));
  const transferBytesEl = byId('transfer-bytes');
  if (transferBytesEl) {
    transferBytesEl.textContent = job.currentTotalBytes
      ? `${formatBytes(job.currentBytes)} / ${formatBytes(job.currentTotalBytes)}${currentPercent === null ? '' : ` · ${currentPercent}%`}`
      : `${formatBytes(job.currentBytes)} загружено${currentPercent === null ? ' · размер неизвестен' : ` · ${currentPercent}%`}`;
  }
  const transferLabelEl = byId('transfer-label');
  if (transferLabelEl) {
    transferLabelEl.textContent = (job.currentSetName || (job.currentSetId ? `Набор ${job.currentSetId}` : 'Прогресс текущего набора')) + (job.currentMirror ? ` · ${job.currentMirror}` : '') + (job.noVideo ? ' · без видео' : '');
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
  lastRenderedErrorsSignature = null;
  lastRenderedErrorsCount = -1;
  lastMirrorsSignature = null;
  stopJobStream();
  stopPolling();
  activeJob = null;
  if (job?.id) lastJobId = job.id;
  const canResume = (job?.status === 'paused' || (job?.status === 'finished_with_errors' && (job.deferred || 0) > 0)) && !errorMessage && !Number.isFinite(job.autoResumeAt);
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
  const canRetry = Boolean(job && (job.canRetryFailed ?? (job.failed > 0)) && !['queued', 'running'].includes(job.status));
  if (retryFailedButton) {
    retryFailedButton.hidden = !canRetry;
    if (canRetry) {
      retryFailedButton.textContent = job.failed ? `Повторить ошибки (${job.failed})` : 'Повторить ошибки';
    }
  }
  if (job && ['finished', 'finished_with_errors'].includes(job.status)) {
    try {
      localStorage.setItem('osu-collector-downloader.lastSummary', JSON.stringify(job));
    } catch {}
  }
  if (errorMessage) setStatus(downloadStatus, errorMessage, 'error');
  else if (job?.status === 'finished') setStatus(downloadStatus, 'Готово! Файлы находятся в папке downloads.', 'success');
  else if (job?.status === 'paused') setStatus(downloadStatus, job.message || 'Зеркала временно ограничили загрузки — нажмите «Продолжить» позже.', 'warn');
  else if (job?.status === 'finished_with_errors') setStatus(downloadStatus, `${job.message} Успешные загрузки лежат в папке downloads.`, 'error');
  else if (job?.status === 'cancelled') setStatus(downloadStatus, 'Загрузка остановлена. Уже скачанные файлы сохранены.');
  updateDownloadButton();
  const activeEl = document.activeElement;
  if (
    typeof HTMLElement !== 'undefined' &&
    activeEl instanceof HTMLElement &&
    activeEl !== document.body &&
    activeEl !== document.documentElement
  ) {
    activeEl.blur();
  }
  if (typeof window !== 'undefined' && typeof window.focus === 'function') {
    try {
      window.focus();
    } catch {}
  }
}

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
    void loadMirrors();
  } catch (rawError) {
    setStatus(downloadStatus, toAny(rawError).message, 'warn');
    void loadMirrors();
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
      const job = await api(`/api/downloads/${targetId}/retry-failed?method=${method}${noVideo ? '&noVideo=1' : ''}`, {
        method: 'POST',
        body: JSON.stringify({ noVideo }),
      });
      pausedJob = null;
      resumeButton.hidden = true;
      retryFailedButton.hidden = true;
      cancelButton.hidden = false;
      startJobPolling(job.id);
      updateJob(job);
      void loadMirrors();
    } catch (rawError) {
      const error = toAny(rawError);
      setStatus(downloadStatus, error.message, 'warn');
      void loadMirrors();
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

// Реактивация задачи после перезагрузки страницы: jobId живёт в localStorage или запрашивается с сервера.
async function restoreJob() {
  let storedId = null;
  try {
    storedId = localStorage.getItem(JOB_STORAGE_KEY);
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
    if (['queued', 'running'].includes(job.status)) {
      startJobPolling(job.id);
      updateJob(job);
    } else if (job.status === 'paused') {
      progressWrap.classList.add('visible');
      updateJob(job);
      if (Number.isFinite(job.autoResumeAt)) {
        startJobPolling(job.id);
      } else {
        finishJob(job);
      }
    } else {
      persistJobId(null);
      progressWrap.classList.add('visible');
      updateJob(job);
      finishJob(job);
    }
  } catch (rawError) {
    const error = toAny(rawError);
    if (error.status === 404 || /не найден|404/i.test(error.message)) {
      persistJobId(null);
      try {
        const lastRaw = localStorage.getItem('osu-collector-downloader.lastSummary');
        if (lastRaw) {
          const lastJob = JSON.parse(lastRaw);
          if (lastJob && lastJob.id === storedId) {
            progressWrap.classList.add('visible');
            updateJob(lastJob);
            finishJob(lastJob);
            setStatus(downloadStatus, `${lastJob.message || 'Загрузка завершена.'} (сохранено локально)`, lastJob.failed ? 'error' : 'success');
            return;
          }
        }
      } catch {}
    } else {
      setStatus(downloadStatus, `Сервер помнит незавершённую задачу, но не отвечает: ${error.message}`, 'warn');
    }
  }
}

// Отсчёт пауз зеркал перерисовывается каждую секунду только при наличии активных кулдаунов.
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (hasActiveCooldowns()) renderMirrors();
  }, 1000);

  // Фоновый опрос зеркал запускается только при открытой вкладке, когда нет активной задачи (во время которой зеркала приходят с каждым тиком задачи), но есть остывающие зеркала.
  setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !activeJob && hasActiveCooldowns()) {
      void loadMirrors();
    }
  }, 4000);
}

async function initialize() {
  const [sessionRes] = await Promise.allSettled([
    api('/api/session'),
    loadMirrors(),
    loadOsuSettings(),
  ]);

  if (sessionRes.status === 'fulfilled') {
    renderSessionState(Boolean(sessionRes.value?.connected));
  } else {
    renderSessionState(false);
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

function setCollection(c) {
  collection = c;
}

function getCollection() {
  return collection;
}

if (typeof window !== 'undefined') {
  initialize();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    updateMapBadge,
    refreshMapListBadges,
    updateMapListLabels,
    renderCollection,
    setCollection,
    getCollection,
    updateJob,
    finishJob,
  };
}
