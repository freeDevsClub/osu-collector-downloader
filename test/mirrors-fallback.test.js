"use strict";

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  downloadFromMirrors,
  MIRRORS,
  mirrorCooldowns,
} = require('../server.js');

describe('Интеграционные тесты fallback между зеркалами', () => {
  let s1, s2, s3;
  let port1, port2, port3;
  let originalMirrors;
  let tempDir;

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirrors-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

    // Зеркало 1: всегда 429 с Retry-After: 60
    s1 = http.createServer((req, res) => {
      res.writeHead(429, { 'Retry-After': '60', 'Content-Type': 'text/plain' });
      res.end('Rate limited');
    });
    await new Promise(r => s1.listen(0, '127.0.0.1', r));
    port1 = /** @type {import('node:net').AddressInfo} */ (s1.address()).port;

    // Зеркало 2: всегда 500 (временный сбой)
    s2 = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });
    await new Promise(r => s2.listen(0, '127.0.0.1', r));
    port2 = /** @type {import('node:net').AddressInfo} */ (s2.address()).port;

    // Зеркало 3: всегда 200 с валидным ZIP
    s3 = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validZipBuffer.length),
      });
      res.end(validZipBuffer);
    });
    await new Promise(r => s3.listen(0, '127.0.0.1', r));
    port3 = /** @type {import('node:net').AddressInfo} */ (s3.address()).port;

    originalMirrors = [...MIRRORS];
  });

  after(async () => {
    MIRRORS.length = 0;
    MIRRORS.push(...originalMirrors);
    mirrorCooldowns.clear();
    await Promise.all([
      new Promise(r => s1.close(r)),
      new Promise(r => s2.close(r)),
      new Promise(r => s3.close(r)),
    ]);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('успешно переключается с 429 и 500 на работающее 3-е зеркало', async () => {
    mirrorCooldowns.clear();
    MIRRORS.length = 0;
    MIRRORS.push(
      { id: 'm1_429', label: 'Mirror 1 (429)', build: id => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm2_500', label: 'Mirror 2 (500)', build: id => `http://127.0.0.1:${port2}/d/${id}` },
      { id: 'm3_200', label: 'Mirror 3 (200)', build: id => `http://127.0.0.1:${port3}/d/${id}` }
    );

    const job = {
      id: 'test_job_1',
      status: 'running',
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById: new Map(),
      currentBytes: 0,
      currentTotalBytes: null,
      currentPercent: 0,
      currentMirror: null,
    };

    const setId = 99901;
    await downloadFromMirrors(setId, job);

    // 1. Зеркало 1 получило 429 и встало на паузу
    assert.ok(mirrorCooldowns.has('m1_429'), 'Зеркало 1 должно быть на кулдауне после 429');
    assert.ok(mirrorCooldowns.get('m1_429') > Date.now());

    // 2. Зеркало 3 успешно отдало файл
    assert.ok(job.doneIds.has(setId), 'Набор должен быть помечен как успешно скачанный');
    assert.equal(job.errIds.has(setId), false);

    // 3. Файл сохранён на диске
    const filePath = path.join(tempDir, `${setId}.osz`);
    const stat = await fs.stat(filePath);
    assert.equal(stat.size, validZipBuffer.length);
  });

  it('отклоняет набор и сообщает missing, если все зеркала возвращают 404', async () => {
    mirrorCooldowns.clear();
    // Создаем сервер, отдающий 404
    const s404 = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise(r => s404.listen(0, '127.0.0.1', () => r(null)));
    const addr = /** @type {import('node:net').AddressInfo} */ (s404.address());
    const port404 = addr.port;

    MIRRORS.length = 0;
    MIRRORS.push(
      { id: 'm_404_a', label: 'Mirror 404 A', build: id => `http://127.0.0.1:${port404}/d/${id}` },
      { id: 'm_404_b', label: 'Mirror 404 B', build: id => `http://127.0.0.1:${port404}/d/${id}` }
    );

    const job = {
      id: 'test_job_404',
      status: 'running',
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
    };

    try {
      await assert.rejects(
        async () => { await downloadFromMirrors(99902, job); },
        /набора нет ни на одном зеркале \(404\)/
      );
    } finally {
      await new Promise(r => s404.close(r));
    }
  });

  it('ставит на паузу (allCooldown), если все зеркала возвращают 429', async () => {
    mirrorCooldowns.clear();
    MIRRORS.length = 0;
    MIRRORS.push(
      { id: 'm_429_a', label: 'Mirror 429 A', build: id => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm_429_b', label: 'Mirror 429 B', build: id => `http://127.0.0.1:${port1}/d/${id}` }
    );

    const job = {
      id: 'test_job_cooldown',
      status: 'running',
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
    };

    await assert.rejects(
      async () => { await downloadFromMirrors(99903, job); },
      (err) => {
        const e = /** @type {any} */ (err);
        assert.ok(e.allCooldown === true, 'Ошибка должна содержать allCooldown: true');
        return true;
      }
    );

    assert.ok(mirrorCooldowns.has('m_429_a'));
    assert.ok(mirrorCooldowns.has('m_429_b'));
  });
});
