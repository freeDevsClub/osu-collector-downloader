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
 * @param {number[]} setIds
 * @returns {any[]}
 */
function fallbackMapInfo(setIds) {
  return setIds.map(id => ({ id, label: `Набор ${id}`, title: null, artist: null, creator: null }));
}

/**
 * Загружает метаданные о картах коллекции через osu!Collector v2 API с пагинацией и бюджетом времени.
 * @param {string} collectionId
 * @param {number[]} setIds
 * @returns {Promise<any[]>}
 */
async function fetchMapsetInfo(collectionId, setIds) {
  const infoById = new Map();
  const wanted = new Set(setIds);
  if (wanted.size === 0) return [];
  let cursor = null;
  const cursors = new Set();
  let hasMore = false;
  const deadline = Date.now() + MAPSET_FETCH_BUDGET_MS;

  for (let page = 0; page < PAGINATION_PAGE_LIMIT; page++) {
    if (Date.now() >= deadline) {
      log('warn', 'collection.mapinfo.budget_exceeded', { collectionId, page, named: infoById.size, totalWanted: wanted.size });
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

    // O(1) сопоставление по Set, собранному один раз перед циклом
    for (const beatmap of data.beatmaps) {
      const id = beatmap?.beatmapset_id ?? beatmap?.beatmapset?.id;
      if (!Number.isSafeInteger(id) || !wanted.has(id) || infoById.has(id)) continue;
      const title = beatmap.beatmapset?.title || beatmap.beatmapset?.title_unicode || null;
      const artist = beatmap.beatmapset?.artist || beatmap.beatmapset?.artist_unicode || null;
      const creator = beatmap.beatmapset?.creator || null;
      const label = [artist, title].filter(Boolean).join(' — ') || title || `Набор ${id}`;
      infoById.set(id, { id, label, title, artist, creator });
    }

    if (infoById.size >= wanted.size) break;

    hasMore = Boolean(data.hasMore);
    if (!data.hasMore) break;
    if (data.nextPageCursor == null || cursors.has(data.nextPageCursor)) {
      break;
    }
    cursors.add(data.nextPageCursor);
    cursor = data.nextPageCursor;
  }

  if (hasMore && infoById.size < wanted.size) {
    // Сообщаем, что длинная коллекция обрезана по лимиту страниц пагинации или бюджету времени
    log('warn', 'collection.mapinfo.truncated', { collectionId, pages: PAGINATION_PAGE_LIMIT, named: infoById.size, totalWanted: setIds.length });
  }

  return setIds.map(id => infoById.get(id) || fallbackMapInfo([id])[0]);
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

      let maps;
      let namesFetched = false;
      try {
        maps = await fetchMapsetInfo(collectionId, setIds);
        namesFetched = true;
      } catch (error) {
        log('warn', 'collection.map_names.unavailable', { collectionId, error: safeErrorMessage(error) });
        maps = fallbackMapInfo(setIds);
      }

      log('info', 'collection.fetch.succeeded', { collectionId, setCount: setIds.length, namedSetCount: maps.filter((/** @type {any} */ map) => map.title || map.artist).length, durationMs: Date.now() - startedAt });

      // Формируем компактный нормализованный снимок коллекции вместо хранения сырого JSON
      const collectionSnapshot = {
        id: rawData.id,
        name: typeof rawData.name === 'string' ? rawData.name : `Коллекция ${collectionId}`,
        uploader: rawData.uploader && typeof rawData.uploader.username === 'string' ? rawData.uploader.username : null,
        count: setIds.length,
        beatmapCount: rawData.beatmapCount ?? setIds.length,
        maps,
        setIds,
        namesFetched,
      };

      // Кешируем снимок: при полноценных названиях — на 10 минут, при сбое названий — на 2 минуты
      setCollectionCache(collectionId, collectionSnapshot, namesFetched ? COLLECTION_CACHE_TTL_MS : COLLECTION_CACHE_DEGRADED_TTL_MS);
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
  fetchCollection,
  collectionCache,
  pruneCollectionCache,
};
