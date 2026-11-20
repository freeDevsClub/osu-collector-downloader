// @ts-check
import { byId, toAny, formatPluralRu, setStatus } from '../utils.js';
import { api } from '../api.js';

let collection = null;

export function getCollection() {
  return collection;
}

/**
 * @param {any} c
 */
export function setCollection(c) {
  collection = c;
  if (collection) {
    if (!collection.installedSet && Array.isArray(collection.installedSetIds)) {
      collection.installedSet = new Set(collection.installedSetIds.map(Number));
    }
    if (!collection.downloadedSet && Array.isArray(collection.downloadedSetIds)) {
      collection.downloadedSet = new Set(collection.downloadedSetIds.map(Number));
    }
  }
}

let mapListRenderId = 0;
export const mapElementsById = new Map();
/** @type {Array<{ item: HTMLElement, title: HTMLElement, creator: HTMLElement | null, badge: HTMLElement | null, currentId: number | undefined }>} */
export let mapListByIndex = [];
let metadataPollTimer = null;
let metadataPollInFlight = false;
let pollingCollectionId = null;

/**
 * @param {{ className?: string, textContent?: string, title?: string } | null} badge
 * @param {number | string} id
 */
export function updateMapBadge(badge, id) {
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

export function refreshMapListBadges() {
  if (!collection) return;
  for (const [id, elements] of mapElementsById.entries()) {
    if (elements?.badge) {
      updateMapBadge(elements.badge, id);
    }
  }
}

/**
 * @param {any[]} [maps=[]]
 */
export function renderMapList(maps = []) {
  // Список потенциально огромный (5000 выборок) — не рендерим всё за один проход, чтобы не завис браузер.
  // Защита от гонки: если пользователь повторно нажал «Показать карты», старый рендер прерывается.
  const renderId = ++mapListRenderId;
  const list = byId('map-list');
  if (!list) return;
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
      title.textContent = isPending ? `Набор ${map?.id ?? ''}` : map?.label || `Набор ${map?.id ?? ''}`;
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
      const idle = (typeof window !== 'undefined' && window.requestIdleCallback) || ((cb) => setTimeout(cb, 0));
      idle(() => {
        if (renderId === mapListRenderId) renderChunk();
      });
    }
  };
  renderChunk();
}

/**
 * @param {any[]} [maps=[]]
 * @param {number} [offset=0]
 */
