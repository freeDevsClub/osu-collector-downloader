// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { getDownloadsDir, getDataDir, log, formatBytes } = require('./config.js');
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
/** @type {Promise<Set<number>> | null} */
let ongoingSongsScanPromise = null;
const CACHE_TTL_MS = 45 * 1000;

let cachedDownloadsDir = null;
/** @type {Set<number> | null} */
let cachedDownloadsSet = null;
let cachedDownloadsTimestamp = 0;
const DOWNLOADS_CACHE_TTL_MS = 2000;
const verifiedNonEmptyOsz = new Set();

/**
 * Очищает строку пути от пробелов и обрамляющих кавычек.
 * @param {string | null | undefined} rawPath
 * @returns {string}
 */
function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/**
 * Проверяет, является ли путь запрещённым системным каталогом или корнем диска.
 * Работает кросс-платформенно (Windows / Linux / macOS).
 * @param {string} dirPath
 * @returns {boolean}
 */
function isForbiddenSystemDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return true;
  const raw = dirPath.trim();
  if (!raw) return true;

  // Запрещены корневые каталоги дисков Windows (C:, C:\, C:/, D:, etc.) независимо от текущей ОС
  if (/^[a-zA-Z]:[\\/]*$/.test(raw)) return true;

  // Запрещены корневые каталоги POSIX (/ и //)
  if (/^\/+$/.test(raw)) return true;

  const norm = path.resolve(raw).toLowerCase();
  const parsed = path.parse(norm);
  // Запрещены корневые каталоги файловой системы (C:\, /, etc.)
  if (parsed.root.toLowerCase() === norm) return true;

  // Запрещены известные системные каталоги Unix
  const unixNorm = raw.replace(/\\/g, '/').toLowerCase();
  const unixSystemDirs = ['/proc', '/sys', '/dev', '/etc', '/bin', '/sbin', '/usr', '/var'];
  if (unixSystemDirs.some((p) => unixNorm === p || unixNorm.startsWith(p + '/'))) {
    return true;
  }

  // Запрещены известные системные каталоги Windows
  const winEnv = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ]
    .filter(Boolean)
    .map((p) => path.resolve(/** @type {string} */ (p)).toLowerCase());

  if (winEnv.some((s) => norm === s || norm.startsWith(s + path.sep))) return true;

  return false;
}

/**
 * Разрешает переданный путь к директории Songs игры osu!.
 * Поддерживает:
 * 1. Путь к папке osu!, содержащей подпапку Songs/songs (даже если остальные файлы игры находятся на другом диске).
 * 2. Прямой путь к папке Songs/songs (включая расположение на отдельном диске, например D:\Songs или D:\osu!\Songs).
 * 3. Нестандартные имена папок карт, содержащие реальные beatmap-наборы (.osu файлы, .osz или папки наборов).
 * Блокирует корни дисков (C:\, D:\) и системные каталоги.
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

    if (isForbiddenSystemDir(resolved)) return null;

    // 1. Проверяем подпапку Songs (работает, даже если на этом диске лежит ТОЛЬКО папка Songs)
    const candidateSongs = path.join(resolved, 'Songs');
    try {
      const subStat = fs.statSync(candidateSongs);
      if (subStat.isDirectory()) return candidateSongs;
    } catch {}

    // 2. Если сама папка называется Songs / songs (прямой путь к Songs на любом диске)
    if (path.basename(resolved).toLowerCase() === 'songs') {
      return resolved;
    }

    // 3. Проверяем подпапку songs в нижнем регистре (Linux / Wine)
    const candidateLower = path.join(resolved, 'songs');
    try {
      const subLower = fs.statSync(candidateLower);
      if (subLower.isDirectory()) return candidateLower;
    } catch {}

    // 4. Нестандартная директория карт: проверяем наличие реальных beatmap-наборов
    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    // Проверяем наличие .osz архивов карт
    if (entries.some((e) => e.isFile() && /^\d{1,8}\.osz$/i.test(e.name))) {
      return resolved;
    }

    // Фильтруем подпапки, начинающиеся с ID набора карт (1-8 цифр)
    const candidateDirs = entries.filter((e) => e.isDirectory() && /^\d{1,8}(\s+.*)?$/.test(e.name));
    if (candidateDirs.length === 0) return null;

    // Проверяем содержимое поддиректорий на наличие файлов карт .osu
    for (const dir of candidateDirs.slice(0, 5)) {
      try {
        const subFiles = fs.readdirSync(path.join(resolved, dir.name));
        if (subFiles.some((f) => f.toLowerCase().endsWith('.osu'))) {
          return resolved;
        }
      } catch {}
    }

    // Если папки пустые, но соответствуют каноническому шаблону osu! "<setId> <Title>"
    if (candidateDirs.some((dir) => /^\d{1,8}\s+.+/.test(dir.name))) {
      return resolved;
    }
  } catch {}
  return null;
}

/**
 * Ищет стандартные пути osu! в системе.
 * @param {{ ignoreTestEnv?: boolean, drives?: string[] }} [options]
 * @returns {string | null}
 */
