// @ts-check
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { jobs, getActiveJob, setActiveJob, safeJobForClient, jobCounters } = require('../lib/jobs.js');
const { createTestJob, createPausedTestJob, createRunningTestJob } = require('./helpers/job-factory.js');

const { server } = require('../server.js');
const { setMirrorsForTest, resetMirrorsForTest } = require('../lib/mirrors.js');
const { PORT, buildMirrorUrl } = require('../lib/config.js');

describe('Возобновление paused-задачи и обновление настроек (Resume Settings)', () => {
  let appServer;
  let appPort;
  let mockMirrorServer;
  let mockMirrorPort;
  let tempDir;
  let originalMirrors;
  const requestedBeatmapSets = [];

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

    // Мок-сервер зеркал
    mockMirrorServer = http.createServer((req, res) => {
      const match = req.url?.match(/\/d\/(\d+)/);
      if (match) {
        requestedBeatmapSets.push(Number(match[1]));
      }
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
        id: 'mock_resume_mirror',
        label: 'Mock Resume Mirror',
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
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (mockMirrorServer) {
      await new Promise((resolve) => mockMirrorServer.close(resolve));
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
    requestedBeatmapSets.length = 0;
  });

  it('POST /api/downloads возобновляет paused-задачу с обновлением method и noVideo', async () => {
    const job = createPausedTestJob({
      id: 'a000000000000001',
      collectionId: '12345',
      collectionName: 'Test Collection',
      method: 'session',
      noVideo: false,
      setIds: [9101, 9102],
      doneIds: [9101],
      autoResumeCount: 2,
      message: 'Пауза.',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads?method=mirror&noVideo=1`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://osucollector.com/collections/12345/test-collection',
        noVideo: true,
      }),
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.id, job.id);
    assert.equal(data.method, 'mirror', 'Ответ должен содержать обновлённый метод mirror');
    assert.equal(data.noVideo, true, 'Ответ должен содержать обновлённый флаг noVideo: true');

    // Проверяем, что поля обновились на самой задаче
    assert.equal(job.method, 'mirror');
    assert.equal(job.noVideo, true);
    assert.equal(job.autoResumeCount, 0);

    // Дожидаемся завершения возобновлённой задачи
    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(job.status, 'finished');
    assert.equal(job.doneIds.has(9102), true);
  });

  it('POST /api/downloads/:id/resume обновляет method и noVideo через query параметры', async () => {
    const job = createPausedTestJob({
      id: 'a000000000000002',
      collectionId: '45678',
      collectionName: 'Test Collection 2',
      method: 'session',
      noVideo: false,
      setIds: [9201],
      autoResumeCount: 1,
      message: 'Пауза.',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${job.id}/resume?method=mirror&noVideo=1`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.id, job.id);
    assert.equal(data.method, 'mirror');
    assert.equal(data.noVideo, true);
    assert.equal(job.method, 'mirror');
    assert.equal(job.noVideo, true);

    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, 'finished');
  });

  it('POST /api/downloads/:id/resume обновляет method и noVideo через JSON тело запроса', async () => {
    const job = createPausedTestJob({
      id: 'a000000000000003',
      collectionId: '78901',
      collectionName: 'Test Collection 3',
      method: 'session',
      noVideo: true,
      setIds: [9301],
      message: 'Пауза.',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${job.id}/resume`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ method: 'mirror', noVideo: false }),
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.method, 'mirror');
    assert.equal(data.noVideo, false);
    assert.equal(job.method, 'mirror');
    assert.equal(job.noVideo, false);

    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, 'finished');
  });

  it('POST /api/downloads/:id/resume возвращает 401 при переключении на session без cookie', async () => {
    const job = createPausedTestJob({
      id: 'a000000000000004',
      collectionId: '88888',
      collectionName: 'Test Auth',
      method: 'mirror',
      noVideo: false,
      setIds: [9401],
      message: 'Пауза.',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${job.id}/resume?method=session`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error.includes('cookie osu_session'), true);
    assert.equal(job.status, 'paused', 'Задача должна остаться на паузе при ошибке аутентификации');
  });

  it('POST /api/downloads/:id/resume возвращает 404 для несуществующей задачи и 409 для выполняющейся', async () => {
    // 404
    const res404 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/deadbeef12345678/resume`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    assert.equal(res404.status, 404);

    // 409
    const runningJob = createRunningTestJob({
      id: 'a000000000000005',
      setIds: [9501],
    });
    jobs.set(runningJob.id, runningJob);
    setActiveJob(runningJob);

    const res409 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${runningJob.id}/resume`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    assert.equal(res409.status, 409);
  });
});
