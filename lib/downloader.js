// @ts-check
"use strict";

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  getDownloadsDir,
  ZIP_SIGNATURES,
  SESSION_COOKIE,
  OSU_API_BASE,
  USER_AGENT,
  REDIRECT_STATUSES,
  CONNECT_TIMEOUT_MS,
  log,
  HttpError,
  sleep,
  sleepWithSignal,
  anySignal,
  formatBytes,
} = require('./config.js');
const {
  safeErrorMessage,
  redirectHostAllowed,
  mirrorRedirectAllowed,
} = require('./security.js');
const {
  MIRRORS,
  mirrorCooldowns,
  mirrorCooldownRemaining,
  parseRetryAfter,
  isTransientError,
  isMirrorBusy,
  acquireMirrorSlot,
  MirrorTransientError,
  MirrorRateLimitError,
  OAuthDownloadScopeError,
} = require('./mirrors.js');
const {
  getSettings: getOsuSettings,
  isSetInOsuSongs,
} = require('./osu.js');

const BODY_STALL_TIMEOUT_MS = 90 * 1000;
const MIRROR_TRANSIENT_RETRIES = 2;
const MIRROR_COOLDOWN_DEFAULT_MS = 60 * 1000;
const MIRROR_COOLDOWN_WAIT_MAX_MS = 30 * 1000;

class BodyStalledError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'BodyStalledError';
  }
}

function partPath(jobId, setId) {
  return path.join(getDownloadsDir(), `${setId}.${jobId}.part`);
}

function jobFilePath(setId) {
  return path.join(getDownloadsDir(), `${setId}.osz`);
}

// Очистка .part-файлов конкретной задачи (по id в имени) — при завершении, отмене и на SIGINT.
async function cleanupJobPartFiles(job) {
  const dir = getDownloadsDir();
  const marker = `.${job.id}.part`;
  try {
    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      if (entry.endsWith(marker)) {
        await fs.promises.rm(path.join(dir, entry), { force: true });
        log('debug', 'downloads.part_cleanup', { jobId: job.id, file: entry });
      }
    }
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err?.code !== 'ENOENT') log('warn', 'downloads.part_cleanup.failed', { jobId: job.id, error: safeErrorMessage(error) });
  }
}

// .part-файлы пережитка процесса ничего не доканчены — чистим их при старте и по завершении задачи.
async function cleanupStalePartFiles() {
  const dir = getDownloadsDir();
  try {
    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      if (entry.endsWith('.part')) {
        await fs.promises.rm(path.join(dir, entry), { force: true });
        log('debug', 'downloads.part_cleanup', { file: entry });
      }
    }
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err?.code !== 'ENOENT') log('warn', 'downloads.part_cleanup.failed', { error: safeErrorMessage(error) });
  }
}

/**
 * Проверяет, находятся ли два пути на одном и том же диске / точке монтирования.
 * @param {string} dirA
 * @param {string} dirB
 * @returns {boolean}
 */
function isSameFileSystem(dirA, dirB) {
  try {
    const rootA = path.parse(path.resolve(dirA)).root.toUpperCase();
    const rootB = path.parse(path.resolve(dirB)).root.toUpperCase();
    if (rootA !== rootB) return false;

    if (process.platform === 'win32') {
      return rootA === rootB;
    }

    if (fs.existsSync(dirA) && fs.existsSync(dirB)) {
      const statA = fs.statSync(dirA);
      const statB = fs.statSync(dirB);
      if (statA.dev !== undefined && statB.dev !== undefined) {
        return statA.dev === statB.dev;
      }
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Получает количество свободных байт на диске указанной директории.
 * @param {string} targetDir
 * @returns {Promise<number | null>}
 */
async function getFreeDiskSpace(targetDir) {
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
    const stats = await fs.promises.statfs(targetDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(freeBytes)) return freeBytes;
  } catch (error) {
    try {
      const root = path.parse(path.resolve(targetDir)).root || ROOT;
      const stats = await fs.promises.statfs(root);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes)) return freeBytes;
    } catch {
      // statfs может не поддерживаться на некоторых ФС — не блокируем загрузку, только лог
      log('warn', 'downloads.disk_space.statfs_failed', { dir: targetDir, error: safeErrorMessage(error) });
    }
  }
  return null;
}

