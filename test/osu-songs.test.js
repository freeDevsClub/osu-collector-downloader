// @ts-check
"use strict";

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const http = require('node:http');

const {
  resolveOsuSongsDir,
  scanOsuSongsSync,
  getCachedOsuSongs,
  invalidateCachedSongs,
  addInstalledSetId,
  loadSettings,
  getSettings,
  saveSettings,
  isSetInOsuSongs,
  classifyCollectionSets,
  extractZip,
  moveFile,
  buildBeatmapFolderName,
  handlePostDownload,
} = require('../lib/osu.js');

const {
  jobFilePath,
  downloadSet,
} = require('../lib/downloader.js');

const {
  jobs,
  launchJob,
  safeJobForClient,
} = require('../lib/jobs.js');

/**
 * Создает валидный ZIP-буфер в памяти для тестирования extractZip.
 * @param {Record<string, string | Buffer | { content: string | Buffer, crc?: number }>} files
 * @returns {Buffer}
 */
function createMockZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const [name, fileDef] of Object.entries(files)) {
    let content = fileDef;
    let customCrc = null;
    if (typeof fileDef === 'object' && !Buffer.isBuffer(fileDef) && fileDef !== null && 'content' in fileDef) {
      // @ts-ignore
      content = fileDef.content;
      // @ts-ignore
      customCrc = fileDef.crc;
    }
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = typeof customCrc === 'number' ? customCrc : zlib.crc32(raw);

    // Local Header (PK\x03\x04)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); // Deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    const localEntryOffset = offset;
    localHeaders.push(lh, deflated);
    offset += lh.length + deflated.length;

    // Central Directory Header (PK\x01\x02)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(localEntryOffset, 42);
    nameBuf.copy(ch, 46);
    centralHeaders.push(ch);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) centralSize += ch.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralHeaders.length, 8);
  eocd.writeUInt16LE(centralHeaders.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Создает валидный ZIP64-буфер в памяти для тестирования extractZip со спецификацией ZIP64.
 * @param {Record<string, string | Buffer>} files
 * @returns {Buffer}
 */
function createMockZip64(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(raw);

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    const localEntryOffset = offset;
    localHeaders.push(lh, deflated);
    offset += lh.length + deflated.length;

    // ZIP64 Extra field (Tag 0x0001, 24 bytes data: 8 bytes uncomp, 8 bytes comp, 8 bytes offset)
    const extraField = Buffer.alloc(28);
    extraField.writeUInt16LE(0x0001, 0);
    extraField.writeUInt16LE(24, 2);
    extraField.writeBigUInt64LE(BigInt(raw.length), 4);
    extraField.writeBigUInt64LE(BigInt(deflated.length), 12);
    extraField.writeBigUInt64LE(BigInt(localEntryOffset), 20);

    const ch = Buffer.alloc(46 + nameBuf.length + extraField.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 4);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(0xffffffff, 20); // ZIP64 indicator
    ch.writeUInt32LE(0xffffffff, 24); // ZIP64 indicator
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(extraField.length, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(0xffffffff, 42); // ZIP64 indicator
    nameBuf.copy(ch, 46);
    extraField.copy(ch, 46 + nameBuf.length);
    centralHeaders.push(ch);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) centralSize += ch.length;

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeUInt16LE(45, 12);
  zip64Eocd.writeUInt16LE(45, 14);
  zip64Eocd.writeUInt32LE(0, 16);
  zip64Eocd.writeUInt32LE(0, 20);
  zip64Eocd.writeBigUInt64LE(BigInt(centralHeaders.length), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(centralHeaders.length), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(centralOffset), 48);

  const zip64EocdOffset = offset + centralSize;

  const zip64Locator = Buffer.alloc(20);
  zip64Locator.writeUInt32LE(0x07064b50, 0);
  zip64Locator.writeUInt32LE(0, 4);
  zip64Locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
  zip64Locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, zip64Eocd, zip64Locator, eocd]);
}

