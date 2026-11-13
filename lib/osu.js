// @ts-check
"use strict";

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { getDownloadsDir, log } = require('./config.js');
const { safeErrorMessage } = require('./security.js');

/**
 * @typedef {'none' | 'move' | 'extract' | 'copy'} PostDownloadAction
 *
 * @typedef {Object} OsuSettings
 * @property {string} osuPath
 * @property {string | null} songsDir
 * @property {boolean} valid
 * @property {number} songsCount
 * @property {boolean} checkExisting
 * @property {PostDownloadAction} postDownloadAction
 */

/** @type {OsuSettings | null} */
let currentSettings = null;

let cachedSongsDir = null;
/** @type {Set<number> | null} */
let cachedSongsSet = null;
let cachedSongsTimestamp = 0;
const CACHE_TTL_MS = 45 * 1000;

/**
 * Очищает строку пути от пробелов и обрамляющих кавычек.
 * @param {string | null | undefined} rawPath
 * @returns {string}
 */
function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath.trim().replace(/^["']+|["']+$/g, '').trim();
}

/**
 * Разрешает переданный путь к директории Songs игры osu!.
 * Поддерживает как путь к корню игры (например, D:\Games\osu!),
 * так и прямой путь к папке Songs (D:\Games\osu!\Songs).
 * @param {string | null | undefined} rawPath
 * @returns {string | null}
 */
function resolveOsuSongsDir(rawPath) {
  const cleaned = sanitizePath(rawPath);
  if (!cleaned) return null;
  const resolved = path.resolve(cleaned);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;

    // 1. Проверяем подпапку Songs
    const candidateSongs = path.join(resolved, 'Songs');
    try {
      const subStat = fs.statSync(candidateSongs);
      if (subStat.isDirectory()) return candidateSongs;
    } catch { }

    // 2. Если сама папка называется Songs / songs
    if (path.basename(resolved).toLowerCase() === 'songs') {
      return resolved;
    }

    // 3. Проверяем подпапку songs в нижнем регистре (Linux / Wine)
    const candidateLower = path.join(resolved, 'songs');
    try {
      const subLower = fs.statSync(candidateLower);
      if (subLower.isDirectory()) return candidateLower;
    } catch { }

    // 4. Если внутри есть числовые папки карт, считаем, что это директория Songs с нестандартным именем
    const entries = fs.readdirSync(resolved);
    if (entries.some(e => /^\d+\b/.test(e))) {
      return resolved;
    }
  } catch { }
  return null;
}

/**
 * Ищет стандартные пути osu! в системе.
 * @returns {string | null}
 */
function getDefaultOsuPath() {
  const envSongs = sanitizePath(process.env.OSU_SONGS_DIR);
  if (envSongs) {
    const resolved = resolveOsuSongsDir(envSongs);
    if (resolved) return resolved;
  }
  const envPath = sanitizePath(process.env.OSU_PATH);
  if (envPath) {
    const resolved = resolveOsuSongsDir(envPath);
    if (resolved) return resolved;
  }

  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  // Путь пользователя из запроса
  const testPath = 'D:\\Games\\osu!\\Songs';
  const resolvedTest = resolveOsuSongsDir(testPath);
  if (resolvedTest) return resolvedTest;

  const testRoot = 'D:\\Games\\osu!';
  const resolvedRoot = resolveOsuSongsDir(testRoot);
  if (resolvedRoot) return resolvedRoot;

  // Стандартный путь osu! в %LOCALAPPDATA%
  if (process.env.LOCALAPPDATA) {
    const defaultLocal = path.join(process.env.LOCALAPPDATA, 'osu!', 'Songs');
    const resolvedLocal = resolveOsuSongsDir(defaultLocal);
    if (resolvedLocal) return resolvedLocal;
  }

  return null;
}

/**
 * Возвращает путь к файлу настроек приложения.
 * @returns {string}
 */
function getSettingsFilePath() {
  return path.join(getDownloadsDir(), '.settings.json');
}

/**
 * Синхронно сканирует директорию Songs и извлекает все уникальные ID наборов карт.
 * @param {string} songsDir
 * @returns {Set<number>}
 */
