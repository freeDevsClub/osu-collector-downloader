'use strict';

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
  jobCounters,
  safeJobForClient,
  resumeJob,
  retryFailedJob,
  getStateFilePath,
  serializeJob,
  deserializeJob,
  serializeState,
  saveStateToDisk,
  loadStateFromDisk,
  scheduleSaveState,
  clearSaveStateTimer,
  waitForPendingSaveState,
} = require('../lib/jobs.js');

const { server, bootstrapServer, resetBootstrap } = require('../server.js');
const { setMirrorsForTest, resetMirrorsForTest } = require('../lib/mirrors.js');
const { buildMirrorUrl } = require('../lib/config.js');

const { buildBeatmapFolderName } = require('../lib/osu.js');

describe('Сохранение состояния очереди на диск (Queue State Persistence)', () => {
  let appServer;
  let appPort;
  let mockMirrorServer;
  let mockMirrorPort;
  let tempDir;
  let originalMirrors;
  let originalDataEnv;
  let originalDownloadsEnv;
  const requestedSets = [];

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-persistence-test-'));
    originalDownloadsEnv = process.env.DOWNLOADS_DIR;
    originalDataEnv = process.env.DATA_DIR;
    process.env.DOWNLOADS_DIR = tempDir;
    process.env.DATA_DIR = tempDir;

    mockMirrorServer = http.createServer((req, res) => {
      const match = req.url?.match(/\/d\/(\d+)/);
      if (match) {
        const setId = Number(match[1]);
        requestedSets.push(setId);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(validZipBuffer.length),
        });
        return res.end(validZipBuffer);
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((r) => mockMirrorServer.listen(0, '127.0.0.1', r));
    mockMirrorPort = /** @type {import('node:net').AddressInfo} */ (mockMirrorServer.address()).port;

    setMirrorsForTest([
      {
        id: 'mock_state_mirror',
        label: 'Mock State Mirror',
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
    if (originalDownloadsEnv !== undefined) {
      process.env.DOWNLOADS_DIR = originalDownloadsEnv;
    } else {
      delete process.env.DOWNLOADS_DIR;
    }
    if (originalDataEnv !== undefined) {
      process.env.DATA_DIR = originalDataEnv;
    } else {
      delete process.env.DATA_DIR;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  beforeEach(async () => {
    await waitForPendingSaveState();
    jobs.clear();
    setActiveJob(null);
    requestedSets.length = 0;
    resetBootstrap();
  });

  it('serializeJob и deserializeJob корректно преобразуют структуры данных', () => {
    const job = {
      id: 'test_job_serialize',
      method: 'mirror',
      noVideo: true,
      collectionId: '54321',
      collectionName: 'Test Collection',
      setIds: [100, 200, 300],
      doneIds: new Set([100]),
      skipIds: new Set([200]),
      errIds: new Set([300]),
      errorsById: new Map([[300, { id: 300, name: 'Map 300', error: 'HTTP 404' }]]),
      extraFailures: 0,
      mapsById: new Map([
        [100, { id: 100, label: 'Artist 1 - Title 1' }],
        [200, { id: 200, label: 'Artist 2 - Title 2' }],
        [300, { id: 300, label: 'Artist 3 - Title 3' }],
      ]),
      status: 'paused',
      message: 'Пауза из-за зеркал',
      autoResumeCount: 1,
      createdAt: 1700000000000,
      pausedAt: 1700000005000,
    };

    const serialized = serializeJob(job);
    assert.equal(serialized.id, 'test_job_serialize');
    assert.deepEqual(serialized.setIds, [100, 200, 300]);
    assert.deepEqual(serialized.doneIds, [100]);
    assert.deepEqual(serialized.skipIds, [200]);
    assert.deepEqual(serialized.errIds, [300]);
    assert.equal(serialized.noVideo, true);
    assert.equal(serialized.errors.length, 1);
    assert.equal(serialized.errors[0].id, 300);

    const deserialized = deserializeJob(serialized);
    assert.ok(deserialized);
    assert.equal(deserialized.id, 'test_job_serialize');
    assert.ok(deserialized.doneIds instanceof Set);
    assert.ok(deserialized.doneIds.has(100));
    assert.ok(deserialized.skipIds.has(200));
    assert.ok(deserialized.errIds.has(300));
    assert.ok(deserialized.errorsById instanceof Map);
    assert.equal(deserialized.errorsById.get(300)?.error, 'HTTP 404');
    assert.equal(deserialized.mapsById.get(100)?.label, 'Artist 1 - Title 1');
    assert.equal(deserialized.status, 'paused');
    assert.equal(deserialized.message, 'Пауза из-за зеркал');
  });

  it('при десериализации незавершённые статусы running и queued безопасно переводятся в paused', () => {
    const runningJobData = {
      id: 'job_running_restart',
      method: 'mirror',
      setIds: [1, 2, 3],
      doneIds: [1],
      skipIds: [],
      errIds: [],
      status: 'running',
      message: 'Загрузка beatmap-наборов…',
    };

    const queuedJobData = {
      id: 'job_queued_restart',
      method: 'mirror',
      setIds: [4, 5],
      doneIds: [],
      skipIds: [],
      errIds: [],
      status: 'queued',
      message: 'Загрузка в очереди.',
    };

    const restoredRunning = deserializeJob(runningJobData);
    assert.ok(restoredRunning);
    assert.equal(restoredRunning.status, 'paused');
    assert.equal(restoredRunning.message, 'Сервер был перезапущен — задача приостановлена. Нажмите «Продолжить».');
    assert.ok(Number.isFinite(restoredRunning.pausedAt));

    const restoredQueued = deserializeJob(queuedJobData);
    assert.ok(restoredQueued);
    assert.equal(restoredQueued.status, 'paused');
    assert.equal(restoredQueued.message, 'Сервер был перезапущен — задача приостановлена. Нажмите «Продолжить».');
  });

  it('десериализация сохраняет терминальные статусы finished, finished_with_errors и cancelled', () => {
    const finishedData = {
      id: 'j_fin',
      setIds: [1],
      doneIds: [1],
      skipIds: [],
      errIds: [],
      status: 'finished',
      message: 'Готово',
    };
    const failedData = {
      id: 'j_err',
      setIds: [2],
      doneIds: [],
      skipIds: [],
      errIds: [2],
      errors: [{ id: 2, name: 'M2', error: '404' }],
      status: 'finished_with_errors',
      message: 'Готово с ошибками',
    };
    const cancelledData = {
      id: 'j_can',
      setIds: [3],
      doneIds: [],
      skipIds: [],
      errIds: [],
      status: 'cancelled',
      message: 'Остановлено',
    };

    const j1 = deserializeJob(finishedData);
    const j2 = deserializeJob(failedData);
    const j3 = deserializeJob(cancelledData);

    assert.equal(j1?.status, 'finished');
    assert.equal(j2?.status, 'finished_with_errors');
    assert.equal(j3?.status, 'cancelled');
    assert.equal(safeJobForClient(j2).canRetryFailed, true);
  });

  it('saveStateToDisk сохраняет файл .state.json, а loadStateFromDisk восстанавливает задачи', async () => {
    const job = {
      id: 'job_disk_persist_1',
      method: 'mirror',
      noVideo: false,
      collectionId: '8811',
      collectionName: 'Persist Collection',
      setIds: [501, 502, 503],
      doneIds: new Set([501]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map([
        [501, { id: 501, label: 'Map 501' }],
        [502, { id: 502, label: 'Map 502' }],
        [503, { id: 503, label: 'Map 503' }],
      ]),
      status: 'paused',
      message: 'Пауза задачи',
      autoResumeCount: 0,
    };

    jobs.set(job.id, job);
    setActiveJob(job);

    await saveStateToDisk();

    const stateFile = getStateFilePath();
    assert.equal(stateFile, path.join(tempDir, '.state.json'));

    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.activeJobId, 'job_disk_persist_1');
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.jobs[0].id, 'job_disk_persist_1');
    assert.deepEqual(parsed.jobs[0].doneIds, [501]);

    // Очищаем память полностью
    jobs.clear();
    setActiveJob(null);
    assert.equal(jobs.size, 0);
    assert.equal(getActiveJob(), null);

    // Загружаем с диска
    const loaded = await loadStateFromDisk();
    assert.equal(loaded, true);
    assert.equal(jobs.size, 1);

    const restoredJob = jobs.get('job_disk_persist_1');
    assert.ok(restoredJob);
    assert.equal(restoredJob.id, 'job_disk_persist_1');
    assert.equal(restoredJob.status, 'paused');
    assert.ok(restoredJob.doneIds.has(501));
    assert.equal(restoredJob.doneIds.size, 1);
    assert.equal(getActiveJob(), restoredJob);

    const counters = jobCounters(restoredJob);
    assert.equal(counters.downloaded, 1);
    assert.equal(counters.completed, 1);
    assert.equal(counters.deferred, 2);
  });

  it('сценарий перезапуска сервера: восстанавливает незавершённую задачу и позволяет продолжить без перескачивания готовых карт', async () => {
    // 1. Создаём задачу, в которой набор 601 уже скачан, а 602 и 603 ещё нет
    const job = {
      id: 'job_resume_after_restart',
      method: 'mirror',
      noVideo: false,
      collectionId: '9922',
      collectionName: 'Resume Collection',
      setIds: [601, 602, 603],
      doneIds: new Set([601]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map([
        [601, { id: 601, label: 'Map 601' }],
        [602, { id: 602, label: 'Map 602' }],
        [603, { id: 603, label: 'Map 603' }],
      ]),
      status: 'running', // была в статусе running до внезапной перезагрузки
      message: 'Загрузка…',
    };

    // Предварительно кладём валидный .osz для 601 на диск
    await fs.writeFile(path.join(tempDir, '601.osz'), validZipBuffer);

    jobs.set(job.id, job);
    setActiveJob(job);
    await saveStateToDisk();

    // 2. Имитируем перезапуск процесса: очищаем память
    jobs.clear();
    setActiveJob(null);

    // 3. Сервер стартует и вызывает loadStateFromDisk()
    const loaded = await loadStateFromDisk();
    assert.equal(loaded, true);

    const restoredJob = jobs.get('job_resume_after_restart');
    assert.ok(restoredJob);
    // Задача должна быть переведена в paused с пояснением
    assert.equal(restoredJob.status, 'paused');
    assert.equal(restoredJob.message, 'Сервер был перезапущен — задача приостановлена. Нажмите «Продолжить».');
    assert.ok(restoredJob.doneIds.has(601));

    // 4. Пользователь нажимает «Продолжить» (resumeJob)
    resumeJob(restoredJob, { kind: 'mirror' }, 'manual');

    // Ждём завершения загрузки оставшихся наборов
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (['finished', 'finished_with_errors'].includes(restoredJob.status)) {
          clearInterval(check);
          resolve(null);
        }
      }, 50);
    });

    if (restoredJob._promise) await restoredJob._promise;
    await waitForPendingSaveState();

    assert.equal(restoredJob.status, 'finished');
    assert.equal(restoredJob.doneIds.has(601), true);
    assert.equal(restoredJob.doneIds.has(602), true);
    assert.equal(restoredJob.doneIds.has(603), true);

    // Проверяем, что к мок-зеркалу НЕ отправлялся запрос на набор 601, так как он уже был в doneIds!
    assert.ok(!requestedSets.includes(601), 'Набор 601 не должен был запрашиваться с зеркала повторно');
    assert.ok(requestedSets.includes(602), 'Набор 602 должен быть скачан');
    assert.ok(requestedSets.includes(603), 'Набор 603 должен быть скачан');
  });

  it('сценарий повтора ошибок после перезапуска сервера: canRetryFailed остаётся true и retryFailedJob докачивает только упавшие наборы', async () => {
    const job = {
      id: 'job_retry_after_restart',
      method: 'mirror',
      noVideo: false,
      collectionId: '9933',
      collectionName: 'Failed Collection',
      setIds: [701, 702],
      doneIds: new Set([701]),
      skipIds: new Set(),
      errIds: new Set([702]),
      errorsById: new Map([[702, { id: 702, name: 'Map 702', error: 'HTTP 502' }]]),
      extraFailures: 0,
      mapsById: new Map([
        [701, { id: 701, label: 'Map 701' }],
        [702, { id: 702, label: 'Map 702' }],
      ]),
      status: 'finished_with_errors',
      message: 'Готово с ошибками: 1 из 2.',
    };

    jobs.set(job.id, job);
    await saveStateToDisk();

    // Перезапуск сервера
    jobs.clear();
    setActiveJob(null);
    await loadStateFromDisk();

    const restoredJob = jobs.get('job_retry_after_restart');
    assert.ok(restoredJob);
    assert.equal(restoredJob.status, 'finished_with_errors');
    assert.equal(safeJobForClient(restoredJob).canRetryFailed, true);
    assert.equal(safeJobForClient(restoredJob).failed, 1);

    // Пользователь нажимает «Повторить ошибки»
    retryFailedJob(restoredJob, { kind: 'mirror' });

    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (['finished', 'finished_with_errors'].includes(restoredJob.status)) {
          clearInterval(check);
          resolve(null);
        }
      }, 50);
    });

    if (restoredJob._promise) await restoredJob._promise;
    await waitForPendingSaveState();

    assert.equal(restoredJob.status, 'finished');
    assert.ok(restoredJob.doneIds.has(702), 'Набор 702 должен быть успешно докачан');
    assert.ok(requestedSets.includes(702), 'Запрос должен быть отправлен на упавший 702');
    assert.ok(!requestedSets.includes(701), 'Успешный 701 не должен перезапрашиваться');
  });

  it('корректно обрабатывает отсутствующий, пустой и повреждённый .state.json без сбоев', async () => {
    await waitForPendingSaveState();
    const stateFile = getStateFilePath();

    // 1. Файл не существует
    await fs.rm(stateFile, { force: true }).catch(() => {});
    const resNoFile = await loadStateFromDisk();
    assert.equal(resNoFile, false);

    // 2. Файл пустой
    await fs.writeFile(stateFile, '   ', 'utf8');
    const resEmpty = await loadStateFromDisk();
    assert.equal(resEmpty, false);

    // 3. Невалидный JSON
    await fs.writeFile(stateFile, '{"version": 1, corrupted_json: true...', 'utf8');
    const resCorrupted = await loadStateFromDisk();
    assert.equal(resCorrupted, false);
  });

  it('эндпоинт GET /api/downloads/active возвращает 404, если задачи нет, и 200 с состоянием, если задача активна или на паузе', async () => {
    // 1. Нет активной задачи -> 404
    const resEmpty = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${appPort}/api/downloads/active`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      });
    });
    assert.equal(resEmpty.status, 404);
    assert.ok(/Нет активной загрузки/i.test(resEmpty.data.error));

    // 2. Создаём задачу на паузе
    const job = {
      id: 'active_check_job_1',
      method: 'mirror',
      noVideo: true,
      collectionId: '777',
      collectionName: 'Active Check',
      setIds: [801, 802],
      doneIds: new Set([801]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map(),
      status: 'paused',
      message: 'Задача на паузе.',
    };
    jobs.set(job.id, job);
    setActiveJob(job);

    const resActive = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${appPort}/api/downloads/active`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      });
    });
    assert.equal(resActive.status, 200);
    assert.equal(resActive.data.id, 'active_check_job_1');
    assert.equal(resActive.data.status, 'paused');
    assert.equal(resActive.data.downloaded, 1);
  });

  it('устранение гонки: фоновый bootstrapServer блокирует ранний GET /api/downloads/active от ложного 404', async () => {
    await waitForPendingSaveState();
    // 1. Создаём сохранённую задачу на диске
    const jobOnDisk = {
      id: 'job_bootstrap_race_test',
      method: 'mirror',
      noVideo: false,
      collectionId: '555',
      collectionName: 'Bootstrap Race',
      setIds: [951, 952],
      doneIds: new Set([951]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map([
        [951, { id: 951, label: 'Map 951' }],
        [952, { id: 952, label: 'Map 952' }],
      ]),
      status: 'paused',
      message: 'Задача на паузе до рестарта.',
    };
    jobs.set(jobOnDisk.id, jobOnDisk);
    setActiveJob(jobOnDisk);
    await saveStateToDisk();

    // 2. Имитируем старт сервера с чистой памятью
    jobs.clear();
    setActiveJob(null);
    resetBootstrap();

    // 3. Запускаем bootstrapServer (дисковое I/O) и параллельно делаем запрос
    const bootPromise = bootstrapServer();

    const res = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${appPort}/api/downloads/active`, (httpRes) => {
        let body = '';
        httpRes.on('data', (chunk) => {
          body += chunk;
        });
        httpRes.on('end', () => resolve({ status: httpRes.statusCode, data: JSON.parse(body) }));
      });
    });

    await bootPromise;
    await waitForPendingSaveState();
    resetBootstrap();

    // 4. Запрос должен был дождаться окончания bootstrap и вернуть 200 с восстановленной задачей
    assert.equal(res.status, 200, 'Запрос должен вернуть 200, а не ложный 404');
    assert.equal(res.data.id, 'job_bootstrap_race_test');
    assert.equal(res.data.status, 'paused');
    assert.equal(res.data.downloaded, 1);
  });

  it('bootstrapServer идемпотентен, переиспользует единый Promise и корректно сбрасывается через resetBootstrap', async () => {
    resetBootstrap();
    const p1 = bootstrapServer();
    const p2 = bootstrapServer();
    assert.strictEqual(p1, p2, 'Параллельные вызовы bootstrapServer должны возвращать один и тот же Promise');
    await p1;
    resetBootstrap();
    const p3 = bootstrapServer();
    assert.notStrictEqual(p1, p3, 'После resetBootstrap должен создаваться новый Promise');
    await p3;
    resetBootstrap();
  });

  it('полная сериализация метаданных карт (artist, title, creator) исключает расхождение имён папок buildBeatmapFolderName после рестарта', () => {
    const originalMapInfo = {
      id: 54321,
      label: 'xi — Freedom Dive',
      title: 'Freedom Dive',
      artist: 'xi',
      creator: 'Nakagawa-Kanon',
    };

    const job = {
      id: 'job_metadata_persistence_test',
      method: 'mirror',
      collectionId: '888',
      setIds: [54321],
      mapsById: new Map([[54321, originalMapInfo]]),
      createdAt: 1700000000000,
    };

    // Имя папки до перезапуска
    const folderBeforeRestart = buildBeatmapFolderName(54321, job.mapsById.get(54321));
    assert.equal(folderBeforeRestart, '54321 xi - Freedom Dive');

    // Сериализация и десериализация (имитация рестарта)
    const serialized = serializeJob(job);
    assert.equal(serialized.maps[0].artist, 'xi');
    assert.equal(serialized.maps[0].title, 'Freedom Dive');
    assert.equal(serialized.maps[0].creator, 'Nakagawa-Kanon');

    const deserialized = deserializeJob(serialized);
    const restoredMapInfo = deserialized.mapsById.get(54321);
    assert.ok(restoredMapInfo);
    assert.equal(restoredMapInfo.artist, 'xi');
    assert.equal(restoredMapInfo.title, 'Freedom Dive');
    assert.equal(restoredMapInfo.creator, 'Nakagawa-Kanon');

    // Имя папки после перезапуска должно строго совпадать!
    const folderAfterRestart = buildBeatmapFolderName(54321, restoredMapInfo);
    assert.equal(folderAfterRestart, folderBeforeRestart);
    assert.equal(folderAfterRestart, '54321 xi - Freedom Dive');
  });

  it('обратная совместимость: десериализация восстанавливает artist и title из старого формата с длинным тире "Artist — Title"', () => {
    const legacyJobData = {
      id: 'job_legacy_format',
      method: 'mirror',
      setIds: [12345],
      maps: [{ id: 12345, label: 'Camellia — crystallized' }],
      createdAt: 1700000000000,
    };

    const deserialized = deserializeJob(legacyJobData);
    const restoredMap = deserialized.mapsById.get(12345);
    assert.ok(restoredMap);
    assert.equal(restoredMap.artist, 'Camellia');
    assert.equal(restoredMap.title, 'crystallized');

    // buildBeatmapFolderName должен построить имя с дефисом '-', а не с длинным тире '—'
    const folderName = buildBeatmapFolderName(12345, restoredMap);
    assert.equal(folderName, '12345 Camellia - crystallized');
  });

  it('поле createdAt стабильно, не мутирует при повторной сериализации и возвращается в safeJobForClient', async () => {
    const initialTime = 1710000000000;
    const job = {
      id: 'job_created_at_test',
      method: 'mirror',
      setIds: [1],
      createdAt: initialTime,
      mapsById: new Map([[1, { id: 1, label: 'Test' }]]),
    };

    // 1. Первая сериализация
    const s1 = serializeJob(job);
    assert.equal(s1.createdAt, initialTime);

    // 2. Имитируем задержку времени и повторную сериализацию
    await new Promise((r) => setTimeout(r, 20));
    const s2 = serializeJob(job);
    assert.equal(s2.createdAt, initialTime, 'createdAt не должен сдвигаться при повторных сохранениях');

    // 3. Десериализация сохраняет createdAt
    const restored = deserializeJob(s2);
    assert.equal(restored.createdAt, initialTime);

    // 4. safeJobForClient отдает createdAt
    const clientData = safeJobForClient(restored);
    assert.equal(clientData.createdAt, initialTime);

    // 5. Авто-инициализация: если в объекте job не было createdAt, serializeJob выставляет его на самом объекте
    const jobWithoutCreatedAt = { id: 'job_no_created_at', setIds: [2] };
    const s3 = serializeJob(jobWithoutCreatedAt);
    assert.ok(typeof s3.createdAt === 'number' && s3.createdAt > 0);
    assert.equal(
      jobWithoutCreatedAt.createdAt,
      s3.createdAt,
      'serializeJob должен зафиксировать createdAt на объекте задачи',
    );
  });

  it('saveStateToDisk сохраняет компактный JSON без отступов и лишних переводов строк', async () => {
    const job = {
      id: 'job_compact_json_test',
      method: 'mirror',
      setIds: [1001, 1002],
      doneIds: new Set([1001]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map([
        [1001, { id: 1001, label: 'Artist 1 — Title 1', title: 'Title 1', artist: 'Artist 1', creator: 'Creator 1' }],
        [1002, { id: 1002, label: 'Artist 2 — Title 2', title: 'Title 2', artist: 'Artist 2', creator: 'Creator 2' }],
      ]),
      status: 'running',
      message: 'Загрузка...',
      createdAt: Date.now(),
    };

    jobs.set(job.id, job);
    setActiveJob(job);

    await saveStateToDisk();

    const stateFile = getStateFilePath();
    const raw = await fs.readFile(stateFile, 'utf8');

    // Файл должен быть валидным JSON
    const parsed = JSON.parse(raw);
    assert.equal(parsed.activeJobId, 'job_compact_json_test');

    // Проверяем, что нет отступов (null, 2)
    assert.ok(!raw.includes('{\n  "version"'), 'JSON не должен содержать форматирование с отступами null, 2');
    assert.ok(!raw.includes('\n    "id":'), 'JSON не должен содержать многострочные отступы внутри элементов массива');
  });

  it('serializeJob повторно использует закешированные метаданные карт (_cachedSerializedMaps) и статическую часть', () => {
    const mapCount = 1000;
    const mapsById = new Map();
    for (let i = 1; i <= mapCount; i++) {
      mapsById.set(i, {
        id: i,
        label: `Artist ${i} — Title ${i}`,
        title: `Title ${i}`,
        artist: `Artist ${i}`,
        creator: `Mapper ${i}`,
      });
    }

    const job = {
      id: 'job_cache_reuse_test',
      method: 'mirror',
      setIds: Array.from(mapsById.keys()),
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById,
      status: 'running',
      message: 'Загрузка...',
      createdAt: 1710000000000,
    };

    const first = serializeJob(job);
    assert.ok(Array.isArray(first.maps));
    assert.equal(first.maps.length, mapCount);
    assert.ok(job._cachedSerializedMaps, 'должен быть сформирован _cachedSerializedMaps');

    // При изменении только динамического прогресса
    job.doneIds.add(1);
    const second = serializeJob(job);

    // Массив карт и статические метаданные должны переиспользоваться по ссылке
    assert.equal(second.maps, first.maps, 'Массив maps должен переиспользоваться без переаллокации');
    assert.deepEqual(second.doneIds, [1]);
  });

  it('serializeJob корректно инвалидирует и обновляет кеш метаданных при фоновом обогащении карт', () => {
    const mapsById = new Map([[10, { id: 10, label: 'Набор 10', title: null, artist: null, creator: null }]]);

    const job = {
      id: 'job_cache_invalidation_test',
      method: 'mirror',
      setIds: [10],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById,
      status: 'running',
      message: 'Ожидание метаданных...',
      createdAt: 1710000000000,
    };

    const first = serializeJob(job);
    assert.equal(first.maps[0].title, null);

    // Имитируем фоновое обогащение названия карты
    mapsById.set(10, {
      id: 10,
      label: 'Artist X — Song Y',
      title: 'Song Y',
      artist: 'Artist X',
      creator: 'Mapper Z',
    });

    const second = serializeJob(job);
    assert.notEqual(second.maps, first.maps, 'Кеш должен обновиться при поступлении названий карт');
    assert.equal(second.maps[0].title, 'Song Y');
    assert.equal(second.maps[0].artist, 'Artist X');
  });
});
