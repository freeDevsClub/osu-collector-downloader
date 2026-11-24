'use strict';

const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { server } = require('../server.js');
const { PORT } = require('../lib/config.js');
const { getApiToken } = require('../lib/security.js');
const { setMirrorsForTest, resetMirrorsForTest } = require('../lib/mirrors.js');
const { collectionCache } = require('../lib/collector.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');
const { createJob, Job } = require('../lib/job.js');
const { jobs, setActiveJob, prepareJobCollection } = require('../lib/jobs.js');

/** @type {any} */
let collectionModule, downloadsModule;

describe('Выбор подмножества карт, поиск и фильтрация в списке коллекции (Issue #3)', () => {
  let testEnv;
  let appServer;
  let appPort;
  let mockMirrorServer;
  let mockMirrorPort;

  const validZipBuffer = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    collectionModule = await import('../public/js/components/collection.js');
    downloadsModule = await import('../public/js/components/downloads.js');
    testEnv = await setupIsolatedTestEnv('collection-selection-test-');

    mockMirrorServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validZipBuffer.length),
      });
      res.end(validZipBuffer);
    });
    await new Promise((r) => mockMirrorServer.listen(0, '127.0.0.1', r));
    mockMirrorPort = /** @type {import('node:net').AddressInfo} */ (mockMirrorServer.address()).port;
    setMirrorsForTest([
      {
        id: 'mock_mirror',
        label: 'Mock Mirror',
        build: (id) => `http://127.0.0.1:${mockMirrorPort}/d/${id}`,
      },
    ]);

    appServer = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    resetMirrorsForTest();
    if (mockMirrorServer) {
      if (typeof mockMirrorServer.closeAllConnections === 'function') mockMirrorServer.closeAllConnections();
      await new Promise((resolve) => mockMirrorServer.close(resolve));
    }
    if (appServer) {
      if (typeof appServer.closeAllConnections === 'function') appServer.closeAllConnections();
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe('Функция matchesFilter (поиск по названию, артисту, мапперу, ID)', () => {
    const map = {
      id: 123456,
      title: 'Galaxy Collapse',
      artist: 'Kurokotei',
      creator: 'DoKito',
      label: 'Kurokotei — Galaxy Collapse',
    };

    it('возвращает true при пустом поисковом запросе', () => {
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, ''), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, null), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, undefined), true);
    });

    it('находит карту по ID', () => {
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, '123456'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, '1234'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, '999999'), false);
    });

    it('находит карту по названию (регистронезависимо)', () => {
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'galaxy'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'COLLAPSE'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'Freedom Dive'), false);
    });

    it('находит карту по артисту', () => {
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'kurokotei'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'KURO'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'Camellia'), false);
    });

    it('находит карту по мапперу', () => {
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'dokito'), true);
      assert.equal(collectionModule.matchesFilter(map, map.label, map.creator, 'Sotarks'), false);
    });
  });

  describe('Управление выбранным подмножеством карт в DOM', () => {
    let mockElements;
    let origDocument;
    let origHTMLElement;

    beforeEach(() => {
      origHTMLElement = global.HTMLElement;
      mockElements = new Map();

      const createElement = (tag) => {
        const classes = new Set();
        const listeners = new Map();
        const attrs = new Map();
        const el = {
          tagName: tag.toUpperCase(),
          children: [],
          classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => {
              if (force === undefined) {
                if (classes.has(c)) classes.delete(c);
                else classes.add(c);
              } else if (force) classes.add(c);
              else classes.delete(c);
            },
            contains: (c) => classes.has(c),
          },
          get className() {
            return Array.from(classes).join(' ');
          },
          set className(val) {
            classes.clear();
            (val || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
          },
          textContent: '',
          checked: false,
          indeterminate: false,
          disabled: false,
          hidden: false,
          value: '',
          type: '',
          dataset: {},
          setAttribute: (k, v) => attrs.set(k, v),
          getAttribute: (k) => attrs.get(k),
          append: (...nodes) => {
            el.children.push(...nodes);
          },
          replaceChildren: (...nodes) => {
            el.children = [...nodes];
            el.textContent = '';
          },
          addEventListener: (evt, fn) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt).push(fn);
          },
          dispatchEvent: (event) => {
            const fns = listeners.get(event.type) || [];
            fns.forEach((fn) => fn(event));
          },
          querySelector: (sel) => el.children.find((c) => c.className?.includes(sel.replace('.', ''))),
          remove: () => {},
        };
        return el;
      };

      origDocument = global.document;
      /** @type {any} */ (global).document = {
        createElement,
        createDocumentFragment: () => ({
          children: [],
          append: function (...nodes) {
            this.children.push(...nodes);
          },
        }),
        getElementById: (id) => {
          if (!mockElements.has(id)) {
            mockElements.set(id, createElement('div'));
          }
          return mockElements.get(id);
        },
        querySelectorAll: () => [],
      };
      /** @type {any} */ (global).HTMLElement = class {};
    });

    afterEach(() => {
      if (collectionModule?.stopMetadataPolling) {
        collectionModule.stopMetadataPolling();
      }
      global.document = origDocument;
      global.HTMLElement = origHTMLElement;
      collectionModule.setCollection(null);
    });

    it('renderCollection инициализирует все наборы как выбранные и обновляет счётчик', () => {
      const mockData = {
        id: 777,
        name: 'Speed Maps',
        count: 3,
        setIds: [1001, 1002, 1003],
        maps: [
          { id: 1001, title: 'Map A', artist: 'Artist A', creator: 'Mapper A', label: 'Artist A — Map A' },
          { id: 1002, title: 'Map B', artist: 'Artist B', creator: 'Mapper B', label: 'Artist B — Map B' },
          { id: 1003, title: 'Map C', artist: 'Artist C', creator: 'Mapper C', label: 'Artist C — Map C' },
        ],
      };

      collectionModule.renderCollection(mockData);

      const selected = collectionModule.getSelectedSetIds();
      assert.deepEqual(selected, [1001, 1002, 1003]);

      const counter = global.document.getElementById('selection-counter');
      assert.equal(counter.textContent, 'Выбрано: 3 из 3');

      const payload = collectionModule.collectionPayload();
      assert.deepEqual(payload.selectedSetIds, [1001, 1002, 1003]);
    });

    it('renderCollection автоматически снимает выбор с уже установленных и скачанных карт', () => {
      const mockData = {
        id: 778,
        name: 'Auto Uncheck Test',
        count: 4,
        setIds: [101, 102, 103, 104],
        installedSetIds: [102],
        downloadedSetIds: [104],
        maps: [
          { id: 101, title: 'New 1' },
          { id: 102, title: 'Installed' },
          { id: 103, title: 'New 2' },
          { id: 104, title: 'Downloaded' },
        ],
      };

      collectionModule.renderCollection(mockData);

      const selected = collectionModule.getSelectedSetIds();
      // Только новые (101 и 103) должны быть выбраны
      assert.deepEqual(selected.sort(), [101, 103]);

      const counter = global.document.getElementById('selection-counter');
      assert.equal(counter.textContent, 'Выбрано: 2 из 4');

      // Кнопка скачивания должна предлагать "Скачать 2 новых"
      const btn = /** @type {any} */ (global.document.getElementById('download-button'));
      downloadsModule.updateDownloadButton(mockData, true);
      assert.equal(btn.textContent, 'Скачать 2 новых');
    });

    it('selectVisible(false) и selectVisible(true) переключают выбор наборов', () => {
      const mockData = {
        id: 888,
        name: 'Jump Maps',
        count: 2,
        setIds: [2001, 2002],
        maps: [
          { id: 2001, title: 'Jump 1', artist: 'A', creator: 'M1', label: 'A — Jump 1' },
          { id: 2002, title: 'Jump 2', artist: 'B', creator: 'M2', label: 'B — Jump 2' },
        ],
      };

      collectionModule.renderCollection(mockData);

      // Снять все
      collectionModule.selectVisible(false);
      assert.deepEqual(collectionModule.getSelectedSetIds(), []);
      assert.equal(global.document.getElementById('selection-counter').textContent, 'Выбрано: 0 из 2');

      // Выбрать все
      collectionModule.selectVisible(true);
      assert.deepEqual(collectionModule.getSelectedSetIds(), [2001, 2002]);
      assert.equal(global.document.getElementById('selection-counter').textContent, 'Выбрано: 2 из 2');
    });

    it('setSelectedSetIds обновляет внутренний Set и счётчик', () => {
      const mockData = {
        id: 999,
        name: 'Tech Maps',
        count: 3,
        setIds: [3001, 3002, 3003],
        maps: [
          { id: 3001, title: 'Tech 1', artist: 'A', creator: 'M1', label: 'A — Tech 1' },
          { id: 3002, title: 'Tech 2', artist: 'B', creator: 'M2', label: 'B — Tech 2' },
          { id: 3003, title: 'Tech 3', artist: 'C', creator: 'M3', label: 'C — Tech 3' },
        ],
      };

      collectionModule.renderCollection(mockData);
      collectionModule.setSelectedSetIds([3002]);

      assert.deepEqual(collectionModule.getSelectedSetIds(), [3002]);
      assert.equal(global.document.getElementById('selection-counter').textContent, 'Выбрано: 1 из 3');

      const masterCheckbox = /** @type {any} */ (global.document.getElementById('select-all-checkbox'));
      assert.equal(masterCheckbox.indeterminate, true);
    });

    it('applySearchFilter скрывает несовпадающие элементы', () => {
      const mockData = {
        id: 1111,
        name: 'Mixed Collection',
        count: 2,
        setIds: [4001, 4002],
        maps: [
          { id: 4001, title: 'Freedom Dive', artist: 'xi', creator: 'Nakagawa-Kanon', label: 'xi — Freedom Dive' },
          { id: 4002, title: 'Blue Zenith', artist: 'xi', creator: 'Asphyxia', label: 'xi — Blue Zenith' },
        ],
      };

      collectionModule.renderCollection(mockData);

      // Ищем 'Freedom'
      collectionModule.applySearchFilter('Freedom');
      assert.equal(collectionModule.mapListByIndex[0].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[1].item.hidden, true);

      // Сбрасываем поиск
      collectionModule.applySearchFilter('');
      assert.equal(collectionModule.mapListByIndex[0].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[1].item.hidden, false);
    });

    it('matchesStatusFilter и setStatusFilter фильтруют карты по статусу (Все, Новые, В игре)', () => {
      const mockData = {
        id: 2222,
        name: 'Status Filter Collection',
        count: 4,
        setIds: [5001, 5002, 5003, 5004],
        installedSetIds: [5002],
        downloadedSetIds: [5004],
        maps: [
          { id: 5001, title: 'Map New 1', artist: 'A1', creator: 'M1', label: 'A1 — Map New 1', bpm: 180, stars: 5.5 },
          { id: 5002, title: 'Map Installed', artist: 'A2', creator: 'M2', label: 'A2 — Map Installed', bpm: 190, stars: 6.2 },
          { id: 5003, title: 'Map New 2', artist: 'A3', creator: 'M3', label: 'A3 — Map New 2', bpm: 200, stars: 7.1 },
          { id: 5004, title: 'Map Downloaded', artist: 'A4', creator: 'M4', label: 'A4 — Map Downloaded', bpm: 210, stars: 5.0 },
        ],
      };

      collectionModule.renderCollection(mockData);

      // Проверяем matchesStatusFilter напрямую
      assert.equal(collectionModule.matchesStatusFilter(5001, 'all'), true);
      assert.equal(collectionModule.matchesStatusFilter(5001, 'new'), true);
      assert.equal(collectionModule.matchesStatusFilter(5001, 'installed'), false);

      assert.equal(collectionModule.matchesStatusFilter(5002, 'all'), true);
      assert.equal(collectionModule.matchesStatusFilter(5002, 'new'), false);
      assert.equal(collectionModule.matchesStatusFilter(5002, 'installed'), true);

      assert.equal(collectionModule.matchesStatusFilter(5004, 'all'), true);
      assert.equal(collectionModule.matchesStatusFilter(5004, 'new'), false);
      assert.equal(collectionModule.matchesStatusFilter(5004, 'installed'), false);

      // Фильтр 'new' скрывает установленные (5002) и скачанные (5004)
      collectionModule.setStatusFilter('new');
      assert.equal(collectionModule.mapListByIndex[0].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[1].item.hidden, true);
      assert.equal(collectionModule.mapListByIndex[2].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[3].item.hidden, true);

      // Фильтр 'installed' оставляет только 5002
      collectionModule.setStatusFilter('installed');
      assert.equal(collectionModule.mapListByIndex[0].item.hidden, true);
      assert.equal(collectionModule.mapListByIndex[1].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[2].item.hidden, true);
      assert.equal(collectionModule.mapListByIndex[3].item.hidden, true);

      // Сброс на 'all'
      collectionModule.setStatusFilter('all');
      assert.equal(collectionModule.mapListByIndex[0].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[1].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[2].item.hidden, false);
      assert.equal(collectionModule.mapListByIndex[3].item.hidden, false);
    });

    it('updateTabCounts вычисляет количество карт для вкладок Все, Новые, В игре', () => {
      const mockData = {
        id: 3333,
        name: 'Counts Test',
        count: 5,
        setIds: [1, 2, 3, 4, 5],
        installedSetIds: [2, 4],
        downloadedSetIds: [3],
      };
      collectionModule.setCollection(mockData);
      collectionModule.updateTabCounts();

      assert.equal(global.document.getElementById('tab-count-all').textContent, '5');
      assert.equal(global.document.getElementById('tab-count-new').textContent, '2');
      assert.equal(global.document.getElementById('tab-count-installed').textContent, '2');
    });

    it('updateMetaRowContent корректно выводит маппера, BPM и звёзды', () => {
      const container = global.document.createElement('div');
      const map = { creator: 'GoldenWolf', bpm: 185, stars: 6.42 };
      const creatorEl = collectionModule.updateMetaRowContent(container, map);

      assert.ok(creatorEl);
      assert.equal(creatorEl.textContent, 'маппер: GoldenWolf');
      const texts = Array.from(container.children).map((c) => c.textContent);
      assert.ok(texts.includes('маппер: GoldenWolf'));
      assert.ok(texts.includes('185 BPM'));
      assert.ok(texts.includes('6.42★'));
      assert.ok(texts.includes('•'));
    });

    it('renderMapList создаёт ссылку на osu.ppy.sh с target="_blank"', () => {
      const mockData = {
        id: 4444,
        count: 1,
        setIds: [99999],
        maps: [{ id: 99999, title: 'Target Test', artist: 'Artist', creator: 'Mapper', label: 'Artist — Target Test' }],
      };
      collectionModule.renderCollection(mockData);

      const record = collectionModule.mapListByIndex[0];
      assert.equal(record.title.href, 'https://osu.ppy.sh/beatmapsets/99999');
      assert.equal(record.title.target, '_blank');
      assert.equal(record.title.rel, 'noopener noreferrer');
    });

    it('updateMapListLabels синхронизирует ссылку и текущий setId при перестановке/обогащении', () => {
      const mockData = {
        id: 5555,
        count: 2,
        setIds: [101, 102],
        maps: [
          { id: 101, label: 'Набор 101' },
          { id: 102, label: 'Набор 102' },
        ],
      };
      collectionModule.renderCollection(mockData);

      // Имитируем ленивую подгрузку, где на первое место встаёт набор 777
      const enrichedMaps = [
        { id: 777, title: 'Enriched Song', artist: 'Artist', label: 'Artist — Enriched Song' },
      ];
      collectionModule.updateMapListLabels(enrichedMaps, 0);

      const record = collectionModule.mapListByIndex[0];
      assert.equal(record.currentId, 777);
      assert.equal(record.title.href, 'https://osu.ppy.sh/beatmapsets/777');
      assert.equal(record.title.textContent, 'Artist — Enriched Song');
    });

    it('updateDownloadButton меняет текст и состояние в зависимости от количества выбранных', () => {
      const btn = /** @type {any} */ (global.document.getElementById('download-button'));
      const coll = { id: 555, count: 4, setIds: [1, 2, 3, 4] };

      collectionModule.setCollection(coll);

      // Все 4 выбраны
      collectionModule.setSelectedSetIds([1, 2, 3, 4]);
      downloadsModule.updateDownloadButton(coll, true);
      assert.equal(btn.disabled, false);
      assert.equal(btn.textContent, 'Скачать наборы');

      // Выбрано 2 из 4
      collectionModule.setSelectedSetIds([1, 3]);
      downloadsModule.updateDownloadButton(coll, true);
      assert.equal(btn.disabled, false);
      assert.equal(btn.textContent, 'Скачать выбранные (2)');

      // Выбрано 0 из 4
      collectionModule.setSelectedSetIds([]);
      downloadsModule.updateDownloadButton(coll, true);
      assert.equal(btn.disabled, true);
      assert.equal(btn.textContent, 'Выберите наборы для загрузки');
    });
  });

  describe('Бэкенд: обработка selectedSetIds в POST /api/downloads и Job', () => {
    beforeEach(() => {
      jobs.clear();
      setActiveJob(null);
      collectionCache.clear();
    });

    it('Job сохраняет selectedSetIds и восстанавливает при сериализации', () => {
      const job = createJob({
        method: 'mirror',
        collectionId: '123',
        setIds: [10, 20, 30],
        selectedSetIds: [10, 30],
      });

      assert.ok(job.selectedSetIds instanceof Set);
      assert.equal(job.selectedSetIds.size, 2);
      assert.ok(job.selectedSetIds.has(10));
      assert.ok(job.selectedSetIds.has(30));
      assert.ok(!job.selectedSetIds.has(20));
    });

    it('POST /api/downloads возвращает 400, если selectedSetIds не массив или пустой', async () => {
      const token = getApiToken();

      // 1. selectedSetIds не массив
      const resBad = await fetch(`http://127.0.0.1:${appPort}/api/downloads`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          'Content-Type': 'application/json',
          'X-API-Token': token,
          Connection: 'close',
        },
        body: JSON.stringify({
          url: 'https://osucollector.com/collections/12345',
          selectedSetIds: 'not-an-array',
        }),
      });
      assert.equal(resBad.status, 400);
      const dataBad = await resBad.json();
      assert.ok(dataBad.error.includes('массивом'));

      // 2. selectedSetIds пустой массив
      const resEmpty = await fetch(`http://127.0.0.1:${appPort}/api/downloads`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          'Content-Type': 'application/json',
          'X-API-Token': token,
          Connection: 'close',
        },
        body: JSON.stringify({
          url: 'https://osucollector.com/collections/12345',
          selectedSetIds: [],
        }),
      });
      assert.equal(resEmpty.status, 400);
      const dataEmpty = await resEmpty.json();
      assert.ok(dataEmpty.error.includes('Не выбрано ни одного набора'));
    });

    it('POST /api/downloads фильтрует кешированную коллекцию по selectedSetIds', async () => {
      const token = getApiToken();
      const testCollectionId = '998877';

      collectionCache.set(testCollectionId, {
        timestamp: Date.now(),
        data: {
          id: testCollectionId,
          name: 'Subset Test Collection',
          beatmapsets: [
            { id: 101, beatmaps: [{ id: 1001, version: 'Easy' }] },
            { id: 202, beatmaps: [{ id: 2002, version: 'Hard' }] },
            { id: 303, beatmaps: [{ id: 3003, version: 'Insane' }] },
          ],
        },
      });

      // Передаём только наборы 101 и 303
      const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          'Content-Type': 'application/json',
          'X-API-Token': token,
          Connection: 'close',
        },
        body: JSON.stringify({
          url: `https://osucollector.com/collections/${testCollectionId}`,
          selectedSetIds: [101, 303],
        }),
      });

      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.total, 2);

      // Проверяем, что в созданной задаче ровно 2 набора
      const createdJob = jobs.get(data.id);
      assert.ok(createdJob);
      assert.deepEqual(createdJob.setIds, [101, 303]);
      assert.deepEqual(Array.from(createdJob.selectedSetIds), [101, 303]);

      while (['preparing', 'queued', 'running'].includes(createdJob.status)) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(createdJob.status, 'finished');
    });

    it('POST /api/downloads возвращает 400, если ни один из выбранных наборов не найден в коллекции', async () => {
      const token = getApiToken();
      const testCollectionId = '998866';

      collectionCache.set(testCollectionId, {
        timestamp: Date.now(),
        data: {
          id: testCollectionId,
          name: 'Non-Matching Collection',
          beatmapsets: [
            { id: 501, beatmaps: [{ id: 5001 }] },
          ],
        },
      });

      const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          'Content-Type': 'application/json',
          'X-API-Token': token,
          Connection: 'close',
        },
        body: JSON.stringify({
          url: `https://osucollector.com/collections/${testCollectionId}`,
          selectedSetIds: [999, 888],
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('не найден в коллекции'));
    });
  });
});
