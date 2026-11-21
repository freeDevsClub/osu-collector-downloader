'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../server.js');
const {
  fetchCollection,
  collectionCache,
  pruneCollectionCache,
  COLLECTION_CACHE_TTL_MS,
  COLLECTION_CACHE_DEGRADED_TTL_MS,
  populateMetadataInBackground,
} = require('../lib/collector.js');
const { PORT, PAGINATION_PAGE_LIMIT, MAPSET_FETCH_BUDGET_MS } = require('../lib/config.js');
const { safeJobForClient } = require('../lib/jobs.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('Мгновенный старт и ленивая подгрузка названий (Instant Start & Lazy Metadata)', () => {
  const originalFetch = globalThis.fetch;
  let serverInstance;
  let serverPort;
  let testEnv;

  before(async () => {
    testEnv = await setupIsolatedTestEnv('lazy-meta-test-');
    serverInstance = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => serverInstance.once('listening', resolve));
    serverPort = /** @type {import('node:net').AddressInfo} */ (serverInstance.address()).port;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => serverInstance.close(resolve));
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(() => {
    collectionCache.clear();
  });

  it('fetchCollection немедленно возвращает структуру коллекции без ожидания пагинации beatmapsV2', async () => {
    /** @type {(value?: any) => void} */
    let resolveBeatmapsV2 = () => {};
    let beatmapsV2Resolved = false;
    const beatmapsV2Promise = new Promise((resolve) => {
      resolveBeatmapsV2 = () => {
        beatmapsV2Resolved = true;
        resolve();
      };
    });

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99001/beatmapsV2')) {
        await beatmapsV2Promise;
        return new Response(
          JSON.stringify({
            beatmaps: [
              {
                beatmapset_id: 101,
                beatmapset: { title: 'First Song', artist: 'Band A', creator: 'Mapper A' },
              },
              {
                beatmapset_id: 102,
                beatmapset: { title: 'Second Song', artist: 'Band B', creator: 'Mapper B' },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99001')) {
        return new Response(
          JSON.stringify({
            id: 99001,
            name: 'Speed Streams',
            uploader: { username: 'ProPlayer' },
            beatmapCount: 2,
            beatmapsets: [{ id: 101 }, { id: 102 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const start = Date.now();
    const snapshot = await fetchCollection('99001');
    const elapsed = Date.now() - start;

    assert.equal(beatmapsV2Resolved, false, 'fetchCollection не должен дожидаться пагинации beatmapsV2');
    assert.ok(elapsed < 2000, `fetchCollection должен возвращаться быстро без ожидания пагинации, заняло ${elapsed}мс`);
    assert.equal(snapshot.id, 99001);
    assert.equal(snapshot.name, 'Speed Streams');
    assert.equal(snapshot.uploader, 'ProPlayer');
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.metadataComplete, false);
    assert.equal(snapshot.metadataProgress, 0);
    assert.equal(snapshot.maps.length, 2);
    assert.equal(snapshot.maps[0].label, 'Набор 101');
    assert.equal(snapshot.maps[1].label, 'Набор 102');

    // Фоновая подгрузка запущена асинхронно
    assert.ok(snapshot.metadataPromise instanceof Promise);

    // Разрешаем ответ beatmapsV2
    resolveBeatmapsV2();
    await snapshot.metadataPromise;

    // После завершения фоновой подгрузки метаданные обогащены
    assert.equal(snapshot.metadataComplete, true);
    assert.equal(snapshot.metadataProgress, 2);
    assert.equal(snapshot.maps[0].label, 'Band A — First Song');
    assert.equal(snapshot.maps[0].creator, 'Mapper A');
    assert.equal(snapshot.maps[1].label, 'Band B — Second Song');
    assert.equal(snapshot.mapsById.get(101).label, 'Band A — First Song');
    assert.equal(snapshot.mapsById.get(102).label, 'Band B — Second Song');
  });

  it('job.mapsById автоматически отражает названия по мере фонового обогащения', async () => {
    /** @type {(value?: any) => void} */
    let resolveBeatmaps = () => {};
    const beatmapsBarrier = new Promise((resolve) => {
      resolveBeatmaps = resolve;
    });

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99002/beatmapsV2')) {
        await beatmapsBarrier;
        return new Response(
          JSON.stringify({
            beatmaps: [
              {
                beatmapset_id: 201,
                beatmapset: { title: 'Freedom Dive', artist: 'xi', creator: 'FourDM' },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99002')) {
        return new Response(
          JSON.stringify({
            id: 99002,
            name: 'Hard Maps',
            uploader: { username: 'Cookiezi' },
            beatmapCount: 1,
            beatmapsets: [{ id: 201 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99002');
    // Создаём задачу скачивания сразу, пока метаданные ещё не подгрузились
    const mockJob = createTestJob({
      id: 'job_test_enrichment',
      method: 'mirror',
      collectionId: '99002',
      collectionName: snapshot.name,
      setIds: snapshot.setIds,
      mapsById: snapshot.mapsById,
      currentSetId: 201,
      status: 'running',
    });

    // До ответа beatmapsV2 safeJobForClient использует fallback-название
    let clientJob = safeJobForClient(mockJob);
    assert.equal(clientJob.currentSetName, 'Набор 201');

    // Разрешаем ответ beatmapsV2
    resolveBeatmaps();
    await snapshot.metadataPromise;

    // После ответа beatmapsV2 safeJobForClient возвращает реальное название из того же объекта mapsById!
    clientJob = safeJobForClient(mockJob);
    assert.equal(clientJob.currentSetName, 'xi — Freedom Dive');
  });

  it('HTTP API POST /api/collections и GET /api/collections/:id отдают статус метаданных', async () => {
    /** @type {(value?: any) => void} */
    let resolvePaging = () => {};
    const pagingGate = new Promise((resolve) => {
      resolvePaging = resolve;
    });

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99003/beatmapsV2')) {
        await pagingGate;
        return new Response(
          JSON.stringify({
            beatmaps: [
              {
                beatmapset_id: 301,
                beatmapset: { title: 'Blue Zenith', artist: 'xi', creator: 'Asuka_--' },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99003')) {
        return new Response(
          JSON.stringify({
            id: 99003,
            name: 'Stream Stamina',
            uploader: { username: 'Akolibed' },
            beatmapCount: 1,
            beatmapsets: [{ id: 301 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };

    // 1. POST /api/collections
    const postRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ url: 'https://osucollector.com/collections/99003' }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.id, 99003);
    assert.equal(postData.metadataComplete, false);
    assert.equal(postData.metadataProgress, 0);
    assert.equal(postData.maps[0].label, 'Набор 301');

    // 2. GET /api/collections/99003 до завершения пагинации
    const getRes1 = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99003`, {
      headers: localHeaders,
    });
    assert.equal(getRes1.status, 200);
    const getData1 = await getRes1.json();
    assert.equal(getData1.metadataComplete, false);

    // 3. Завершаем фоновую пагинацию
    resolvePaging();
    const cachedEntry = collectionCache.get('99003');
    if (cachedEntry?.data?.metadataPromise) {
      await cachedEntry.data.metadataPromise;
    }

    // 4. GET /api/collections/99003 после завершения пагинации
    const getRes2 = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99003`, {
      headers: localHeaders,
    });
    assert.equal(getRes2.status, 200);
    const getData2 = await getRes2.json();
    assert.equal(getData2.metadataComplete, true);
    assert.equal(getData2.metadataProgress, 1);
    assert.equal(getData2.maps[0].label, 'xi — Blue Zenith');
  });

  it('грамотно обрабатывает ошибки beatmapsV2: помечает деградированной и выставляет degraded-TTL', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99004/beatmapsV2')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      if (url.includes('/api/collections/99004')) {
        return new Response(
          JSON.stringify({
            id: 99004,
            name: 'Error Handling Test',
            uploader: { username: 'Tester' },
            beatmapCount: 1,
            beatmapsets: [{ id: 401 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99004');
    assert.equal(snapshot.metadataComplete, false);
    if (snapshot.metadataPromise) {
      await snapshot.metadataPromise;
    }
    // При сбое beatmapsV2 метаданные помечаются деградированными, процесс не падает
    assert.equal(snapshot.metadataComplete, false);
    assert.equal(snapshot.metadataDegraded, true);
    assert.equal(snapshot.maps[0].label, 'Набор 401');

    // Кэш для деградированной коллекции должен получить degraded-TTL (2 мин), а не 10 мин
    const entry = collectionCache.get('99004');
    assert.ok(entry);
    assert.equal(entry.ttl, COLLECTION_CACHE_DEGRADED_TTL_MS);
    assert.equal(entry.data.metadataDegraded, true);
  });

  it('при успешном фоновом обогащении кэш получает полный TTL (10 мин), а при частичном — degraded TTL (2 мин)', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99005/beatmapsV2')) {
        return new Response(
          JSON.stringify({
            beatmaps: [{ beatmapset_id: 501, beatmapset: { title: 'Complete Song', artist: 'Artist 5' } }],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99005')) {
        return new Response(
          JSON.stringify({ id: 99005, name: 'Complete Coll', beatmapCount: 1, beatmapsets: [{ id: 501 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99006/beatmapsV2')) {
        // Возвращает только 1 набор из 2 требуемых (частичное обогащение)
        return new Response(
          JSON.stringify({
            beatmaps: [{ beatmapset_id: 601, beatmapset: { title: 'Partial Song', artist: 'Artist 6' } }],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99006')) {
        return new Response(
          JSON.stringify({ id: 99006, name: 'Partial Coll', beatmapCount: 2, beatmapsets: [{ id: 601 }, { id: 602 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    // 1. Полная коллекция
    const snapComplete = await fetchCollection('99005');
    if (snapComplete.metadataPromise) await snapComplete.metadataPromise;
    assert.equal(snapComplete.metadataComplete, true);
    assert.equal(snapComplete.metadataDegraded, false);
    const entryComplete = collectionCache.get('99005');
    assert.equal(entryComplete.ttl, COLLECTION_CACHE_TTL_MS);

    // 2. Частично обогащённая коллекция
    const snapPartial = await fetchCollection('99006');
    if (snapPartial.metadataPromise) await snapPartial.metadataPromise;
    assert.equal(snapPartial.metadataComplete, false);
    assert.equal(snapPartial.metadataDegraded, true);
    assert.equal(snapPartial.metadataProgress, 1);
    assert.equal(snapPartial.count, 2);
    const entryPartial = collectionCache.get('99006');
    assert.equal(entryPartial.ttl, COLLECTION_CACHE_DEGRADED_TTL_MS);
  });

  it('pruneCollectionCache вытесняет деградированные записи через 2 минуты, но сохраняет полные записи на 10 минут', () => {
    const now = Date.now();
    // Деградированная запись 2.5 минуты назад
    collectionCache.set('deg_old', {
      data: { id: 1, name: 'Degraded Old' },
      fetchedAt: now - 150_000,
      ttl: COLLECTION_CACHE_DEGRADED_TTL_MS, // 120_000
    });
    // Свежая деградированная запись (30 секунд назад)
    collectionCache.set('deg_fresh', {
      data: { id: 2, name: 'Degraded Fresh' },
      fetchedAt: now - 30_000,
      ttl: COLLECTION_CACHE_DEGRADED_TTL_MS,
    });
    // Полная запись 2.5 минуты назад (при TTL 10 минут она всё ещё свежая)
    collectionCache.set('full_active', {
      data: { id: 3, name: 'Full Active' },
      fetchedAt: now - 150_000,
      ttl: COLLECTION_CACHE_TTL_MS, // 600_000
    });

    pruneCollectionCache();

    assert.equal(collectionCache.has('deg_old'), false, 'Устаревшая деградированная запись должна быть удалена');
    assert.equal(collectionCache.has('deg_fresh'), true, 'Свежая деградированная запись должна остаться');
    assert.equal(collectionCache.has('full_active'), true, 'Полная запись со сроком 2.5 мин не должна удаляться');
  });

  it('после истечения degraded-TTL повторный запрос fetchCollection перезапрашивает коллекцию и возобновляет обогащение', async () => {
    let beatmapsCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99007/beatmapsV2')) {
        beatmapsCalls += 1;
        if (beatmapsCalls === 1) {
          // Первая попытка: сбой upstream
          return new Response('Gateway Timeout', { status: 504 });
        }
        // Вторая попытка: успешный ответ
        return new Response(
          JSON.stringify({
            beatmaps: [{ beatmapset_id: 701, beatmapset: { title: 'Recovered Song', artist: 'Artist 7' } }],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99007')) {
        return new Response(
          JSON.stringify({ id: 99007, name: 'Recovery Coll', beatmapCount: 1, beatmapsets: [{ id: 701 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    // 1. Первый запрос: сбой и сохранение с degraded-TTL
    const snap1 = await fetchCollection('99007');
    if (snap1.metadataPromise) await snap1.metadataPromise;
    assert.equal(snap1.metadataComplete, false);
    assert.equal(snap1.metadataDegraded, true);
    const entry1 = collectionCache.get('99007');
    assert.equal(entry1.ttl, COLLECTION_CACHE_DEGRADED_TTL_MS);

    // 2. Симулируем истечение degraded-TTL (более 2 минут)
    entry1.fetchedAt = Date.now() - (COLLECTION_CACHE_DEGRADED_TTL_MS + 5000);

    // 3. Второй запрос: устаревший кэш сбрасывается, запрос уходит в osu!Collector и успешно обогащается
    const snap2 = await fetchCollection('99007');
    if (snap2.metadataPromise) await snap2.metadataPromise;
    assert.equal(snap2.metadataComplete, true);
    assert.equal(snap2.metadataDegraded, false);
    assert.equal(snap2.maps[0].label, 'Artist 7 — Recovered Song');
    const entry2 = collectionCache.get('99007');
    assert.equal(entry2.ttl, COLLECTION_CACHE_TTL_MS);
    assert.equal(beatmapsCalls, 2);
  });

  it('дефолтные лимиты метаданных соответствуют увеличенным значениям для крупных коллекций', () => {
    assert.ok(PAGINATION_PAGE_LIMIT >= 250, 'PAGINATION_PAGE_LIMIT по умолчанию должен быть не менее 250');
    assert.ok(MAPSET_FETCH_BUDGET_MS >= 60000, 'MAPSET_FETCH_BUDGET_MS по умолчанию должен быть не менее 60000');
    assert.equal(
      COLLECTION_CACHE_DEGRADED_TTL_MS,
      2 * 60 * 1000,
      'COLLECTION_CACHE_DEGRADED_TTL_MS должен быть 2 минуты',
    );
    assert.equal(COLLECTION_CACHE_TTL_MS, 10 * 60 * 1000, 'COLLECTION_CACHE_TTL_MS должен быть 10 минут');
  });

  it('HTTP API POST /api/collections и GET /api/collections/:id отдают metadataDegraded: true при сбое', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99008/beatmapsV2')) {
        return new Response('Rate Limited', { status: 429 });
      }
      if (url.includes('/api/collections/99008')) {
        return new Response(
          JSON.stringify({
            id: 99008,
            name: 'API Degraded Test',
            uploader: { username: 'Degrader' },
            beatmapCount: 1,
            beatmapsets: [{ id: 801 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };

    // 1. POST /api/collections
    const postRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ url: 'https://osucollector.com/collections/99008' }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.id, 99008);
    assert.equal(postData.metadataComplete, false);

    // Дожидаемся завершения фонового обогащения со статусом 429
    const cachedEntry = collectionCache.get('99008');
    if (cachedEntry?.data?.metadataPromise) {
      await cachedEntry.data.metadataPromise;
    }

    // 2. GET /api/collections/99008 возвращает metadataDegraded: true
    const getRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99008`, {
      headers: localHeaders,
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.metadataComplete, false);
    assert.equal(getData.metadataDegraded, true);
    assert.equal(getData.metadataProgress, 0);
  });

  it('выстраивает наборы строго сверху вниз в порядке поступления из beatmapsV2 с дедупликацией трудностей', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99009/beatmapsV2')) {
        return new Response(
          JSON.stringify({
            beatmaps: [
              // Трудность 1 набора 200 (A Song)
              { beatmapset_id: 200, beatmapset: { title: 'A Song', artist: 'Artist A' } },
              // Трудность 2 того же набора 200 (дубликат по setId, должен быть дедуплицирован)
              { beatmapset_id: 200, beatmapset: { title: 'A Song', artist: 'Artist A' } },
              // Трудность набора 100 (B Song)
              { beatmapset_id: 100, beatmapset: { title: 'B Song', artist: 'Artist B' } },
              // Трудность набора 300 (C Song)
              { beatmapset_id: 300, beatmapset: { title: 'C Song', artist: 'Artist C' } },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99009')) {
        return new Response(
          JSON.stringify({
            id: 99009,
            name: 'Top Down Order Collection',
            beatmapCount: 4,
            // В сыром заголовке порядок хаотичный (300, 100, 200)
            beatmapsets: [{ id: 300 }, { id: 100 }, { id: 200 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99009');
    if (snapshot.metadataPromise) await snapshot.metadataPromise;

    assert.equal(snapshot.metadataComplete, true);
    assert.equal(snapshot.count, 3);
    assert.equal(snapshot.maps.length, 3);

    // Порядок должен быть строго по beatmapsV2 (200 -> 100 -> 300), а не по сырому beatmapsets (300 -> 100 -> 200)
    assert.deepEqual(snapshot.setIds, [200, 100, 300]);
    assert.equal(snapshot.maps[0].id, 200);
    assert.equal(snapshot.maps[0].label, 'Artist A — A Song');
    assert.equal(snapshot.maps[1].id, 100);
    assert.equal(snapshot.maps[1].label, 'Artist B — B Song');
    assert.equal(snapshot.maps[2].id, 300);
    assert.equal(snapshot.maps[2].label, 'Artist C — C Song');
  });

  it('сохраняет в хвосте наборы, отсутствующие в beatmapsV2 (удалённые или скрытые карты)', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99010/beatmapsV2')) {
        return new Response(
          JSON.stringify({
            // V2 отдаёт только набор 500
            beatmaps: [{ beatmapset_id: 500, beatmapset: { title: 'Available Song', artist: 'Artist 5' } }],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99010')) {
        return new Response(
          JSON.stringify({
            id: 99010,
            name: 'Partially Missing Collection',
            beatmapCount: 2,
            // В коллекции 2 набора: 500 и 999 (999 удалён или отсутствует в V2)
            beatmapsets: [{ id: 999 }, { id: 500 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99010');
    if (snapshot.metadataPromise) await snapshot.metadataPromise;

    // В коллекции должны остаться оба набора: 500 впереди с названием, а 999 в хвосте с заглушкой
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.maps.length, 2);
    assert.deepEqual(snapshot.setIds, [500, 999]);
    assert.equal(snapshot.maps[0].id, 500);
    assert.equal(snapshot.maps[0].label, 'Artist 5 — Available Song');
    assert.equal(snapshot.maps[1].id, 999);
    assert.equal(snapshot.maps[1].label, 'Набор 999');
  });

  it('GET /api/collections/:id?poll=1&since=N отдаёт только дельту обогащённых карт и исключает классификацию', async () => {
    const osu = require('../lib/osu.js');
    let classifyCalls = 0;
    const originalClassify = osu.classifyCollectionSets;
    osu.classifyCollectionSets = (setIds) => {
      classifyCalls++;
      return originalClassify(setIds);
    };

    /** @type {(value?: any) => void} */
    let resolvePaging = () => {};
    const pagingGate = new Promise((resolve) => {
      resolvePaging = resolve;
    });

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/99011/beatmapsV2')) {
        await pagingGate;
        return new Response(
          JSON.stringify({
            beatmaps: [
              { beatmapset_id: 1101, beatmapset: { title: 'Song 1', artist: 'Artist 1' } },
              { beatmapset_id: 1102, beatmapset: { title: 'Song 2', artist: 'Artist 2' } },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/collections/99011')) {
        return new Response(
          JSON.stringify({
            id: 99011,
            name: 'Polling Test Collection',
            beatmapCount: 3,
            beatmapsets: [{ id: 1101 }, { id: 1102 }, { id: 1103 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const localHeaders = {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      };

      // 1. Первоначальный запрос коллекции (POST /api/collections)
      const postRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections`, {
        method: 'POST',
        headers: localHeaders,
        body: JSON.stringify({ url: 'https://osucollector.com/collections/99011' }),
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.id, 99011);
      assert.equal(postData.metadataProgress, 0);
      assert.equal(classifyCalls, 1, 'Первоначальный POST должен выполнить классификацию');

      // 2. Легковесный запрос статуса ?statusOnly=1 во время ожидания пагинации
      const statusRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99011?statusOnly=1`, {
        headers: localHeaders,
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.id, 99011);
      assert.equal(statusData.metadataComplete, false);
      assert.equal(statusData.metadataProgress, 0);
      assert.equal(statusData.maps, undefined, 'statusOnly не должен отдавать maps');
      assert.equal(statusData.installedSetIds, undefined, 'statusOnly не должен отдавать installedSetIds');
      assert.equal(classifyCalls, 1, 'statusOnly=1 не должен вызывать classifyCollectionSets');

      // 3. Поллинг ?poll=1&since=0 до появления новых названий
      const pollResEmpty = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99011?poll=1&since=0`, {
        headers: localHeaders,
      });
      assert.equal(pollResEmpty.status, 200);
      const pollDataEmpty = await pollResEmpty.json();
      assert.deepEqual(pollDataEmpty.maps, [], 'since=0 при progress=0 должен вернуть пустой массив maps');
      assert.equal(classifyCalls, 1, 'poll=1 не должен вызывать classifyCollectionSets');

      // 4. Разрешаем пагинацию V2
      resolvePaging();
      const cachedEntry = collectionCache.get('99011');
      if (cachedEntry?.data?.metadataPromise) {
        await cachedEntry.data.metadataPromise;
      }

      // 5. Поллинг ?poll=1&since=0 после обогащения 2 карт: сервер должен отдать только 2 новые карты
      const pollResDelta = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99011?poll=1&since=0`, {
        headers: localHeaders,
      });
      assert.equal(pollResDelta.status, 200);
      const pollDataDelta = await pollResDelta.json();
      assert.equal(pollDataDelta.metadataProgress, 2);
      assert.equal(pollDataDelta.offset, 0);
      assert.equal(pollDataDelta.maps.length, 2, 'Сервер должен отдать дельту из 2 карт');
      assert.equal(pollDataDelta.maps[0].label, 'Artist 1 — Song 1');
      assert.equal(pollDataDelta.maps[1].label, 'Artist 2 — Song 2');
      assert.equal(classifyCalls, 1, 'poll=1 не должен вызывать classifyCollectionSets');

      // 6. Повторный поллинг с актуальным since=2: новых карт нет, maps пустой
      const pollResUpToDate = await originalFetch(
        `http://127.0.0.1:${serverPort}/api/collections/99011?poll=1&since=2`,
        {
          headers: localHeaders,
        },
      );
      assert.equal(pollResUpToDate.status, 200);
      const pollDataUpToDate = await pollResUpToDate.json();
      assert.deepEqual(pollDataUpToDate.maps, [], 'при since=2 отдаётся пустой массив maps');
      assert.equal(classifyCalls, 1, 'poll=1 не должен вызывать classifyCollectionSets');

      // 7. Обычный GET без параметров по-прежнему выполняет полную классификацию (обратная совместимость)
      const fullRes = await originalFetch(`http://127.0.0.1:${serverPort}/api/collections/99011`, {
        headers: localHeaders,
      });
      assert.equal(fullRes.status, 200);
      const fullData = await fullRes.json();
      assert.equal(fullData.maps.length, 3);
      assert.ok(Array.isArray(fullData.installedSetIds));
      assert.equal(classifyCalls, 2, 'Обычный GET должен выполнить classifyCollectionSets');
    } finally {
      osu.classifyCollectionSets = originalClassify;
    }
  });
});
