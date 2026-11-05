// @ts-check
"use strict";

const {
  HttpError,
  log,
  sleep,
  USER_AGENT,
  PAGE_FETCH_TIMEOUT_MS,
  PAGINATION_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  MAPSET_FETCH_BUDGET_MS,
} = require('./config.js');
const { safeErrorMessage } = require('./security.js');

/**
 * Извлекает числовой ID коллекции из URL osu!Collector или строки с ID.
 * @param {string | number} value
 * @returns {string}
 */
function extractCollectionId(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Укажите ссылку на коллекцию osu!Collector.');
  if (/^\d+$/.test(value.trim())) return value.trim();
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, 'Введите URL коллекции osu!Collector или её числовой ID.');
  }
  const match = url.pathname.match(/^\/collections\/(\d+)(?:\/|$)/);
  if (url.protocol !== 'https:' || !['osucollector.com', 'www.osucollector.com'].includes(url.hostname) || !match) {
    throw new HttpError(400, 'Нужна HTTPS-ссылка формата https://osucollector.com/collections/123/name.');
  }
  return match[1];
}

/**
 * @param {any} data
 * @returns {number[]}
 */
function parseSetIds(data) {
  if (Array.isArray(data?.setIds)) return data.setIds;
  if (!data || !Array.isArray(data.beatmapsets)) throw new HttpError(502, 'osu!Collector вернул неожиданный формат коллекции.');
  return [...new Set(data.beatmapsets.map((/** @type {any} */ set) => set && set.id).filter((/** @type {any} */ id) => Number.isSafeInteger(id) && id > 0))];
}

/**
 * @typedef {Object} MapInfo
 * @property {number} id
 * @property {string} label
 * @property {string | null} [title]
 * @property {string | null} [artist]
 * @property {string | null} [creator]
 *
 * @typedef {Object} CollectionSnapshot
 * @property {number} id
 * @property {string} name
 * @property {string | null} uploader
 * @property {number} count
 * @property {number} beatmapCount
 * @property {MapInfo[]} maps
 * @property {Map<number, MapInfo>} mapsById
 * @property {number[]} setIds
 * @property {boolean} metadataComplete
 * @property {number} metadataProgress
 * @property {Promise<void> | null} [metadataPromise]
 */

/**
 * @param {number[]} setIds
 * @returns {MapInfo[]}
 */
function fallbackMapInfo(setIds) {
  return setIds.map(id => ({ id, label: `Набор ${id}`, title: null, artist: null, creator: null }));
}

/**
 * Фоновая пагинация метаданных карт (beatmapsV2) без блокировки старта загрузки.
 * @param {CollectionSnapshot} snapshot
 * @param {string} collectionId
 * @returns {Promise<void>}
 */
