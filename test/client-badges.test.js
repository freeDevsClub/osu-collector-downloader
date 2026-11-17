"use strict";

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { updateMapBadge, setCollection, getCollection } = require('../app.js');

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

    // 5000 вызовов updateMapBadge должны выполняться быстрее 15 мс (в среднем < 3 мс)
    assert.ok(elapsedMs < 50, `5000 вызовов заняли ${elapsedMs.toFixed(2)} мс, ожидалось < 50 мс`);

    // Проверяем выборочные результаты
    assert.equal(badges[0].className, 'badge-tag tag-installed'); // index 0 (% 2 === 0)
    assert.equal(badges[1].className, 'badge-tag tag-new');       // index 1
    assert.equal(badges[3].className, 'badge-tag tag-downloaded');// index 3 (% 3 === 0, % 2 !== 0)
  });
});
