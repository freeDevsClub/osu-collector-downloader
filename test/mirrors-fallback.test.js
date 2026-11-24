'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { downloadFromMirrors, safeDownloadFetch } = require('../lib/downloader.js');
const {
  mirrorCooldowns,
  parseRetryAfter,
  getMirrorCooldownDefaultMs,
  getMirrorCooldownMaxMs,
  getMirrorCooldownWaitMaxMs,
  MIRROR_COOLDOWN_DEFAULT_MS,
  MIRROR_COOLDOWN_MAX_MS,
  MIRROR_COOLDOWN_WAIT_MAX_MS,
  setMirrorsForTest,
  resetMirrorsForTest,
} = require('../lib/mirrors.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('Интеграционные тесты fallback между зеркалами', () => {
  let s1, s2, s3;
  let port1, port2, port3;
  let originalMirrors;
  let testEnv;

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    testEnv = await setupIsolatedTestEnv('mirrors-test-');

    // Зеркало 1: всегда 429 с Retry-After: 60
    s1 = http.createServer((req, res) => {
      res.writeHead(429, { 'Retry-After': '60', 'Content-Type': 'text/plain' });
      res.end('Rate limited');
    });
    await new Promise((r) => s1.listen(0, '127.0.0.1', r));
    port1 = /** @type {import('node:net').AddressInfo} */ (s1.address()).port;

    // Зеркало 2: всегда 500 (временный сбой)
    s2 = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    port2 = /** @type {import('node:net').AddressInfo} */ (s2.address()).port;

    // Зеркало 3: всегда 200 с валидным ZIP
    s3 = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validZipBuffer.length),
      });
      res.end(validZipBuffer);
    });
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    port3 = /** @type {import('node:net').AddressInfo} */ (s3.address()).port;

    resetMirrorsForTest();
  });

  after(async () => {
    resetMirrorsForTest();
    await Promise.all([
      new Promise((r) => s1.close(r)),
      new Promise((r) => s2.close(r)),
      new Promise((r) => s3.close(r)),
    ]);
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it('успешно переключается с 429 и 500 на работающее 3-е зеркало', async () => {
    setMirrorsForTest([
      { id: 'm1_429', label: 'Mirror 1 (429)', build: (id) => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm2_500', label: 'Mirror 2 (500)', build: (id) => `http://127.0.0.1:${port2}/d/${id}` },
      { id: 'm3_200', label: 'Mirror 3 (200)', build: (id) => `http://127.0.0.1:${port3}/d/${id}` },
    ]);

    const job = createTestJob({
      id: 'test_job_1',
      status: 'running',
    });

    const setId = 99901;
    await downloadFromMirrors(setId, job);

    // 1. Зеркало 1 получило 429 и встало на паузу
    assert.ok(mirrorCooldowns.has('m1_429'), 'Зеркало 1 должно быть на кулдауне после 429');
    assert.ok(mirrorCooldowns.get('m1_429') > Date.now());

    // 2. Зеркало 3 успешно отдало файл
    assert.ok(job.doneIds.has(setId), 'Набор должен быть помечен как успешно скачанный');
    assert.equal(job.errIds.has(setId), false);

    // 3. Файл сохранён на диске
    const filePath = path.join(testEnv.tempDownloadsDir, `${setId}.osz`);
    const stat = await fs.stat(filePath);
    assert.equal(stat.size, validZipBuffer.length);
  });

  it('отклоняет набор и сообщает missing, если все зеркала возвращают 404', async () => {
    // Создаем сервер, отдающий 404
    const s404 = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise((r) => s404.listen(0, '127.0.0.1', () => r(null)));
    const addr = /** @type {import('node:net').AddressInfo} */ (s404.address());
    const port404 = addr.port;

    setMirrorsForTest([
      { id: 'm_404_a', label: 'Mirror 404 A', build: (id) => `http://127.0.0.1:${port404}/d/${id}` },
      { id: 'm_404_b', label: 'Mirror 404 B', build: (id) => `http://127.0.0.1:${port404}/d/${id}` },
    ]);

    const job = createTestJob({
      id: 'test_job_404',
      status: 'running',
    });

    try {
      await assert.rejects(
        async () => {
          await downloadFromMirrors(99902, job);
        },
        (err) => {
          const e = /** @type {any} */ (err);
          assert.match(e.message, /набора нет ни на одном зеркале \(404\)/);
          assert.match(e.message, /osu\.ppy\.sh/);
          return true;
        },
      );
    } finally {
      await new Promise((r) => s404.close(r));
    }
  });

  it('ставит на паузу (allCooldown), если все зеркала возвращают 429', async () => {
    setMirrorsForTest([
      { id: 'm_429_a', label: 'Mirror 429 A', build: (id) => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm_429_b', label: 'Mirror 429 B', build: (id) => `http://127.0.0.1:${port1}/d/${id}` },
    ]);

    const job = createTestJob({
      id: 'test_job_cooldown',
      status: 'running',
    });

    await assert.rejects(
      async () => {
        await downloadFromMirrors(99903, job);
      },
      (err) => {
        const e = /** @type {any} */ (err);
        assert.ok(e.allCooldown === true, 'Ошибка должна содержать allCooldown: true');
        return true;
      },
    );

    assert.ok(mirrorCooldowns.has('m_429_a'));
    assert.ok(mirrorCooldowns.has('m_429_b'));
  });

  it('downloader.js использует динамический MIRROR_COOLDOWN_DEFAULT_MS при 429 без Retry-After', async () => {
    const prevDefault = process.env.MIRROR_COOLDOWN_DEFAULT_MS;
    const prevWait = process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    process.env.MIRROR_COOLDOWN_DEFAULT_MS = '2500'; // 2.5 секунды
    process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = '500'; // лимит ожидания в цикле ниже кулдауна, чтобы сразу отложить задачу
    try {
      mirrorCooldowns.clear();
      // Сервер, возвращающий 429 БЕЗ заголовка Retry-After
      const s429NoHeader = http.createServer((req, res) => {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Rate Limited Without Header');
      });
      await new Promise((r) => s429NoHeader.listen(0, '127.0.0.1', () => r(null)));
      const port429NoHeader = /** @type {import('node:net').AddressInfo} */ (s429NoHeader.address()).port;

      setMirrorsForTest([
        {
          id: 'm_dyn_default',
          label: 'Mirror Dynamic Default',
          build: (id) => `http://127.0.0.1:${port429NoHeader}/d/${id}`,
        },
      ]);

      const job = createTestJob({
        id: 'test_job_dyn_default',
        status: 'running',
      });

      const start = Date.now();
      await assert.rejects(
        async () => {
          await downloadFromMirrors(99904, job);
        },
        (err) => {
          const e = /** @type {any} */ (err);
          return e.allCooldown === true;
        },
      );

      assert.ok(mirrorCooldowns.has('m_dyn_default'));
      const until = mirrorCooldowns.get('m_dyn_default');
      const cooldownMs = until - start;
      // Должно быть около 2500 мс (с небольшим допуском), а не захардкоженные 60 000 мс!
      assert.ok(cooldownMs >= 2000 && cooldownMs <= 3500, `Ожидался кулдаун ~2500мс, фактически: ${cooldownMs}мс`);

      await new Promise((r) => s429NoHeader.close(r));
    } finally {
      if (prevDefault !== undefined) process.env.MIRROR_COOLDOWN_DEFAULT_MS = prevDefault;
      else delete process.env.MIRROR_COOLDOWN_DEFAULT_MS;
      if (prevWait !== undefined) process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = prevWait;
      else delete process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    }
  });

  it('downloader.js соблюдает динамический лимит ожидания в цикле MIRROR_COOLDOWN_WAIT_MAX_MS', async () => {
    const prevEnv = process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    try {
      // 1. Лимит ожидания 1000 мс: кулдаун 4000 мс превышает лимит -> не ждём в цикле, сразу allCooldown
      process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = '1000';
      setMirrorsForTest([
        { id: 'm_wait_test', label: 'Wait Test Mirror', build: (id) => `http://127.0.0.1:${port3}/d/${id}` },
      ]);
      mirrorCooldowns.set('m_wait_test', Date.now() + 4000);

      const job = createTestJob({
        id: 'test_job_wait_max',
        status: 'running',
      });

      const start = Date.now();
      await assert.rejects(
        async () => {
          await downloadFromMirrors(99905, job);
        },
        (err) => {
          const e = /** @type {any} */ (err);
          return e.allCooldown === true;
        },
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, `Не должно ждать 4 секунды, если лимит ожидания 1000мс. Заняло ${elapsed}мс`);

      // 2. Лимит ожидания 3000 мс: кулдаун 200 мс укладывается в лимит -> дожидается и успешно скачивает
      process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = '3000';
      mirrorCooldowns.clear();
      mirrorCooldowns.set('m_wait_test', Date.now() + 200);

      await downloadFromMirrors(99906, job);
      assert.ok(job.doneIds.has(99906), 'Набор должен быть успешно скачан после короткого ожидания');
    } finally {
      if (prevEnv !== undefined) process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = prevEnv;
      else delete process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    }
  });

  it('mirrors.js парсит Retry-After с учётом динамического потолка MIRROR_COOLDOWN_MAX_MS', () => {
    const prevEnv = process.env.MIRROR_COOLDOWN_MAX_MS;
    try {
      process.env.MIRROR_COOLDOWN_MAX_MS = '12000'; // 12 секунд потолок
      // Потолок должен ограничить 1 час (3600с) до 12000 мс, а не до дефолтных 15 минут
      const capped = parseRetryAfter('3600');
      assert.equal(capped, 12000);

      // Маленькие значения не должны обрезаться
      const normal = parseRetryAfter('5');
      assert.equal(normal, 5000);
    } finally {
      if (prevEnv !== undefined) process.env.MIRROR_COOLDOWN_MAX_MS = prevEnv;
      else delete process.env.MIRROR_COOLDOWN_MAX_MS;
    }
  });

  it('геттеры и константы кулдаунов зеркал возвращают актуальные значения конфигурации', () => {
    const prevDefault = process.env.MIRROR_COOLDOWN_DEFAULT_MS;
    const prevMax = process.env.MIRROR_COOLDOWN_MAX_MS;
    const prevWait = process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    try {
      process.env.MIRROR_COOLDOWN_DEFAULT_MS = '5000';
      process.env.MIRROR_COOLDOWN_MAX_MS = '20000';
      process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = '8000';

      assert.equal(getMirrorCooldownDefaultMs(), 5000);
      assert.equal(getMirrorCooldownMaxMs(), 20000);
      assert.equal(getMirrorCooldownWaitMaxMs(), 8000);

      // Свойство-геттер на объекте конфигурации также динамически возвращает обновлённое значение
      const config = require('../lib/config.js');
      assert.equal(config.MIRROR_COOLDOWN_DEFAULT_MS, 5000);
      assert.equal(config.MIRROR_COOLDOWN_MAX_MS, 20000);
      assert.equal(config.MIRROR_COOLDOWN_WAIT_MAX_MS, 8000);
    } finally {
      if (prevDefault !== undefined) process.env.MIRROR_COOLDOWN_DEFAULT_MS = prevDefault;
      else delete process.env.MIRROR_COOLDOWN_DEFAULT_MS;
      if (prevMax !== undefined) process.env.MIRROR_COOLDOWN_MAX_MS = prevMax;
      else delete process.env.MIRROR_COOLDOWN_MAX_MS;
      if (prevWait !== undefined) process.env.MIRROR_COOLDOWN_WAIT_MAX_MS = prevWait;
      else delete process.env.MIRROR_COOLDOWN_WAIT_MAX_MS;
    }
  });

  it('откладывает набор (deferSet = true), если часть зеркал 404, а часть вернули 5xx/таймаут', async () => {
    const s404 = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    const s503 = http.createServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
    });
    await Promise.all([
      new Promise((r) => s404.listen(0, '127.0.0.1', () => r(null))),
      new Promise((r) => s503.listen(0, '127.0.0.1', () => r(null))),
    ]);
    const port404 = /** @type {import('node:net').AddressInfo} */ (s404.address()).port;
    const port503 = /** @type {import('node:net').AddressInfo} */ (s503.address()).port;

    setMirrorsForTest([
      { id: 'm_test_503', label: 'Mirror 503', build: (id) => `http://127.0.0.1:${port503}/d/${id}` },
      { id: 'm_test_404', label: 'Mirror 404', build: (id) => `http://127.0.0.1:${port404}/d/${id}` },
    ]);

    const job = createTestJob({
      id: 'test_job_defer_503',
      status: 'running',
    });

    try {
      await assert.rejects(
        async () => {
          await downloadFromMirrors(99907, job);
        },
        (err) => {
          const e = /** @type {any} */ (err);
          assert.equal(e.deferSet, true, 'Ошибка должна содержать deferSet: true');
          assert.match(e.message, /Mirror 503/);
          assert.match(e.message, /Mirror 404/);
          return true;
        },
      );
    } finally {
      await Promise.all([
        new Promise((r) => s404.close(r)),
        new Promise((r) => s503.close(r)),
      ]);
    }
  });

  it('включает в диагностику зеркала на кулдауне (429) и откладывает набор при частичных 404', async () => {
    const s404 = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise((r) => s404.listen(0, '127.0.0.1', () => r(null)));
    const port404 = /** @type {import('node:net').AddressInfo} */ (s404.address()).port;

    setMirrorsForTest([
      { id: 'm_cd_429', label: 'Mirror Cooldown', build: (id) => `http://127.0.0.1:${port404}/d/${id}` },
      { id: 'm_only_404', label: 'Mirror 404 Only', build: (id) => `http://127.0.0.1:${port404}/d/${id}` },
    ]);
    mirrorCooldowns.set('m_cd_429', Date.now() + 5000);

    const job = createTestJob({
      id: 'test_job_defer_cooldown_diag',
      status: 'running',
    });

    try {
      await assert.rejects(
        async () => {
          await downloadFromMirrors(99908, job);
        },
        (err) => {
          const e = /** @type {any} */ (err);
          assert.equal(e.deferSet, true, 'Ошибка должна содержать deferSet: true');
          assert.match(e.message, /Mirror Cooldown: остывает после 429/);
          assert.match(e.message, /Mirror 404 Only/);
          return true;
        },
      );
    } finally {
      mirrorCooldowns.clear();
      await new Promise((r) => s404.close(r));
    }
  });

  it('safeDownloadFetch отклоняет промис с ETIMEDOUT при срабатывании таймаута', async () => {
    // Сервер, который принимает соединение, но не отправляет заголовки
    const hangingServer = http.createServer(() => {
      // намеренно не отвечаем
    });
    await new Promise((r) => hangingServer.listen(0, '127.0.0.1', () => r(null)));
    const hangPort = /** @type {import('node:net').AddressInfo} */ (hangingServer.address()).port;

    try {
      await assert.rejects(
        async () => {
          await safeDownloadFetch(`http://127.0.0.1:${hangPort}/hang`, { timeout: 150 });
        },
        (err) => {
          const e = /** @type {any} */ (err);
          assert.equal(e.code, 'ETIMEDOUT');
          return true;
        },
      );
    } finally {
      await new Promise((r) => hangingServer.close(r));
    }
  });

  it('config.js экспортирует DEFERRED_RETRY_DELAY_MS и getDeferredRetryDelayMs', () => {
    const config = require('../lib/config.js');
    assert.equal(typeof config.getDeferredRetryDelayMs, 'function');
    assert.ok(config.getDeferredRetryDelayMs() >= 0);
    assert.ok(config.DEFERRED_RETRY_DELAY_MS >= 0);
  });
});
