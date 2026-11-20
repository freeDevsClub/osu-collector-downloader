'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nodeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  estimateRequiredDiskSpace,
  ensureDiskSpace,
  isSameFileSystem,
  jobFilePath,
  getCachedDownloadedSets,
  getCachedDownloadedSetsAsync,
  addDownloadedSetId,
  removeDownloadedSetId,
  invalidateCachedDownloads,
} = require('../lib/downloader.js');
const {
  saveSettings: saveOsuSettings,
  invalidateCachedSongs,
  loadSettings,
  classifyCollectionSets,
} = require('../lib/osu.js');
const { runJob } = require('../lib/jobs.js');
const { HttpError } = require('../lib/config.js');

describe('Оценка и проверка свободного места на диске (Disk Space Checks)', () => {
  let tempBaseDir;
  let tempDownloadsDir;
  let tempSongsDir;
  let originalDownloadsEnv;
  let originalDataEnv;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-space-test-'));
    tempDownloadsDir = path.join(tempBaseDir, 'downloads');
    tempSongsDir = path.join(tempBaseDir, 'Songs');
    await fs.mkdir(tempDownloadsDir, { recursive: true });
    await fs.mkdir(tempSongsDir, { recursive: true });

    originalDownloadsEnv = process.env.DOWNLOADS_DIR;
    originalDataEnv = process.env.DATA_DIR;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;
    process.env.DATA_DIR = tempDownloadsDir;

    invalidateCachedSongs();
    invalidateCachedDownloads();
  });

  afterEach(async () => {
    process.env.DOWNLOADS_DIR = originalDownloadsEnv;
    if (originalDataEnv !== undefined) process.env.DATA_DIR = originalDataEnv;
    else delete process.env.DATA_DIR;
    invalidateCachedSongs();
    invalidateCachedDownloads();
    loadSettings();
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('estimateRequiredDiskSpace рассчитывает базовый объём с видео и без видео', async () => {
    const setIds = [101, 102, 103];
    const withVideo = await estimateRequiredDiskSpace(setIds, false);
    const withoutVideo = await estimateRequiredDiskSpace(setIds, true);

    assert.equal(withVideo, 3 * 10 * 1024 * 1024); // 30 МБ
    assert.equal(withoutVideo, 3 * 3 * 1024 * 1024); // 9 МБ
  });

  it('estimateRequiredDiskSpace не требует место под файлы, уже скачанные в downloads', async () => {
    const existingFile = path.join(tempDownloadsDir, '101.osz');
    await fs.writeFile(existingFile, Buffer.alloc(1024)); // 1 КБ

    const setIds = [101, 102, 103];
    const est = await estimateRequiredDiskSpace(setIds, false);

    // 101 уже скачан, место нужно только под 102 и 103
    assert.equal(est, 2 * 10 * 1024 * 1024);
  });

  it('estimateRequiredDiskSpace не требует место под наборы, уже установленные в osu! Songs', async () => {
    // Создаём папку установленной карты 101 в Songs
    await fs.mkdir(path.join(tempSongsDir, '101 Artist - Title'), { recursive: true });

    // Настраиваем osu! Songs с включённым checkExisting
    await saveOsuSettings({
      osuPath: tempSongsDir,
      checkExisting: true,
      postDownloadAction: 'none',
    });

    const setIds = [101, 102, 103];
    const est = await estimateRequiredDiskSpace(setIds, false);

    // 101 уже в игре, место нужно только под 102 и 103
    assert.equal(est, 2 * 10 * 1024 * 1024);
  });

  it('estimateRequiredDiskSpace учитывает checkExisting: false', async () => {
    await fs.mkdir(path.join(tempSongsDir, '101 Artist - Title'), { recursive: true });

    // checkExisting отключён
    await saveOsuSettings({
      osuPath: tempSongsDir,
      checkExisting: false,
      postDownloadAction: 'none',
    });

    const setIds = [101, 102, 103];
    const est = await estimateRequiredDiskSpace(setIds, false);

    // Должен оценить все 3, так как проверка существующих отключена
    assert.equal(est, 3 * 10 * 1024 * 1024);
  });

  it('estimateRequiredDiskSpace исключает наборы из doneIds и skipIds при возобновлении задачи', async () => {
    const mockJob = {
      doneIds: new Set([101]),
      skipIds: new Set([102]),
    };

    const setIds = [101, 102, 103];
    const est = await estimateRequiredDiskSpace(setIds, false, { job: mockJob });

    // 101 скачан, 102 пропущен, остался только 103
    assert.equal(est, 1 * 10 * 1024 * 1024);
  });

  it('estimateRequiredDiskSpace возвращает 0, если все наборы уже установлены или скачаны', async () => {
    await fs.mkdir(path.join(tempSongsDir, '101 Artist - Title'), { recursive: true });
    await fs.mkdir(path.join(tempSongsDir, '102 Artist - Title'), { recursive: true });

    await saveOsuSettings({
      osuPath: tempSongsDir,
      checkExisting: true,
      postDownloadAction: 'none',
    });

    const setIds = [101, 102];
    const est = await estimateRequiredDiskSpace(setIds, false);

    assert.equal(est, 0);
  });

  it('ensureDiskSpace успешно завершается при 0 требуемых байт', async () => {
    await assert.doesNotReject(async () => {
      await ensureDiskSpace(0);
    });
  });

  it('ensureDiskSpace выбрасывает HttpError(507) при заведомо нереалистичном объёме', async () => {
    // Запрашиваем 1000 Петабайт
    const impossibleBytes = 1000 * 1024 * 1024 * 1024 * 1024 * 1024;

    await assert.rejects(
      async () => {
        await ensureDiskSpace(impossibleBytes);
      },
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.httpStatus, 507);
        assert.match(err.message, /мало места/);
        return true;
      },
    );
  });

  it('isSameFileSystem корректно сравнивает пути на одной и разных файловых системах', () => {
    assert.equal(isSameFileSystem('C:\\downloads', 'C:\\Songs'), true);
    assert.equal(isSameFileSystem('C:\\downloads', 'D:\\Songs'), false);
    assert.equal(isSameFileSystem('D:\\downloads', 'D:\\Games\\osu!\\Songs'), true);
  });

  it('getCachedDownloadedSets / getCachedDownloadedSetsAsync корректно фильтрует файлы по размеру и маске', async () => {
    // 101.osz: валидный файл > 0 байт
    await fs.writeFile(path.join(tempDownloadsDir, '101.osz'), Buffer.alloc(1024));
    // 102.osz: пустой файл 0 байт (должен игнорироваться)
    await fs.writeFile(path.join(tempDownloadsDir, '102.osz'), Buffer.alloc(0));
    // 103.part: временный файл (должен игнорироваться)
    await fs.writeFile(path.join(tempDownloadsDir, '103.part'), Buffer.alloc(1024));
    // invalid.osz: нечисловое имя (должно игнорироваться)
    await fs.writeFile(path.join(tempDownloadsDir, 'invalid.osz'), Buffer.alloc(1024));
    // 104.osz: папка с именем .osz (должна игнорироваться)
    await fs.mkdir(path.join(tempDownloadsDir, '104.osz'));

    const syncSets = getCachedDownloadedSets(tempDownloadsDir, true);
    assert.equal(syncSets.has(101), true);
    assert.equal(syncSets.has(102), false, '0-байтовый файл не должен считаться скачанным');
    assert.equal(syncSets.has(103), false, '.part файл не должен считаться скачанным');
    assert.equal(syncSets.has(104), false, 'директория не должна считаться скачанным набором');
    assert.equal(syncSets.size, 1);

    const asyncSets = await getCachedDownloadedSetsAsync(tempDownloadsDir, true);
    assert.equal(asyncSets.has(101), true);
    assert.equal(asyncSets.has(102), false);
    assert.equal(asyncSets.size, 1);
  });

  it('addDownloadedSetId и removeDownloadedSetId корректно модифицируют кэш', async () => {
    invalidateCachedDownloads();
    await fs.writeFile(path.join(tempDownloadsDir, '777.osz'), Buffer.alloc(100));
    addDownloadedSetId(777);
    const sets = getCachedDownloadedSets(tempDownloadsDir);
    assert.equal(sets.has(777), true);

    removeDownloadedSetId(777);
    assert.equal(sets.has(777), false);
  });

  it('classifyCollectionSets и estimateRequiredDiskSpace не выполняют пофайловый stat на каждый ID из 5000 карт', async () => {
    await fs.writeFile(path.join(tempDownloadsDir, '101.osz'), Buffer.alloc(1024));
    invalidateCachedDownloads();

    const ids = Array.from({ length: 5000 }, (_, i) => i + 1);

    let statSyncCalls = 0;
    const origStatSync = nodeFs.statSync;
    nodeFs.statSync = function (...args) {
      statSyncCalls++;
      return origStatSync.apply(this, args);
    };

    try {
      const res = classifyCollectionSets(ids);
      assert.deepEqual(res.downloadedSetIds, [101]);
      // Вместо 5000 вызовов statSync для каждого ID, statSync вызывается только для реальных файлов в папке (1 раз для 101.osz)
      assert.ok(statSyncCalls <= 5, `Ожидалось не более 5 вызовов statSync, получено: ${statSyncCalls}`);
    } finally {
      nodeFs.statSync = origStatSync;
    }

    let asyncStatCalls = 0;
    const origAsyncStat = nodeFs.promises.stat;
    nodeFs.promises.stat = async function (...args) {
      asyncStatCalls++;
      return origAsyncStat.apply(this, args);
    };

    try {
      const est = await estimateRequiredDiskSpace(ids, false, { checkOsu: false });
      // 4999 карт по 10 МБ (101 уже скачан)
      assert.equal(est, 4999 * 10 * 1024 * 1024);
      assert.ok(asyncStatCalls <= 5, `Ожидалось не более 5 вызовов async stat, получено: ${asyncStatCalls}`);
    } finally {
      nodeFs.promises.stat = origAsyncStat;
    }
  });

  it('runJob не выполняет повторный estimateRequiredDiskSpace при job._spaceChecked = true', async () => {
    const mockJob = {
      id: 'job_space_checked_test',
      method: 'mirror',
      setIds: [99901, 99902],
      doneIds: new Set([99901, 99902]),
      skipIds: new Set(),
      errIds: new Set(),
      _spaceChecked: true,
      status: 'queued',
      abortController: new AbortController(),
    };

    await runJob(mockJob, { kind: 'mirror' });
    // _spaceChecked должен быть очищен после первого прохода
    assert.equal(mockJob._spaceChecked, undefined);
  });
});