// Проверка свободного места перед стартом: крупные коллекции весят десятки ГБ.
// Учитывает режим пост-обработки (extract, move, copy, none) и реальные диски размещения.
async function ensureDiskSpace(reserveBytes, options = {}) {
  const neededBytes = Math.max(Number(reserveBytes) || 0, 0);
  if (neededBytes <= 0) return;

  const SAFETY_MARGIN_BYTES = 100 * 1024 * 1024; // запас 100 МБ
  const osuSettings = getOsuSettings();
  const action = options.postDownloadAction || (osuSettings?.valid ? osuSettings?.postDownloadAction : 'none') || 'none';
  const songsDir = options.songsDir !== undefined ? options.songsDir : (osuSettings?.valid ? osuSettings?.songsDir : null);
  const downloadsDir = options.downloadsDir || getDownloadsDir();
  const concurrency = Math.max(1, Number(options.concurrency || 3));

  const resolvedDownloads = path.resolve(downloadsDir);
  const resolvedSongs = (songsDir && typeof songsDir === 'string') ? path.resolve(songsDir) : null;

  const sameDisk = Boolean(resolvedSongs && isSameFileSystem(resolvedDownloads, resolvedSongs));

  let neededDownloads = 0;
  let neededSongs = 0;

  if (!resolvedSongs || action === 'none') {
    neededDownloads = neededBytes + SAFETY_MARGIN_BYTES;
  } else if (action === 'move') {
    if (sameDisk) {
      neededDownloads = neededBytes + SAFETY_MARGIN_BYTES;
    } else {
      // На диске downloads хранятся только одновременно скачиваемые файлы
      const tempBuffer = Math.min(neededBytes, concurrency * 35 * 1024 * 1024) + SAFETY_MARGIN_BYTES;
      neededDownloads = tempBuffer;
      neededSongs = neededBytes + SAFETY_MARGIN_BYTES;
    }
  } else if (action === 'extract') {
    // Распакованные карты osu! занимают ~1.2x от размера .osz архива
    const extractedBytes = Math.ceil(neededBytes * 1.2);
    if (sameDisk) {
      neededDownloads = extractedBytes + SAFETY_MARGIN_BYTES;
    } else {
      // На диске downloads лежат только временные архивы до распаковки (после распаковки .osz удаляется)
      const tempBuffer = Math.min(neededBytes, concurrency * 35 * 1024 * 1024) + SAFETY_MARGIN_BYTES;
      neededDownloads = tempBuffer;
      neededSongs = extractedBytes + SAFETY_MARGIN_BYTES;
    }
  } else if (action === 'copy') {
    if (sameDisk) {
      neededDownloads = (neededBytes * 2) + SAFETY_MARGIN_BYTES;
    } else {
      neededDownloads = neededBytes + SAFETY_MARGIN_BYTES;
      neededSongs = neededBytes + SAFETY_MARGIN_BYTES;
    }
  }

  // 1. Проверяем свободное место в downloadsDir
  if (neededDownloads > 0) {
    const freeDownloads = await getFreeDiskSpace(resolvedDownloads);
    if (Number.isFinite(freeDownloads) && freeDownloads < neededDownloads) {
      const diskLabel = sameDisk ? 'диске' : `диске загрузок (${resolvedDownloads})`;
      throw new HttpError(
        507,
        `На ${diskLabel} мало места: свободно ${formatBytes(freeDownloads)}, нужно хотя бы ${formatBytes(neededDownloads)}.`
      );
    }
  }

  // 2. Проверяем свободное место в songsDir (если на отдельном диске)
  if (!sameDisk && resolvedSongs && neededSongs > 0) {
    const freeSongs = await getFreeDiskSpace(resolvedSongs);
    if (Number.isFinite(freeSongs) && freeSongs < neededSongs) {
      throw new HttpError(
        507,
        `На диске osu! Songs (${resolvedSongs}) мало места: свободно ${formatBytes(freeSongs)}, нужно хотя бы ${formatBytes(neededSongs)}.`
      );
    }
  }
}

/**
 * Оценка требуемого места с учётом уже скачанных файлов (чтобы не требовать место под 4000 уже существующих файлов).
 * @param {number[]} setIds
 * @param {boolean | { noVideo?: boolean }} [noVideo=false]
 * @param {any} [options={}]
 * @returns {Promise<number>}
 */
