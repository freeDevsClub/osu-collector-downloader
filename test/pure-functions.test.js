"use strict";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  extractCollectionId,
  parseRetryAfter,
  verifyZipFile,
  jobCounters,
  formatBytes,
  safeErrorMessage,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  isPrivateIp,
  isPrivateIPv4,
  isPrivateIPv6,
  redirectHostAllowed,
  HttpError,
  pluralizeRu,
  formatPluralRu,
} = require('../server.js');

describe('extractCollectionId', () => {
  it('извлекает ID из полного HTTPS URL osu!Collector', () => {
    assert.equal(extractCollectionId('https://osucollector.com/collections/23905/stream-180-189'), '23905');
    assert.equal(extractCollectionId('https://www.osucollector.com/collections/123'), '123');
    assert.equal(extractCollectionId('https://osucollector.com/collections/9999/'), '9999');
  });

  it('принимает числовой ID напрямую', () => {
    assert.equal(extractCollectionId('23905'), '23905');
    assert.equal(extractCollectionId('  12345  '), '12345');
  });

  it('выбрасывает HttpError (400) при некорректных данных', () => {
    assert.throws(() => extractCollectionId(''), { status: 400 });
    assert.throws(() => extractCollectionId('not-a-url'), { status: 400 });
    assert.throws(() => extractCollectionId('http://osucollector.com/collections/123'), { status: 400 }); // не https
    assert.throws(() => extractCollectionId('https://evil.com/collections/123'), { status: 400 }); // чужой хост
    assert.throws(() => extractCollectionId('https://osucollector.com/users/123'), { status: 400 }); // не collections
  });
});

describe('parseRetryAfter', () => {
  it('корректно парсит секунды в миллисекунды', () => {
    assert.equal(parseRetryAfter('60'), 60000);
    assert.equal(parseRetryAfter('120'), 120000);
  });

  it('ограничивает максимальный кулдаун 15 минутами', () => {
    assert.equal(parseRetryAfter('999999'), 15 * 60 * 1000);
  });

  it('возвращает null для нулевых и отрицательных значений (fallback на DEFAULT)', () => {
    assert.equal(parseRetryAfter('0'), null);
    assert.equal(parseRetryAfter('-5'), null);
    assert.equal(parseRetryAfter(''), null);
    assert.equal(parseRetryAfter(null), null);
  });

  it('парсит HTTP-даты в будущем', () => {
    const futureDate = new Date(Date.now() + 30000).toUTCString();
    const result = parseRetryAfter(futureDate);
    assert.ok(typeof result === 'number' && result > 20000 && result <= 35000);
  });

  it('возвращает null для HTTP-дат в прошлом', () => {
    const pastDate = new Date(Date.now() - 30000).toUTCString();
    assert.equal(parseRetryAfter(pastDate), null);
  });
});

describe('jobCounters', () => {
  it('корректно рассчитывает прогресс без ошибок', () => {
    const job = {
      setIds: [1, 2, 3, 4, 5],
      doneIds: new Set([1, 2]),
      skipIds: new Set([3]),
      errIds: new Set(),
      extraFailures: 0,
    };
    const counters = jobCounters(job);
    assert.deepEqual(counters, {
      downloaded: 2,
      skipped: 1,
      failed: 0,
      completed: 3,
      deferred: 2,
    });
  });

  it('учитывает ошибки и исключает повторы из done/skip', () => {
    const job = {
      setIds: [1, 2, 3, 4],
      doneIds: new Set([1]),
      skipIds: new Set([2]),
      errIds: new Set([1, 3]), // 1 уже в doneIds, поэтому failed = 1 (только 3)
      extraFailures: 1,
    };
    const counters = jobCounters(job);
    assert.deepEqual(counters, {
      downloaded: 1,
      skipped: 1,
      failed: 2, // id 3 + 1 extraFailure
      completed: 4,
      deferred: 0,
    });
  });
});

describe('formatBytes', () => {
  it('форматирует различные объёмы данных', () => {
    assert.equal(formatBytes(0), '0 Б');
    assert.equal(formatBytes(500), '500 Б');
    assert.equal(formatBytes(1024), '1.0 КБ');
    assert.equal(formatBytes(10 * 1024 * 1024), '10.0 МБ');
    assert.equal(formatBytes(100 * 1024 * 1024), '100 МБ');
    assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 ГБ');
  });

  it('обрабатывает некорректные и отрицательные значения', () => {
    assert.equal(formatBytes(-1), 'unknown');
    assert.equal(formatBytes(NaN), 'unknown');
  });
});