function getDefaultOsuPath(options = {}) {
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

  if (
    !options?.ignoreTestEnv &&
    (process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT))
  ) {
    return null;
  }

  // 1. Стандартный путь osu! в %LOCALAPPDATA% (официальный путь установки osu! на Windows)
  if (process.env.LOCALAPPDATA) {
    const defaultLocal = path.join(process.env.LOCALAPPDATA, 'osu!', 'Songs');
    const resolvedLocal = resolveOsuSongsDir(defaultLocal);
    if (resolvedLocal) return resolvedLocal;

    const defaultLocalRoot = path.join(process.env.LOCALAPPDATA, 'osu!');
    const resolvedLocalRoot = resolveOsuSongsDir(defaultLocalRoot);
    if (resolvedLocalRoot) return resolvedLocalRoot;
  }

  // 2. Стандартные пути для macOS / Linux
  if (process.platform === 'darwin') {
    const macCandidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'osu!', 'Songs'),
      path.join(os.homedir(), 'Library', 'Application Support', 'osu!'),
      path.join(os.homedir(), 'Library', 'Application Support', 'osu', 'Songs'),
      path.join(os.homedir(), 'Library', 'Application Support', 'osu'),
    ];
    for (const cand of macCandidates) {
      const resolved = resolveOsuSongsDir(cand);
      if (resolved) return resolved;
    }
  } else if (process.platform === 'linux') {
    const linuxCandidates = [
      path.join(os.homedir(), '.local', 'share', 'osu', 'Songs'),
      path.join(os.homedir(), '.local', 'share', 'osu'),
      path.join(os.homedir(), '.osu', 'Songs'),
      path.join(os.homedir(), '.osu'),
    ];
    for (const cand of linuxCandidates) {
      const resolved = resolveOsuSongsDir(cand);
      if (resolved) return resolved;
    }
  }

  // 3. Стандартные каталоги на Windows (Program Files, C:\Games\osu!, C:\osu!, а также перебор распространенных дисков)
  if (process.platform === 'win32' || process.env.LOCALAPPDATA) {
    /** @type {string[]} */
    const windowsCandidates = [];

    if (options?.drives === undefined || options.drives.length > 0) {
      if (process.env.ProgramFiles) {
        windowsCandidates.push(
          path.join(process.env.ProgramFiles, 'osu!', 'Songs'),
          path.join(process.env.ProgramFiles, 'osu!'),
        );
      }
      if (process.env['ProgramFiles(x86)']) {
        windowsCandidates.push(
          path.join(process.env['ProgramFiles(x86)'], 'osu!', 'Songs'),
          path.join(process.env['ProgramFiles(x86)'], 'osu!'),
        );
      }

      const commonDrives = options?.drives ?? ['C', 'D', 'E', 'F'];
      for (const drive of commonDrives) {
        windowsCandidates.push(
          `${drive}:\\Games\\osu!\\Songs`,
          `${drive}:\\Games\\osu!`,
          `${drive}:\\osu!\\Songs`,
          `${drive}:\\osu!`,
        );
      }
    }

    for (const cand of windowsCandidates) {
      const resolved = resolveOsuSongsDir(cand);
      if (resolved) return resolved;
    }
  }

  // 4. Значение по умолчанию (fallback), если директория osu! ещё не найдена на диске
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'osu!');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'osu!');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.local', 'share', 'osu');
  }
  return 'C:\\Games\\osu!';
}

/**
 * Возвращает путь к файлу настроек приложения.
 * Сохраняется в каталоге данных (DATA_DIR / CONFIG_DIR / data).
 * @returns {string}
 */
function getSettingsFilePath() {
  return path.join(getDataDir(), '.settings.json');
}

/**
 * Возвращает устаревший путь к файлу настроек в каталоге загрузок (для обратной совместимости).
 * @returns {string}
 */
function getLegacySettingsFilePath() {
  return path.join(getDownloadsDir(), '.settings.json');
}

/**
 * Синхронно сканирует директорию Songs и извлекает все уникальные ID наборов карт.
 * Защищена от ложных срабатываний:
 * - Игнорирует скрытые и staging-папки, начинающиеся с точки (.tmp_extract_*)
 * - Для файлов требует строго расширение .osz (файлы вроде "1000 notes.txt" или "999.bak" игнорируются)
 * - Для директорий требует наличие разделителя (пробел, точка, подчеркивание, дефис) после ID
 * - Для директорий без стандартного разделителя исполнитель/название (" - ") сверяет наличие хотя бы одного .osu файла
 * @param {string} songsDir
 * @returns {Set<number>}
 */
