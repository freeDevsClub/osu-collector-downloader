'use strict';

const { describe, it, beforeEach, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {any} */
let updateMapBadge, setCollection, getCollection, updateJob;

before(async () => {
  ({ updateMapBadge, setCollection, getCollection } = await import('../public/js/components/collection.js'));
  ({ updateJob } = await import('../public/js/components/downloads.js'));
});

describe('Оптимизация updateMapBadge: переход с O(N²) на O(N) через Set', () => {
  beforeEach(() => {
    setCollection(null);
  });

  it('updateMapBadge корректно выставляет классы и текст бейджа через O(1) Set', () => {
    const mockCollection = {
      id: 12345,
      count: 3,
      installedSetIds: [101],
      downloadedSetIds: [202],
    };
    setCollection(mockCollection);

    const badge101 = { className: '', textContent: '', title: '' };
    updateMapBadge(badge101, 101);
    assert.equal(badge101.className, 'badge-tag tag-installed');
    assert.equal(badge101.textContent, 'В игре');

    const badge202 = { className: '', textContent: '', title: '' };
    updateMapBadge(badge202, 202);
    assert.equal(badge202.className, 'badge-tag tag-downloaded');
    assert.equal(badge202.textContent, 'Скачано');

    const badge303 = { className: '', textContent: '', title: '' };
    updateMapBadge(badge303, 303);
    assert.equal(badge303.className, 'badge-tag tag-new');
    assert.equal(badge303.textContent, 'Новый');

    // Проверяем, что создались Set-коллекции для O(1) поиска
    const coll = getCollection();
    assert.ok(coll.installedSet instanceof Set);
    assert.ok(coll.downloadedSet instanceof Set);
    assert.equal(coll.installedSet.has(101), true);
    assert.equal(coll.downloadedSet.has(202), true);
  });

  it('updateMapBadge корректно работает со строковыми и числовыми ID', () => {
    const mockCollection = {
      id: 54321,
      count: 2,
      installedSetIds: [5001],
      downloadedSetIds: [6002],
    };
    setCollection(mockCollection);

    // Передаём строку '5001' вместо числа 5001
    const badgeStr = { className: '', textContent: '', title: '' };
    updateMapBadge(badgeStr, '5001');
    assert.equal(badgeStr.className, 'badge-tag tag-installed');
    assert.equal(badgeStr.textContent, 'В игре');

    const badgeDownStr = { className: '', textContent: '', title: '' };
    updateMapBadge(badgeDownStr, '6002');
    assert.equal(badgeDownStr.className, 'badge-tag tag-downloaded');
    assert.equal(badgeDownStr.textContent, 'Скачано');
  });

  it('производительность: 5000 бейджей обновляются мгновенно за O(N) благодаря Set.has', () => {
    const totalMaps = 5000;
    const allIds = Array.from({ length: totalMaps }, (_, i) => 100000 + i);
    // 2500 установленных, 1500 скачанных
    const installedSetIds = allIds.filter((_, i) => i % 2 === 0);
    const downloadedSetIds = allIds.filter((_, i) => i % 3 === 0 && i % 2 !== 0);

    const mockCollection = {
      id: 77777,
      count: totalMaps,
      installedSetIds,
      downloadedSetIds,
      installedSet: new Set(installedSetIds),
      downloadedSet: new Set(downloadedSetIds),
    };
    setCollection(mockCollection);

    const badges = allIds.map(() => ({ className: '', textContent: '', title: '' }));

    const start = performance.now();
    for (let i = 0; i < totalMaps; i++) {
      updateMapBadge(badges[i], allIds[i]);
    }
    const elapsedMs = performance.now() - start;

    // 5000 вызовов updateMapBadge должны выполняться за O(N) (в среднем < 5 мс, с запасом под CI < 250 мс)
    assert.ok(elapsedMs < 250, `5000 вызовов заняли ${elapsedMs.toFixed(2)} мс, ожидалось < 250 мс`);

    // Проверяем выборочные результаты
    assert.equal(badges[0].className, 'badge-tag tag-installed'); // index 0 (% 2 === 0)
    assert.equal(badges[1].className, 'badge-tag tag-new'); // index 1
    assert.equal(badges[3].className, 'badge-tag tag-downloaded'); // index 3 (% 3 === 0, % 2 !== 0)
  });
});

describe('Оптимизация updateJob и DOM-реконсиляция ошибок/зеркал', () => {
  it('style.css не содержит CSS-свойства content-visibility: auto и contain-intrinsic-size, исключая layout thrashing при скролле', async () => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    let content;
    try {
      content = await fs.readFile(path.join(__dirname, '..', 'style.css'), 'utf-8');
    } catch {
      content = await fs.readFile(path.join(__dirname, '..', 'index.html'), 'utf-8');
    }

    assert.doesNotMatch(content, /content-visibility:\s*auto;/);
    assert.doesNotMatch(content, /contain-intrinsic-size/);
  });

  it('updateJob не пересоздаёт DOM-узлы в #failed-list, если сигнатура ошибок не изменилась или при byteTick', () => {
    let replaceChildrenCalls = 0;
    /** @type {any} */
    const mockFailedList = {
      children: [],
      replaceChildren: () => {
        replaceChildrenCalls++;
        mockFailedList.children = [];
      },
      append: (item) => {
        mockFailedList.children.push(item);
      },
    };
    const mockFailedDetails = { hidden: true };
    const mockFailedCount = { textContent: '' };

    /** @type {Record<string, any>} */
    const elements = {
      'failed-details': mockFailedDetails,
      'failed-list': mockFailedList,
      'failed-summary-count': mockFailedCount,
      'transfer-bytes': { textContent: '' },
      'transfer-label': { textContent: '' },
      'downloaded-count': { textContent: '' },
      'skipped-count': { textContent: '' },
      'failed-count': { textContent: '' },
    };

    const originalDocument = /** @type {any} */ (global).document;
    /** @type {any} */ (global).document = {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => ({
        tagName: tag,
        className: '',
        textContent: '',
        append: (...args) => {},
      }),
    };

    try {
      const initialJob = {
        id: 'job_rec_1',
        total: 10,
        completed: 1,
        downloaded: 1,
        skipped: 0,
        failed: 1,
        errors: [{ id: 101, name: 'Beatmap 101', error: '404 Not Found' }],
      };

      // Первый вызов: ошибки рендерятся в DOM (replaceChildren вызывается 1 раз)
      updateJob(initialJob);
      assert.equal(replaceChildrenCalls, 1, 'Первый рендер ошибок должен вызвать replaceChildren');
      assert.equal(mockFailedDetails.hidden, false);
      assert.equal(mockFailedCount.textContent, '1');

      // Второй вызов: byte tick без поля errors (job.errors = undefined)
      const byteTickJob = {
        ...initialJob,
        currentBytes: 1024,
        errors: undefined,
      };
      updateJob(byteTickJob);
      assert.equal(replaceChildrenCalls, 1, 'Byte tick без errors не должен трогать DOM список ошибок');

      // Третий вызов: тот же массив ошибок с той же сигнатурой
      updateJob(initialJob);
      assert.equal(replaceChildrenCalls, 1, 'Повторный вызов с теми же ошибками не должен пересоздавать DOM');

      // Четвертый вызов: добавилась новая ошибка
      const updatedErrorsJob = {
        ...initialJob,
        failed: 2,
        errors: [
          { id: 101, name: 'Beatmap 101', error: '404 Not Found' },
          { id: 102, name: 'Beatmap 102', error: 'Timeout' },
        ],
      };
      updateJob(updatedErrorsJob);
      assert.equal(replaceChildrenCalls, 2, 'При появлении новой ошибки replaceChildren должен вызваться снова');
      assert.equal(mockFailedCount.textContent, '2');
    } finally {
      /** @type {any} */ (global).document = originalDocument;
    }
  });

  it('updateJob создаёт ссылки на osu.ppy.sh и подсказку о сессии osu! для упавших карт', () => {
    const createdElements = [];
    /** @type {any} */
    const mockFailedList = {
      children: [],
      replaceChildren: () => {
        mockFailedList.children = [];
      },
      append: (item) => {
        mockFailedList.children.push(item);
      },
    };
    const mockFailedDetails = { hidden: true };
    const mockFailedCount = { textContent: '' };

    const elements = {
      'failed-details': mockFailedDetails,
      'failed-list': mockFailedList,
      'failed-summary-count': mockFailedCount,
      'transfer-bytes': { textContent: '' },
      'transfer-label': { textContent: '' },
      'downloaded-count': { textContent: '' },
      'skipped-count': { textContent: '' },
      'failed-count': { textContent: '' },
    };

    const originalDocument = /** @type {any} */ (global).document;
    /** @type {any} */ (global).document = {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => {
        const el = {
          tagName: tag,
          className: '',
          textContent: '',
          href: '',
          target: '',
          rel: '',
          children: [],
          append: (...args) => {
            el.children.push(...args);
          },
        };
        createdElements.push(el);
        return el;
      },
    };

    try {
      const job = {
        id: 'job_links_test',
        total: 5,
        completed: 1,
        downloaded: 0,
        skipped: 0,
        failed: 1,
        errors: [
          {
            id: 1832053,
            name: 'Kafu — Bita Ichimonme',
            error: 'набора нет ни на одном зеркале (404): osu!dl: 404',
          },
        ],
      };

      updateJob(job);

      // Проверяем подсказку вверху списка
      const tip = mockFailedList.children.find((c) => c.className === 'failed-summary-tip');
      assert.ok(tip, 'Должна присутствовать подсказка failed-summary-tip');
      assert.match(tip.textContent, /Сессия osu!/);

      // Проверяем ссылку на osu.ppy.sh
      const links = createdElements.filter((el) => el.tagName === 'a');
      const osuLink = links.find((l) => l.href === 'https://osu.ppy.sh/beatmapsets/1832053');
      assert.ok(osuLink, 'Должна быть ссылка на https://osu.ppy.sh/beatmapsets/1832053');
      assert.equal(osuLink.target, '_blank');
      assert.equal(osuLink.rel, 'noopener noreferrer');

      // Проверяем подсказку внутри карточки ошибки
      const hint = createdElements.find((el) => el.className === 'failed-item-hint');
      assert.ok(hint, 'Должна присутствовать подсказка failed-item-hint');
      assert.match(hint.textContent, /официального сайта или через Cookie сессии/);
    } finally {
      /** @type {any} */ (global).document = originalDocument;
    }
  });
});