export function updateMapListLabels(maps = [], offset = 0) {
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

/**
 * @param {any} data
 */
export function updateMetadataBadge(data) {
  let chip = byId('metadata-chip');
  if (data.metadataComplete) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'metadata-chip';
    byId('collection-meta')?.append(chip);
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

export function stopMetadataPolling() {
  if (metadataPollTimer) {
    clearTimeout(metadataPollTimer);
    metadataPollTimer = null;
  }
  metadataPollInFlight = false;
  pollingCollectionId = null;
}

/**
 * @param {string | number} collectionId
 */
export function startMetadataPolling(collectionId) {
  stopMetadataPolling();
  pollingCollectionId = String(collectionId);
  scheduleNextMetadataPoll(1200);
}

/**
 * @param {number} [delay=1200]
 */
export function scheduleNextMetadataPoll(delay = 1200) {
  if (metadataPollTimer) clearTimeout(metadataPollTimer);
  metadataPollTimer = setTimeout(() => {
    void pollMetadata();
  }, delay);
}

export async function pollMetadata() {
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

/**
 * @param {{ updateDownloadButton?: () => void }} [callbacks={}]
 */
export async function recheckCollectionOsu(callbacks = {}) {
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
    if (typeof callbacks?.updateDownloadButton === 'function') {
      callbacks.updateDownloadButton();
    }
  } catch {}
}

/**
 * @param {any} data
 * @param {{ updateDownloadButton?: () => void }} [callbacks={}]
 */
export function renderCollection(data, callbacks = {}) {
  collection = data;
  collection.installedSet = new Set((data.installedSetIds || []).map(Number));
  collection.downloadedSet = new Set((data.downloadedSetIds || []).map(Number));
  const collectionName = byId('collection-name');
  if (collectionName) collectionName.textContent = data.name;
  const collectionUploader = byId('collection-uploader');
  if (collectionUploader) collectionUploader.textContent = data.uploader ? `Автор: ${data.uploader}` : '';
  const collectionCount = byId('collection-count');
  if (collectionCount) collectionCount.textContent = formatPluralRu(data.count, 'набор', 'набора', 'наборов');
  const collectionMeta = byId('collection-meta');
  if (collectionMeta) collectionMeta.replaceChildren();
  const metadata = [formatPluralRu(data.beatmapCount, 'карта', 'карты', 'карт'), `ID ${data.id}`];
  for (const text of metadata) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    collectionMeta?.append(chip);
  }
  if (Array.isArray(data.installedSetIds) && data.installedSetIds.length > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-installed';
    chip.id = 'chip-installed';
    chip.textContent = `В игре: ${data.installedSetIds.length} из ${data.count}`;
    collectionMeta?.append(chip);
  }
  if (Array.isArray(data.downloadedSetIds) && data.downloadedSetIds.length > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-downloads';
    chip.id = 'chip-downloads';
    chip.textContent = `В downloads: ${data.downloadedSetIds.length}`;
    collectionMeta?.append(chip);
  }
  updateMetadataBadge(data);

  renderMapList(data.maps || (data.setIds || []).map((id) => ({ id })));
  const collectionCard = byId('collection-card');
  collectionCard?.classList.add('visible');
  if (typeof callbacks?.updateDownloadButton === 'function') {
    callbacks.updateDownloadButton();
  }

  const collectionStatus = byId('collection-status');
  const installedCount = data.installedSetIds?.length || 0;
  if (installedCount === data.count && data.count > 0) {
    setStatus(
      collectionStatus,
      `Все ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт из этой коллекции уже есть в osu! Songs.`,
      'success',
    );
  } else if (installedCount > 0) {
    setStatus(
      collectionStatus,
      `Найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} (${installedCount} уже в osu!, ${data.count - installedCount} новых).`,
      'success',
    );
  } else {
    setStatus(
      collectionStatus,
      `Найдено ${formatPluralRu(data.count, 'уникальный набор', 'уникальных набора', 'уникальных наборов')} карт.`,
      'success',
    );
  }

  if (!data.metadataComplete && !data.metadataDegraded) {
    startMetadataPolling(data.id);
  } else {
    stopMetadataPolling();
  }
  updateMetadataBadge(data);
}

// Загружаем ту коллекцию, что открыта в предпросмотре, а не то, что осталось в поле ввода:
// после показа списка пользователь мог отредактировать текст в input.
export function collectionPayload() {
  const collectionUrl = /** @type {HTMLInputElement | null} */ (byId('collection-url'));
  return collection?.id ? { url: String(collection.id) } : { url: collectionUrl ? collectionUrl.value.trim() : '' };
}

/**
 * @param {{ updateDownloadButton?: () => void }} [callbacks={}]
 */
export function initCollectionUi(callbacks = {}) {
  const collectionForm = byId('collection-form');
  const collectionUrl = /** @type {HTMLInputElement | null} */ (byId('collection-url'));
  const previewButton = /** @type {HTMLButtonElement | null} */ (byId('preview-button'));
  const collectionCard = byId('collection-card');
  const collectionStatus = byId('collection-status');

  collectionForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = collectionUrl ? collectionUrl.value.trim() : '';
    if (!value) return;
    stopMetadataPolling();
    if (previewButton) {
      previewButton.disabled = true;
      previewButton.textContent = 'Ищем…';
    }
    collectionCard?.classList.remove('visible');
    setStatus(collectionStatus, 'Получаю данные коллекции…');
    try {
      const data = await api('/api/collections', {
        method: 'POST',
        body: JSON.stringify({ url: value }),
        timeoutMs: 60000,
      });
      renderCollection(data, callbacks);
    } catch (rawError) {
      const error = toAny(rawError);
      if (error.name === 'TimeoutError') {
        setStatus(
          collectionStatus,
          'Время ожидания ответа истекло. Возможно, коллекция слишком большая или сервер osu!Collector перегружен.',
          'error',
        );
      } else {
        setStatus(collectionStatus, error.message, 'error');
      }
    } finally {
      if (previewButton) {
        previewButton.disabled = false;
        previewButton.textContent = 'Показать карты';
      }
    }
  });
}