describe('safeErrorMessage', () => {
  it('маскирует перенос строк и усекает длину', () => {
    const multiline = 'First line\r\nSecond line\twith tab';
    const sanitized = safeErrorMessage(multiline);
    assert.equal(sanitized, 'First line  Second line with tab');
  });

  it('корректно обрабатывает пустые ошибки и объекты', () => {
    assert.equal(safeErrorMessage(null), 'Unknown error');
    assert.equal(safeErrorMessage(new Error('Тестовая ошибка')), 'Тестовая ошибка');
  });

  it('маскирует зарегистрированные секреты и поддерживает счётчик ссылок', () => {
    clearRedactions();
    assert.equal(getActiveRedactionsCount(), 0);

    const secret = 'super_secret_osu_token_12345';
    addRedaction(secret);
    assert.equal(getActiveRedactionsCount(), 1);

    const errorMsg = safeErrorMessage(new Error(`Failed with ${secret} in payload`));
    assert.equal(errorMsg, 'Failed with [redacted] in payload');

    // Повторное добавление того же секрета увеличивает ref-count, не создавая дубликатов
    addRedaction(secret);
    assert.equal(getActiveRedactionsCount(), 1);

    // Удаление одного использования оставляет секрет замаскированным (ref-count > 0)
    removeRedaction(secret);
    assert.equal(getActiveRedactionsCount(), 1);
    assert.equal(safeErrorMessage(`Token: ${secret}`), 'Token: [redacted]');

    // Полное удаление (ref-count = 0) удаляет секрет из списка маскирования
    removeRedaction(secret);
    assert.equal(getActiveRedactionsCount(), 0);
    assert.equal(safeErrorMessage(`Token: ${secret}`), `Token: ${secret}`);

    // Игнорирует слишком короткие строки (< 4 символов)
    addRedaction('abc');
    assert.equal(getActiveRedactionsCount(), 0);
  });
});

describe('isPrivateIp (IPv4 / IPv6)', () => {
  it('блокирует все виды приватных и локальных сетей', () => {
    // Loopback
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('127.100.0.1'), true);
    assert.equal(isPrivateIp('::1'), true);

    // RFC 1918 Private
    assert.equal(isPrivateIp('10.0.0.1'), true);
    assert.equal(isPrivateIp('172.16.0.1'), true);
    assert.equal(isPrivateIp('172.31.255.255'), true);
    assert.equal(isPrivateIp('192.168.1.1'), true);

    // Link-local & Cloud Metadata
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('fe80::1'), true);

    // Carrier-Grade NAT
    assert.equal(isPrivateIp('100.64.0.1'), true);
    assert.equal(isPrivateIp('100.127.255.255'), true);

    // IPv6 Unique Local
    assert.equal(isPrivateIp('fc00::1'), true);
    assert.equal(isPrivateIp('fd12:3456::1'), true);

    // IPv4-mapped IPv6 to private IPv4
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIp('::ffff:192.168.0.1'), true);
  });

  it('разрешает легитимные публичные IP-адреса', () => {
    assert.equal(isPrivateIp('104.21.41.231'), false); // Cloudflare
    assert.equal(isPrivateIp('172.67.195.154'), false); // Cloudflare
    assert.equal(isPrivateIp('8.8.8.8'), false); // Google DNS
    assert.equal(isPrivateIp('1.1.1.1'), false); // Cloudflare DNS
    assert.equal(isPrivateIp('2606:4700:3033::ac43:c39a'), false); // Cloudflare IPv6
  });
});