async function populateMetadataInBackground(snapshot, collectionId) {
  const setIds = snapshot.setIds;
  const wanted = new Set(setIds);
  if (wanted.size === 0) {
    snapshot.metadataComplete = true;
    return;
  }

  const deadline = Date.now() + MAPSET_FETCH_BUDGET_MS;
  let cursor = null;
  const cursors = new Set();
  let hasMore = false;

  try {
    for (let page = 0; page < PAGINATION_PAGE_LIMIT; page++) {
      if (Date.now() >= deadline) {
        log('warn', 'collection.mapinfo.budget_exceeded', { collectionId, page, named: snapshot.metadataProgress, totalWanted: wanted.size });
        break;
      }
      if (page > 0 && PAGINATION_DELAY_MS > 0) {
        await sleep(PAGINATION_DELAY_MS);
      }
      const remainingTime = Math.max(1000, deadline - Date.now());
      const pageTimeout = Math.min(PAGE_FETCH_TIMEOUT_MS, remainingTime);

      const url = new URL(`https://osucollector.com/api/collections/${collectionId}/beatmapsV2`);
      url.searchParams.set('perPage', '100');
      if (cursor !== null) url.searchParams.set('cursor', String(cursor));
      let response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(pageTimeout),
        });
      } catch (pageError) {
        log('warn', 'collection.mapinfo.page_failed', { collectionId, page, error: safeErrorMessage(pageError) });
        break;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        log('warn', 'collection.mapinfo.page_bad_status', { collectionId, page, status: response.status });
        break;
      }
      let data;
      try {
        data = await response.json();
      } catch {
        break;
      }
      if (!data || !Array.isArray(data.beatmaps)) break;

      for (const beatmap of data.beatmaps) {
        const id = beatmap?.beatmapset_id ?? beatmap?.beatmapset?.id;
        if (!Number.isSafeInteger(id) || !wanted.has(id)) continue;
        const current = snapshot.mapsById.get(id);
        if (current && (current.title || current.artist)) continue;

        const title = beatmap.beatmapset?.title || beatmap.beatmapset?.title_unicode || null;
        const artist = beatmap.beatmapset?.artist || beatmap.beatmapset?.artist_unicode || null;
        const creator = beatmap.beatmapset?.creator || null;
        const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${id}`;
        snapshot.mapsById.set(id, { id, label, title, artist, creator });
      }

      snapshot.maps = setIds.map(id => snapshot.mapsById.get(id) || fallbackMapInfo([id])[0]);
      let namedCount = 0;
      for (const m of snapshot.mapsById.values()) {
        if (m.title || m.artist) namedCount += 1;
      }
      snapshot.metadataProgress = namedCount;

      if (namedCount >= wanted.size) break;

      hasMore = Boolean(data.hasMore);
      if (!data.hasMore) break;
      if (data.nextPageCursor == null || cursors.has(data.nextPageCursor)) {
        break;
      }
      cursors.add(data.nextPageCursor);
      cursor = data.nextPageCursor;
    }
  } catch (error) {
    log('warn', 'collection.metadata.background_failed', { collectionId, error: safeErrorMessage(error) });
  } finally {
    snapshot.metadataComplete = true;
    snapshot.metadataPromise = null;
    log('info', 'collection.metadata.completed', {
      collectionId,
      named: snapshot.metadataProgress,
      total: wanted.size,
    });
  }
}

/**
 * Загружает метаданные о картах коллекции через osu!Collector v2 API с пагинацией и бюджетом времени.
 * @param {string} collectionId
 * @param {number[]} setIds
 * @returns {Promise<MapInfo[]>}
 */
async function fetchMapsetInfo(collectionId, setIds) {
  const fallbackMaps = fallbackMapInfo(setIds);
  const mapsById = new Map(fallbackMaps.map(m => [m.id, m]));
  /** @type {CollectionSnapshot} */
  const tempSnapshot = {
    id: Number(collectionId) || 0,
    name: `Коллекция ${collectionId}`,
    uploader: null,
    count: setIds.length,
    beatmapCount: setIds.length,
    maps: fallbackMaps,
    mapsById,
    setIds,
    metadataComplete: false,
    metadataProgress: 0,
  };
  await populateMetadataInBackground(tempSnapshot, collectionId);
  return tempSnapshot.maps;
}

// Кеш нормализованных снимков коллекций с LRU-вытеснением.
const collectionCache = new Map();
const inFlightCollections = new Map();
const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;
const COLLECTION_CACHE_DEGRADED_TTL_MS = 2 * 60 * 1000;
const MAX_COLLECTION_CACHE_ENTRIES = 20;

function pruneCollectionCache() {
  const now = Date.now();
  for (const [id, entry] of collectionCache) {
    if (now - entry.fetchedAt > (entry.ttl || COLLECTION_CACHE_TTL_MS)) {
      collectionCache.delete(id);
    }
  }
}

function setCollectionCache(collectionId, data, ttl = COLLECTION_CACHE_TTL_MS) {
  pruneCollectionCache();
  while (collectionCache.size >= MAX_COLLECTION_CACHE_ENTRIES) {
    const oldestKey = collectionCache.keys().next().value;
    if (oldestKey === undefined) break;
    collectionCache.delete(oldestKey);
  }
  collectionCache.set(collectionId, { data, fetchedAt: Date.now(), ttl });
}

/**
 * Загружает коллекцию osu!Collector по ID с кешированием и подавлением дублирующих запросов (in-flight join).
 * @param {string} collectionId
 * @returns {Promise<any>}
 */
async function fetchCollection(collectionId) {
  const cached = collectionCache.get(collectionId);
  if (cached && Date.now() - cached.fetchedAt < (cached.ttl || COLLECTION_CACHE_TTL_MS)) {
    // Обновляем порядок использования в LRU-кеше
    collectionCache.delete(collectionId);
    collectionCache.set(collectionId, cached);
    log('info', 'collection.cache.hit', { collectionId, ageMs: Date.now() - cached.fetchedAt });
    return cached.data;
  }
  if (cached) collectionCache.delete(collectionId);

  if (inFlightCollections.has(collectionId)) {
    log('info', 'collection.fetch.inflight_join', { collectionId });
    return inFlightCollections.get(collectionId);
  }

  const fetchPromise = (async () => {
    const startedAt = Date.now();
    log('info', 'collection.fetch.started', { collectionId });
    try {
      const response = await fetch(`https://osucollector.com/api/collections/${collectionId}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status === 404 ? 404 : 502, `osu!Collector ответил HTTP ${response.status}.`);
      }
      const rawData = await response.json();
      const setIds = parseSetIds(rawData);
      if (Array.isArray(rawData.beatmapsets) && setIds.length < rawData.beatmapsets.length) {
        log('info', 'collection.mapinfo.deduplicated', { collectionId, totalInCollection: rawData.beatmapsets.length, uniqueSets: setIds.length });
      } else if (typeof rawData.beatmapCount === 'number' && rawData.beatmapCount > 0 && setIds.length === 0) {
        log('warn', 'collection.mapinfo.empty', { collectionId, beatmapCount: rawData.beatmapCount });
      }

      // Формируем начальные метаданные карт: базовые заглушки с обогащением из beatmapsets, если они присутствуют
      const mapsById = new Map();
      for (const id of setIds) {
        mapsById.set(id, { id, label: `Набор ${id}`, title: null, artist: null, creator: null });
      }
      if (Array.isArray(rawData.beatmapsets)) {
        for (const s of rawData.beatmapsets) {
          if (!s || !Number.isSafeInteger(s.id) || !mapsById.has(s.id)) continue;
          const title = s.title || s.title_unicode || null;
          const artist = s.artist || s.artist_unicode || null;
          const creator = s.creator || null;
          if (title || artist) {
            const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${s.id}`;
            mapsById.set(s.id, { id: s.id, label, title, artist, creator });
          }
        }
      }

      const initialMaps = setIds.map(id => mapsById.get(id));
      let initialNamed = 0;
      for (const m of mapsById.values()) {
        if (m.title || m.artist) initialNamed += 1;
      }
      const metadataComplete = initialNamed >= setIds.length || setIds.length === 0;

      // Формируем компактный нормализованный снимок коллекции вместо хранения сырого JSON
      /** @type {CollectionSnapshot} */
      const collectionSnapshot = {
        id: rawData.id,
        name: typeof rawData.name === 'string' ? rawData.name : `Коллекция ${collectionId}`,
        uploader: rawData.uploader && typeof rawData.uploader.username === 'string' ? rawData.uploader.username : null,
        count: setIds.length,
        beatmapCount: rawData.beatmapCount ?? setIds.length,
        maps: initialMaps,
        mapsById,
        setIds,
        metadataComplete,
        metadataProgress: initialNamed,
        metadataPromise: null,
      };

      log('info', 'collection.fetch.succeeded', {
        collectionId,
        setCount: setIds.length,
        initialNamed,
        metadataComplete,
        durationMs: Date.now() - startedAt,
      });

      // Кешируем снимок коллекции
      setCollectionCache(collectionId, collectionSnapshot, COLLECTION_CACHE_TTL_MS);

      if (!metadataComplete) {
        // Фоновое наполнение метаданных без блокировки клиента
        collectionSnapshot.metadataPromise = populateMetadataInBackground(collectionSnapshot, collectionId);
      }

      return collectionSnapshot;
    } catch (error) {
      log('error', 'collection.fetch.failed', { collectionId, durationMs: Date.now() - startedAt, error: safeErrorMessage(error) });
      throw error;
    }
  })();

  inFlightCollections.set(collectionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightCollections.delete(collectionId);
  }
}

module.exports = {
  extractCollectionId,
  parseSetIds,
  fallbackMapInfo,
  fetchMapsetInfo,
  populateMetadataInBackground,
  fetchCollection,
  collectionCache,
  pruneCollectionCache,
};
