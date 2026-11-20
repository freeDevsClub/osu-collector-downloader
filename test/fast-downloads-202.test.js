"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  jobs,
  getActiveJob,
  setActiveJob,
} = require('../lib/jobs.js');
const {
  collectionCache,
} = require('../lib/collector.js');
const {
  server,
  MIRRORS,
} = require('../server.js');

describe('Мгновенный ответ POST /api/downloads со статусом preparing и фоновая подготовка', () => {
  let appServer;
  let appPort;
  let tempDir;
  let originalFetch;
  let mirrorServer;
  let mirrorPort;

  const validZipBuffer = Buffer.from([
    0x50, 0x4b, 0x03, 0x04,
    0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x21, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x04, 0x00, 0x00, 0x00,
    0x74, 0x65, 0x73, 0x74,
    0x50, 0x4b, 0x01, 0x02,
    0x14, 0x03, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x21, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x74, 0x65, 0x73, 0x74,
    0x50, 0x4b, 0x05, 0x06,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x32, 0x00, 0x00, 0x00,
    0x1e, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-dl-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

    // Мок зеркала
    mirrorServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validZipBuffer.length),
      });
      res.end(validZipBuffer);
    });
    mirrorServer.listen(0, '127.0.0.1');
    await new Promise(r => mirrorServer.once('listening', r));
    const mirrorAddr = /** @type {import('node:net').AddressInfo} */ (mirrorServer.address());
    mirrorPort = mirrorAddr.port;

    MIRRORS.length = 0;
    MIRRORS.push({
      id: 'mock_mirror',
      label: 'Mock Mirror',
      build: id => `http://127.0.0.1:${mirrorPort}/d/${id}`,
    });

    appServer = server.listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    const appAddr = /** @type {import('node:net').AddressInfo} */ (appServer.address());
    appPort = appAddr.port;

    originalFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (appServer) {
      await new Promise(resolve => appServer.close(resolve));
    }
    if (mirrorServer) {
      await new Promise(resolve => mirrorServer.close(resolve));
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
    collectionCache.clear();
  });

  it('POST /api/downloads мгновенно возвращает 202 со статусом preparing, а сбор коллекции и скачивание происходят в фоне', async () => {
    let fetchStarted = false;
    let fetchCompleted = false;

    // Мокаем osu!Collector API с искусственной задержкой
    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/collections/55001')) {
        fetchStarted = true;
        await new Promise(r => setTimeout(r, 200));
        fetchCompleted = true;
        return new Response(
          JSON.stringify({
            id: 55001,
            name: 'Slow Collection',
            beatmapCount: 1,
            beatmapsets: [{ id: 5501, title: 'Test Map', artist: 'Artist' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    const startTime = Date.now();
    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${appPort}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://osucollector.com/collections/55001' }),
    });

    const responseDuration = Date.now() - startTime;
    assert.equal(res.status, 202);
    const data = await res.json();

    // Запрос должен ответить мгновенно, не блокируясь на ожидание 200мс загрузки коллекции
    assert.equal(fetchCompleted, false, 'Ответ 202 должен вернуться ДО завершения загрузки коллекции');
    assert.ok(responseDuration < 150, `Ответ должен вернуться быстрее задержки osu!Collector (200мс), занял: ${responseDuration}мс`);
    assert.equal(data.status, 'preparing');
    assert.ok(data.id);

    const job = jobs.get(data.id);
    assert.ok(job);
    assert.equal(getActiveJob(), job);

    // Дожидаемся, пока фоновая подготовка загрузит коллекцию и завершит задачу
    while (['preparing', 'queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(fetchCompleted, true, 'Коллекция должна была быть успешно загружена в фоне');
    assert.equal(job.status, 'finished');
    assert.equal(job.doneIds.has(5501), true);
  });

  it('при сетевой ошибке 404 в osu!Collector задача в фоне корректно переходит в finished_with_errors', async () => {
    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/collections/55404')) {
        return new Response('Not found', { status: 404 });
      }
      return originalFetch(input, init);
    };

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${appPort}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://osucollector.com/collections/55404' }),
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, 'preparing');

    const job = jobs.get(data.id);
    assert.ok(job);

    while (['preparing', 'queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(job.status, 'finished_with_errors');
    assert.match(job.message, /osu!Collector ответил HTTP 404/);
    assert.equal(job.extraFailures, 1);
    assert.equal(getActiveJob(), null, 'activeJob должен быть сброшен после сбоя подготовки');
  });

  it('при пустой коллекции задача в фоне переходит в finished_with_errors с сообщением об отсутствии наборов', async () => {
    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/collections/55000')) {
        return new Response(
          JSON.stringify({
            id: 55000,
            name: 'Empty Collection',
            beatmapCount: 0,
            beatmapsets: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${appPort}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://osucollector.com/collections/55000' }),
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, 'preparing');

    const job = jobs.get(data.id);
    assert.ok(job);

    while (['preparing', 'queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(job.status, 'finished_with_errors');
    assert.match(job.message, /В коллекции нет доступных наборов/);
    assert.equal(getActiveJob(), null);
  });

  it('отмена задачи в статусе preparing мгновенно прерывает подготовку', async () => {
    // Имитируем очень медленный ответ osu!Collector
    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/collections/55999')) {
        // Ожидание 500мс
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Aborted'));
            });
          }
        });
        return new Response(JSON.stringify({ id: 55999, beatmapsets: [{ id: 5599 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${appPort}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://osucollector.com/collections/55999' }),
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, 'preparing');

    const job = jobs.get(data.id);
    assert.equal(job.status, 'preparing');

    // Отправляем отмену
    const cancelRes = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${job.id}/cancel`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${appPort}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    assert.equal(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.equal(cancelData.status, 'cancelled');
    assert.equal(job.status, 'cancelled');
    assert.equal(getActiveJob(), null);
  });
});
