// @ts-check
import { byId, toAny, formatPluralRu, setStatus } from '../utils.js';
import { api } from '../api.js';

let collection = null;
/** @type {Set<number>} */
let selectedSetIds = new Set();
let currentSearchFilter = '';
let currentStatusFilter = 'all';
let uiCallbacks = /** @type {{ updateDownloadButton?: () => void } | null} */ (null);

export function getCollection() {
  return collection;
}

export function getStatusFilter() {
  return currentStatusFilter;
}

/**
 * @returns {number[]}
 */
export function getSelectedSetIds() {
  return Array.from(selectedSetIds);
}

/**
 * @param {number[] | Set<number>} ids
 */
export function setSelectedSetIds(ids) {
  selectedSetIds = ids instanceof Set ? new Set(ids) : new Set((ids || []).map(Number));
  for (const [id, elements] of mapElementsById.entries()) {
    const isSelected = selectedSetIds.has(Number(id));
    if (elements?.checkbox) {
      elements.checkbox.checked = isSelected;
    }
    if (elements?.item) {
      elements.item.classList.toggle('is-unselected', !isSelected);
    }
  }
  updateSelectionSummary();
  if (uiCallbacks?.updateDownloadButton) {
    uiCallbacks.updateDownloadButton();
  }
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
    const allIds = Array.isArray(collection.setIds)
      ? collection.setIds.map(Number)
      : Array.isArray(collection.maps)
        ? collection.maps.map((m) => Number(m.id))
        : [];
    const newIds = allIds.filter(
      (id) => !collection.installedSet?.has(id) && !collection.downloadedSet?.has(id),
    );
    selectedSetIds = new Set(newIds);
  }
}

let mapListRenderId = 0;
export const mapElementsById = new Map();
/** @type {Array<{ item: HTMLElement, title: HTMLElement, creator: HTMLElement | null, metaRow?: HTMLElement | null, badge: HTMLElement | null, checkbox?: HTMLInputElement | null, currentId: number | undefined, map?: any }>} */
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
 * Проверяет, удовлетворяет ли набор карт поисковому фильтру.
 * @param {any} map
 * @param {string | null | undefined} titleText
 * @param {string | null | undefined} creatorText
 * @param {string} query
 * @returns {boolean}
 */
export function matchesFilter(map, titleText, creatorText, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const idStr = String(map?.id ?? '');
  const title = (titleText || map?.title || '').toLowerCase();
  const artist = (map?.artist || '').toLowerCase();
  const creator = (creatorText || map?.creator || '').toLowerCase();
  const label = (map?.label || '').toLowerCase();
  return (
    idStr.includes(q) ||
    title.includes(q) ||
    artist.includes(q) ||
    creator.includes(q) ||
    label.includes(q)
  );
}

/**
 * Обновляет счётчик выбранных карт и состояние мастер-чекбокса.
 */
export function updateSelectionSummary() {
  const counter = byId('selection-counter');
  const masterCheckbox = /** @type {HTMLInputElement | null} */ (byId('select-all-checkbox'));
  const totalCount = collection?.setIds?.length || collection?.count || 0;
  const selectedCount = selectedSetIds.size;

  if (counter) {
    counter.textContent = `Выбрано: ${selectedCount} из ${totalCount}`;
  }

  if (masterCheckbox) {
    let visibleTotal = 0;
    let visibleSelected = 0;
    for (const record of mapListByIndex) {
      if (!record || !record.item || record.item.hidden) continue;
      visibleTotal++;
      if (record.currentId && selectedSetIds.has(Number(record.currentId))) {
        visibleSelected++;
      }
    }
    if (visibleTotal === 0) {
      masterCheckbox.checked = false;
      masterCheckbox.indeterminate = false;
    } else if (visibleSelected === visibleTotal) {
      masterCheckbox.checked = true;
      masterCheckbox.indeterminate = false;
    } else if (visibleSelected === 0) {
      masterCheckbox.checked = false;
      masterCheckbox.indeterminate = false;
    } else {
      masterCheckbox.checked = false;
      masterCheckbox.indeterminate = true;
    }
  }
}

/**
 * Проверяет соответствие набора статусному фильтру ('all' | 'new' | 'installed').
 * @param {number | string | undefined} mapId
 * @param {string} statusFilter
 * @returns {boolean}
 */
export function matchesStatusFilter(mapId, statusFilter) {
  if (!statusFilter || statusFilter === 'all') return true;
  if (!mapId) return true;
  const numId = Number(mapId);
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
  if (statusFilter === 'installed') return Boolean(isInstalled);
  if (statusFilter === 'new') return !isInstalled && !isDownloaded;
  return true;
}

