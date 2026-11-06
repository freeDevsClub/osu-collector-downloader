"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  acquireMirrorSlot,
  isMirrorBusy,
  resetMirrorSlots,
  DOWNLOAD_CONCURRENCY,
  MIRRORS,
  mirrorCooldowns,
} = require('../server.js');
const { runJob, safeJobForClient } = require('../lib/jobs.js');

describe('Worker Pool и per-mirror concurrency', () => {
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

  const mirrorStats = {
    m1: { active: 0, maxActive: 0, total: 0 },
    m2: { active: 0, maxActive: 0, total: 0 },
    m3: { active: 0, maxActive: 0, total: 0 },
    globalActive: 0,
    maxGlobalActive: 0,
  };

  function trackServer(key, delayMs = 30) {
    return http.createServer((req, res) => {
      mirrorStats[key].active += 1;
      mirrorStats.globalActive += 1;
      mirrorStats[key].total += 1;
      if (mirrorStats[key].active > mirrorStats[key].maxActive) {
        mirrorStats[key].maxActive = mirrorStats[key].active;
      }
      if (mirrorStats.globalActive > mirrorStats.maxGlobalActive) {
        mirrorStats.maxGlobalActive = mirrorStats.globalActive;
      }

      setTimeout(() => {
        mirrorStats[key].active -= 1;
        mirrorStats.globalActive -= 1;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(validZipBuffer.length),
        });
        res.end(validZipBuffer);
      }, delayMs);
    });
  }

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-test-'));
    process.env.DOWNLOADS_DIR = tempDir;

    s1 = trackServer('m1', 40);
    s2 = trackServer('m2', 40);
    s3 = trackServer('m3', 40);

    await Promise.all([
      new Promise(r => s1.listen(0, '127.0.0.1', r)),
      new Promise(r => s2.listen(0, '127.0.0.1', r)),
      new Promise(r => s3.listen(0, '127.0.0.1', r)),
    ]);

    port1 = /** @type {import('node:net').AddressInfo} */ (s1.address()).port;
    port2 = /** @type {import('node:net').AddressInfo} */ (s2.address()).port;
    port3 = /** @type {import('node:net').AddressInfo} */ (s3.address()).port;

    originalMirrors = [...MIRRORS];
  });

  after(async () => {
    MIRRORS.length = 0;
    MIRRORS.push(...originalMirrors);
    resetMirrorSlots();
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

  beforeEach(() => {
    resetMirrorSlots();
    mirrorCooldowns.clear();
    mirrorStats.m1 = { active: 0, maxActive: 0, total: 0 };
    mirrorStats.m2 = { active: 0, maxActive: 0, total: 0 };
    mirrorStats.m3 = { active: 0, maxActive: 0, total: 0 };
    mirrorStats.globalActive = 0;
    mirrorStats.maxGlobalActive = 0;
  });

  it('DOWNLOAD_CONCURRENCY по умолчанию равен 3', () => {
    assert.equal(DOWNLOAD_CONCURRENCY, 3);
  });

  it('acquireMirrorSlot обеспечивает не более 1 активного запроса на зеркало', async () => {
    const mirror = { id: 'test_m1', label: 'Test Mirror 1' };
    assert.equal(isMirrorBusy(mirror), false);

    const release1 = await acquireMirrorSlot(mirror);
    assert.equal(isMirrorBusy(mirror), true);

    let secondAcquired = false;
    const p2 = acquireMirrorSlot(mirror).then(release => {
      secondAcquired = true;
      return release;
    });

    // p2 должен ждать
    await new Promise(r => setTimeout(r, 20));
    assert.equal(secondAcquired, false);

    // Освобождаем 1
    release1();

    const release2 = await p2;
    assert.equal(secondAcquired, true);
    assert.equal(isMirrorBusy(mirror), true);

    release2();
    assert.equal(isMirrorBusy(mirror), false);
  });

  it('acquireMirrorSlot корректно отменяет ожидание по AbortSignal', async () => {
    const mirror = { id: 'test_m_abort', label: 'Test Mirror Abort' };
    const release1 = await acquireMirrorSlot(mirror);

    const controller = new AbortController();
    const waitPromise = acquireMirrorSlot(mirror, controller.signal);

    controller.abort(new Error('Отменено пользователем'));

    await assert.rejects(waitPromise, /Отменено пользователем/);
    release1();
    assert.equal(isMirrorBusy(mirror), false);
  });

  it('параллельно скачивает 3 набора через 3 зеркала, не превышая 1 запрос на зеркало', async () => {
    MIRRORS.length = 0;
    MIRRORS.push(
      { id: 'm1', label: 'Mirror 1', build: id => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm2', label: 'Mirror 2', build: id => `http://127.0.0.1:${port2}/d/${id}` },
      { id: 'm3', label: 'Mirror 3', build: id => `http://127.0.0.1:${port3}/d/${id}` }
    );

    const job = {
      id: 'job_parallel_1',
      method: 'mirror',
      collectionName: 'Test Coll',
      status: 'queued',
      setIds: [77001, 77002, 77003],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById: new Map([
        [77001, { label: 'Mapset 77001' }],
        [77002, { label: 'Mapset 77002' }],
        [77003, { label: 'Mapset 77003' }],
      ]),
      currentBytes: 0,
      currentTotalBytes: null,
      currentPercent: 0,
      currentMirror: null,
    };

    await runJob(job, { kind: 'mirror' });

    assert.equal(job.status, 'finished');
    assert.equal(job.doneIds.size, 3);
    assert.equal(job.errIds.size, 0);

    // Проверяем, что запросы распределились по зеркалам и шли параллельно
    assert.ok(mirrorStats.maxGlobalActive >= 2, `Ожидалась параллельность >= 2, получено: ${mirrorStats.maxGlobalActive}`);
    assert.equal(mirrorStats.m1.maxActive, 1, 'Mirror 1 не должен иметь более 1 активного запроса');
    assert.equal(mirrorStats.m2.maxActive, 1, 'Mirror 2 не должен иметь более 1 активного запроса');
    assert.equal(mirrorStats.m3.maxActive, 1, 'Mirror 3 не должен иметь более 1 активного запроса');

    // Проверяем файлы на диске
    for (const setId of [77001, 77002, 77003]) {
      const stat = await fs.stat(path.join(tempDir, `${setId}.osz`));
      assert.equal(stat.size, validZipBuffer.length);
    }
  });

  it('safeJobForClient агрегирует состояние при параллельных загрузках', () => {
    const job = {
      id: 'job_multi_transfer',
      method: 'mirror',
      collectionName: 'Parallel Coll',
      setIds: [1, 2, 3],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById: new Map([
        [1, { label: 'Artist 1 - Title 1' }],
        [2, { label: 'Artist 2 - Title 2' }],
      ]),
      activeTransfers: new Map([
        [1, { setId: 1, setName: 'Artist 1 - Title 1', mirror: 'osu.direct', bytes: 1000, totalBytes: 2000 }],
        [2, { setId: 2, setName: 'Artist 2 - Title 2', mirror: 'Hinamizawa', bytes: 3000, totalBytes: 4000 }],
      ]),
      status: 'running',
    };

    const clientJob = safeJobForClient(job);
    assert.equal(clientJob.currentBytes, 4000);
    assert.equal(clientJob.currentTotalBytes, 6000);
    assert.equal(clientJob.currentPercent, 66);
    assert.ok(clientJob.currentMirror.includes('osu.direct'));
    assert.ok(clientJob.currentMirror.includes('Hinamizawa'));
    assert.ok(clientJob.currentSetName.includes('2 набора параллельно'));
  });

  it('выбирает свободное зеркало вместо блокировки на занятом зеркале', async () => {
    MIRRORS.length = 0;
    MIRRORS.push(
      { id: 'm1', label: 'Mirror 1', build: id => `http://127.0.0.1:${port1}/d/${id}` },
      { id: 'm2', label: 'Mirror 2', build: id => `http://127.0.0.1:${port2}/d/${id}` }
    );

    // Захватываем m1 вручную, делая его занятым
    const releaseM1 = await acquireMirrorSlot(MIRRORS[0]);
    assert.equal(isMirrorBusy(MIRRORS[0]), true);

    const job = {
      id: 'job_fallback_free',
      method: 'mirror',
      collectionName: 'Fallback Coll',
      status: 'queued',
      setIds: [77010],
      doneIds: new Set(),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById: new Map([[77010, { label: 'Mapset 77010' }]]),
      currentBytes: 0,
      currentTotalBytes: null,
      currentPercent: 0,
      currentMirror: null,
    };

    // Задача с 1 набором при занятом m1 должна сразу пойти в свободное m2
    await runJob(job, { kind: 'mirror' });

    assert.equal(job.status, 'finished');
    assert.equal(job.doneIds.has(77010), true);
    assert.equal(mirrorStats.m2.total, 1, 'Запрос должен был пойти на свободное Mirror 2');
    assert.equal(mirrorStats.m1.total, 0, 'Занятое Mirror 1 не должно было получить запрос задачи');

    releaseM1();
    assert.equal(isMirrorBusy(MIRRORS[0]), false);
  });
});