function scanOsuSongsSync(songsDir) {
  const result = new Set();
  try {
    const entries = fs.readdirSync(songsDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      // Игнорируем скрытые и staging-папки
      if (!name || name.startsWith('.')) continue;

      const isFile = typeof entry === 'string' ? null : entry.isFile();
      const isDir = typeof entry === 'string' ? null : entry.isDirectory();

      // 1. Файлы в Songs: считаются наборами только если это .osz архивы
      if (isFile === true || (isFile === null && !fs.statSync(path.join(songsDir, name)).isDirectory())) {
        const match = name.match(/^(\d+)(?:[.\s_-].*)?\.osz$/i);
        if (match) {
          const id = Number(match[1]);
          if (Number.isSafeInteger(id) && id > 0) {
            result.add(id);
          }
        }
        continue;
      }

      // 2. Директории в Songs
      if (isDir === true || isDir === null) {
        // Имя папки вида "12345 Artist - Title", "12345" или "12345_Artist_Title"
        const match = name.match(/^(\d+)(?:[\s._-](.*))?$/);
        if (!match) continue;

        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;

        const rest = match[2];
        // Если имя папки состоит только из цифр ("12345") или содержит стандартный разделитель " - " / " — "
        if (!rest || /[-—–]/.test(rest)) {
          result.add(id);
          continue;
        }

        // Если разделитель есть, но нет стандартного дефиса исполнителя/названия (например, "2024 favorites" или "1000 notes"),
        // проверяем наличие хотя бы одного .osu файла внутри, чтобы не принять пользовательскую папку за карту
        try {
          const subEntries = fs.readdirSync(path.join(songsDir, name));
          if (subEntries.some((f) => typeof f === 'string' && f.toLowerCase().endsWith('.osu'))) {
            result.add(id);
          }
        } catch {}
      }
    }
  } catch (err) {
    log('warn', 'osu.songs.scan_failed', { dir: songsDir, error: safeErrorMessage(err) });
  }
  return result;
}

/**
 * Асинхронно сканирует директорию Songs и извлекает все уникальные ID наборов карт.
 * Использует неблокирующий fs.promises.readdir, не блокируя Event Loop при десятках тысяч карт.
 * @param {string} songsDir
 * @returns {Promise<Set<number>>}
 */
async function scanOsuSongsAsync(songsDir) {
  const result = new Set();
  try {
    const entries = await fs.promises.readdir(songsDir, { withFileTypes: true });
    /** @type {Promise<void>[]} */
    const subCheckPromises = [];

    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      // Игнорируем скрытые и staging-папки
      if (!name || name.startsWith('.')) continue;

      const isFile = typeof entry === 'string' ? null : entry.isFile();
      const isDir = typeof entry === 'string' ? null : entry.isDirectory();

      // 1. Файлы в Songs (.osz архивы)
      if (
        isFile === true ||
        (isFile === null &&
          !(await fs.promises
            .stat(path.join(songsDir, name))
            .then((s) => s.isDirectory())
            .catch(() => true)))
      ) {
        const match = name.match(/^(\d+)(?:[.\s_-].*)?\.osz$/i);
        if (match) {
          const id = Number(match[1]);
          if (Number.isSafeInteger(id) && id > 0) {
            result.add(id);
          }
        }
        continue;
      }

      // 2. Директории в Songs
      if (isDir === true || isDir === null) {
        const match = name.match(/^(\d+)(?:[\s._-](.*))?$/);
        if (!match) continue;

        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;

        const rest = match[2];
        if (!rest || /[-—–]/.test(rest)) {
          result.add(id);
          continue;
        }

        // Для нестандартных имён проверяем наличие .osu файла асинхронно
        subCheckPromises.push(
          (async () => {
            try {
              const subEntries = await fs.promises.readdir(path.join(songsDir, name));
              if (subEntries.some((f) => typeof f === 'string' && f.toLowerCase().endsWith('.osu'))) {
                result.add(id);
              }
            } catch {}
          })(),
        );
      }
    }

    if (subCheckPromises.length > 0) {
      await Promise.all(subCheckPromises);
    }
  } catch (err) {
    log('warn', 'osu.songs.scan_failed', { dir: songsDir, error: safeErrorMessage(err) });
  }
  return result;
}

/**
 * Возвращает кэшированный список ID наборов карт в osu! Songs (асинхронно).
 * @param {string} songsDir
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Set<number>>}
 */
async function getCachedOsuSongsAsync(songsDir, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSongsSet && cachedSongsDir === songsDir && now - cachedSongsTimestamp < CACHE_TTL_MS) {
    return cachedSongsSet;
  }
  if (ongoingSongsScanPromise && cachedSongsDir === songsDir && !forceRefresh) {
    return ongoingSongsScanPromise;
  }
  cachedSongsDir = songsDir;
  ongoingSongsScanPromise = (async () => {
    try {
      const set = await scanOsuSongsAsync(songsDir);
      cachedSongsSet = set;
      cachedSongsTimestamp = Date.now();
      return set;
    } finally {
      ongoingSongsScanPromise = null;
    }
  })();
  return ongoingSongsScanPromise;
}

/**
 * Возвращает кэшированный список ID наборов карт в osu! Songs (синхронно, с поддержкой кэша).
 * @param {string} songsDir
 * @param {boolean} [forceRefresh=false]
 * @returns {Set<number>}
 */