async function estimateRequiredDiskSpace(setIds, noVideo = false, options = {}) {
  const isNoVideo = typeof noVideo === 'boolean' ? noVideo : Boolean(/** @type {any} */ (noVideo)?.noVideo);
  const opts = typeof noVideo === 'object' && noVideo !== null ? noVideo : (options || {});

  const checkOsu = opts.checkOsu !== false;
  const osuSettings = checkOsu ? getOsuSettings() : null;
  const osuCheckActive = Boolean(checkOsu && osuSettings?.valid && osuSettings?.songsDir && osuSettings?.checkExisting);

  const doneIds = opts.job?.doneIds || opts.doneIds || null;
  const skipIds = opts.job?.skipIds || opts.skipIds || null;

  let missingCount = 0;
  for (const id of setIds) {
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) continue;
    if (doneIds?.has(numId) || skipIds?.has(numId)) continue;
    if (osuCheckActive && isSetInOsuSongs(numId)) continue;

    try {
      const stat = await fs.promises.stat(jobFilePath(numId));
      if (stat.size <= 0) missingCount++;
    } catch {
      missingCount++;
    }
  }
  const avgBytes = isNoVideo ? 3 * 1024 * 1024 : 10 * 1024 * 1024; // ~3 МБ без видео, ~10 МБ с видео
  return missingCount * avgBytes;
}

/**
 * Добавляет параметр noVideo=1 к URL, если его там ещё нет.
 * @param {string} rawUrl
 * @returns {string}
 */
function appendNoVideo(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('noVideo', '1');
    return u.href;
  } catch {
    return rawUrl.includes('?') ? `${rawUrl}&noVideo=1` : `${rawUrl}?noVideo=1`;
  }
}

function isNoSpaceError(error) {
  if (!error) return false;
  if (error.code === 'ENOSPC' || error.cause?.code === 'ENOSPC') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('enospc') || msg.includes('no space left on device') || msg.includes('на диске мало места') || msg.includes('диск переполнен') || msg.includes('недостаточно места');
}