/**
 * Применяет активный поисковый и статусный фильтры ко всем элементам списка.
 */
export function applyCombinedFilters() {
  for (const record of mapListByIndex) {
    if (!record || !record.item) continue;
    const matchesSearch = matchesFilter(
      record.map,
      record.title?.textContent,
      record.creator?.textContent,
      currentSearchFilter,
    );
    const matchesStatus = matchesStatusFilter(record.currentId, currentStatusFilter);
    record.item.hidden = !(matchesSearch && matchesStatus);
  }
  updateSelectionSummary();
}

/**
 * Применяет строку поиска к элементам списка карт.
 * @param {string} [query='']
 */
export function applySearchFilter(query = '') {
  currentSearchFilter = (query || '').trim().toLowerCase();
  applyCombinedFilters();
}

/**
 * Переключает активный статусный фильтр карт ('all' | 'new' | 'installed').
 * @param {string} filter
 */
export function setStatusFilter(filter) {
  currentStatusFilter = filter || 'all';
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach((tab) => {
      const isCurrent = tab.getAttribute('data-filter') === currentStatusFilter;
      tab.classList.toggle('active', isCurrent);
      tab.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });
  }
  applyCombinedFilters();
}

/**
 * Обновляет счётчики на вкладках фильтра статуса (Все, Новые, В игре).
 */
export function updateTabCounts() {
  const allCount = collection?.count || collection?.setIds?.length || 0;
  if (collection) {
    if (!collection.installedSet && Array.isArray(collection.installedSetIds)) {
      collection.installedSet = new Set(collection.installedSetIds.map(Number));
    }
    if (!collection.downloadedSet && Array.isArray(collection.downloadedSetIds)) {
      collection.downloadedSet = new Set(collection.downloadedSetIds.map(Number));
    }
  }
  let installedCount = 0;
  if (collection?.installedSet) {
    installedCount = collection.installedSet.size;
  } else if (Array.isArray(collection?.installedSetIds)) {
    installedCount = collection.installedSetIds.length;
  }
  let downloadedCount = 0;
  if (collection?.downloadedSet) {
    downloadedCount = collection.downloadedSet.size;
  } else if (Array.isArray(collection?.downloadedSetIds)) {
    downloadedCount = collection.downloadedSetIds.length;
  }

  let newCount = 0;
  const allIds = Array.isArray(collection?.setIds)
    ? collection.setIds
    : Array.isArray(collection?.maps)
      ? collection.maps.map((m) => m?.id)
      : null;

  if (allIds && allIds.length === allCount) {
    for (const rawId of allIds) {
      const numId = Number(rawId);
      const isInstalled = collection?.installedSet
        ? collection.installedSet.has(numId)
        : collection?.installedSetIds?.includes(numId);
      const isDownloaded = collection?.downloadedSet
        ? collection.downloadedSet.has(numId)
        : collection?.downloadedSetIds?.includes(numId);
      if (!isInstalled && !isDownloaded) {
        newCount++;
      }
    }
  } else {
    newCount = Math.max(0, allCount - installedCount - downloadedCount);
  }

  const countAll = byId('tab-count-all');
  const countNew = byId('tab-count-new');
  const countInstalled = byId('tab-count-installed');
  if (countAll) countAll.textContent = String(allCount);
  if (countNew) countNew.textContent = String(newCount);
  if (countInstalled) countInstalled.textContent = String(installedCount);
}

/**
 * Выбирает или снимает выбор для всех видимых (не скрытых фильтром) элементов списка.
 * @param {boolean} [select=true]
 */
export function selectVisible(select = true) {
  for (const record of mapListByIndex) {
    if (!record || !record.item || record.item.hidden) continue;
    const mapId = Number(record.currentId);
    if (!mapId) continue;
    if (select) {
      selectedSetIds.add(mapId);
      if (record.checkbox) record.checkbox.checked = true;
      record.item.classList.remove('is-unselected');
    } else {
      selectedSetIds.delete(mapId);
      if (record.checkbox) record.checkbox.checked = false;
      record.item.classList.add('is-unselected');
    }
  }
  if (mapListByIndex.length === 0 && collection?.setIds && !currentSearchFilter) {
    if (select) {
      selectedSetIds = new Set(collection.setIds.map(Number));
    } else {
      selectedSetIds.clear();
    }
  }
  updateSelectionSummary();
  if (uiCallbacks?.updateDownloadButton) {
    uiCallbacks.updateDownloadButton();
  }
}