function getCachedOsuSongs(songsDir, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSongsSet && cachedSongsDir === songsDir && now - cachedSongsTimestamp < CACHE_TTL_MS) {
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
  ongoingSongsScanPromise = null;
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
  } catch {
    const legacyFile = getLegacySettingsFilePath();
    if (settingsFile !== legacyFile) {
      try {
        const content = fs.readFileSync(legacyFile, 'utf8');
        fileData = JSON.parse(content);
        log('info', 'osu.settings.loaded_legacy', { legacyFile, targetFile: settingsFile });
      } catch {}
    }
  }

  const defaultFallback =
    process.env.NODE_ENV === 'test'
      ? ''
      : process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'osu!')
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'osu!')
          : process.platform === 'linux'
            ? path.join(os.homedir(), '.local', 'share', 'osu')
            : 'C:\\Games\\osu!';
  const rawPath = fileData?.osuPath ?? getDefaultOsuPath() ?? defaultFallback;
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
  const songsCount = valid ? (await getCachedOsuSongsAsync(resolved, pathChanged)).size : 0;

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
    await fs.promises.unlink(settingsFile).catch(() => {});
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
 * Синхронно сканирует директорию загрузок и возвращает Set ID скачанных .osz файлов с размером > 0.
 * @param {string} [downloadsDir]
 * @returns {Set<number>}
 */
function scanDownloadedSetsSync(downloadsDir = getDownloadsDir()) {
  const result = new Set();
  const currentEntries = new Set();
  try {
    const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name || name.startsWith('.')) continue;
      const isFile = typeof entry === 'string' ? null : entry.isFile() || entry.isSymbolicLink();
      if (isFile === false) continue;
      const match = name.match(/^(\d+)\.osz$/i);
      if (!match) continue;
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0) continue;

      currentEntries.add(id);
      if (verifiedNonEmptyOsz.has(id)) {
        result.add(id);
        continue;
      }

      try {
        const filePath = path.join(downloadsDir, name);
        const stat = fs.statSync(filePath);
        if (stat.size > 0) {
          verifiedNonEmptyOsz.add(id);
          result.add(id);
        }
      } catch {}
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'ENOENT') {
      log('warn', 'downloads.scan_failed', { dir: downloadsDir, error: safeErrorMessage(err) });
    }
  }

  for (const id of verifiedNonEmptyOsz) {
    if (!currentEntries.has(id)) {
      verifiedNonEmptyOsz.delete(id);
    }
  }

  return result;
}

/**
 * Асинхронно сканирует директорию загрузок и возвращает Set ID скачанных .osz файлов с размером > 0.
 * @param {string} [downloadsDir]
 * @returns {Promise<Set<number>>}
 */
async function scanDownloadedSetsAsync(downloadsDir = getDownloadsDir()) {
  const result = new Set();
  const currentEntries = new Set();
  try {
    const entries = await fs.promises.readdir(downloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name || name.startsWith('.')) continue;
      const isFile = typeof entry === 'string' ? null : entry.isFile() || entry.isSymbolicLink();
      if (isFile === false) continue;
      const match = name.match(/^(\d+)\.osz$/i);
      if (!match) continue;
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0) continue;

      currentEntries.add(id);
      if (verifiedNonEmptyOsz.has(id)) {
        result.add(id);
        continue;
      }

      try {
        const filePath = path.join(downloadsDir, name);
        const stat = await fs.promises.stat(filePath);
        if (stat.size > 0) {
          verifiedNonEmptyOsz.add(id);
          result.add(id);
        }
      } catch {}
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'ENOENT') {
      log('warn', 'downloads.scan_failed', { dir: downloadsDir, error: safeErrorMessage(err) });
    }
  }

  for (const id of verifiedNonEmptyOsz) {
    if (!currentEntries.has(id)) {
      verifiedNonEmptyOsz.delete(id);
    }
  }

  return result;
}

/**
 * Возвращает кэшированный список ID скачанных карт (синхронно).
 * @param {string} [downloadsDir]
 * @param {boolean} [forceRefresh=false]
 * @returns {Set<number>}
 */
function getCachedDownloadedSets(downloadsDir = getDownloadsDir(), forceRefresh = false) {
  const now = Date.now();
  const ttl = process.env.NODE_ENV === 'test' ? 0 : DOWNLOADS_CACHE_TTL_MS;
  if (
    !forceRefresh &&
    cachedDownloadsSet &&
    cachedDownloadsDir === downloadsDir &&
    now - cachedDownloadsTimestamp < ttl
  ) {
    return cachedDownloadsSet;
  }
  if (cachedDownloadsDir !== downloadsDir) {
    verifiedNonEmptyOsz.clear();
  }
  cachedDownloadsDir = downloadsDir;
  cachedDownloadsSet = scanDownloadedSetsSync(downloadsDir);
  cachedDownloadsTimestamp = now;
  return cachedDownloadsSet;
}

/**
 * Возвращает кэшированный список ID скачанных карт (асинхронно).
 * @param {string} [downloadsDir]
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Set<number>>}
 */
async function getCachedDownloadedSetsAsync(downloadsDir = getDownloadsDir(), forceRefresh = false) {
  const now = Date.now();
  const ttl = process.env.NODE_ENV === 'test' ? 0 : DOWNLOADS_CACHE_TTL_MS;
  if (
    !forceRefresh &&
    cachedDownloadsSet &&
    cachedDownloadsDir === downloadsDir &&
    now - cachedDownloadsTimestamp < ttl
  ) {
    return cachedDownloadsSet;
  }
  if (cachedDownloadsDir !== downloadsDir) {
    verifiedNonEmptyOsz.clear();
  }
  cachedDownloadsDir = downloadsDir;
  cachedDownloadsSet = await scanDownloadedSetsAsync(downloadsDir);
  cachedDownloadsTimestamp = now;
  return cachedDownloadsSet;
}

