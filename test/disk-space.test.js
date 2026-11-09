"use strict";

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  estimateRequiredDiskSpace,
  ensureDiskSpace,
  isSameFileSystem,
  jobFilePath,
} = require('../lib/downloader.js');
const {
  saveSettings: saveOsuSettings,
  invalidateCachedSongs,
} = require('../lib/osu.js');
const { HttpError } = require('../lib/config.js');

describe('Оценка и проверка свободного места на диске (Disk Space Checks)', () => {
  let tempBaseDir;
  let tempDownloadsDir;
  let tempSongsDir;
  let originalDownloadsEnv;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-space-test-'));
    tempDownloadsDir = path.join(tempBaseDir, 'downloads');
    tempSongsDir = path.join(tempBaseDir, 'Songs');
    await fs.mkdir(tempDownloadsDir, { recursive: true });
    await fs.mkdir(tempSongsDir, { recursive: true });

    originalDownloadsEnv = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    invalidateCachedSongs();
  });

  afterEach(async () => {
    process.env.DOWNLOADS_DIR = originalDownloadsEnv;
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
      }
    );
  });

  it('isSameFileSystem корректно сравнивает пути на одной и разных файловых системах', () => {
    assert.equal(isSameFileSystem('C:\\downloads', 'C:\\Songs'), true);
    assert.equal(isSameFileSystem('C:\\downloads', 'D:\\Songs'), false);
    assert.equal(isSameFileSystem('D:\\downloads', 'D:\\Games\\osu!\\Songs'), true);
  });
});
