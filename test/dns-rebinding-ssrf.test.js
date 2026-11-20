// @ts-check
"use strict";

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  isPrivateIp,
  mirrorRedirectAllowed,
  createPinnedLookup,
} = require('../lib/security.js');
const {
  safeDownloadFetch,
  downloadSet,
} = require('../lib/downloader.js');
const { buildMirrorUrl } = require('../lib/config.js');

describe('Защита от DNS Rebinding и SSRF в mirrorRedirectAllowed и загрузчике карт', () => {
  test('mirrorRedirectAllowed отклоняет небезопасный HTTP-протокол', async () => {
    const isAllowed = await mirrorRedirectAllowed(new URL('http://cdn.example.com/beatmap.osz'));
    assert.equal(isAllowed, false);
  });

  test('mirrorRedirectAllowed отклоняет нестандартные порты (не 443)', async () => {
    const isAllowed = await mirrorRedirectAllowed(new URL('https://cdn.example.com:8443/beatmap.osz'));
    assert.equal(isAllowed, false);
  });

  test('mirrorRedirectAllowed отклоняет прямые IP-адреса хостов (обязан быть CDN-домен)', async () => {
    assert.equal(await mirrorRedirectAllowed(new URL('https://1.1.1.1/beatmap.osz')), false);
    assert.equal(await mirrorRedirectAllowed(new URL('https://127.0.0.1/beatmap.osz')), false);
    assert.equal(await mirrorRedirectAllowed(new URL('https://192.168.1.1/beatmap.osz')), false);
  });

  test('mirrorRedirectAllowed отклоняет зарезервированные и локальные доменные зоны (.localhost, .local, .internal)', async () => {
    assert.equal(await mirrorRedirectAllowed(new URL('https://localhost/beatmap.osz')), false);
    assert.equal(await mirrorRedirectAllowed(new URL('https://service.localhost/beatmap.osz')), false);
    assert.equal(await mirrorRedirectAllowed(new URL('https://router.local/beatmap.osz')), false);
    assert.equal(await mirrorRedirectAllowed(new URL('https://metadata.internal/beatmap.osz')), false);
  });

  test('mirrorRedirectAllowed успешно валидирует публичный HTTPS домен и сохраняет проверенные адреса в outPinned', async () => {
    /** @type {{ addresses?: import('node:dns').LookupAddress[] }} */
    const outPinned = {};
    const isAllowed = await mirrorRedirectAllowed(new URL('https://example.com/beatmap.osz'), outPinned);
    assert.equal(isAllowed, true);
    assert.ok(Array.isArray(outPinned.addresses), 'outPinned должен содержать массив адресов');
    assert.ok(outPinned.addresses.length > 0, 'Массив адресов не должен быть пустым');
    assert.equal(typeof outPinned.addresses[0].address, 'string');
    assert.equal(typeof outPinned.addresses[0].family, 'number');
    for (const entry of outPinned.addresses) {
      assert.equal(isPrivateIp(entry.address), false, 'Все закреплённые адреса обязаны быть публичными');
    }
  });

  test('createPinnedLookup возвращает закреплённые IP-адреса и поддерживает single и all запросы', () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const lookup = createPinnedLookup(addresses);

    // Запрос с all: true
    lookup('malicious-rebinding.com', { all: true }, (err, result) => {
      assert.ifError(err);
      assert.deepEqual(result, addresses);
    });

    // Одиночный запрос с запросом IPv4
    lookup('malicious-rebinding.com', { family: 4 }, (err, address, family) => {
      assert.ifError(err);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
    });

    // Одиночный запрос с запросом IPv6
    lookup('malicious-rebinding.com', { family: 6 }, (err, address, family) => {
      assert.ifError(err);
      assert.equal(address, '2606:2800:220:1:248:1893:25c8:1946');
      assert.equal(family, 6);
    });
  });

  test('createPinnedLookup блокирует приватные IP-адреса (defense-in-depth)', () => {
    const badAddresses = [
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    const lookup = createPinnedLookup(badAddresses);

    lookup('attacker.com', {}, (err) => {
      assert.ok(err, 'Должна быть возвращена ошибка SSRF');
      assert.match(err.message, /SSRF/);
    });
  });

  describe('Интеграция downloadSet с редиректами и защитой от SSRF', () => {
    /** @type {http.Server} */
    let server;
    /** @type {number} */
    let serverPort;

    before(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/redirect-to-private') {
          // Имитируем попытку зеркала перенаправить на приватный адрес
          res.writeHead(302, { Location: 'http://127.0.0.1:8080/internal' });
          res.end();
          return;
        }
        if (req.url === '/redirect-empty') {
          res.writeHead(302);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') {
            serverPort = address.port;
          }
          resolve(null);
        });
      });
    });

    after(async () => {
      await new Promise(resolve => server.close(resolve));
    });

    test('downloadSet блокирует небезопасный редирект зеркала на приватный хост', async () => {
      const mirror = {
        id: 'mock_ssrf_mirror',
        label: 'Mock SSRF Mirror',
        build: () => `http://127.0.0.1:${serverPort}/redirect-to-private`,
      };
      const mockJob = {
        id: 'job_ssrf_test',
        doneIds: new Set(),
        skipIds: new Set(),
        errIds: new Set(),
        errorsById: new Map(),
      };

      await assert.rejects(
        async () => {
          await downloadSet(99999, { kind: 'mirror', mirror }, mockJob);
        },
        /Зеркало перенаправило на небезопасный URL/
      );
    });

    test('downloadSet отклоняет редирект с пустым заголовком Location', async () => {
      const mirror = {
        id: 'mock_empty_redirect_mirror',
        label: 'Mock Empty Redirect Mirror',
        build: () => `http://127.0.0.1:${serverPort}/redirect-empty`,
      };
      const mockJob = {
        id: 'job_empty_redirect_test',
        doneIds: new Set(),
        skipIds: new Set(),
        errIds: new Set(),
        errorsById: new Map(),
      };

      await assert.rejects(
        async () => {
          await downloadSet(99998, { kind: 'mirror', mirror }, mockJob);
        },
        /Сервер загрузки вернул пустое перенаправление/
      );
    });
  });
});