function scanOsuSongsSync(songsDir) {
  const result = new Set();
  try {
    const entries = fs.readdirSync(songsDir);
    for (const entry of entries) {
      // Имя папки вида "12345 Artist - Title" или просто "12345"
      // Либо файл .osz "12345.osz" или "12345 Artist - Title.osz"
      const match = entry.match(/^(\d+)(?:\D.*)?$/);
      if (match) {
        const id = Number(match[1]);
        if (Number.isSafeInteger(id) && id > 0) {
          result.add(id);
        }
      }
    }
  } catch (err) {
    log('warn', 'osu.songs.scan_failed', { dir: songsDir, error: safeErrorMessage(err) });
  }
  return result;
}

/**
 * Возвращает кэшированный список ID наборов карт в osu! Songs.
 * @param {string} songsDir
 * @param {boolean} [forceRefresh=false]
 * @returns {Set<number>}
 */
function getCachedOsuSongs(songsDir, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSongsSet && cachedSongsDir === songsDir && (now - cachedSongsTimestamp < CACHE_TTL_MS)) {
    return cachedSongsSet;
  }
  cachedSongsDir = songsDir;
  cachedSongsSet = scanOsuSongsSync(songsDir);
  cachedSongsTimestamp = now;
  return cachedSongsSet;
}

/**
 * Сбрасывает кэш списка карт.
 */
function invalidateCachedSongs() {
  cachedSongsSet = null;
  cachedSongsTimestamp = 0;
}

/**
 * Добавляет набор в кэш без полного пересканирования директории.
 * @param {number} setId
 */
function addInstalledSetId(setId) {
  if (cachedSongsSet && Number.isSafeInteger(setId)) {
    cachedSongsSet.add(Number(setId));
  }
}

/**
 * Загружает настройки интеграции с диска или инициализирует значениями по умолчанию.
 * @returns {OsuSettings}
 */
function loadSettings() {
  const settingsFile = getSettingsFilePath();
  let fileData = null;
  try {
    const content = fs.readFileSync(settingsFile, 'utf8');
    fileData = JSON.parse(content);
  } catch { }

  const rawPath = fileData?.osuPath ?? getDefaultOsuPath() ?? '';
  const resolved = resolveOsuSongsDir(rawPath);
  const valid = Boolean(resolved);
  const songsCount = valid ? getCachedOsuSongs(resolved).size : 0;
  const checkExisting = fileData?.checkExisting !== undefined ? Boolean(fileData.checkExisting) : true;
  /** @type {PostDownloadAction} */
  const postDownloadAction = ['none', 'move', 'extract', 'copy'].includes(fileData?.postDownloadAction)
    ? fileData.postDownloadAction
    : 'none';

  currentSettings = {
    osuPath: rawPath,
    songsDir: resolved,
    valid,
    songsCount,
    checkExisting,
    postDownloadAction,
  };

  return currentSettings;
}

/**
 * Возвращает текущие настройки (загружает при необходимости).
 * @returns {OsuSettings}
 */
function getSettings() {
  if (!currentSettings) {
    return loadSettings();
  }
  return currentSettings;
}

/**
 * Сохраняет настройки на диск.
 * @param {Partial<OsuSettings>} [patch={}]
 * @returns {Promise<OsuSettings>}
 */
async function saveSettings(patch = {}) {
  const current = getSettings();
  const isPathSpecified = patch.osuPath !== undefined;
  let rawPath = isPathSpecified ? sanitizePath(patch.osuPath) : current.osuPath;
  let resolved = isPathSpecified ? resolveOsuSongsDir(rawPath) : current.songsDir;
  let valid = Boolean(resolved);

  if (isPathSpecified && rawPath && !valid) {
    throw new Error('Директория Songs не найдена по указанному пути. Проверьте путь к папке игры osu!.');
  }

  const checkExisting = patch.checkExisting !== undefined ? Boolean(patch.checkExisting) : current.checkExisting;
  /** @type {PostDownloadAction} */
  const postDownloadAction = ['none', 'move', 'extract', 'copy'].includes(patch.postDownloadAction)
    ? patch.postDownloadAction
    : current.postDownloadAction;

  const pathChanged = resolved !== current.songsDir;
  if (pathChanged) {
    invalidateCachedSongs();
  }
  const songsCount = valid ? getCachedOsuSongs(resolved, pathChanged).size : 0;

  currentSettings = {
    osuPath: rawPath,
    songsDir: resolved,
    valid,
    songsCount,
    checkExisting,
    postDownloadAction,
  };

  const toSave = {
    osuPath: currentSettings.osuPath,
    checkExisting: currentSettings.checkExisting,
    postDownloadAction: currentSettings.postDownloadAction,
  };

  const settingsFile = getSettingsFilePath();
  const dir = path.dirname(settingsFile);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${settingsFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(toSave, null, 2), 'utf8');
  try {
    await fs.promises.rename(tempPath, settingsFile);
  } catch {
    await fs.promises.unlink(settingsFile).catch(() => { });
    await fs.promises.rename(tempPath, settingsFile);
  }

  log('info', 'osu.settings.saved', {
    osuPath: currentSettings.osuPath,
    valid: currentSettings.valid,
    songsCount: currentSettings.songsCount,
    action: currentSettings.postDownloadAction,
  });

  return currentSettings;
}