/**
 * Сбрасывает кэш списка скачанных карт.
 */
function invalidateCachedDownloads() {
  cachedDownloadsSet = null;
  cachedDownloadsTimestamp = 0;
  cachedDownloadsDir = null;
  verifiedNonEmptyOsz.clear();
}

/**
 * Добавляет набор в кэш скачанных карт без полного пересканирования.
 * @param {number} setId
 */
function addDownloadedSetId(setId) {
  const numId = Number(setId);
  if (Number.isSafeInteger(numId) && numId > 0) {
    verifiedNonEmptyOsz.add(numId);
    if (cachedDownloadsSet) {
      cachedDownloadsSet.add(numId);
    }
  }
}

/**
 * Удаляет набор из кэша скачанных карт.
 * @param {number} setId
 */
function removeDownloadedSetId(setId) {
  const numId = Number(setId);
  if (Number.isSafeInteger(numId) && numId > 0) {
    verifiedNonEmptyOsz.delete(numId);
    if (cachedDownloadsSet) {
      cachedDownloadsSet.delete(numId);
    }
  }
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

  const osuSet =
    settings.valid && settings.songsDir && settings.checkExisting ? getCachedOsuSongs(settings.songsDir) : null;

  const downloadedSet = getCachedDownloadedSets(downloadsDir);

  for (const rawId of setIds || []) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    if (osuSet && osuSet.has(id)) {
      installedSetIds.push(id);
      continue;
    }

    if (downloadedSet.has(id)) {
      downloadedSetIds.push(id);
    }
  }

  return { installedSetIds, downloadedSetIds };
}

/**
 * Регулярное выражение для зарезервированных имён устройств Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DEFAULT_MAX_ZIP_FILES = 500;
const DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 МБ
const DEFAULT_MAX_ZIP_COMPRESSION_RATIO = 100; // макс. степень сжатия 100:1 для DEFLATE

/**
 * @typedef {Object} ExtractZipOptions
 * @property {number} [maxFiles]
 * @property {number} [maxUncompressedBytes]
 * @property {number} [maxCompressionRatio]
 * @property {boolean} [validateBeatmap]
 * @property {number | string} [expectedSetId]
 */

/**
 * Распаковывает ZIP/.osz архив в указанную директорию (Zero-Dependency).
 * Защищен от атак Zip Slip, NTFS ADS (:), зарезервированных имён Windows, zip-бомб и повреждения CRC32.
 * Распаковка производится атомарно через временную папку: при любой ошибке (включая несовпадение CRC32)
 * временные файлы удаляются, а целевая директория не загрязняется битыми файлами.
 * Поддерживает как стандартный формат ZIP, так и спецификацию ZIP64, методы сжатия 0 (STORED) и 8 (DEFLATE).
 * @param {string} zipFilePath
 * @param {string} targetDir
 * @param {ExtractZipOptions} [options]
 * @returns {Promise<number>} Количество извлеченных файлов
 */
