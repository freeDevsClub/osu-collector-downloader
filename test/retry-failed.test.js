"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  getFailedSetIds,
  retryFailedJob,
  safeJobForClient,
  jobCounters,
  jobs,
  getActiveJob,
  setActiveJob,
} = require('../lib/jobs.js');
const {
  server,
  MIRRORS,
  buildMirrorUrl,
} = require('../server.js');
const { PORT } = require('../lib/config.js');

describe('Повтор загрузки наборов с ошибками (Retry Failed Only)', () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-failed-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

    // Мок-сервер зеркала
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
    await new Promise(r => mockMirrorServer.listen(0, '127.0.0.1', r));
    mockMirrorPort = /** @type {import('node:net').AddressInfo} */ (mockMirrorServer.address()).port;

    originalMirrors = [...MIRRORS];
    MIRRORS.length = 0;
    MIRRORS.push({
      id: 'mock_retry_mirror',
      label: 'Mock Retry Mirror',
      build: (id, opts) => buildMirrorUrl(`http://127.0.0.1:${mockMirrorPort}/d/{id}`, id, opts),
    });

    appServer = server.listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    if (appServer) {
      await new Promise(resolve => appServer.close(resolve));
    }
    if (mockMirrorServer) {
      await new Promise(resolve => mockMirrorServer.close(resolve));
    }
    if (originalMirrors) {
      MIRRORS.length = 0;
      MIRRORS.push(...originalMirrors);
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
    requestedBeatmapSets.length = 0;
  });

  it('getFailedSetIds корректно извлекает только ошибочные ID наборов без повторов и исключений', () => {
    const job = {
      setIds: [101, 102, 103, 104, 105],
      doneIds: new Set([101]),
      skipIds: new Set([102]),
      errIds: new Set([101, 103, 104]),
      errorsById: new Map(/** @type {[string | number, any][]} */ ([
        [103, { id: 103, error: 'Network timeout' }],
        [105, { id: 105, error: 'HTTP 500' }],
        ['fatal', { id: 'fatal', error: 'Process crashed' }],
      ])),
    };

    const failedIds = getFailedSetIds(job);
    // 101 уже в doneIds -> исключается
    // 102 в skipIds -> исключается
    // 103 в errIds и errorsById -> 1 раз
    // 104 в errIds -> включается
    // 105 в errorsById -> включается
    // 'fatal' -> не число, исключается
    assert.deepEqual(failedIds.sort((a, b) => a - b), [103, 104, 105]);
    assert.deepEqual(getFailedSetIds(null), []);
    assert.deepEqual(getFailedSetIds({}), []);
  });

  it('retryFailedJob валидирует состояние и выбрасывает исключения при некорректных данных', () => {
    // 1. Нет ошибок
    const healthyJob = {
      id: 'job_healthy',
      status: 'finished',
      setIds: [201],
      doneIds: new Set([201]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
    };
    assert.throws(() => retryFailedJob(healthyJob, { kind: 'mirror' }), {
      message: /нет ошибок для повторной загрузки/,
    });

    // 2. Задача уже выполняется
    const runningJob = {
      id: 'job_running',
      status: 'running',
      setIds: [202],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set([202]),
      errorsById: new Map([[202, { id: 202, error: 'fail' }]]),
    };
    assert.throws(() => retryFailedJob(runningJob, { kind: 'mirror' }), {
      message: /Задача уже выполняется/,
    });

    // 3. Другая активная задача уже заняла воркер
    const activeOtherJob = {
      id: 'job_active_other',
      status: 'running',
      setIds: [203],
    };
    setActiveJob(activeOtherJob);
    const stoppedJob = {
      id: 'job_stopped',
      status: 'finished_with_errors',
      setIds: [204],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set([204]),
      errorsById: new Map([[204, { id: 204, error: 'fail' }]]),
    };
    assert.throws(() => retryFailedJob(stoppedJob, { kind: 'mirror' }), {
      message: /Уже идёт другая загрузка/,
    });
  });

  it('safeJobForClient рассчитывает canRetryFailed на основе статуса и ошибок', () => {
    const jobWithErrors = {
      id: 'job_client_test',
      status: 'finished_with_errors',
      setIds: [301, 302],
      doneIds: new Set([301]),
      skipIds: new Set(),
      errIds: new Set([302]),
      errorsById: new Map([[302, { id: 302, name: 'Map 302', error: '404' }]]),
    };

    let clientSafe = safeJobForClient(jobWithErrors);
    assert.equal(clientSafe.canRetryFailed, true);
    assert.equal(clientSafe.failed, 1);

    // Во время повторного выполнения canRetryFailed должен быть false
    jobWithErrors.status = 'running';
    clientSafe = safeJobForClient(jobWithErrors);
    assert.equal(clientSafe.canRetryFailed, false);

    // После успешного завершения всех карт canRetryFailed должен быть false
    jobWithErrors.status = 'finished';
    jobWithErrors.doneIds.add(302);
    jobWithErrors.errIds.delete(302);
    jobWithErrors.errorsById.delete(302);
    clientSafe = safeJobForClient(jobWithErrors);
    assert.equal(clientSafe.canRetryFailed, false);
    assert.equal(clientSafe.failed, 0);
  });

  it('retryFailedJob скачивает исключительно ошибочные наборы и обновляет статус до finished', async () => {
    const job = {
      id: 'job_retry_success',
      method: 'mirror',
      noVideo: false,
      setIds: [401, 402, 403],
      doneIds: new Set([401, 403]),
      skipIds: new Set(),
      errIds: new Set([402]),
      errorsById: new Map([[402, { id: 402, name: 'Map 402', error: 'Timeout' }]]),
      status: 'finished_with_errors',
      message: 'Загрузка завершена с ошибками.',
    };
    jobs.set(job.id, job);

    retryFailedJob(job, { kind: 'mirror' });

    // Ждём завершения задачи
    while (['queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    assert.equal(job.status, 'finished');
    assert.deepEqual(requestedBeatmapSets, [402], 'Только набор 402 должен был быть запрошен с зеркала');
    assert.equal(job.doneIds.has(402), true);
    assert.equal(job.errIds.has(402), false);
    assert.equal(job.errorsById.has(402), false);

    const counters = jobCounters(job);
    assert.equal(counters.downloaded, 3);
    assert.equal(counters.failed, 0);
    assert.equal(counters.completed, 3);
  });

  it('при отмене повторной загрузки незавершённые ошибочные наборы сохраняются в errIds для следующей попытки', async () => {
    const job = {
      id: 'a000000000000001',
      method: 'mirror',
      noVideo: false,
      setIds: [501, 502],
      doneIds: new Set([501]),
      skipIds: new Set(),
      errIds: new Set([502]),
      errorsById: new Map([[502, { id: 502, name: 'Map 502', error: 'Initial fail' }]]),
      status: 'finished_with_errors',
    };
    jobs.set(job.id, job);

    retryFailedJob(job, { kind: 'mirror' });

    // Имитируем отмену пользователем
    job.status = 'cancelled';
    job.abortController?.abort();

    while (job.retryOnlyIds) {
      await new Promise(r => setTimeout(r, 10));
    }

    // Набор 502 не был завершён, значит должен остаться в errIds
    const failedIds = getFailedSetIds(job);
    assert.equal(failedIds.includes(502), true);
    const clientSafe = safeJobForClient(job);
    assert.equal(clientSafe.canRetryFailed, true);
  });

  it('HTTP API POST /api/downloads/:id/retry-failed валидирует запросы и перезапускает загрузку', async () => {
    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };

    // 1. 404 для несуществующей задачи
    const res404 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/deadbeef12345678/retry-failed`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res404.status, 404);

    // 2. 400 для задачи без ошибок
    const jobNoErrors = {
      id: 'a000000000000002',
      method: 'mirror',
      status: 'finished',
      setIds: [601],
      doneIds: new Set([601]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
    };
    jobs.set(jobNoErrors.id, jobNoErrors);

    const res400 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobNoErrors.id}/retry-failed`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res400.status, 400);

    // 3. 409 для задачи, которая уже выполняется
    const jobRunning = {
      id: 'a000000000000003',
      method: 'mirror',
      status: 'running',
      setIds: [602],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set([602]),
      errorsById: new Map([[602, { id: 602, error: 'fail' }]]),
    };
    jobs.set(jobRunning.id, jobRunning);

    const res409 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobRunning.id}/retry-failed`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res409.status, 409);

    // 4. 202 для корректного запроса с переключением параметров method и noVideo
    const jobWithFail = {
      id: 'a000000000000004',
      method: 'mirror',
      noVideo: false,
      status: 'finished_with_errors',
      message: 'Были ошибки.',
      setIds: [603, 604],
      doneIds: new Set([603]),
      skipIds: new Set(),
      errIds: new Set([604]),
      errorsById: new Map([[604, { id: 604, name: 'Failed Map 604', error: '404 Missing' }]]),
    };
    jobs.set(jobWithFail.id, jobWithFail);

    const res202 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobWithFail.id}/retry-failed?method=mirror&noVideo=1`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ noVideo: true }),
    });
    assert.equal(res202.status, 202);
    const data202 = await res202.json();
    assert.equal(data202.id, jobWithFail.id);
    assert.equal(data202.noVideo, true, 'Параметр noVideo должен был примениться к задаче');
    assert.equal(jobWithFail.noVideo, true);

    // Дожидаемся завершения перезапущенной задачи
    while (['queued', 'running'].includes(jobWithFail.status)) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(jobWithFail.status, 'finished');
    assert.equal(jobWithFail.doneIds.has(604), true);
  });
});