async function readChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BodyStalledError(`Нет данных от сервера дольше, чем ${Math.round(timeoutMs / 1000)} с — соединение зависло.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Проверяет сигнатуру конца центрального каталога (EOCD) ZIP-архива.
 * @param {any} handle
 * @param {number} totalSize
 * @returns {Promise<boolean>}
 */
async function verifyZipFile(handle, totalSize) {
  if (totalSize < 22) return false;
  const readSize = Math.min(totalSize, 65557);
  const buffer = Buffer.alloc(readSize);
  const position = totalSize - readSize;
  const { bytesRead } = await handle.read(buffer, 0, readSize, position);
  if (bytesRead < 22) return false;
  const slice = buffer.subarray(0, bytesRead);
  for (let i = slice.length - 22; i >= 0; i--) {
    if (slice[i] === 0x50 && slice[i + 1] === 0x4b && slice[i + 2] === 0x05 && slice[i + 3] === 0x06) {
      const commentLen = slice.readUInt16LE(i + 20);
      // EOCD может иметь хвостовой паддинг (выравнивание секторов, оверлеи)
      if (i + 22 + commentLen <= slice.length) {
        return true;
      }
    }
    // Проверяем ZIP64 locator (0x50, 0x4b, 0x06, 0x07) или ZIP64 EOCD record (0x50, 0x4b, 0x06, 0x06)
    if (slice[i] === 0x50 && slice[i + 1] === 0x4b && slice[i + 2] === 0x06) {
      if (slice[i + 3] === 0x07 && i + 20 <= slice.length) {
        return true;
      }
      if (slice[i + 3] === 0x06 && i + 56 <= slice.length) {
        return true;
      }
    }
  }
  return false;
}

async function isValidZipOnDisk(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    return await verifyZipFile(handle, stat.size);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error('Не удалось записать данные на диск: получено 0 байт при записи.');
    }
    offset += bytesWritten;
  }
}

async function streamBodyToFile(reader, firstChunk, tempPath, job, expectedBytes, readTimeoutMs, setId = null) {
  let handle;
  try {
    handle = await fs.promises.open(tempPath, 'wx+');
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err?.code === 'ENOENT') {
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      try {
        handle = await fs.promises.open(tempPath, 'wx+');
      } catch (retryError) {
        throw new HttpError(500, `Не удалось создать временный файл: ${safeErrorMessage(retryError)}`);
      }
    } else if (err?.code === 'EEXIST') {
      throw new Error('Временный файл уже существует.');
    } else {
      throw error;
    }
  }
  let received = 0;
  try {
    // Через первый чанк образец: буфер данных -> поток -> файл. далее следующий read начинаем только после записи
    // предыдущего (естественный backpressure на socket), а в памяти держим один-два чанка.
    let chunk = firstChunk || null; // первый чанк уже прочитан ради проверки сигнатуры ZIP
    for (;;) {
      if (!chunk) {
        const next = await readChunkWithTimeout(reader, readTimeoutMs);
        if (next.done) break;
        chunk = next.value;
      }
      received += chunk.byteLength;
      if (Number.isSafeInteger(expectedBytes) && received > expectedBytes) {
        throw new Error(`Сервер отдал больше, чем обещал в Content-Length (${formatBytes(expectedBytes)}).`);
      }
      if (job.activeTransfers && setId != null) {
        const transfer = job.activeTransfers.get(setId);
        if (transfer) {
          transfer.bytes = received;
          transfer.totalBytes = expectedBytes;
        }
      }
      job.currentBytes = received;
      job.currentPercent = job.currentTotalBytes ? Math.min(100, Math.floor(received / job.currentTotalBytes * 100)) : null;
      if (typeof job.notifyUpdate === 'function') {
        job.notifyUpdate(false);
      }
      await writeAll(handle, chunk);
      chunk = null;
    }
    if (Number.isSafeInteger(expectedBytes) && received !== expectedBytes) {
      throw new Error(`Файл усечён на стороне зеркала: получено ${formatBytes(received)} из обещанных ${formatBytes(expectedBytes)}.`);
    }
    if (!received) throw new Error('Тело ответа пустое.');
    const validZip = await verifyZipFile(handle, received);
    if (!validZip) {
      throw new Error('Файл усечён: отсутствует сигнатура окончания ZIP-архива (EOCD). Возможно, соединение оборвалось.');
    }
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
  return received;
}

function authHeaders(auth, requestUrl, referer) {
  const headers = /** @type {Record<string, string>} */ ({ 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' });
  if (referer && auth.kind !== 'mirror') headers.Referer = referer;
  const host = new URL(requestUrl).hostname;
  if (host === 'osu.ppy.sh' && auth.kind === 'session') {
    headers.Cookie = `${SESSION_COOKIE}=${auth.session}`;
  } else if (host === 'osu.ppy.sh' && auth.kind === 'oauth' && auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  return headers;
}

async function responsePreview(response, limit = 300) {
  try {
    if (!response.body) return '';
    const reader = response.body.getReader();
    let text = '';
    try {
      while (Buffer.byteLength(text, 'utf8') < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  } catch {
    await response.body?.cancel().catch(() => {});
    return '';
  }
}

/**
 * Скачивает одиночный beatmapset по протоколу OAuth, Cookie или с конкретного зеркала.
 * @param {number} setId
 * @param {any} auth
 * @param {any} job
 * @returns {Promise<void>}
 */
async function downloadSet(setId, auth, job) {
  let releaseSlot = null;
  if (auth.kind === 'mirror' && auth.mirror) {
    releaseSlot = await acquireMirrorSlot(auth.mirror, job.abortController?.signal);
  }

  try {
    const noVideo = Boolean(job.noVideo);
    const referer = `https://osu.ppy.sh/beatmapsets/${setId}`;
    let url;
    if (auth.kind === 'oauth') {
      url = `${OSU_API_BASE}/beatmapsets/${setId}/download${noVideo ? '?noVideo=1' : ''}`;
    } else if (auth.kind === 'mirror') {
      const built = auth.mirror.build(setId, { noVideo });
      url = noVideo ? appendNoVideo(built) : built;
    } else {
      url = `https://osu.ppy.sh/beatmapsets/${setId}/download${noVideo ? '?noVideo=1' : ''}`;
    }
    const tempPath = partPath(job.id, setId);
    const finalPath = jobFilePath(setId);
    log('info', 'map.download.started', { jobId: job.id, beatmapsetId: setId, method: auth.kind, mirror: auth.mirror?.id || null, noVideo: noVideo || undefined });

    let response;
    for (let redirectCount = 0; redirectCount <= 8; redirectCount++) {
      // Свежий таймаут на соединение и заголовки для каждого запроса в цепочке
      const connect = new AbortController();
      const connectTimer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
      try {
        response = await fetch(url, {
          redirect: 'manual',
          headers: authHeaders(auth, url, referer),
          signal: job.abortController ? anySignal([job.abortController.signal, connect.signal]) : connect.signal,
        });
      } catch (error) {
        if (connect.signal.aborted) {
          const timeoutError = /** @type {any} */ (new Error(`Соединение не установлено за ${Math.round(CONNECT_TIMEOUT_MS / 1000)} с.`));
          timeoutError.code = 'ETIMEDOUT';
          throw timeoutError;
        }
        if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
        throw error;
      } finally {
        clearTimeout(connectTimer);
      }
      if (!REDIRECT_STATUSES.includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('Сервер загрузки вернул пустое перенаправление.');
      const nextUrl = new URL(location, url);
      const isAllowed = auth.kind === 'mirror'
        ? await mirrorRedirectAllowed(nextUrl)
        : redirectHostAllowed(nextUrl);
      if (!isAllowed) {
        throw new Error(auth.kind === 'mirror' ? `Зеркало перенаправило на небезопасный URL (${nextUrl.hostname}).` : `osu! вернул небезопасный URL загрузки (${nextUrl.hostname}).`);
      }
      log('debug', 'map.download.redirected', { jobId: job.id, beatmapsetId: setId, status: response.status, host: nextUrl.hostname });
      url = nextUrl.href;
    }
    if (!response || REDIRECT_STATUSES.includes(response.status)) {
      await response?.body?.cancel().catch(() => {});
      throw new Error('Слишком много перенаправлений загрузки.');
    }
    if (!response.ok || !response.body) {
      const detail = await responsePreview(response);
      if (auth.kind === 'mirror') {
        if (response.status === 429) {
          throw new MirrorRateLimitError(auth.mirror, parseRetryAfter(response.headers.get('retry-after')) ?? MIRROR_COOLDOWN_DEFAULT_MS);
        }
        if (response.status >= 500 || response.status === 408 || response.status === 425) {
          throw new MirrorTransientError(auth.mirror, `HTTP ${response.status} от ${auth.mirror.label}.`);
        }
        const missing = response.status === 404 || response.status === 410;
        const error = /** @type {any} */ (new Error(`HTTP ${response.status} от ${auth.mirror.label}${missing ? ' (набора там нет)' : ''}. ${detail}`.trim()));
        if (missing) error.isMissing = true;
        throw error;
      }
      if (auth.kind === 'oauth' && response.status === 403) {
        if (/invalid scope\(s\) provided/i.test(detail)) {
          throw new OAuthDownloadScopeError('osu! отклонил API-загрузку: обычному OAuth-приложению не выдан нужный scope. Загрузка остановлена; выберите способ «Cookie osu_session». Добавлять scope lazer или * не нужно — osu! не предлагает их для обычных OAuth-приложений.');
        }
        throw new HttpError(502, `HTTP 403: osu! ограничивает API-загрузку клиентом lazer; обычные OAuth-приложения не имеют доступа. ${detail}`.trim());
      }
      if (auth.kind === 'oauth' && response.status === 401) {
        throw new HttpError(401, `HTTP 401: osu! отклонил OAuth-токен; войдите через osu! повторно. ${detail}`.trim());
      }
      if (response.status === 429) throw new HttpError(429, 'osu! временно ограничил загрузки — попробуйте позже.');
      throw new HttpError(502, `osu! ответил HTTP ${response.status}. ${detail}`.trim());
    }
    log('debug', 'map.download.response.received', { jobId: job.id, beatmapsetId: setId, status: response.status, contentType: response.headers.get('content-type') || 'unknown' });

    const contentEncoding = (response.headers.get('content-encoding') || '').toLowerCase().trim();
    const isEncoded = contentEncoding.length > 0 && contentEncoding !== 'identity';
    const contentLength = Number(response.headers.get('content-length'));
    const expectedBytes = !isEncoded && Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
    job.currentTotalBytes = expectedBytes;
    job.currentBytes = 0;
    job.currentPercent = expectedBytes ? 0 : null;
    if (job.activeTransfers) {
      const t = job.activeTransfers.get(setId);
      if (t) {
        t.mirror = auth.mirror?.label || null;
        t.totalBytes = expectedBytes;
        t.bytes = 0;
      }
    }
    const reader = response.body.getReader();
    let first;
    try {
      first = await readChunkWithTimeout(reader, BODY_STALL_TIMEOUT_MS);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    if (first.done || !ZIP_SIGNATURES.some(signature => Buffer.from(first.value.subarray(0, signature.length)).equals(signature))) {
      await reader.cancel().catch(() => {});
      const where = auth.kind === 'oauth' ? 'OAuth-токен' : auth.kind === 'mirror' ? `зеркало ${auth.mirror.label}` : 'сессия osu!';
      throw new Error(`Ответ не является .osz: вместо файла пришла другая страница (${where}). Возможно, авторизация устарела.`);
    }

    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    try {
      const received = await streamBodyToFile(reader, first.value, tempPath, job, expectedBytes, BODY_STALL_TIMEOUT_MS, setId);
      await fs.promises.rename(tempPath, finalPath);
      job.doneIds.add(setId);
      job.errIds.delete(setId);
      job.errorsById?.delete(setId);
      job.currentPercent = 100;
      log('info', 'map.download.succeeded', { jobId: job.id, beatmapsetId: setId, sizeBytes: received, expectedBytes, file: path.relative(ROOT, finalPath) });
    } catch (error) {
      await reader.cancel().catch(() => {});
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  } finally {
    if (releaseSlot) releaseSlot();
  }
}

/**
 * Скачивает битмапсет с зеркал с автоматическим перебором (fallback) и кулдаунами.
 * @param {number} setId
 * @param {any} job
 * @param {Object} [options]
 * @param {number} [options.workerIndex]
 * @returns {Promise<void>}
 */
async function downloadFromMirrors(setId, job, options = {}) {
  const workerIndex = Number(options?.workerIndex) || 0;
  const failures = new Map();
  let rateLimited = 0;
  let transientRetries = 0;
  const missingMirrors = new Set();
  const transientMirrors = new Set();

  function getCandidateMirrors() {
    const count = MIRRORS.length;
    const offset = count > 0 ? (workerIndex % count) : 0;
    const rotated = MIRRORS.slice(offset).concat(MIRRORS.slice(0, offset));
    const idle = [];
    const busy = [];
    for (const m of rotated) {
      if (missingMirrors.has(m.id)) continue;
      if (mirrorCooldownRemaining(m) > 0) continue;
      if (isMirrorBusy(m)) {
        busy.push(m);
      } else {
        idle.push(m);
      }
    }
    return [...idle, ...busy];
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    transientMirrors.clear();

    const candidates = getCandidateMirrors();
    for (const mirror of candidates) {
      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
      if (missingMirrors.has(mirror.id)) continue;
      const cooldown = mirrorCooldownRemaining(mirror);
      if (cooldown > 0) {
        log('debug', 'map.download.mirror.skipped_cooldown', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, cooldownMs: cooldown });
        continue;
      }
      job.currentMirror = mirror.label;
      if (job.activeTransfers) {
        const t = job.activeTransfers.get(setId);
        if (t) t.mirror = mirror.label;
      }
      job.currentBytes = 0;
      job.currentTotalBytes = null;
      job.currentPercent = 0;
      try {
        await downloadSet(setId, { kind: 'mirror', mirror }, job);
        return;
      } catch (error) {
        job.currentBytes = 0;
        job.currentTotalBytes = null;
        job.currentPercent = 0;
        if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
        if (error instanceof MirrorRateLimitError) {
          mirrorCooldowns.set(mirror.id, Date.now() + error.retryAfterMs);
          rateLimited += 1;
          log('warn', 'map.download.mirror.cooldown', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, cooldownMs: error.retryAfterMs });
          continue;
        }
        if (/** @type {any} */ (error).isMissing) {
          missingMirrors.add(mirror.id);
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
          log('debug', 'map.download.mirror.missing', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
          continue;
        }
        if (isTransientError(error)) {
          transientMirrors.add(mirror.id);
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
          log('warn', 'map.download.mirror.transient', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
          continue;
        }
        failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
        log('warn', 'map.download.mirror.failed', { jobId: job.id, beatmapsetId: setId, mirror: mirror.id, error: safeErrorMessage(error) });
      }
    }

    if (missingMirrors.size === MIRRORS.length) break;

    const cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
    const hasTransient = transientMirrors.size > 0;
    if (!hasTransient || cooldowns.length === MIRRORS.length || transientRetries >= MIRROR_TRANSIENT_RETRIES) {
      break;
    }

    transientRetries += 1;
    const backoffMs = 1500 * transientRetries;
    job.message = `Зеркала отдали временные ошибки — жду ${Math.ceil(backoffMs / 1000)} с и пробую ещё раз.`;
    log('info', 'map.download.transient.wait', { jobId: job.id, beatmapsetId: setId, backoffMs, attempt: transientRetries });
    await sleepWithSignal(backoffMs, job.abortController?.signal);
    if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
  }

  let cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);

  if (cooldowns.length === MIRRORS.length) {
    const waitMs = Math.min(...cooldowns);
    if (waitMs > 0 && waitMs <= MIRROR_COOLDOWN_WAIT_MAX_MS) {
      log('info', 'map.download.all_mirrors_cooldown.wait', { jobId: job.id, beatmapsetId: setId, waitMs });
      job.message = `Все зеркала на паузе — жду ${Math.ceil(waitMs / 1000)} с…`;
      await sleepWithSignal(waitMs + 500, job.abortController?.signal);
      if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
      for (const mirror of getCandidateMirrors()) {
        if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
        if (missingMirrors.has(mirror.id)) continue;
        if (mirrorCooldownRemaining(mirror) > 0) continue;
        job.currentMirror = mirror.label;
        if (job.activeTransfers) {
          const t = job.activeTransfers.get(setId);
          if (t) t.mirror = mirror.label;
        }
        job.currentBytes = 0;
        job.currentTotalBytes = null;
        job.currentPercent = 0;
        try {
          await downloadSet(setId, { kind: 'mirror', mirror }, job);
          return;
        } catch (error) {
          job.currentBytes = 0;
          job.currentTotalBytes = null;
          job.currentPercent = 0;
          if (job.status === 'cancelled' || job.abortController?.signal?.aborted) return;
          if (error instanceof MirrorRateLimitError) {
            mirrorCooldowns.set(mirror.id, Date.now() + error.retryAfterMs);
            continue;
          }
          if (/** @type {any} */ (error).isMissing) {
            missingMirrors.add(mirror.id);
          }
          failures.set(mirror.id, `${mirror.label}: ${safeErrorMessage(error).slice(0, 240)}`);
        }
      }
    }
  }

  cooldowns = MIRRORS.map(mirrorCooldownRemaining).filter(ms => ms > 0);
  const allCooldown = cooldowns.length === MIRRORS.length;
  const allMissing = missingMirrors.size === MIRRORS.length;

  if (allCooldown) {
    const error = /** @type {any} */ (new Error('Все зеркала временно ограничили загрузки (HTTP 429).'));
    error.allCooldown = true;
    error.retryLater = true;
    throw error;
  }

  if (cooldowns.length > 0 && !allMissing) {
    const error = /** @type {any} */ (new Error(`зеркало(а) остывают/отдают 429 — набор отложен: ${[...failures.values()].filter(Boolean).join('; ') || 'зеркала остывали'}`));
    error.deferSet = true;
    throw error;
  }
  const detail = [...failures.values()].filter(Boolean).join('; ');
  if (!detail) {
    const error = /** @type {any} */ (new Error('ни одно зеркало не ответило (все на cooldown) — набор отложен'));
    error.allCooldown = true;
    error.retryLater = true;
    throw error;
  }
  if (allMissing) {
    throw new Error(`набора нет ни на одном зеркале (404): ${detail}`);
  }
  throw new Error(`ни одно зеркало не отдало файл — ${detail}${rateLimited ? '; часть зеркал ограничила загрузки (HTTP 429)' : ''}`);
}

module.exports = {
  partPath,
  jobFilePath,
  cleanupJobPartFiles,
  cleanupStalePartFiles,
  ensureDiskSpace,
  estimateRequiredDiskSpace,
  isSameFileSystem,
  getFreeDiskSpace,
  appendNoVideo,
  isNoSpaceError,
  verifyZipFile,
  isValidZipOnDisk,
  streamBodyToFile,
  downloadSet,
  downloadFromMirrors,
  authHeaders,
  responsePreview,
};
