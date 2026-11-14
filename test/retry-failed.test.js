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
  resumeJob,
  safeJobForClient,
  jobCounters,
  jobs,
  getActiveJob,
  setActiveJob,
} = require('../lib/jobs.js');
const {
  server,
  MIRRORS,
  mirrorCooldowns,
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
  const mockStatusBySetId = new Map();

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
      const setId = match ? Number(match[1]) : null;
      if (setId) {
        requestedBeatmapSets.push(setId);
        if (mockStatusBySetId.has(setId)) {
          const status = mockStatusBySetId.get(setId);
          res.writeHead(status, {
            'Content-Type': 'text/plain',
            'Retry-After': '60',
          });
          res.end(`Mock error ${status}`);
          return;
        }
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
    mockStatusBySetId.clear();
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

  it('при приостановке повторной загрузки (paused) незавершённые карты не помечаются ошибками и сохраняются в retryOnlyIds', async () => {
    // 1. Создаём задачу с двумя ошибками: 701 и 702
    const job = {
      id: 'a000000000000009',
      method: 'mirror',
      noVideo: false,
      setIds: [700, 701, 702],
      doneIds: new Set([700]),
      skipIds: new Set(),
      errIds: new Set([701, 702]),
      errorsById: new Map([
        [701, { id: 701, name: 'Map 701', error: 'Initial 500' }],
        [702, { id: 702, name: 'Map 702', error: 'Initial 500' }],
      ]),
      status: 'finished_with_errors',
      message: 'Были ошибки.',
    };
    jobs.set(job.id, job);

    // Настраиваем мок-сервер: набор 701 скачивается успешно, а набор 702 отдаёт 429
    mockStatusBySetId.set(702, 429);

    retryFailedJob(job, { kind: 'mirror' });

    // Ждём, пока задача перейдёт в paused
    while (['queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    // Проверяем статус и счётчики
    assert.equal(job.status, 'paused', 'Задача должна быть в статусе paused из-за остывания зеркал');
    assert.equal(job.doneIds.has(701), true, 'Набор 701 должен быть успешно скачан');
    assert.equal(job.doneIds.has(702), false, 'Набор 702 не должен быть скачан');

    // Ключевая проверка Issue 8:
    assert.equal(job.errIds.has(702), false, 'Набор 702 НЕ должен быть помечен как ошибка в errIds при паузе');
    assert.equal(job.errorsById?.has(702), false, 'Для набора 702 не должно быть ложного сообщения об ошибке');
    assert.notEqual(job.retryOnlyIds, undefined, 'retryOnlyIds должен быть сохранён на объекте задачи');
    assert.equal(job.retryOnlyIds.has(702), true, 'Набор 702 должен оставаться в retryOnlyIds для продолжения');

    const counters = jobCounters(job);
    assert.equal(counters.deferred, 1, 'Набор 702 должен учитываться как deferred');
    assert.equal(counters.failed, 0, 'Количество ошибок должно быть 0 (все отложенные наборы ждут возобновления)');

    // 2. Зеркало остывает: убираем 429 и очищаем остывание
    mockStatusBySetId.delete(702);
    MIRRORS.forEach(m => mirrorCooldowns.delete(m.id));

    // Нажимаем «Продолжить» (resumeJob)
    resumeJob(job, { kind: 'mirror' }, 'manual');

    // Ждём завершения докачки
    while (['queued', 'running'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    assert.equal(job.status, 'finished', 'После возобновления задача должна завершиться успехом');
    assert.equal(job.doneIds.has(702), true, 'Набор 702 должен быть успешно скачан после возобновления');
    assert.equal(job.retryOnlyIds, undefined, 'После полного завершения retryOnlyIds должен быть очищен');
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

  it('jobCounters и getFailedSetIds устойчивы к fatal ошибке даже если extraFailures не был предварительно сохранён', () => {
    const jobWithoutExtraField = {
      setIds: [901, 902],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      extraFailures: 0,
      errorsById: new Map([
        ['fatal', { id: 'fatal', name: 'Системный сбой', error: 'Unexpected exception' }],
      ]),
    };
    const counters = jobCounters(jobWithoutExtraField);
    assert.equal(counters.failed, 1, 'jobCounters должен учесть fatal ошибку из errorsById');
    const failedIds = getFailedSetIds(jobWithoutExtraField);
    assert.deepEqual(failedIds.sort((a, b) => a - b), [901, 902]);
  });

  it('корректно обрабатывает критический сбой задачи (fatal): учитывает extraFailures, отображает canRetryFailed и успешно перезапускает незавершённые наборы', async () => {
    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };
    const jobFatal = {
      id: 'a000000000000005',
      method: 'mirror',
      noVideo: false,
      status: 'finished_with_errors',
      message: 'Критический сбой задачи: Network disconnected',
      setIds: [801, 802, 803],
      doneIds: new Set([801]),
      skipIds: new Set(),
      errIds: new Set(),
      extraFailures: 1,
      errorsById: new Map([
        ['fatal', { id: 'fatal', name: 'Системный сбой', error: 'Network disconnected' }],
      ]),
      mapsById: new Map([
        [801, { id: 801, label: 'Map 801' }],
        [802, { id: 802, label: 'Map 802' }],
        [803, { id: 803, label: 'Map 803' }],
      ]),
    };
    jobs.set(jobFatal.id, jobFatal);

    // 1. Проверяем счётчики и состояние safeJobForClient
    const counters = jobCounters(jobFatal);
    assert.equal(counters.failed, 1, 'fatal error должен учитываться в failed');
    assert.equal(counters.downloaded, 1);
    assert.equal(counters.deferred, 1);

    const clientSafe = safeJobForClient(jobFatal);
    assert.equal(clientSafe.failed, 1);
    assert.equal(clientSafe.canRetryFailed, true, 'canRetryFailed должен быть true при наличии fatal error');
    assert.equal(clientSafe.errors.length, 1);
    assert.equal(clientSafe.errors[0].id, 'fatal');
    assert.equal(clientSafe.errors[0].name, 'Системный сбой');

    // 2. Проверяем getFailedSetIds
    const failedIds = getFailedSetIds(jobFatal);
    assert.deepEqual(failedIds.sort((a, b) => a - b), [802, 803], 'Должны вернуться все незавершённые наборы (802, 803), а 801 исключён');

    // 3. Вызываем POST /api/downloads/:id/retry-failed через HTTP API
    const res = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobFatal.id}/retry-failed?method=mirror`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, 'queued');

    // 4. Проверяем сброс extraFailures и очистку fatal ошибки
    assert.equal(jobFatal.extraFailures, 0);
    assert.equal(jobFatal.errorsById.has('fatal'), false, 'fatal ошибка должна быть удалена из errorsById');

    // Дожидаемся завершения докачки
    while (['queued', 'running'].includes(jobFatal.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    assert.equal(jobFatal.status, 'finished');
    assert.equal(jobFatal.doneIds.has(802), true);
    assert.equal(jobFatal.doneIds.has(803), true);
    assert.equal(jobCounters(jobFatal).failed, 0);
  });
});
