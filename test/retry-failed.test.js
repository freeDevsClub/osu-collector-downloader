'use strict';

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
  waitForPendingSaveState,
  checkAndSkipIfAvailable,
} = require('../lib/jobs.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { server } = require('../server.js');
const { setMirrorsForTest, resetMirrorsForTest, mirrorCooldowns } = require('../lib/mirrors.js');
const { PORT, buildMirrorUrl } = require('../lib/config.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('Повтор загрузки наборов с ошибками (Retry Failed Only)', () => {
  let appServer;
  let appPort;
  let mockMirrorServer;
  let mockMirrorPort;
  let testEnv;
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
    testEnv = await setupIsolatedTestEnv('retry-failed-test-');

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
    await new Promise((r) => mockMirrorServer.listen(0, '127.0.0.1', r));
    mockMirrorPort = /** @type {import('node:net').AddressInfo} */ (mockMirrorServer.address()).port;

    setMirrorsForTest([
      {
        id: 'mock_retry_mirror',
        label: 'Mock Retry Mirror',
        build: (id, opts) => buildMirrorUrl(`http://127.0.0.1:${mockMirrorPort}/d/{id}`, id, opts),
      },
    ]);

    appServer = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    await waitForPendingSaveState();
    resetMirrorsForTest();
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (mockMirrorServer) {
      await new Promise((resolve) => mockMirrorServer.close(resolve));
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await waitForPendingSaveState();
    jobs.clear();
    setActiveJob(null);
    requestedBeatmapSets.length = 0;
    mockStatusBySetId.clear();
  });

  it('getFailedSetIds корректно извлекает только ошибочные ID наборов без повторов и исключений', () => {
    const job = createTestJob({
      setIds: [101, 102, 103, 104, 105],
      doneIds: [101],
      skipIds: [102],
      errIds: [101, 103, 104],
      errorsById: [
        [103, { id: 103, error: 'Network timeout' }],
        [105, { id: 105, error: 'HTTP 500' }],
        ['fatal', { id: 'fatal', error: 'Process crashed' }],
      ],
    });

    const failedIds = getFailedSetIds(job);
    // 101 уже в doneIds -> исключается
    // 102 в skipIds -> исключается
    // 103 в errIds и errorsById -> 1 раз
    // 104 в errIds -> включается
    // 105 в errorsById -> включается
    // 'fatal' -> не число, исключается
    assert.deepEqual(
      failedIds.sort((a, b) => a - b),
      [103, 104, 105],
    );
    assert.deepEqual(getFailedSetIds(null), []);
    assert.deepEqual(getFailedSetIds({}), []);
  });

  it('retryFailedJob валидирует состояние и выбрасывает исключения при некорректных данных', () => {
    // 1. Нет ошибок
    const healthyJob = createTestJob({
      id: 'job_healthy',
      status: 'finished',
      setIds: [201],
      doneIds: [201],
    });
    assert.throws(() => retryFailedJob(healthyJob, { kind: 'mirror' }), {
      message: /нет ошибок для повторной загрузки/,
    });

    // 2. Задача уже выполняется
    const runningJob = createTestJob({
      id: 'job_running',
      status: 'running',
      setIds: [202],
      errIds: [202],
      errorsById: [[202, { id: 202, error: 'fail' }]],
    });
    assert.throws(() => retryFailedJob(runningJob, { kind: 'mirror' }), {
      message: /Задача уже выполняется/,
    });

    // 3. Другая активная задача уже заняла воркер
    const activeOtherJob = createTestJob({
      id: 'job_active_other',
      status: 'running',
      setIds: [203],
    });
    setActiveJob(activeOtherJob);
    const stoppedJob = createTestJob({
      id: 'job_stopped',
      status: 'finished_with_errors',
      setIds: [204],
      errIds: [204],
      errorsById: [[204, { id: 204, error: 'fail' }]],
    });
    assert.throws(() => retryFailedJob(stoppedJob, { kind: 'mirror' }), {
      message: /Уже идёт другая загрузка/,
    });
  });

  it('safeJobForClient рассчитывает canRetryFailed на основе статуса и ошибок', () => {
    const jobWithErrors = createTestJob({
      id: 'job_client_test',
      status: 'finished_with_errors',
      setIds: [301, 302],
      doneIds: [301],
      errIds: [302],
      errorsById: [[302, { id: 302, name: 'Map 302', error: '404' }]],
    });

    let clientSafe = safeJobForClient(jobWithErrors);
    assert.equal(clientSafe.canRetryFailed, true);
    assert.equal(clientSafe.failed, 1);

    // Во время повторного выполнения canRetryFailed должен быть false
    jobWithErrors.status = 'queued';
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
    const job = createTestJob({
      id: 'job_retry_success',
      method: 'mirror',
      noVideo: false,
      setIds: [401, 402, 403],
      doneIds: [401, 403],
      errIds: [402],
      errorsById: [[402, { id: 402, name: 'Map 402', error: 'Timeout' }]],
      status: 'finished_with_errors',
      message: 'Загрузка завершена с ошибками.',
    });
    jobs.set(job.id, job);

    retryFailedJob(job, { kind: 'mirror' });

    // Ждём завершения задачи
    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (job._promise) await job._promise;

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
    const job = createTestJob({
      id: 'a000000000000001',
      method: 'mirror',
      noVideo: false,
      setIds: [501, 502],
      doneIds: [501],
      errIds: [502],
      errorsById: [[502, { id: 502, name: 'Map 502', error: 'Initial fail' }]],
      status: 'finished_with_errors',
    });
    jobs.set(job.id, job);

    retryFailedJob(job, { kind: 'mirror' });

    // Имитируем отмену пользователем
    job.status = 'cancelled';
    job.abortController?.abort();

    while (job.retryOnlyIds) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (job._promise) await job._promise;

    // Набор 502 не был завершён, значит должен остаться в errIds
    const failedIds = getFailedSetIds(job);
    assert.equal(failedIds.includes(502), true);
    const clientSafe = safeJobForClient(job);
    assert.equal(clientSafe.canRetryFailed, true);
  });

  it('при приостановке повторной загрузки (paused) незавершённые карты не помечаются ошибками и сохраняются в retryOnlyIds', async () => {
    // 1. Создаём задачу с двумя ошибками: 701 и 702
    const job = createTestJob({
      id: 'a000000000000009',
      method: 'mirror',
      noVideo: false,
      setIds: [700, 701, 702],
      doneIds: [700],
      errIds: [701, 702],
      errorsById: [
        [701, { id: 701, name: 'Map 701', error: 'Initial 500' }],
        [702, { id: 702, name: 'Map 702', error: 'Initial 500' }],
      ],
      status: 'finished_with_errors',
      message: 'Были ошибки.',
    });
    jobs.set(job.id, job);

    // Настраиваем мок-сервер: набор 701 скачивается успешно, а набор 702 отдаёт 429
    mockStatusBySetId.set(702, 429);

    retryFailedJob(job, { kind: 'mirror' });

    // Ждём, пока задача перейдёт в paused
    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
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
    mirrorCooldowns.clear();

    // Нажимаем «Продолжить» (resumeJob)
    resumeJob(job, { kind: 'mirror' }, 'manual');

    // Ждём завершения докачки
    while (['queued', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (job._promise) await job._promise;
    await waitForPendingSaveState();

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
    const jobNoErrors = createTestJob({
      id: 'a000000000000002',
      method: 'mirror',
      status: 'finished',
      setIds: [601],
      doneIds: [601],
    });
    jobs.set(jobNoErrors.id, jobNoErrors);

    const res400 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobNoErrors.id}/retry-failed`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res400.status, 400);

    // 3. 409 для задачи, которая уже выполняется
    const jobRunning = createTestJob({
      id: 'a000000000000003',
      method: 'mirror',
      status: 'running',
      setIds: [602],
      errIds: [602],
      errorsById: [[602, { id: 602, error: 'fail' }]],
    });
    jobs.set(jobRunning.id, jobRunning);

    const res409 = await fetch(`http://127.0.0.1:${appPort}/api/downloads/${jobRunning.id}/retry-failed`, {
      method: 'POST',
      headers: localHeaders,
    });
    assert.equal(res409.status, 409);

    // 4. 202 для корректного запроса с переключением параметров method и noVideo
    const jobWithFail = createTestJob({
      id: 'a000000000000004',
      method: 'mirror',
      noVideo: false,
      status: 'finished_with_errors',
      message: 'Были ошибки.',
      setIds: [603, 604],
      doneIds: [603],
      errIds: [604],
      errorsById: [[604, { id: 604, name: 'Failed Map 604', error: '404 Missing' }]],
    });
    jobs.set(jobWithFail.id, jobWithFail);

    const res202 = await fetch(
      `http://127.0.0.1:${appPort}/api/downloads/${jobWithFail.id}/retry-failed?method=mirror&noVideo=1`,
      {
        method: 'POST',
        headers: localHeaders,
        body: JSON.stringify({ noVideo: true }),
      },
    );
    assert.equal(res202.status, 202);
    const data202 = await res202.json();
    assert.equal(data202.id, jobWithFail.id);
    assert.equal(data202.noVideo, true, 'Параметр noVideo должен был примениться к задаче');
    assert.equal(jobWithFail.noVideo, true);

    // Дожидаемся завершения перезапущенной задачи
    while (['queued', 'running'].includes(jobWithFail.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (jobWithFail._promise) await jobWithFail._promise;
    await waitForPendingSaveState();
    assert.equal(jobWithFail.status, 'finished');
    assert.equal(jobWithFail.doneIds.has(604), true);
  });

  it('jobCounters и getFailedSetIds устойчивы к fatal ошибке даже если extraFailures не был предварительно сохранён', () => {
    const jobWithoutExtraField = createTestJob({
      setIds: [901, 902],
      errorsById: [['fatal', { id: 'fatal', name: 'Системный сбой', error: 'Unexpected exception' }]],
    });
    const counters = jobCounters(jobWithoutExtraField);
    assert.equal(counters.failed, 1, 'jobCounters должен учесть fatal ошибку из errorsById');
    const failedIds = getFailedSetIds(jobWithoutExtraField);
    assert.deepEqual(
      failedIds.sort((a, b) => a - b),
      [901, 902],
    );
  });

  it('корректно обрабатывает критический сбой задачи (fatal): учитывает extraFailures, отображает canRetryFailed и успешно перезапускает незавершённые наборы', async () => {
    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };
    const jobFatal = createTestJob({
      id: 'a000000000000005',
      method: 'mirror',
      noVideo: false,
      status: 'finished_with_errors',
      message: 'Критический сбой задачи: Network disconnected',
      setIds: [801, 802, 803],
      doneIds: [801],
      extraFailures: 1,
      errorsById: [['fatal', { id: 'fatal', name: 'Системный сбой', error: 'Network disconnected' }]],
      mapsById: [
        [801, { id: 801, label: 'Map 801' }],
        [802, { id: 802, label: 'Map 802' }],
        [803, { id: 803, label: 'Map 803' }],
      ],
    });
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
    assert.deepEqual(
      failedIds.sort((a, b) => a - b),
      [802, 803],
      'Должны вернуться все незавершённые наборы (802, 803), а 801 исключён',
    );

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
      await new Promise((r) => setTimeout(r, 20));
    }
    if (jobFatal._promise) await jobFatal._promise;
    await waitForPendingSaveState();

    assert.equal(jobFatal.status, 'finished');
    assert.equal(jobFatal.doneIds.has(802), true);
    assert.equal(jobFatal.doneIds.has(803), true);
    assert.equal(jobCounters(jobFatal).failed, 0);
  });

  it('при повторе ошибок (retryFailedJob) наборы с ошибкой пост-обработки не пропускаются через checkAndSkipIfAvailable, а повторно обрабатываются', async () => {
    const { getDownloadsDir } = require('../lib/config.js');
    const { saveSettings, resetSettingsForTest, isSetInOsuSongs } = require('../lib/osu.js');
    const downloadsDir = getDownloadsDir();

    // Создаем тестовую директорию Songs
    const tempSongsDir = path.join(testEnv.tempBaseDir, 'osu_fake_retry1', 'Songs');
    await fs.mkdir(tempSongsDir, { recursive: true });

    await saveSettings({
      osuPath: tempSongsDir,
      checkExisting: true,
      postDownloadAction: 'move',
    });

    const setId = 901;
    const oszPath = path.join(downloadsDir, `${setId}.osz`);
    await fs.writeFile(oszPath, validZipBuffer);

    // Задача, где setId был скачан, но упал на пост-обработке
    const job = createTestJob({
      id: 'job_test_retry_post_download',
      method: 'mirror',
      setIds: [setId],
      doneIds: [],
      errIds: [setId],
      postDownloadErrors: [[setId, 'Permission denied during move']],
      errorsById: [[setId, { id: setId, name: 'Map 901', error: 'Permission denied during move', isPostDownload: true }]],
      status: 'finished_with_errors',
    });
    jobs.set(job.id, job);

    // 1. Проверяем, что checkAndSkipIfAvailable не просто скипает набор, а успешно запускает handlePostDownload (move)
    const skipped = await checkAndSkipIfAvailable(setId, job);
    assert.equal(skipped, true, 'checkAndSkipIfAvailable возвращает true после успешной пост-обработки');
    assert.equal(job.doneIds.has(setId), true, 'Набор должен попасть в doneIds');
    assert.equal(job.skipIds.has(setId), false, 'Набор НЕ должен ошибочно попадать в skipIds');
    assert.equal(job.errIds.has(setId), false, 'Набор должен быть удален из errIds');
    assert.equal(job.postDownloadErrors.has(setId), false, 'Набор должен быть удален из postDownloadErrors');
    assert.equal(isSetInOsuSongs(setId), true, 'Набор должен оказаться в osu! Songs');

    // Очистка
    resetSettingsForTest();
  });

  it('при повторе ошибки пост-обработки в checkAndSkipIfAvailable карта сохраняет статус ошибки и не помечается как skipIds', async () => {
    const { getDownloadsDir } = require('../lib/config.js');
    const { saveSettings, resetSettingsForTest } = require('../lib/osu.js');
    const downloadsDir = getDownloadsDir();

    const tempSongsDir = path.join(testEnv.tempBaseDir, 'osu_fake_retry2', 'Songs');
    await fs.mkdir(tempSongsDir, { recursive: true });

    await saveSettings({
      osuPath: tempSongsDir,
      checkExisting: true,
      postDownloadAction: 'extract',
    });

    const setId = 902;
    const oszPath = path.join(downloadsDir, `${setId}.osz`);
    // Создаем zip, который валиден по структуре, но не содержит файлов карт .osu (extractZip с validateBeatmap: true выбросит ошибку)
    await fs.writeFile(oszPath, validZipBuffer);

    const job = createTestJob({
      id: 'job_test_retry_extract_fail',
      method: 'mirror',
      setIds: [setId],
      doneIds: [],
      errIds: [setId],
      postDownloadErrors: [[setId, 'В архиве отсутствуют файлы карт']],
      errorsById: [[setId, { id: setId, name: 'Map 902', error: 'В архиве отсутствуют файлы карт', isPostDownload: true }]],
      status: 'finished_with_errors',
    });
    jobs.set(job.id, job);

    const handled = await checkAndSkipIfAvailable(setId, job);
    assert.equal(handled, true, 'Обработка завершена');
    assert.equal(job.doneIds.has(setId), false, 'Не должен попасть в doneIds');
    assert.equal(job.skipIds.has(setId), false, 'НЕ должен попасть в skipIds!');
    assert.equal(job.errIds.has(setId), true, 'Должен остаться в errIds');
    assert.equal(job.postDownloadErrors.has(setId), true, 'Должен остаться в postDownloadErrors');
    assert.equal(job.errorsById.has(setId), true, 'Должен остаться в errorsById');

    await fs.unlink(oszPath).catch(() => {});
    resetSettingsForTest();
  });
});