async function extractZip(zipFilePath, targetDir, options = {}) {
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_ZIP_FILES;
  const maxUncompressedBytes = options?.maxUncompressedBytes ?? DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxCompressionRatio = options?.maxCompressionRatio ?? DEFAULT_MAX_ZIP_COMPRESSION_RATIO;
  const validateBeatmap = Boolean(options?.validateBeatmap);
  const expectedSetId = options?.expectedSetId != null ? Number(options.expectedSetId) : null;

  const handle = await fs.promises.open(zipFilePath, 'r');
  let handleClosed = false;

  const { size: fileSize } = await handle.stat();
  if (fileSize < 22) {
    await handle.close();
    throw new Error('Некорректный ZIP-архив: размер файла меньше 22 байт.');
  }

  // Поиск конца центрального каталога (EOCD) с конца файла
  const searchLen = Math.min(fileSize, 65557);
  const searchOffset = fileSize - searchLen;
  const tailBuf = Buffer.allocUnsafe(searchLen);
  await handle.read(tailBuf, 0, searchLen, searchOffset);

  let eocdOffset = -1;
  for (let i = searchLen - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = searchOffset + i;
      break;
    }
  }
  if (eocdOffset === -1) {
    await handle.close();
    throw new Error('Некорректный ZIP-архив: сигнатура EOCD не найдена.');
  }

  const eocdTailIdx = eocdOffset - searchOffset;
  let totalEntries = tailBuf.readUInt16LE(eocdTailIdx + 10);
  let cdSize = tailBuf.readUInt32LE(eocdTailIdx + 12);
  let cdOffset = tailBuf.readUInt32LE(eocdTailIdx + 16);

  // Проверка на ZIP64: наличие ZIP64 Locator перед EOCD или флаги переполнения 0xFFFF / 0xFFFFFFFF
  const hasZip64Locator = eocdTailIdx >= 20 && tailBuf.readUInt32LE(eocdTailIdx - 20) === 0x07064b50;
  if (hasZip64Locator || totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    let locatorTailIdx = -1;
    if (hasZip64Locator) {
      locatorTailIdx = eocdTailIdx - 20;
    } else {
      for (let i = eocdTailIdx - 20; i >= Math.max(0, eocdTailIdx - 128); i--) {
        if (tailBuf.readUInt32LE(i) === 0x07064b50) {
          locatorTailIdx = i;
          break;
        }
      }
    }

    if (locatorTailIdx !== -1) {
      const zip64EocdOffset = Number(tailBuf.readBigUInt64LE(locatorTailIdx + 8));
      if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= fileSize) {
        const zip64Buf = Buffer.allocUnsafe(56);
        await handle.read(zip64Buf, 0, 56, zip64EocdOffset);
        if (zip64Buf.readUInt32LE(0) === 0x06064b50) {
          totalEntries = Number(zip64Buf.readBigUInt64LE(32));
          cdSize = Number(zip64Buf.readBigUInt64LE(40));
          cdOffset = Number(zip64Buf.readBigUInt64LE(48));
        }
      }
    }
  }

  if (totalEntries === 0) {
    await handle.close();
    throw new Error('Некорректный ZIP-архив: архив пуст (0 файлов).');
  }
  if (totalEntries > maxFiles) {
    await handle.close();
    throw new Error(
      `Недопустимый ZIP-архив: количество файлов (${totalEntries}) превышает лимит (${maxFiles}). Возможна zip-бомба.`,
    );
  }

  if (
    cdOffset < 0 ||
    cdSize < 0 ||
    !Number.isFinite(cdOffset) ||
    !Number.isFinite(cdSize) ||
    cdOffset + cdSize > fileSize
  ) {
    await handle.close();
    throw new Error('Некорректный ZIP-архив: центральный каталог выходит за пределы файла.');
  }

  // Загружаем только байты центрального каталога (обычно несколько КБ вместо сотен МБ всего архива)
  const cdBuf = Buffer.allocUnsafe(cdSize);
  await handle.read(cdBuf, 0, cdSize, cdOffset);

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
    let cur = 0;
    let totalUncompressedBytes = 0;
    let foundOsuFiles = 0;
    let validOsuHeaderFound = false;
    let hasMatchingSetId = false;
    /** @type {number[]} */
    const mismatchedSetIds = [];

    for (let entry = 0; entry < totalEntries && cur < cdSize; entry++) {
      if (cur + 46 > cdSize || cdBuf.readUInt32LE(cur) !== 0x02014b50) break;

      const method = cdBuf.readUInt16LE(cur + 10);
      const expectedCrc = cdBuf.readUInt32LE(cur + 16);
      let compSize = cdBuf.readUInt32LE(cur + 20);
      let uncompSize = cdBuf.readUInt32LE(cur + 24);
      const nameLen = cdBuf.readUInt16LE(cur + 28);
      const extraLen = cdBuf.readUInt16LE(cur + 30);
      const commentLen = cdBuf.readUInt16LE(cur + 32);
      let localHeaderOffset = cdBuf.readUInt32LE(cur + 42);

      if (cur + 46 + nameLen > cdSize) {
        throw new Error('Некорректный заголовок файла в ZIP-архиве.');
      }
      const rawName = cdBuf.toString('utf8', cur + 46, cur + 46 + nameLen);

      // Чтение ZIP64 Extra field (Tag 0x0001) при необходимости
      if (extraLen > 0 && (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff)) {
        const extraStart = cur + 46 + nameLen;
        const extraEnd = Math.min(extraStart + extraLen, cdSize);
        let ep = extraStart;
        while (ep + 4 <= extraEnd) {
          const tag = cdBuf.readUInt16LE(ep);
          const sz = cdBuf.readUInt16LE(ep + 2);
          if (tag === 0x0001) {
            let dp = ep + 4;
            const dend = Math.min(dp + sz, extraEnd);
            if (uncompSize === 0xffffffff && dp + 8 <= dend) {
              uncompSize = Number(cdBuf.readBigUInt64LE(dp));
              dp += 8;
            }
            if (compSize === 0xffffffff && dp + 8 <= dend) {
              compSize = Number(cdBuf.readBigUInt64LE(dp));
              dp += 8;
            }
            if (localHeaderOffset === 0xffffffff && dp + 8 <= dend) {
              localHeaderOffset = Number(cdBuf.readBigUInt64LE(dp));
              dp += 8;
            }
            break;
          }
          ep += 4 + sz;
        }
      }

      cur += 46 + nameLen + extraLen + commentLen;

      if (compSize < 0 || uncompSize < 0 || !Number.isFinite(compSize) || !Number.isFinite(uncompSize)) {
        throw new Error('Некорректный размер файла в заголовке ZIP-архива.');
      }

      totalUncompressedBytes += uncompSize;
      if (totalUncompressedBytes > maxUncompressedBytes) {
        throw new Error(
          `Превышен максимальный суммарный размер распакованных данных (${formatBytes(totalUncompressedBytes)} > ${formatBytes(maxUncompressedBytes)}). Возможна zip-бомба.`,
        );
      }

      if (method === 8 && compSize > 0) {
        const ratio = uncompSize / compSize;
        if (ratio > maxCompressionRatio) {
          throw new Error(
            `Подозрительно высокая степень сжатия файла "${rawName}" (${ratio.toFixed(0)}:1 > ${maxCompressionRatio}:1). Возможна zip-бомба.`,
          );
        }
      }
      if (method === 8 && compSize === 0 && uncompSize > 1024 * 1024) {
        throw new Error(
          `Недопустимый архив: файл "${rawName}" имеет нулевой сжатый размер при распакованном размере ${formatBytes(uncompSize)}.`,
        );
      }

      // Нормализация имени пути и защита от Zip Slip, NTFS ADS (:), управляющих символов и зарезервированных имён Windows
      const normalizedName = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
      const rawParts = normalizedName.split('/');
      if (rawParts.some((p) => p === '..')) {
        continue;
      }
      const parts = rawParts.filter((p) => p && p !== '.');

      // Отсекаем альтернативные потоки данных NTFS (:), управляющие символы и зарезервированные имена устройств (CON, PRN, AUX, NUL)
      if (parts.some((p) => p.includes(':') || /[\x00-\x1f]/.test(p) || WINDOWS_RESERVED_NAMES.test(p))) {
        continue;
      }

      // Очищаем хвостовые точки и пробелы для Windows-совместимости
      const cleanedParts = parts.map((p) => p.replace(/[.\s]+$/, '')).filter(Boolean);
      if (cleanedParts.length === 0) continue;

      const safePath = path.resolve(stagingDir, ...cleanedParts);
      if (!safePath.startsWith(stagingDir + path.sep) && safePath !== stagingDir) {
        continue; // Защита от выхода за пределы папки распаковки
      }

      if (rawName.endsWith('/') || rawName.endsWith('\\')) {
        await fs.promises.mkdir(safePath, { recursive: true });
        continue;
      }

      if (localHeaderOffset < 0 || !Number.isFinite(localHeaderOffset) || localHeaderOffset + 30 > fileSize) {
        throw new Error('Поврежден локальный заголовок файла в ZIP-архиве.');
      }

      const lhBuf = Buffer.allocUnsafe(30);
      await handle.read(lhBuf, 0, 30, localHeaderOffset);
      if (lhBuf.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('Поврежден локальный заголовок файла в ZIP-архиве.');
      }

      const lhNameLen = lhBuf.readUInt16LE(26);
      const lhExtraLen = lhBuf.readUInt16LE(28);
      const dataOffset = localHeaderOffset + 30 + lhNameLen + lhExtraLen;

      if (dataOffset < 0 || !Number.isFinite(dataOffset) || dataOffset + compSize > fileSize) {
        throw new Error('Неожиданный конец данных файла в ZIP-архиве.');
      }

      let compData;
      if (compSize > 0) {
        compData = Buffer.allocUnsafe(compSize);
        await handle.read(compData, 0, compSize, dataOffset);
      } else {
        compData = Buffer.alloc(0);
      }

      let data;
      if (compSize === 0 && uncompSize === 0) {
        data = Buffer.alloc(0);
      } else if (method === 0) {
        data = compData;
      } else if (method === 8) {
        // Асинхронная декомпрессия в пуле потоков libuv (не блокирует Event Loop)
        data = await new Promise((resolve, reject) => {
          zlib.inflateRaw(compData, (err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
        });
      } else {
        throw new Error(`Неподдерживаемый метод сжатия в архиве: ${method}`);
      }

      if (data.length !== uncompSize) {
        throw new Error(
          `Несоответствие размера распакованного файла "${rawName}": ожидалось ${uncompSize} байт, получено ${data.length}.`,
        );
      }

      const actualCrc = zlib.crc32(data);
      if (actualCrc !== expectedCrc) {
        throw new Error(
          `Несоответствие контрольной суммы CRC32 для файла "${rawName}": ожидалось 0x${expectedCrc.toString(16).padStart(8, '0')}, получено 0x${actualCrc.toString(16).padStart(8, '0')}.`,
        );
      }

      await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
      await fs.promises.writeFile(safePath, data);
      extractedCount += 1;

      const isOsuFile = rawName.toLowerCase().endsWith('.osu');
      if (isOsuFile) {
        foundOsuFiles++;
        const headText = data.toString('utf8', 0, Math.min(data.length, 4096));
        if (/^osu\s*(file\s*)?format/i.test(headText.trimStart())) {
          validOsuHeaderFound = true;
        }
        const idMatch = headText.match(/^BeatmapSetID:\s*(-?\d+)/im);
        if (idMatch) {
          const parsedId = Number.parseInt(idMatch[1], 10);
          if (parsedId > 0) {
            if (expectedSetId != null && expectedSetId > 0 && parsedId === expectedSetId) {
              hasMatchingSetId = true;
            } else if (expectedSetId != null && expectedSetId > 0 && parsedId !== expectedSetId) {
              mismatchedSetIds.push(parsedId);
            }
          }
        }
      }
    }

    if (validateBeatmap) {
      if (foundOsuFiles === 0) {
        throw new Error('Некорректный .osz архив: архив не содержит файлов карт (.osu).');
      }
      if (!validOsuHeaderFound) {
        throw new Error(
          'Некорректный .osz архив: ни один файл .osu не содержит валидного заголовка формата osu! (osu file format).',
        );
      }
      if (expectedSetId != null && expectedSetId > 0 && !hasMatchingSetId && mismatchedSetIds.length > 0) {
        const uniqueMismatches = [...new Set(mismatchedSetIds)].join(', ');
        throw new Error(
          `Несоответствие BeatmapSetID: архив содержит карты для набора (${uniqueMismatches}), ожидался ${expectedSetId}.`,
        );
      }
    }

    // Закрываем дескриптор файла до операции переименования папки
    await handle.close();
    handleClosed = true;

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
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally {
    if (!handleClosed) {
      await handle.close().catch(() => {});
    }
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
    removeDownloadedSetId(setId);
    addInstalledSetId(setId);
    log('info', 'osu.post_download.moved', { jobId: job?.id, setId, target: targetPath });
  } else if (action === 'copy') {
    const targetPath = path.join(songsDir, `${setId}.osz`);
    await fs.promises.copyFile(oszPath, targetPath);
    addDownloadedSetId(setId);
    addInstalledSetId(setId);
    log('info', 'osu.post_download.copied', { jobId: job?.id, setId, target: targetPath });
  } else if (action === 'extract') {
    const mapInfo = job?.mapsById?.get(setId);
    const folderName = buildBeatmapFolderName(setId, mapInfo);
    const targetFolder = path.join(songsDir, folderName);
    await extractZip(oszPath, targetFolder, { expectedSetId: setId, validateBeatmap: true });
    await fs.promises.unlink(oszPath).catch(() => {});
    removeDownloadedSetId(setId);
    addInstalledSetId(setId);
    log('info', 'osu.post_download.extracted', { jobId: job?.id, setId, targetFolder });
  }
}

/**
 * Открывает нативный диалог выбора папки (Проводник Windows / Finder macOS / Zenity Linux).
 * @param {string} [initialPath]
 * @param {any} [options]
 * @returns {Promise<string | null>}
 */
function selectFolderDialog(initialPath = '', options = {}) {
  if (options && options.mockPath !== undefined) {
    return Promise.resolve(options.mockPath);
  }
  const isTest =
    process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
  if (isTest && !options?.force) {
    return Promise.resolve(options?.testPath ?? null);
  }

  return new Promise((resolve, reject) => {
    const platform = process.platform;
    if (platform === 'win32') {
      const rawInitial = sanitizePath(initialPath) || '';
      const escapedPath = rawInitial.replace(/'/g, "''");
      const psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$f.Description = 'Выберите папку с игрой osu! или директорию Songs'",
        '$f.ShowNewFolderButton = $false',
        `$init = '${escapedPath}'`,
        'if ($init -and (Test-Path -LiteralPath $init)) { $f.SelectedPath = $init }',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$res = $f.ShowDialog($owner)',
        'if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $f.SelectedPath) { Write-Output $f.SelectedPath }',
      ].join(';\n');

      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Sta', '-Command', psScript],
        {
          windowsHide: true,
          timeout: 180000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              return resolve(null);
            }
            log('warn', 'osu.dialog.failed', { error: error.message, stderr });
            return reject(new Error(`Не удалось открыть Проводник: ${error.message}`));
          }
          const chosen = stdout ? stdout.trim() : '';
          resolve(chosen ? chosen : null);
        },
      );
    } else if (platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Выберите папку с игрой osu!:")';
      execFile('osascript', ['-e', script], { timeout: 180000, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(null);
        const chosen = stdout ? stdout.trim() : '';
        resolve(chosen ? chosen : null);
      });
    } else {
      execFile(
        'zenity',
        ['--file-selection', '--directory', '--title=Выберите папку с игрой osu!'],
        { timeout: 180000, encoding: 'utf8' },
        (error, stdout) => {
          if (error) return resolve(null);
          const chosen = stdout ? stdout.trim() : '';
          resolve(chosen ? chosen : null);
        },
      );
    }
  });
}

module.exports = {
  sanitizePath,
  resolveOsuSongsDir,
  getDefaultOsuPath,
  getSettingsFilePath,
  getLegacySettingsFilePath,
  scanOsuSongsSync,
  scanOsuSongsAsync,
  getCachedOsuSongs,
  getCachedOsuSongsAsync,
  invalidateCachedSongs,
  addInstalledSetId,
  scanDownloadedSetsSync,
  scanDownloadedSetsAsync,
  getCachedDownloadedSets,
  getCachedDownloadedSetsAsync,
  invalidateCachedDownloads,
  addDownloadedSetId,
  removeDownloadedSetId,
  loadSettings,
  getSettings,
  saveSettings,
  isSetInOsuSongs,
  classifyCollectionSets,
  isForbiddenSystemDir,
  extractZip,
  DEFAULT_MAX_ZIP_FILES,
  DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES,
  DEFAULT_MAX_ZIP_COMPRESSION_RATIO,
  moveFile,
  buildBeatmapFolderName,
  handlePostDownload,
  selectFolderDialog,
};
