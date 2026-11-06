"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchCollection,
  collectionCache,
  server,
} = require('../server.js');
const { PORT } = require('../lib/config.js');
const { safeJobForClient } = require('../lib/jobs.js');

describe('Мгновенный старт и ленивая подгрузка названий (Instant Start & Lazy Metadata)', () => {
  const originalFetch = globalThis.fetch;
  let serverInstance;
  let serverPort;

  before(async () => {
    serverInstance = server.listen(0, '127.0.0.1');
    await new Promise(resolve => serverInstance.once('listening', resolve));
    serverPort = /** @type {import('node:net').AddressInfo} */ (serverInstance.address()).port;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => serverInstance.close(resolve));
  });

  beforeEach(() => {
    collectionCache.clear();
  });

  it('fetchCollection немедленно возвращает структуру коллекции без ожидания пагинации beatmapsV2', async () => {
    /** @type {(value?: any) => void} */
    let resolveBeatmapsV2 = () => {};
    const beatmapsV2Promise = new Promise(resolve => {
      resolveBeatmapsV2 = resolve;
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    const start = Date.now();
    const snapshot = await fetchCollection('99001');
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 200, `fetchCollection должен возвращаться мгновенно, заняло ${elapsed}мс`);
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
    const beatmapsBarrier = new Promise(resolve => {
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99002');
    // Создаём задачу скачивания сразу, пока метаданные ещё не подгрузились
    const mockJob = {
      id: 'job_test_enrichment',
      method: 'mirror',
      noVideo: false,
      collectionId: '99002',
      collectionName: snapshot.name,
      setIds: snapshot.setIds,
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: snapshot.mapsById,
      currentBytes: 0,
      currentTotalBytes: null,
      currentPercent: 0,
      currentMirror: null,
      autoResumeAt: null,
      autoResumeCount: 0,
      autoResumeTimer: null,
      abortController: null,
      currentSetId: 201,
      status: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };

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
    const pagingGate = new Promise(resolve => {
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
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

  it('грамотно обрабатывает ошибки beatmapsV2 без падения процесса', async () => {
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
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    const snapshot = await fetchCollection('99004');
    assert.equal(snapshot.metadataComplete, false);
    if (snapshot.metadataPromise) {
      await snapshot.metadataPromise;
    }
    // При сбое beatmapsV2 метаданные помечаются как завершённые, процесс не падает
    assert.equal(snapshot.metadataComplete, true);
    assert.equal(snapshot.maps[0].label, 'Набор 401');
  });
});