/**
 * Проверяет, установлен ли конкретный набор в osu! Songs.
 * @param {number | string} setId
 * @returns {boolean}
 */
function isSetInOsuSongs(setId) {
  const settings = getSettings();
  if (!settings.valid || !settings.songsDir || !settings.checkExisting) return false;
  const numId = Number(setId);
  if (!Number.isSafeInteger(numId) || numId <= 0) return false;
  const set = getCachedOsuSongs(settings.songsDir);
  return set.has(numId);
}

/**
 * Разделяет массив ID наборов на установленные в игре и скачанные в downloads.
 * @param {Array<number | string>} setIds
 * @returns {{ installedSetIds: number[], downloadedSetIds: number[] }}
 */
function classifyCollectionSets(setIds) {
  const settings = getSettings();
  const installedSetIds = [];
  const downloadedSetIds = [];
  const downloadsDir = getDownloadsDir();

  const osuSet = (settings.valid && settings.songsDir && settings.checkExisting)
    ? getCachedOsuSongs(settings.songsDir)
    : null;

  for (const rawId of (setIds || [])) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    if (osuSet && osuSet.has(id)) {
      installedSetIds.push(id);
      continue;
    }

    const oszPath = path.join(downloadsDir, `${id}.osz`);
    try {
      const stat = fs.statSync(oszPath);
      if (stat.size > 0) {
        downloadedSetIds.push(id);
      }
    } catch { }
  }

  return { installedSetIds, downloadedSetIds };
}

/**
 * Регулярное выражение для зарезервированных имён устройств Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Распаковывает ZIP/.osz архив в указанную директорию (Zero-Dependency).
 * Защищен от атак Zip Slip, NTFS ADS (:), зарезервированных имён Windows и повреждения CRC32.
 * Распаковка производится атомарно через временную папку: при любой ошибке (включая несовпадение CRC32)
 * временные файлы удаляются, а целевая директория не загрязняется битыми файлами.
 * Поддерживает как стандартный формат ZIP, так и спецификацию ZIP64, методы сжатия 0 (STORED) и 8 (DEFLATE).
 * @param {string} zipFilePath
 * @param {string} targetDir
 * @returns {Promise<number>} Количество извлеченных файлов
 */