/**
 * Заполняет мета-строку карты (маппер • BPM • Stars★).
 * @param {HTMLElement | null | undefined} container
 * @param {any} map
 * @returns {HTMLElement | null} ссылка на элемент автора (creator)
 */
export function updateMetaRowContent(container, map) {
  if (!container) return null;
  container.replaceChildren();
  if (!map) return null;

  let creatorEl = null;
  if (map.creator) {
    creatorEl = document.createElement('span');
    creatorEl.className = 'map-creator';
    creatorEl.textContent = `маппер: ${map.creator}`;
    container.append(creatorEl);
  }

  if (map.bpm != null) {
    if (container.children && container.children.length > 0) {
      const dot = document.createElement('span');
      dot.className = 'map-meta-dot';
      dot.textContent = '•';
      container.append(dot);
    }
    const bpmSpan = document.createElement('span');
    bpmSpan.className = 'map-bpm';
    bpmSpan.textContent = `${map.bpm} BPM`;
    container.append(bpmSpan);
  }

  if (map.stars != null) {
    if (container.children && container.children.length > 0) {
      const dot = document.createElement('span');
      dot.className = 'map-meta-dot';
      dot.textContent = '•';
      container.append(dot);
    }
    const starsSpan = document.createElement('span');
    starsSpan.className = 'map-stars';
    const starsNum = Number(map.stars);
    starsSpan.textContent = `${starsNum.toFixed(2).replace(/\.00$/, '')}★`;
    container.append(starsSpan);
  }

  return creatorEl;
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
      const numId = Number(map?.id);
      const isSelected = selectedSetIds.has(numId);

      const item = document.createElement('li');
      item.className = 'map-id map-item' + (isPending ? ' is-pending' : '') + (!isSelected ? ' is-unselected' : '');

      const inner = document.createElement('div');
      inner.className = 'map-item-inner';

      const checkboxCol = document.createElement('div');
      checkboxCol.className = 'map-checkbox-col';

      /** @type {{ item: HTMLElement, title: HTMLAnchorElement, creator: HTMLElement | null, metaRow: HTMLElement | null, badge: HTMLElement | null, checkbox: HTMLInputElement, currentId: number | undefined, map: any }} */
      const record = {
        item,
        title: /** @type {any} */ (null),
        creator: null,
        metaRow: null,
        badge: null,
        checkbox: /** @type {any} */ (null),
        currentId: map?.id,
        map,
      };

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'map-select-checkbox';
      checkbox.checked = isSelected;
      checkbox.setAttribute('aria-label', `Выбрать набор ${map?.id ?? ''}`);
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        const currentSetId = Number(record.currentId || map?.id);
        if (!currentSetId) return;
        if (checkbox.checked) {
          selectedSetIds.add(currentSetId);
          item.classList.remove('is-unselected');
        } else {
          selectedSetIds.delete(currentSetId);
          item.classList.add('is-unselected');
        }
        updateSelectionSummary();
        if (uiCallbacks?.updateDownloadButton) {
          uiCallbacks.updateDownloadButton();
        }
      });
      checkboxCol.append(checkbox);
      record.checkbox = checkbox;

      const mainCol = document.createElement('div');
      mainCol.className = 'map-item-main';

      const title = document.createElement('a');
      title.className = 'map-title';
      title.href = numId ? `https://osu.ppy.sh/beatmapsets/${numId}` : '#';
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.textContent = isPending ? `Набор ${map?.id ?? ''}` : map?.label || `Набор ${map?.id ?? ''}`;
      title.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      record.title = title;

      const metaRow = document.createElement('div');
      metaRow.className = 'map-meta-row';
      const creator = updateMetaRowContent(metaRow, map);
      record.metaRow = metaRow;
      record.creator = creator;

      mainCol.append(title, metaRow);

      const badge = document.createElement('span');
      updateMapBadge(badge, map?.id);
      record.badge = badge;

      inner.append(checkboxCol, mainCol, badge);
      item.append(inner);

      item.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target?.closest?.('.map-select-checkbox') || target?.closest?.('a')) return;
        const currentSetId = Number(record.currentId || map?.id);
        const targetHref = title.href && title.href !== '#'
          ? title.href
          : (currentSetId ? `https://osu.ppy.sh/beatmapsets/${currentSetId}` : null);
        if (targetHref && typeof window !== 'undefined' && window.open) {
          window.open(targetHref, '_blank', 'noopener,noreferrer');
        }
      });

      const matchesSearch = matchesFilter(map, title.textContent, creator?.textContent, currentSearchFilter);
      const matchesStatus = matchesStatusFilter(numId, currentStatusFilter);
      item.hidden = !(matchesSearch && matchesStatus);

      mapListByIndex[i] = record;
      if (map?.id) {
        mapElementsById.set(map.id, record);
      }
      fragment.append(item);
    }
    index += CHUNK_SIZE;
    list.append(fragment);
    updateSelectionSummary();
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

    elements.map = map;

    // Если у этой строки изменился setId (при перестановке незаполненных элементов)
    if (elements.currentId !== map.id) {
      if (elements.currentId) mapElementsById.delete(elements.currentId);
      elements.currentId = map.id;
      if (map.id) mapElementsById.set(map.id, elements);
      if (elements.checkbox) {
        elements.checkbox.setAttribute('aria-label', `Выбрать набор ${map?.id ?? ''}`);
        elements.checkbox.checked = selectedSetIds.has(Number(map.id));
        elements.item.classList.toggle('is-unselected', !selectedSetIds.has(Number(map.id)));
      }
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
    if ('href' in elements.title && map.id) {
      // @ts-ignore
      elements.title.href = `https://osu.ppy.sh/beatmapsets/${map.id}`;
    }
    if (elements.badge) {
      updateMapBadge(elements.badge, map.id);
    }
    if (elements.metaRow) {
      elements.creator = updateMetaRowContent(elements.metaRow, map);
    } else if (map.creator) {
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

    const matchesSearch = matchesFilter(
      map,
      elements.title?.textContent,
      elements.creator?.textContent,
      currentSearchFilter,
    );
    const matchesStatus = matchesStatusFilter(elements.currentId, currentStatusFilter);
    elements.item.hidden = !(matchesSearch && matchesStatus);
  }
  updateSelectionSummary();
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
  if (metadataPollTimer && typeof metadataPollTimer.unref === 'function') {
    metadataPollTimer.unref();
  }
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

  if (callbacks) {
    uiCallbacks = callbacks;
  }
  currentSearchFilter = '';
  const searchInput = /** @type {HTMLInputElement | null} */ (byId('collection-search'));
  if (searchInput) searchInput.value = '';

  const initialSetIds = Array.isArray(data.setIds)
    ? data.setIds.map(Number)
    : Array.isArray(data.maps)
      ? data.maps.map((m) => Number(m.id))
      : [];
  const newSetIds = initialSetIds.filter(
    (id) => !collection.installedSet.has(id) && !collection.downloadedSet.has(id),
  );
  selectedSetIds = new Set(newSetIds);

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
  updateTabCounts();
  currentStatusFilter = 'all';
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach((tab) => {
      const isCurrent = tab.getAttribute('data-filter') === 'all';
      tab.classList.toggle('active', isCurrent);
      tab.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });
  }

  renderMapList(data.maps || (data.setIds || []).map((id) => ({ id })));
  updateSelectionSummary();
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
  /** @type {{ url: string, selectedSetIds?: number[] }} */
  const payload = collection?.id ? { url: String(collection.id) } : { url: collectionUrl ? collectionUrl.value.trim() : '' };
  payload.selectedSetIds = getSelectedSetIds();
  return payload;
}