describe('verifyZipFile', () => {
  let tempDir;

  it('успешно валидирует корректный пустой ZIP-архив (EOCD 22 байта)', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-'));
    const zipPath = path.join(tempDir, 'valid.zip');
    // Минимальный EOCD: сигнатура 0x06054b50 + 18 нулевых байт
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await fs.writeFile(zipPath, eocd);
    const handle = await fs.open(zipPath, 'r');
    try {
      const valid = await verifyZipFile(handle, eocd.length);
      assert.equal(valid, true);
    } finally {
      await handle.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('отклоняет усечённый файл менее 22 байт', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-'));
    const zipPath = path.join(tempDir, 'truncated.zip');
    await fs.writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const handle = await fs.open(zipPath, 'r');
    try {
      const valid = await verifyZipFile(handle, 4);
      assert.equal(valid, false);
    } finally {
      await handle.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('отклоняет файл без EOCD сигнатуры', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-'));
    const zipPath = path.join(tempDir, 'fake.zip');
    await fs.writeFile(zipPath, Buffer.alloc(100, 0x41)); // 100 байт букв 'A'
    const handle = await fs.open(zipPath, 'r');
    try {
      const valid = await verifyZipFile(handle, 100);
      assert.equal(valid, false);
    } finally {
      await handle.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('redirectHostAllowed', () => {
  it('разрешает только домены ppy.sh по HTTPS и на стандартном порту 443', () => {
    assert.equal(redirectHostAllowed(new URL('https://osu.ppy.sh/d/123')), true);
    assert.equal(redirectHostAllowed(new URL('https://ppy.sh/d/123')), true);
    assert.equal(redirectHostAllowed(new URL('https://assets.ppy.sh/d/123')), true);
  });

  it('отклоняет сторонние домены, HTTP и нестандартные порты', () => {
    assert.equal(redirectHostAllowed(new URL('http://osu.ppy.sh/d/123')), false); // HTTP
    assert.equal(redirectHostAllowed(new URL('https://osu.ppy.sh:8443/d/123')), false); // Нестандартный порт
    assert.equal(redirectHostAllowed(new URL('https://fake-ppy.sh/d/123')), false);
    assert.equal(redirectHostAllowed(new URL('https://ppy.sh.evil.com/d/123')), false);
  });
});

describe('pluralizeRu и formatPluralRu', () => {
  it('корректно выбирает грамматическую форму числительного в русском языке', () => {
    // 1 набор, 21 набор, 101 набор
    assert.equal(pluralizeRu(1, 'набор', 'набора', 'наборов'), 'набор');
    assert.equal(pluralizeRu(21, 'набор', 'набора', 'наборов'), 'набор');
    assert.equal(pluralizeRu(101, 'набор', 'набора', 'наборов'), 'набор');

    // 2-4 набора, 22-24 набора
    assert.equal(pluralizeRu(2, 'набор', 'набора', 'наборов'), 'набора');
    assert.equal(pluralizeRu(3, 'набор', 'набора', 'наборов'), 'набора');
    assert.equal(pluralizeRu(4, 'набор', 'набора', 'наборов'), 'набора');
    assert.equal(pluralizeRu(22, 'набор', 'набора', 'наборов'), 'набора');
    assert.equal(pluralizeRu(34, 'набор', 'набора', 'наборов'), 'набора');

    // 0, 5-20, 25-30 наборов
    assert.equal(pluralizeRu(0, 'набор', 'набора', 'наборов'), 'наборов');
    assert.equal(pluralizeRu(5, 'набор', 'набора', 'наборов'), 'наборов');
    assert.equal(pluralizeRu(11, 'набор', 'набора', 'наборов'), 'наборов');
    assert.equal(pluralizeRu(14, 'набор', 'набора', 'наборов'), 'наборов');
    assert.equal(pluralizeRu(20, 'набор', 'набора', 'наборов'), 'наборов');
    assert.equal(pluralizeRu(25, 'набор', 'набора', 'наборов'), 'наборов');
  });

  it('форматирует строку с числом и существительным (formatPluralRu)', () => {
    assert.equal(formatPluralRu(1, 'набор', 'набора', 'наборов'), '1 набор');
    assert.equal(formatPluralRu(2, 'набор', 'набора', 'наборов'), '2 набора');
    assert.equal(formatPluralRu(5, 'набор', 'набора', 'наборов'), '5 наборов');
    assert.equal(formatPluralRu(21, 'набор', 'набора', 'наборов'), '21 набор');

    // Родительный падеж ("для 1 набора", "для 2 наборов", "для 5 наборов")
    assert.equal(formatPluralRu(1, 'набора', 'наборов', 'наборов'), '1 набора');
    assert.equal(formatPluralRu(2, 'набора', 'наборов', 'наборов'), '2 наборов');
    assert.equal(formatPluralRu(5, 'набора', 'наборов', 'наборов'), '5 наборов');
    assert.equal(formatPluralRu(21, 'набора', 'наборов', 'наборов'), '21 набора');
  });
});

describe('HttpError', () => {
  it('инициализирует status как каноническое свойство и синхронизирует httpStatus', () => {
    const err = new HttpError(404, 'Не найдено');
    assert.equal(err instanceof Error, true);
    assert.equal(err instanceof HttpError, true);
    assert.equal(err.name, 'HttpError');
    assert.equal(err.message, 'Не найдено');
    assert.equal(err.status, 404);
    assert.equal(err.httpStatus, 404);

    // Проверка сеттера httpStatus
    err.httpStatus = 500;
    assert.equal(err.status, 500);
    assert.equal(err.httpStatus, 500);

    // Проверка изменения status
    err.status = 503;
    assert.equal(err.httpStatus, 503);
  });
});
