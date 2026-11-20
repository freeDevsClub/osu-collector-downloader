// @ts-check
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { server } = require('../server.js');

describe('Декомпозиция клиентского монолита на ES-модули (Issue #9)', () => {
  /** @type {any} */
  let utilsMod;
  /** @type {any} */
  let apiMod;
  /** @type {any} */
  let mirrorsMod;
  /** @type {any} */
  let settingsMod;
  /** @type {any} */
  let collectionMod;
  /** @type {any} */
  let downloadsMod;

  /** @type {number} */
  let port;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    utilsMod = await import('../public/js/utils.js');
    apiMod = await import('../public/js/api.js');
    mirrorsMod = await import('../public/js/components/mirrors.js');
    settingsMod = await import('../public/js/components/settings.js');
    collectionMod = await import('../public/js/components/collection.js');
    downloadsMod = await import('../public/js/components/downloads.js');

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve(null);
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('public/js/utils.js экспортирует чистые функции форматирования и DOM-утилиты', () => {
    assert.equal(utilsMod.formatBytes(0), '0 Б');
    assert.equal(utilsMod.formatBytes(1024), '1.00 КБ');
    assert.equal(utilsMod.formatBytes(10485760), '10.0 МБ');
    assert.equal(utilsMod.formatBytes(-5), '0 Б');

    assert.equal(utilsMod.pluralizeRu(1, 'карта', 'карты', 'карт'), 'карта');
    assert.equal(utilsMod.pluralizeRu(2, 'карта', 'карты', 'карт'), 'карты');
    assert.equal(utilsMod.pluralizeRu(5, 'карта', 'карты', 'карт'), 'карт');
    assert.equal(utilsMod.formatPluralRu(3, 'набор', 'набора', 'наборов'), '3 набора');

    const mockEl = { textContent: '', className: '' };
    utilsMod.setStatus(mockEl, 'Успех', 'success');
    assert.equal(mockEl.textContent, 'Успех');
    assert.equal(mockEl.className, 'status success');
  });

  it('public/js/api.js изолирует управление состоянием сессии', () => {
    apiMod.setSessionConnected(true);
    assert.equal(apiMod.isSessionConnected(), true);

    apiMod.setSessionConnected(false);
    assert.equal(apiMod.isSessionConnected(), false);
  });

  it('public/js/components/mirrors.js управляет состоянием зеркал и кулдаунами', () => {
    mirrorsMod.setMirrorStatus([]);
    assert.deepEqual(mirrorsMod.getMirrorStatus(), []);

    mirrorsMod.updateMirrorsFromData([
      { id: 'm1', label: 'Mirror 1', cooldownMs: 0 },
      { id: 'm2', label: 'Mirror 2', cooldownMs: 5000 },
    ]);
    assert.equal(mirrorsMod.getMirrorStatus().length, 2);
    assert.equal(mirrorsMod.hasActiveCooldowns(), true);
  });

  it('public/js/components/settings.js управляет моделью настроек osu!', () => {
    settingsMod.renderOsuSettings(
      {
        osuPath: 'C:\\osu',
        valid: true,
        songsCount: 150,
        postDownloadAction: 'move',
      },
      false,
    );

    const s = settingsMod.getOsuSettings();
    assert.equal(s.osuPath, 'C:\\osu');
    assert.equal(s.valid, true);
    assert.equal(s.songsCount, 150);
    assert.equal(s.postDownloadAction, 'move');
  });

  it('public/js/components/collection.js управляет O(1) бейджами и состоянием коллекции', () => {
    collectionMod.setCollection({
      id: 999,
      count: 2,
      installedSetIds: [10],
      downloadedSetIds: [20],
    });

    const coll = collectionMod.getCollection();
    assert.ok(coll.installedSet instanceof Set);
    assert.equal(coll.installedSet.has(10), true);
    assert.equal(coll.downloadedSet.has(20), true);

    const badge = { className: '', textContent: '', title: '' };
    collectionMod.updateMapBadge(badge, 10);
    assert.equal(badge.className, 'badge-tag tag-installed');
    assert.equal(badge.textContent, 'В игре');

    collectionMod.updateMapBadge(badge, 20);
    assert.equal(badge.className, 'badge-tag tag-downloaded');
    assert.equal(badge.textContent, 'Скачано');

    collectionMod.updateMapBadge(badge, 30);
    assert.equal(badge.className, 'badge-tag tag-new');
    assert.equal(badge.textContent, 'Новый');
  });

  it('public/js/components/downloads.js управляет состоянием активной задачи и методами скачивания', () => {
    downloadsMod.setActiveJob('job_test_1');
    assert.equal(downloadsMod.getActiveJob(), 'job_test_1');

    downloadsMod.setPausedJob('job_test_paused');
    assert.equal(downloadsMod.getPausedJob(), 'job_test_paused');

    assert.equal(downloadsMod.methodReady('mirror', false), true);
    assert.equal(downloadsMod.methodReady('session', false), false);
    assert.equal(downloadsMod.methodReady('session', true), true);
  });

  it('server.js раздаёт клиентские ES-модули из /public/js/* с правильными MIME-типами и заголовками', async () => {
    // GET /public/js/app.js -> 200 text/javascript
    const resApp = await fetch(`${baseUrl}/public/js/app.js`);
    assert.equal(resApp.status, 200);
    assert.match(resApp.headers.get('content-type') || '', /^text\/javascript/);
    assert.match(resApp.headers.get('content-security-policy') || '', /script-src 'self'/);
    const bodyApp = await resApp.text();
    assert.match(bodyApp, /export \* from '\.\/components\/collection\.js'/);

    // GET /public/js/components/collection.js -> 200 text/javascript
    const resColl = await fetch(`${baseUrl}/public/js/components/collection.js`);
    assert.equal(resColl.status, 200);
    assert.match(resColl.headers.get('content-type') || '', /^text\/javascript/);

    // POST /public/js/app.js -> 405 Method Not Allowed
    const resPost = await fetch(`${baseUrl}/public/js/app.js`, { method: 'POST' });
    assert.equal(resPost.status, 405);
    assert.equal(resPost.headers.get('allow'), 'GET, HEAD');

    // GET несуществующего файла -> 404
    const res404 = await fetch(`${baseUrl}/public/js/non-existent.js`);
    assert.equal(res404.status, 404);

    // Попытка выхода из каталога не раздаёт внутренние файлы (404/403)
    const resTraversal = await fetch(`${baseUrl}/public/%2e%2e/server.js`);
    assert.equal([403, 404].includes(resTraversal.status), true);
  });
});