async function extractZip(zipFilePath, targetDir) {
  const buf = await fs.promises.readFile(zipFilePath);
  if (buf.length < 22) throw new Error('Некорректный ZIP-архив: размер файла меньше 22 байт.');

  // Поиск конца центрального каталога (EOCD) с конца файла
  let eocdOffset = -1;
  const searchLimit = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchLimit; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Некорректный ZIP-архив: сигнатура EOCD не найдена.');
  }

  let totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdSize = buf.readUInt32LE(eocdOffset + 12);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // Проверка на ZIP64: наличие ZIP64 Locator перед EOCD или флаги переполнения 0xFFFF / 0xFFFFFFFF
  const hasZip64Locator = eocdOffset >= 20 && buf.readUInt32LE(eocdOffset - 20) === 0x07064b50;
  if (hasZip64Locator || totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    let locatorOffset = -1;
    if (hasZip64Locator) {
      locatorOffset = eocdOffset - 20;
    } else {
      for (let i = eocdOffset - 20; i >= Math.max(0, eocdOffset - 128); i--) {
        if (buf.readUInt32LE(i) === 0x07064b50) {
          locatorOffset = i;
          break;
        }
      }
    }

    if (locatorOffset !== -1) {
      const zip64EocdOffset = Number(buf.readBigUInt64LE(locatorOffset + 8));
      if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= buf.length && buf.readUInt32LE(zip64EocdOffset) === 0x06064b50) {
        totalEntries = Number(buf.readBigUInt64LE(zip64EocdOffset + 32));
        cdSize = Number(buf.readBigUInt64LE(zip64EocdOffset + 40));
        cdOffset = Number(buf.readBigUInt64LE(zip64EocdOffset + 48));
      }
    }
  }

  if (cdOffset + cdSize > buf.length) {
    throw new Error('Некорректный ZIP-архив: центральный каталог выходит за пределы файла.');
  }

  const resolvedTarget = path.resolve(targetDir);
  const parentDir = path.dirname(resolvedTarget);
  await fs.promises.mkdir(parentDir, { recursive: true });

  // Атомарная распаковка через временную папку в той же родительской директории
  const stagingName = `.tmp_extract_${path.basename(resolvedTarget)}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const stagingDir = path.join(parentDir, stagingName);
  await fs.promises.mkdir(stagingDir, { recursive: true });

  let renamed = false;
  let extractedCount = 0;

  try {
    let cur = cdOffset;
    for (let entry = 0; entry < totalEntries && cur < cdOffset + cdSize; entry++) {
      if (cur + 46 > buf.length || buf.readUInt32LE(cur) !== 0x02014b50) break;

      const method = buf.readUInt16LE(cur + 10);
      const expectedCrc = buf.readUInt32LE(cur + 16);
      let compSize = buf.readUInt32LE(cur + 20);
      let uncompSize = buf.readUInt32LE(cur + 24);
      const nameLen = buf.readUInt16LE(cur + 28);
      const extraLen = buf.readUInt16LE(cur + 30);
      const commentLen = buf.readUInt16LE(cur + 32);
      let localHeaderOffset = buf.readUInt32LE(cur + 42);

      if (cur + 46 + nameLen > buf.length) {
        throw new Error('Некорректный заголовок файла в ZIP-архиве.');
      }
      const rawName = buf.toString('utf8', cur + 46, cur + 46 + nameLen);

      // Чтение ZIP64 Extra field (Tag 0x0001) при необходимости
      if (extraLen > 0 && (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff)) {
        const extraStart = cur + 46 + nameLen;
        const extraEnd = Math.min(extraStart + extraLen, buf.length);
        let ep = extraStart;
        while (ep + 4 <= extraEnd) {
          const tag = buf.readUInt16LE(ep);
          const sz = buf.readUInt16LE(ep + 2);
          if (tag === 0x0001) {
            let dp = ep + 4;
            const dend = Math.min(dp + sz, extraEnd);
            if (uncompSize === 0xffffffff && dp + 8 <= dend) {
              uncompSize = Number(buf.readBigUInt64LE(dp));
              dp += 8;
            }
            if (compSize === 0xffffffff && dp + 8 <= dend) {
              compSize = Number(buf.readBigUInt64LE(dp));
              dp += 8;
            }
            if (localHeaderOffset === 0xffffffff && dp + 8 <= dend) {
              localHeaderOffset = Number(buf.readBigUInt64LE(dp));
              dp += 8;
            }
            break;
          }
          ep += 4 + sz;
        }
      }

      cur += 46 + nameLen + extraLen + commentLen;

      // Нормализация имени пути и защита от Zip Slip, NTFS ADS (:), управляющих символов и зарезервированных имён Windows
      const normalizedName = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
      const parts = normalizedName.split('/').filter(p => p && p !== '.' && p !== '..');

      // Отсекаем альтернативные потоки данных NTFS (:), управляющие символы и зарезервированные имена устройств (CON, PRN, AUX, NUL)
      if (parts.some(p => p.includes(':') || /[\x00-\x1f]/.test(p) || WINDOWS_RESERVED_NAMES.test(p))) {
        continue;
      }

      // Очищаем хвостовые точки и пробелы для Windows-совместимости
      const cleanedParts = parts.map(p => p.replace(/[.\s]+$/, '')).filter(Boolean);
      if (cleanedParts.length === 0) continue;

      const safePath = path.resolve(stagingDir, ...cleanedParts);
      if (!safePath.startsWith(stagingDir + path.sep) && safePath !== stagingDir) {
        continue; // Защита от выхода за пределы папки распаковки
      }

      if (rawName.endsWith('/') || rawName.endsWith('\\')) {
        await fs.promises.mkdir(safePath, { recursive: true });
        continue;
      }

      if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('Поврежден локальный заголовок файла в ZIP-архиве.');
      }

      const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + lhNameLen + lhExtraLen;

      if (dataOffset + compSize > buf.length) {
        throw new Error('Неожиданный конец данных файла в ZIP-архиве.');
      }

      const compData = buf.subarray(dataOffset, dataOffset + compSize);

      let data;
      if (compSize === 0 && uncompSize === 0) {
        data = Buffer.alloc(0);
      } else if (method === 0) {
        data = compData;
      } else if (method === 8) {
        data = zlib.inflateRawSync(compData);
      } else {
        throw new Error(`Неподдерживаемый метод сжатия в архиве: ${method}`);
      }

      if (data.length !== uncompSize) {
        throw new Error(`Несоответствие размера распакованного файла "${rawName}": ожидалось ${uncompSize} байт, получено ${data.length}.`);
      }

      const actualCrc = zlib.crc32(data);
      if (actualCrc !== expectedCrc) {
        throw new Error(`Несоответствие контрольной суммы CRC32 для файла "${rawName}": ожидалось 0x${expectedCrc.toString(16).padStart(8, '0')}, получено 0x${actualCrc.toString(16).padStart(8, '0')}.`);
      }

      await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
      await fs.promises.writeFile(safePath, data);
      extractedCount += 1;
    }

    // Атомарное перемещение stagingDir в resolvedTarget
    if (fs.existsSync(resolvedTarget)) {
      await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.rename(stagingDir, resolvedTarget);
        renamed = true;
        break;
      } catch (renameErr) {
        if (attempt === 4) throw renameErr;
        await new Promise(r => setTimeout(r, 50));
      }
    }
  } finally {
    if (!renamed) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return extractedCount;
}

/**
 * Безопасно перемещает файл между дисками (rename с фоллбэком на copyFile + unlink).
 * @param {string} source
 * @param {string} target
 * @returns {Promise<void>}
 */
async function moveFile(source, target) {
  try {
    await fs.promises.rename(source, target);
  } catch (err) {
    const error = /** @type {any} */ (err);
    if (error && (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EBUSY')) {
      await fs.promises.copyFile(source, target);
      await fs.promises.unlink(source);
    } else {
      throw err;
    }
  }
}

/**
 * Формирует валидное имя папки для набора карт osu!.
 * Очищает запрещенные символы, нормализует пробелы и удаляет хвостовые точки и пробелы,
 * предотвращая ошибки Win32 API и коллизии файловой системы.
 * @param {number} setId
 * @param {any} [mapInfo]
 * @returns {string}
 */
function buildBeatmapFolderName(setId, mapInfo) {
  let label = '';
  if (mapInfo?.artist && mapInfo?.title) {
    label = `${mapInfo.artist} - ${mapInfo.title}`;
  } else if (mapInfo?.label) {
    label = mapInfo.label;
  }
  const cleanLabel = String(label || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[.\s]+$/, '');

  const folderName = cleanLabel ? `${setId} ${cleanLabel}` : String(setId);
  return folderName.replace(/[.\s]+$/, '');
}

/**
 * Выполняет пост-обработку скачанного набора (перемещение, распаковка, копирование в Songs).
 * @param {number} setId
 * @param {any} job
 * @returns {Promise<void>}
 */
async function handlePostDownload(setId, job) {
  const settings = getSettings();
  if (!settings.valid || !settings.songsDir) return;
  const action = settings.postDownloadAction;
  if (!action || action === 'none') return;

  const oszPath = path.join(getDownloadsDir(), `${setId}.osz`);
  try {
    const stat = await fs.promises.stat(oszPath);
    if (stat.size <= 0) return;
  } catch {
    return;
  }

  const songsDir = settings.songsDir;
  await fs.promises.mkdir(songsDir, { recursive: true });

  if (action === 'move') {
    const targetPath = path.join(songsDir, `${setId}.osz`);
    await moveFile(oszPath, targetPath);
    addInstalledSetId(setId);
    log('info', 'osu.post_download.moved', { jobId: job?.id, setId, target: targetPath });
  } else if (action === 'copy') {
    const targetPath = path.join(songsDir, `${setId}.osz`);
    await fs.promises.copyFile(oszPath, targetPath);
    addInstalledSetId(setId);
    log('info', 'osu.post_download.copied', { jobId: job?.id, setId, target: targetPath });
  } else if (action === 'extract') {
    const mapInfo = job.mapsById?.get(setId);
    const folderName = buildBeatmapFolderName(setId, mapInfo);
    const targetFolder = path.join(songsDir, folderName);
    await extractZip(oszPath, targetFolder);
    await fs.promises.unlink(oszPath).catch(() => { });
    addInstalledSetId(setId);
    log('info', 'osu.post_download.extracted', { jobId: job?.id, setId, targetFolder });
  }
}

module.exports = {
  sanitizePath,
  resolveOsuSongsDir,
  getDefaultOsuPath,
  getSettingsFilePath,
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
};