/**
 * @param {{ updateDownloadButton?: () => void }} [callbacks={}]
 */
export function initCollectionUi(callbacks = {}) {
  if (callbacks) {
    uiCallbacks = callbacks;
  }
  const collectionForm = byId('collection-form');
  const collectionUrl = /** @type {HTMLInputElement | null} */ (byId('collection-url'));
  const previewButton = /** @type {HTMLButtonElement | null} */ (byId('preview-button'));
  const collectionCard = byId('collection-card');
  const collectionStatus = byId('collection-status');

  const searchInput = /** @type {HTMLInputElement | null} */ (byId('collection-search'));
  const masterCheckbox = /** @type {HTMLInputElement | null} */ (byId('select-all-checkbox'));
  const selectAllBtn = byId('select-all-btn');
  const deselectAllBtn = byId('deselect-all-btn');

  searchInput?.addEventListener('input', () => {
    applySearchFilter(searchInput.value);
  });

  masterCheckbox?.addEventListener('change', () => {
    selectVisible(masterCheckbox.checked);
  });

  selectAllBtn?.addEventListener('click', () => {
    selectVisible(true);
  });

  deselectAllBtn?.addEventListener('click', () => {
    selectVisible(false);
  });

  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const filter = tab.getAttribute('data-filter') || 'all';
        setStatusFilter(filter);
      });
    });
  }

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