describe('Интеграция с локальной директорией osu! Songs', () => {
  let tempBaseDir;
  let mockSongsDir;
  let mockDownloadsDir;

  before(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'osu-songs-test-'));
    mockSongsDir = path.join(tempBaseDir, 'Songs');
    mockDownloadsDir = path.join(tempBaseDir, 'downloads');
    await fs.promises.mkdir(mockSongsDir, { recursive: true });
    await fs.promises.mkdir(mockDownloadsDir, { recursive: true });

    // Создаем несколько папок карт в тестовой директории Songs
    await fs.promises.mkdir(path.join(mockSongsDir, '10001 Artist - Title One'), { recursive: true });
    await fs.promises.mkdir(path.join(mockSongsDir, '10002'), { recursive: true });
    await fs.promises.mkdir(path.join(mockSongsDir, '10003 Complex (Name) [Hard]'), { recursive: true });
    // Создаем файл .osz в Songs
    await fs.promises.writeFile(path.join(mockSongsDir, '10004.osz'), Buffer.from('mock'));
    // Не-числовые папки и файлы, которые должны игнорироваться
    await fs.promises.mkdir(path.join(mockSongsDir, 'Failed'), { recursive: true });
    await fs.promises.mkdir(path.join(mockSongsDir, 'Skins'), { recursive: true });
    await fs.promises.writeFile(path.join(mockSongsDir, 'readme.txt'), 'notes');
  });

  after(async () => {
    if (tempBaseDir) {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('resolveOsuSongsDir корректно разрешает путь к Songs и корню игры', () => {
    // 1. Прямой путь к Songs
    assert.equal(resolveOsuSongsDir(mockSongsDir), mockSongsDir);
    // 2. Путь к родительской папке, содержащей Songs
    assert.equal(resolveOsuSongsDir(tempBaseDir), mockSongsDir);
    // 3. Путь в кавычках
    assert.equal(resolveOsuSongsDir(`"${mockSongsDir}"`), mockSongsDir);
    // 4. Несуществующий путь
    assert.equal(resolveOsuSongsDir(path.join(tempBaseDir, 'non_existent')), null);
    // 5. Пустой путь или мусор
    assert.equal(resolveOsuSongsDir(''), null);
    assert.equal(resolveOsuSongsDir(null), null);
  });

  test('resolveOsuSongsDir успешно находит реальную директорию Songs пользователя при наличии', () => {
    const userPath = 'D:\\Games\\osu!\\Songs';
    if (fs.existsSync(userPath)) {
      const resolved = resolveOsuSongsDir(userPath);
      assert.equal(resolved, userPath);
      const rootResolved = resolveOsuSongsDir('D:\\Games\\osu!');
      assert.equal(rootResolved, userPath);
    }
  });

  test('scanOsuSongsSync извлекает верные ID наборов карт и игнорирует нечисловые файлы', () => {
    const setIds = scanOsuSongsSync(mockSongsDir);
    assert.equal(setIds.has(10001), true);
    assert.equal(setIds.has(10002), true);
    assert.equal(setIds.has(10003), true);
    assert.equal(setIds.has(10004), true);
    assert.equal(setIds.has(99999), false);
    // Проверяем, что не создались NaN или 0
    assert.equal(setIds.has(0), false);
    assert.equal(setIds.size, 4);
  });

  test('getCachedOsuSongs кэширует результаты и addInstalledSetId пополняет кэш', () => {
    invalidateCachedSongs();
    const s1 = getCachedOsuSongs(mockSongsDir);
    assert.equal(s1.has(10001), true);
    assert.equal(s1.has(10005), false);

    // Добавляем набор в кэш
    addInstalledSetId(10005);
    const s2 = getCachedOsuSongs(mockSongsDir);
    assert.equal(s2.has(10005), true);
  });

  test('buildBeatmapFolderName формирует безопасные имена папок для Windows и очищает хвостовые точки/пробелы', () => {
    const n1 = buildBeatmapFolderName(12345, { artist: 'Artist / Slash', title: 'Title : Colon * Star ? Question " Quote < > |' });
    assert.equal(n1, '12345 Artist _ Slash - Title _ Colon _ Star _ Question _ Quote _ _ _');
    const n2 = buildBeatmapFolderName(67890, null);
    assert.equal(n2, '67890');
    const n3 = buildBeatmapFolderName(999, { label: 'Custom — Label' });
    assert.equal(n3, '999 Custom — Label');
    // Хвостовые точки и пробелы должны срезаться
    const n4 = buildBeatmapFolderName(111, { artist: 'Artist.', title: 'Title...   ' });
    assert.equal(n4, '111 Artist. - Title');
    const n5 = buildBeatmapFolderName(222, { label: 'Trailed Label... ' });
    assert.equal(n5, '222 Trailed Label');
  });

  test('extractZip безопасно распаковывает .osz архив без сторонних пакетов', async () => {
    const zipOutDir = path.join(tempBaseDir, 'extracted_test');
    const testZipBuf = createMockZip({
      'audio.mp3': 'fake_mp3_data',
      'song.osu': 'osu file format v14\r\nBeatmapSetID:55555',
      'bg.jpg': 'fake_jpg_data',
      'sb/sprites/star.png': 'fake_png_data',
    });
    const zipFilePath = path.join(tempBaseDir, 'test_map.osz');
    await fs.promises.writeFile(zipFilePath, testZipBuf);

    const extractedCount = await extractZip(zipFilePath, zipOutDir);
    assert.equal(extractedCount, 4);

    assert.equal(fs.existsSync(path.join(zipOutDir, 'audio.mp3')), true);
    assert.equal(fs.existsSync(path.join(zipOutDir, 'song.osu')), true);
    assert.equal(fs.existsSync(path.join(zipOutDir, 'bg.jpg')), true);
    assert.equal(fs.existsSync(path.join(zipOutDir, 'sb', 'sprites', 'star.png')), true);
    assert.equal(fs.readFileSync(path.join(zipOutDir, 'song.osu'), 'utf8').includes('BeatmapSetID:55555'), true);
  });

  test('extractZip поддерживает спецификацию ZIP64 (EOCD64, Locator и Extra Fields)', async () => {
    const zip64OutDir = path.join(tempBaseDir, 'extracted_zip64');
    const zip64Buf = createMockZip64({
      'audio.mp3': 'zip64_mp3_data',
      'map.osu': 'osu file format v14\r\nBeatmapSetID:77777',
      'bg.png': 'zip64_image_content',
    });
    const zip64FilePath = path.join(tempBaseDir, 'test_zip64.osz');
    await fs.promises.writeFile(zip64FilePath, zip64Buf);

    const extractedCount = await extractZip(zip64FilePath, zip64OutDir);
    assert.equal(extractedCount, 3);
    assert.equal(fs.existsSync(path.join(zip64OutDir, 'audio.mp3')), true);
    assert.equal(fs.readFileSync(path.join(zip64OutDir, 'map.osu'), 'utf8').includes('BeatmapSetID:77777'), true);
  });

  test('extractZip проверяет CRC32 и атомарно очищает директорию при несовпадении', async () => {
    const corruptOutDir = path.join(tempBaseDir, 'corrupt_extracted');
    const corruptZipBuf = createMockZip({
      'file1.txt': 'good content',
      'file2.txt': { content: 'bad crc content', crc: 0xdeadbeef },
    });
    const corruptZipPath = path.join(tempBaseDir, 'corrupt_crc.osz');
    await fs.promises.writeFile(corruptZipPath, corruptZipBuf);

    await assert.rejects(
      async () => {
        await extractZip(corruptZipPath, corruptOutDir);
      },
      /контрольной суммы CRC32/
    );

    // Целевая папка не должна быть создана
    assert.equal(fs.existsSync(corruptOutDir), false, 'Целевая папка не должна существовать после сбоя');

    // Временные папки не должны оставаться в tempBaseDir
    const entries = await fs.promises.readdir(tempBaseDir);
    const tempLeftovers = entries.filter(e => e.startsWith('.tmp_extract_'));
    assert.equal(tempLeftovers.length, 0, 'Временные staging-директории должны быть очищены');
  });

  test('extractZip защищает от NTFS ADS (:), зарезервированных имён Windows и опасных путей', async () => {
    const adsOutDir = path.join(tempBaseDir, 'ads_extracted');
    const unsafeZipBuf = createMockZip({
      'valid.txt': 'valid content',
      'malicious.txt:hidden': 'ads stream',
      'CON': 'device name CON',
      'nul.txt': 'device name NUL',
      'aux.mp3': 'device name AUX',
      'trailing_dot./nested.txt': 'folder with trailing dot',
    });
    const unsafeZipPath = path.join(tempBaseDir, 'unsafe_names.osz');
    await fs.promises.writeFile(unsafeZipPath, unsafeZipBuf);

    await extractZip(unsafeZipPath, adsOutDir);

    assert.equal(fs.existsSync(path.join(adsOutDir, 'valid.txt')), true);
    assert.equal(fs.existsSync(path.join(adsOutDir, 'malicious.txt:hidden')), false);
    assert.equal(fs.existsSync(path.join(adsOutDir, 'CON')), false);
    assert.equal(fs.existsSync(path.join(adsOutDir, 'nul.txt')), false);
    assert.equal(fs.existsSync(path.join(adsOutDir, 'aux.mp3')), false);
  });

  test('extractZip отклоняет файлы с выходом за пределы директории (Zip Slip guard)', async () => {
    const safeTarget = path.join(tempBaseDir, 'safe_zip_slip_target');
    const maliciousZipBuf = createMockZip({
      '../../evil.txt': 'should not be extracted outside',
      'valid.txt': 'valid file',
    });
    const zipPath = path.join(tempBaseDir, 'slip.osz');
    await fs.promises.writeFile(zipPath, maliciousZipBuf);

    await extractZip(zipPath, safeTarget);
    // Файл evil.txt не должен появиться за пределами safeTarget
    assert.equal(fs.existsSync(path.join(tempBaseDir, 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(safeTarget, 'valid.txt')), true);
  });

  test('moveFile перемещает файл даже при кросс-устройствах', async () => {
    const src = path.join(tempBaseDir, 'source_file.tmp');
    const dst = path.join(tempBaseDir, 'dest_file.tmp');
    await fs.promises.writeFile(src, 'content to move');
    await moveFile(src, dst);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.existsSync(dst), true);
    assert.equal(await fs.promises.readFile(dst, 'utf8'), 'content to move');
  });

  test('saveSettings поддерживает частичные обновления без rescan папки Songs', async () => {
    // Устанавливаем базовые валидные настройки
    const base = await saveSettings({
      osuPath: mockSongsDir,
      checkExisting: true,
      postDownloadAction: 'none',
    });
    assert.equal(base.valid, true);
    assert.equal(base.checkExisting, true);
    assert.equal(base.postDownloadAction, 'none');
    assert.equal(base.songsCount >= 4, true);

    // Подменяем fs.readdirSync чтобы проверить отсутствие лишнего вызова при частичном апдейте
    let readdirSyncCalls = 0;
    const originalReaddirSync = fs.readdirSync;
    // @ts-ignore
    fs.readdirSync = (dirPath, opts) => {
      readdirSyncCalls++;
      // @ts-ignore
      return originalReaddirSync(dirPath, opts);
    };

    try {
      // 1. Частичный апдейт: только checkExisting
      const updatedCheck = await saveSettings({ checkExisting: false });
      assert.equal(updatedCheck.checkExisting, false);
      assert.equal(updatedCheck.postDownloadAction, 'none');
      assert.equal(updatedCheck.valid, true);
      assert.equal(updatedCheck.osuPath, base.osuPath);
      assert.equal(updatedCheck.songsDir, base.songsDir);
      assert.equal(updatedCheck.songsCount, base.songsCount);
      assert.equal(readdirSyncCalls, 0, 'fs.readdirSync не должен вызываться при неизменном пути');

      // 2. Частичный апдейт: только postDownloadAction
      const updatedAction = await saveSettings({ postDownloadAction: 'move' });
      assert.equal(updatedAction.postDownloadAction, 'move');
      assert.equal(updatedAction.checkExisting, false);
      assert.equal(updatedAction.valid, true);
      assert.equal(readdirSyncCalls, 0, 'fs.readdirSync не должен вызываться при неизменном пути');

      // 3. Апдейт с тем же самым osuPath не должен принудительно пересканировать диск
      const samePath = await saveSettings({ osuPath: mockSongsDir });
      assert.equal(samePath.valid, true);
      assert.equal(readdirSyncCalls, 0, 'fs.readdirSync не должен вызываться при повторной передаче того же пути');
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    // 4. Попытка передать невалидный osuPath выбрасывает ошибку
    await assert.rejects(
      async () => {
        await saveSettings({ osuPath: path.join(tempBaseDir, 'non_existent_osu_dir_xyz') });
      },
      /Директория Songs не найдена/
    );
  });

  test('handlePostDownload: режим move перемещает .osz в Songs', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'move',
      });

      const setId = 88001;
      const oszPath = path.join(mockDownloadsDir, `${setId}.osz`);
      await fs.promises.writeFile(oszPath, 'osz content');

      await handlePostDownload(setId, { id: 'job_test' });

      assert.equal(fs.existsSync(oszPath), false, 'Файл должен быть перемещен из downloads');
      const targetInSongs = path.join(mockSongsDir, `${setId}.osz`);
      assert.equal(fs.existsSync(targetInSongs), true, 'Файл должен оказаться в Songs');
      assert.equal(isSetInOsuSongs(setId), true, 'Набор должен появиться в кэше установленных');
      // Очистка
      await fs.promises.unlink(targetInSongs).catch(() => {});
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('handlePostDownload: режим copy копирует .osz в Songs, сохраняя оригинал', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'copy',
      });

      const setId = 88002;
      const oszPath = path.join(mockDownloadsDir, `${setId}.osz`);
      await fs.promises.writeFile(oszPath, 'osz content copy');

      await handlePostDownload(setId, { id: 'job_test' });

      assert.equal(fs.existsSync(oszPath), true, 'Оригинал должен остаться в downloads');
      const targetInSongs = path.join(mockSongsDir, `${setId}.osz`);
      assert.equal(fs.existsSync(targetInSongs), true, 'Копия должна быть в Songs');
      // Очистка
      await fs.promises.unlink(oszPath).catch(() => {});
      await fs.promises.unlink(targetInSongs).catch(() => {});
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('handlePostDownload: режим extract распаковывает .osz в папку карты в Songs', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'extract',
      });

      const setId = 88003;
      const oszPath = path.join(mockDownloadsDir, `${setId}.osz`);
      const mockZip = createMockZip({
        'audio.mp3': 'mp3 data',
        'diff.osu': 'osu format',
      });
      await fs.promises.writeFile(oszPath, mockZip);

      const mockJob = {
        id: 'job_test_extract',
        mapsById: new Map([
          [setId, { artist: 'Camellia', title: 'GHOST' }],
        ]),
      };

      await handlePostDownload(setId, mockJob);

      assert.equal(fs.existsSync(oszPath), false, 'Временный .osz должен быть удален');
      const targetFolder = path.join(mockSongsDir, '88003 Camellia - GHOST');
      assert.equal(fs.existsSync(targetFolder), true, 'Папка карты должна быть создана в Songs');
      assert.equal(fs.existsSync(path.join(targetFolder, 'audio.mp3')), true);
      assert.equal(fs.existsSync(path.join(targetFolder, 'diff.osu')), true);

      // Очистка
      await fs.promises.rm(targetFolder, { recursive: true, force: true }).catch(() => {});
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('handlePostDownload: режим extract при битом архиве не оставляет папку в Songs и не помечает карту установленной', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'extract',
      });

      const setId = 88004;
      const oszPath = path.join(mockDownloadsDir, `${setId}.osz`);
      const corruptZip = createMockZip({
        'audio.mp3': 'mp3 data',
        'diff.osu': { content: 'broken content', crc: 0x11223344 },
      });
      await fs.promises.writeFile(oszPath, corruptZip);

      const mockJob = {
        id: 'job_test_corrupt_extract',
        mapsById: new Map([
          [setId, { artist: 'Broken', title: 'Song' }],
        ]),
      };

      await assert.rejects(
        async () => {
          await handlePostDownload(setId, mockJob);
        },
        /контрольной суммы CRC32/
      );

      const targetFolder = path.join(mockSongsDir, '88004 Broken - Song');
      assert.equal(fs.existsSync(targetFolder), false, 'Папка карты НЕ должна быть создана в Songs при ошибке распаковки');
      assert.equal(isSetInOsuSongs(setId), false, 'Набор НЕ должен помечаться как установленный в osu!');
      assert.equal(fs.existsSync(oszPath), true, 'Исходный .osz не должен удаляться при ошибке');

      // Очистка
      await fs.promises.unlink(oszPath).catch(() => {});
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('classifyCollectionSets правильно категоризирует наборы в игре и в downloads', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'none',
      });

      // 10001 есть в Songs
      // 55001 создаем в downloads
      await fs.promises.writeFile(path.join(mockDownloadsDir, '55001.osz'), 'downloaded');
      // 99999 нет нигде

      const res = classifyCollectionSets([10001, 55001, 99999]);
      assert.deepEqual(res.installedSetIds, [10001]);
      assert.deepEqual(res.downloadedSetIds, [55001]);

      // Очистка
      await fs.promises.unlink(path.join(mockDownloadsDir, '55001.osz')).catch(() => {});
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('Сквозной сценарий: если набор уже есть в osu! Songs, загрузчик мгновенно пропускает его', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    try {
      await saveSettings({
        osuPath: mockSongsDir,
        checkExisting: true,
        postDownloadAction: 'none',
      });

      // 10001 уже присутствует в mockSongsDir
      const job = {
        id: 'job_skip_osu_test',
        method: 'mirror',
        collectionId: 999,
        collectionName: 'Test Collection',
        setIds: [10001],
        doneIds: new Set(),
        skipIds: new Set(),
        errIds: new Set(),
        errorsById: new Map(),
        mapsById: new Map([[10001, { label: 'Artist - Title One' }]]),
        currentBytes: 0,
        currentTotalBytes: null,
        currentPercent: 0,
        currentMirror: null,
        status: 'queued',
        message: 'Старт',
      };
      jobs.set(job.id, job);

      launchJob(job, { kind: 'mirror' });

      // Даем циклу запуститься
      for (let i = 0; i < 20; i++) {
        if (job.status === 'finished') break;
        await new Promise(r => setTimeout(r, 50));
      }

      assert.equal(job.status, 'finished');
      assert.equal(job.skipIds.has(10001), true, 'Набор 10001 должен быть пропущен');
      assert.equal(job.doneIds.size, 0, 'Ничего не должно быть скачано');
      assert.equal(job.message.includes('уже есть'), true, 'Сообщение должно указывать, что наборы уже в библиотеке');
    } finally {
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });

  test('HTTP API эндпоинты интеграции с osu! Songs', async () => {
    const originalDownloads = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = mockDownloadsDir;
    const { server } = require('../server.js');
    let testServer;
    let testPort;

    testServer = http.createServer((req, res) => {
      server.emit('request', req, res);
    });
    await new Promise(r => testServer.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
    testPort = /** @type {import('node:net').AddressInfo} */ (testServer.address()).port;

    try {
      // 1. GET /api/osu/settings
      const getRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/settings`);
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(typeof getBody.checkExisting, 'boolean');

      // 2. POST /api/osu/settings с валидным путем
      const postRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osuPath: mockSongsDir,
          checkExisting: true,
          postDownloadAction: 'move',
        }),
      });
      assert.equal(postRes.status, 200);
      const postBody = await postRes.json();
      assert.equal(postBody.valid, true);
      assert.equal(postBody.songsCount >= 4, true);
      assert.equal(postBody.postDownloadAction, 'move');

      // 2a. POST /api/osu/settings частичное обновление без osuPath
      const partialRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkExisting: false,
          postDownloadAction: 'copy',
        }),
      });
      assert.equal(partialRes.status, 200);
      const partialBody = await partialRes.json();
      assert.equal(partialBody.checkExisting, false);
      assert.equal(partialBody.postDownloadAction, 'copy');
      assert.equal(partialBody.valid, true);
      assert.equal(partialBody.songsDir, mockSongsDir);
      assert.equal(partialBody.songsCount >= 4, true);

      // 3. POST /api/osu/settings с невалидным путем
      const badRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osuPath: path.join(tempBaseDir, 'invalid_path_12345'),
        }),
      });
      assert.equal(badRes.status, 400);

      // 4. POST /api/osu/rescan
      const rescanRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/rescan`, { method: 'POST' });
      assert.equal(rescanRes.status, 200);
      const rescanBody = await rescanRes.json();
      assert.equal(rescanBody.songsCount >= 4, true);

      // 5. POST /api/osu/check
      const checkRes = await fetch(`http://127.0.0.1:${testPort}/api/osu/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setIds: [10001, 10002, 999999] }),
      });
      assert.equal(checkRes.status, 200);
      const checkBody = await checkRes.json();
      assert.deepEqual(checkBody.installedSetIds.sort(), [10001, 10002]);
    } finally {
      await new Promise(r => testServer.close(r));
      if (originalDownloads !== undefined) process.env.DOWNLOADS_DIR = originalDownloads;
      else delete process.env.DOWNLOADS_DIR;
    }
  });
});
