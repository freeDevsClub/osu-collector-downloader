// @ts-check
"use strict";

const {
  HttpError,
  log,
  sleep,
  anySignal,
  USER_AGENT,
  PAGE_FETCH_TIMEOUT_MS,
  PAGINATION_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  MAPSET_FETCH_BUDGET_MS,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
  INITIAL_PAGE_WAIT_MS,
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
 * @property {number[]} [rawSetIds]
 * @property {boolean} metadataComplete
 * @property {boolean} [metadataDegraded]
 * @property {number} metadataProgress
 * @property {Promise<void> | null} [metadataPromise]
 * @property {Promise<boolean> | null} [page0Promise]
 */

/**
 * @param {number[]} setIds
 * @returns {MapInfo[]}
 */
function fallbackMapInfo(setIds) {
  return setIds.map(id => ({ id, label: `Набор ${id}`, title: null, artist: null, creator: null }));
}

/**
 * Извлекает уникальные наборы карт из массива beatmaps и сохраняет их в порядке появления beatmapsV2.
 * @param {any[]} beatmaps
 * @param {Set<number>} wantedSetIds
 * @param {Map<number, MapInfo>} mapsById
 * @param {Set<number>} seenSetIds
 * @param {number[]} orderedSetIds
 * @returns {number} количество вновь обогащённых наборов
 */
function ingestBeatmaps(beatmaps, wantedSetIds, mapsById, seenSetIds, orderedSetIds) {
  let newlyEnriched = 0;
  if (!Array.isArray(beatmaps)) return 0;
  for (const beatmap of beatmaps) {
    const id = beatmap?.beatmapset_id ?? beatmap?.beatmapset?.id;
    if (!Number.isSafeInteger(id) || !wantedSetIds.has(id)) continue;

    const title = beatmap.beatmapset?.title || beatmap.beatmapset?.title_unicode || null;
    const artist = beatmap.beatmapset?.artist || beatmap.beatmapset?.artist_unicode || null;
    const creator = beatmap.beatmapset?.creator || null;
    const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${id}`;

    if (!seenSetIds.has(id)) {
      seenSetIds.add(id);
      orderedSetIds.push(id);
      mapsById.set(id, { id, label, title, artist, creator });
      newlyEnriched++;
    } else {
      const existing = mapsById.get(id);
      if (existing && !existing.title && !existing.artist && (title || artist)) {
        mapsById.set(id, { id, label, title, artist, creator });
        newlyEnriched++;
      }
    }
  }
  return newlyEnriched;
}

/**
 * Фоновая пагинация метаданных карт (beatmapsV2) без блокировки старта загрузки.
 * Формирует естественный порядок наборов (сверху вниз, как на сайте osu!Collector).
 * @param {CollectionSnapshot} snapshot
 * @param {string} collectionId
 * @returns {Promise<void>}
 */
async function populateMetadataInBackground(snapshot, collectionId) {
  let resolvePage0 = (/** @type {boolean} */ _val) => {};
  snapshot.page0Promise = new Promise(resolve => {
    resolvePage0 = resolve;
  });

  const rawSetIds = snapshot.rawSetIds || snapshot.setIds;
  const wanted = new Set(rawSetIds);
  if (wanted.size === 0) {
    snapshot.metadataComplete = true;
    snapshot.metadataDegraded = false;
    resolvePage0(true);
    return;
  }

  const seenEnriched = new Set();
  const orderedEnrichedSetIds = [];

  // Подсчитываем уже названные наборы
  for (const id of rawSetIds) {
    const m = snapshot.mapsById.get(id);
    if (m && (m.title || m.artist) && !seenEnriched.has(id)) {
      seenEnriched.add(id);
      orderedEnrichedSetIds.push(id);
    }
  }

  // При явном указании переменной окружения соблюдаем её точно (для тестов и точной настройки).
  // По умолчанию динамически масштабируем бюджет для крупных коллекций (>3000 наборов).
  const envBudget = process.env.MAPSET_FETCH_BUDGET_MS ? Number(process.env.MAPSET_FETCH_BUDGET_MS) : null;
  const effectiveBudget = envBudget && !isNaN(envBudget)
    ? Math.max(50, envBudget)
    : Math.max(
        MAPSET_FETCH_BUDGET_MS,
        Math.min(180000, Math.ceil(wanted.size / 20) * (PAGINATION_DELAY_MS + 250))
      );
  const deadline = Date.now() + effectiveBudget;

  let cursor = null;
  const cursors = new Set();
  let hasMore = true;

  try {
    for (let page = 0; page < PAGINATION_PAGE_LIMIT; page++) {
      if (seenEnriched.size >= wanted.size) break;
      if (!hasMore && page > 0) break;
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
        if (page === 0) resolvePage0(false);
        break;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        log('warn', 'collection.mapinfo.page_bad_status', { collectionId, page, status: response.status });
        if (page === 0) resolvePage0(false);
        break;
      }
      let data;
      try {
        data = await response.json();
      } catch {
        if (page === 0) resolvePage0(false);
        break;
      }
      if (!data || !Array.isArray(data.beatmaps)) {
        if (page === 0) resolvePage0(false);
        break;
      }

      ingestBeatmaps(data.beatmaps, wanted, snapshot.mapsById, seenEnriched, orderedEnrichedSetIds);

      // Перестраиваем порядок: сначала обогащённые наборы по beatmapsV2 (сверху вниз),
      // затем остаток коллекции из rawSetIds, ещё ожидающий своей очереди
      const pendingSetIds = rawSetIds.filter(id => !seenEnriched.has(id));
      snapshot.setIds = [...orderedEnrichedSetIds, ...pendingSetIds];
      snapshot.maps = snapshot.setIds.map(id => snapshot.mapsById.get(id) || fallbackMapInfo([id])[0]);
      snapshot.metadataProgress = seenEnriched.size;

      if (page === 0) resolvePage0(true);

      if (seenEnriched.size >= wanted.size) break;

      hasMore = Boolean(data.hasMore);
      if (!data.hasMore) break;
      if (data.nextPageCursor == null || cursors.has(data.nextPageCursor)) {
        break;
      }
      cursors.add(data.nextPageCursor);
      cursor = data.nextPageCursor;
    }
  } catch (error) {
    resolvePage0(false);
    log('warn', 'collection.metadata.background_failed', { collectionId, error: safeErrorMessage(error) });
  } finally {
    resolvePage0(false);
    // Финальная сверка: всё, что было в rawSetIds, но не пришло из V2, обязательно дописывается в конец
    const remainingSetIds = rawSetIds.filter(id => !seenEnriched.has(id));
    snapshot.setIds = [...orderedEnrichedSetIds, ...remainingSetIds];
    snapshot.maps = snapshot.setIds.map(id => snapshot.mapsById.get(id) || fallbackMapInfo([id])[0]);

    const isFullyEnriched = snapshot.metadataProgress >= wanted.size || wanted.size === 0;
    snapshot.metadataComplete = isFullyEnriched;
    snapshot.metadataDegraded = !isFullyEnriched;
    snapshot.metadataPromise = null;

    const ttl = isFullyEnriched ? COLLECTION_CACHE_TTL_MS : COLLECTION_CACHE_DEGRADED_TTL_MS;
    const cacheEntry = collectionCache.get(collectionId);
    if (cacheEntry && cacheEntry.data === snapshot) {
      cacheEntry.ttl = ttl;
      if (isFullyEnriched) {
        cacheEntry.fetchedAt = Date.now();
      }
    }

    log('info', 'collection.metadata.completed', {
      collectionId,
      named: snapshot.metadataProgress,
      total: wanted.size,
      complete: isFullyEnriched,
      degraded: !isFullyEnriched,
      cacheTtlMs: ttl,
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
    rawSetIds: setIds,
    metadataComplete: false,
    metadataDegraded: false,
    metadataProgress: 0,
  };
  await populateMetadataInBackground(tempSnapshot, collectionId);
  return tempSnapshot.maps;
}

// Кеш нормализованных снимков коллекций с LRU-вытеснением.
const collectionCache = new Map();
const inFlightCollections = new Map();
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
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
async function fetchCollection(collectionId, options = {}) {
  const cached = collectionCache.get(collectionId);
  if (cached && Date.now() - cached.fetchedAt < (cached.ttl || COLLECTION_CACHE_TTL_MS)) {
    // Обновляем порядок использования в LRU-кеше
    collectionCache.delete(collectionId);
    collectionCache.set(collectionId, cached);
    log('info', 'collection.cache.hit', {
      collectionId,
      ageMs: Date.now() - cached.fetchedAt,
      degraded: Boolean(cached.data?.metadataDegraded),
    });
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
      const timeoutSignal = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
      const signal = options?.signal
        ? anySignal([timeoutSignal, options.signal])
        : timeoutSignal;
      const response = await fetch(`https://osucollector.com/api/collections/${collectionId}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status === 404 ? 404 : 502, `osu!Collector ответил HTTP ${response.status}.`);
      }
      const rawData = await response.json();
      const rawSetIds = parseSetIds(rawData);

      if (Array.isArray(rawData.beatmapsets) && rawSetIds.length < rawData.beatmapsets.length) {
        log('info', 'collection.mapinfo.deduplicated', { collectionId, totalInCollection: rawData.beatmapsets.length, uniqueSets: rawSetIds.length });
      } else if (typeof rawData.beatmapCount === 'number' && rawData.beatmapCount > 0 && rawSetIds.length === 0) {
        log('warn', 'collection.mapinfo.empty', { collectionId, beatmapCount: rawData.beatmapCount });
      }

      // Формируем начальные метаданные карт: базовые заглушки с обогащением из beatmapsets, если они присутствуют
      const mapsById = new Map();
      for (const id of rawSetIds) {
        mapsById.set(id, { id, label: `Набор ${id}`, title: null, artist: null, creator: null });
      }
      let initialNamed = 0;
      if (Array.isArray(rawData.beatmapsets)) {
        for (const s of rawData.beatmapsets) {
          if (!s || !Number.isSafeInteger(s.id) || !mapsById.has(s.id)) continue;
          const title = s.title || s.title_unicode || null;
          const artist = s.artist || s.artist_unicode || null;
          const creator = s.creator || null;
          if (title || artist) {
            const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${s.id}`;
            mapsById.set(s.id, { id: s.id, label, title, artist, creator });
            initialNamed++;
          }
        }
      }

      const initialMaps = rawSetIds.map(id => mapsById.get(id));
      const metadataComplete = initialNamed >= rawSetIds.length || rawSetIds.length === 0;

      // Формируем компактный нормализованный снимок коллекции вместо хранения сырого JSON
      /** @type {CollectionSnapshot} */
      const collectionSnapshot = {
        id: rawData.id,
        name: typeof rawData.name === 'string' ? rawData.name : `Коллекция ${collectionId}`,
        uploader: rawData.uploader && typeof rawData.uploader.username === 'string' ? rawData.uploader.username : null,
        count: rawSetIds.length,
        beatmapCount: rawData.beatmapCount ?? rawSetIds.length,
        maps: initialMaps,
        mapsById,
        setIds: rawSetIds,
        rawSetIds,
        metadataComplete,
        metadataDegraded: false,
        metadataProgress: initialNamed,
        metadataPromise: null,
      };

      log('info', 'collection.fetch.succeeded', {
        collectionId,
        setCount: rawSetIds.length,
        initialNamed,
        metadataComplete,
        durationMs: Date.now() - startedAt,
      });

      // Кешируем снимок коллекции (при неполных метаданных выставляем деградированный TTL)
      setCollectionCache(collectionId, collectionSnapshot, metadataComplete ? COLLECTION_CACHE_TTL_MS : COLLECTION_CACHE_DEGRADED_TTL_MS);

      if (!metadataComplete) {
        // Фоновое наполнение метаданных с естественным порядком beatmapsV2
        collectionSnapshot.metadataPromise = populateMetadataInBackground(collectionSnapshot, collectionId);
        if (INITIAL_PAGE_WAIT_MS > 0 && collectionSnapshot.page0Promise) {
          await Promise.race([
            collectionSnapshot.page0Promise,
            sleep(INITIAL_PAGE_WAIT_MS),
          ]);
        }
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
  setCollectionCache,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
};
