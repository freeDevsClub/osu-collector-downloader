'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { jobs, jobEvents, emitJobUpdate, getActiveJob, setActiveJob, safeJobForClient } = require('../lib/jobs.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { server } = require('../server.js');
const { setMirrorsForTest, resetMirrorsForTest } = require('../lib/mirrors.js');
const { PORT, buildMirrorUrl } = require('../lib/config.js');

describe('Стриминг событий через Server-Sent Events (SSE)', () => {
  let appServer;
  let appPort;
  let mockMirrorServer;
  let mockMirrorPort;
  let tempDir;
  let originalMirrors;

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sse-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

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
        id: 'mock_sse_mirror',
        label: 'Mock SSE Mirror',
        build: (id, opts) => buildMirrorUrl(`http://127.0.0.1:${mockMirrorPort}/d/{id}`, id, opts),
      },
    ]);

    appServer = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    resetMirrorsForTest();
    if (appServer) {
      if (typeof appServer.closeAllConnections === 'function') {
        appServer.closeAllConnections();
      }
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (mockMirrorServer) {
      if (typeof mockMirrorServer.closeAllConnections === 'function') {
        mockMirrorServer.closeAllConnections();
      }
      await new Promise((resolve) => mockMirrorServer.close(resolve));
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
  });

  it('отдаёт корректные HTTP-заголовки text/event-stream и первоначальный снимок задачи', async () => {
    const job = createTestJob({
      id: 'c000000000000001',
      setIds: [1001, 1002],
      doneIds: [1001],
      status: 'running',
      message: 'Загрузка beatmap-наборов…',
    });
    jobs.set(job.id, job);

    const res = await new Promise((resolve) => {
      http.get(
        `http://127.0.0.1:${appPort}/api/downloads/${job.id}/events`,
        {
          headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
        },
        resolve,
      );
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['connection'], 'keep-alive');

    const firstChunk = await new Promise((resolve) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        if (buf.includes('data:')) resolve(buf);
      });
    });

    assert.match(firstChunk, /retry:\s*1500/);
    assert.match(firstChunk, /data:\s*\{/);

    const dataMatch = firstChunk.match(/^data:\s*(.+)$/m);
    assert.ok(dataMatch, 'Должна присутствовать строка data: с JSON-объектом');
    const snapshot = JSON.parse(dataMatch[1]);
    assert.equal(snapshot.id, job.id);
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.downloaded, 1);
    assert.equal(snapshot.total, 2);

    res.socket?.destroy();
    res.destroy();
  });

  it('стримит события в реальном времени при обновлении состояния задачи', async () => {
    const job = createTestJob({
      id: 'c000000000000002',
      setIds: [2001, 2002],
      status: 'queued',
      message: 'В очереди.',
    });
    jobs.set(job.id, job);

    /** @type {any[]} */
    const receivedEvents = [];
    /** @type {(value?: any) => void} */
    let resolveThirdEvent = () => {};
    const thirdEventPromise = new Promise((resolve) => {
      resolveThirdEvent = resolve;
    });

    let buffer = '';
    const req = http.get(
      `http://127.0.0.1:${appPort}/api/downloads/${job.id}/events`,
      {
        headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
      },
      (res) => {
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const match = block.match(/^data:\s*(.+)$/m);
            if (match) {
              try {
                const data = JSON.parse(match[1]);
                receivedEvents.push(data);
                if (receivedEvents.length >= 3) {
                  resolveThirdEvent();
                }
              } catch {}
            }
          }
        });
      },
    );

    // Даём первому событию (initial snapshot) дойти
    await new Promise((r) => setTimeout(r, 50));

    // Генерируем 2 обновления задачи
    job.status = 'running';
    job.message = 'Скачивание...';
    emitJobUpdate(job, true);

    job.doneIds.add(2001);
    emitJobUpdate(job, true);

    await thirdEventPromise;

    req.destroy();

    assert.ok(receivedEvents.length >= 3, `Ожидалось не менее 3 событий, получено: ${receivedEvents.length}`);
    assert.equal(receivedEvents[0].status, 'queued');
    assert.equal(receivedEvents[1].status, 'running');
    assert.equal(receivedEvents[2].downloaded, 1);
  });

  it('возвращает 404 при запросе событий несуществующей задачи и 400 без ID', async () => {
    const res404 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/deadbeef12345678/events`, {
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    assert.equal(res404.status, 404);

    const res400 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/events`, {
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    assert.equal(res400.status, 400);
  });

  it('поддерживает URL /api/downloads/events?id=... как алиас', async () => {
    const job = createTestJob({
      id: 'c000000000000003',
      setIds: [3001],
      status: 'queued',
      message: 'В очереди.',
    });
    jobs.set(job.id, job);

    const res = await new Promise((resolve) => {
      http.get(
        `http://127.0.0.1:${appPort}/api/downloads/events?id=${job.id}`,
        {
          headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
        },
        resolve,
      );
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    res.socket?.destroy();
    res.destroy();
  });

  it('корректно отписывает слушателей при разрыве клиентского соединения', async () => {
    const job = createTestJob({
      id: 'c000000000000004',
      setIds: [4001],
      status: 'running',
    });
    jobs.set(job.id, job);

    const initialListeners = jobEvents.listenerCount(`job:${job.id}`);
    assert.equal(initialListeners, 0);

    const req = http.get(`http://127.0.0.1:${appPort}/api/downloads/${job.id}/events`, {
      headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
    });

    // Ждём регистрации подписчика на сервере
    while (jobEvents.listenerCount(`job:${job.id}`) === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(jobEvents.listenerCount(`job:${job.id}`), 1);

    // Разрываем соединение
    req.destroy();

    // Ждём срабатывания req.on('close') на сервере
    while (jobEvents.listenerCount(`job:${job.id}`) > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(jobEvents.listenerCount(`job:${job.id}`), 0);
  });

  it('полный сквозной цикл скачивания набора через SSE-стрим до статуса finished', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/collections/88001')) {
        return new Response(
          JSON.stringify({
            id: 88001,
            name: 'SSE Test Collection',
            beatmapCount: 1,
            beatmapsets: [{ id: 8801 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const postRes = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://osucollector.com/collections/88001' }),
      });
      assert.equal(postRes.status, 202);
      const postData = await postRes.json();
      const jobId = postData.id;
      assert.ok(jobId);

      /** @type {any[]} */
      const sseUpdates = [];
      /** @type {(value?: any) => void} */
      let resolveFinished = () => {};
      const finishedPromise = new Promise((resolve) => {
        resolveFinished = resolve;
      });

      let buf = '';
      const req = http.get(
        `http://127.0.0.1:${appPort}/api/downloads/${jobId}/events`,
        {
          headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
        },
        (res) => {
          res.on('data', (chunk) => {
            buf += chunk.toString('utf-8');
            const blocks = buf.split('\n\n');
            buf = blocks.pop() || '';
            for (const block of blocks) {
              const match = block.match(/^data:\s*(.+)$/m);
              if (match) {
                try {
                  const data = JSON.parse(match[1]);
                  sseUpdates.push(data);
                  if (data.status === 'finished') {
                    resolveFinished();
                  }
                } catch {}
              }
            }
          });
        },
      );

      await finishedPromise;
      req.destroy();

      assert.ok(sseUpdates.length >= 2, 'Должно быть получено как минимум 2 события (старт и финиш)');
      const last = sseUpdates[sseUpdates.length - 1];
      assert.equal(last.status, 'finished');
      assert.equal(last.downloaded, 1);
      assert.equal(last.total, 1);
      assert.equal(last.failed, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('safeJobForClient исключает массивы errors и mirrors при options.byteTick: true', () => {
    const job = createTestJob({
      id: 'c000000000000005',
      setIds: [1001, 1002],
      doneIds: [1001],
      errIds: [1002],
      errorsById: [[1002, { id: 1002, name: 'Beatmap 1002', error: 'Mirror 500 error' }]],
      status: 'running',
    });

    const full = safeJobForClient(job);
    assert.ok(Array.isArray(full.errors), 'Полный снимок должен содержать errors');
    assert.equal(full.errors.length, 1);
    assert.ok(Array.isArray(full.mirrors), 'Полный снимок должен содержать mirrors');
    assert.ok(full.mirrors.length > 0);

    const byteTickSnapshot = safeJobForClient(job, { byteTick: true });
    assert.equal(byteTickSnapshot.errors, undefined, 'Снимок при byteTick: true не должен содержать errors');
    assert.equal(byteTickSnapshot.mirrors, undefined, 'Снимок при byteTick: true не должен содержать mirrors');
    assert.equal(byteTickSnapshot.id, job.id);
    assert.equal(byteTickSnapshot.downloaded, 1);
  });

  it('SSE-стрим передаёт легковесный снимок без errors и mirrors при промежуточном тике байтов', async () => {
    const job = createTestJob({
      id: 'c000000000000006',
      setIds: [2001, 2002],
      errIds: [2001],
      errorsById: [[2001, { id: 2001, name: 'Beatmap 2001', error: 'Fail' }]],
      status: 'running',
      currentSetId: 2002,
      currentBytes: 1024,
      currentTotalBytes: 4096,
      currentPercent: 25,
    });
    jobs.set(job.id, job);

    /** @type {any[]} */
    const sseUpdates = [];
    const res = await new Promise((resolve) => {
      http.get(
        `http://127.0.0.1:${appPort}/api/downloads/${job.id}/events`,
        {
          headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream' },
        },
        resolve,
      );
    });

    let buf = '';
    const updateReceived = new Promise((resolve) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const block of blocks) {
          const match = block.match(/^data:\s*(.+)$/m);
          if (match) {
            try {
              const data = JSON.parse(match[1]);
              sseUpdates.push(data);
              if (sseUpdates.length >= 2) {
                resolve(null);
              }
            } catch {}
          }
        }
      });
    });

    job.currentBytes = 2048;
    job.currentPercent = 50;
    emitJobUpdate(job, false);

    await updateReceived;
    res.socket?.destroy();
    res.destroy();

    assert.ok(sseUpdates.length >= 2);
    // Первый снимок — initial snapshot (содержит errors и mirrors)
    assert.ok(Array.isArray(sseUpdates[0].errors));
    assert.ok(Array.isArray(sseUpdates[0].mirrors));

    // Второй снимок — byteTick update (не содержит errors и mirrors)
    const byteTickUpdate = sseUpdates[1];
    assert.equal(byteTickUpdate.currentBytes, 2048);
    assert.equal(byteTickUpdate.currentPercent, 50);
    assert.equal(byteTickUpdate.errors, undefined, 'Byte tick не должен передавать массив errors');
    assert.equal(byteTickUpdate.mirrors, undefined, 'Byte tick не должен передавать массив mirrors');
  });
});
