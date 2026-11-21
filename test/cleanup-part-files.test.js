'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { cleanupStalePartFiles, cleanupJobPartFiles, STALE_PART_MAX_AGE_MS } = require('../lib/downloader.js');

describe('Безопасная очистка .part-файлов (cleanupStalePartFiles и cleanupJobPartFiles)', () => {
  let tempDir;
  let originalDownloadsEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-part-test-'));
    originalDownloadsEnv = process.env.DOWNLOADS_DIR;
    process.env.DOWNLOADS_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalDownloadsEnv !== undefined) {
      process.env.DOWNLOADS_DIR = originalDownloadsEnv;
    } else {
      delete process.env.DOWNLOADS_DIR;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('cleanupStalePartFiles НЕ удаляет свежие .part-файлы (моложе maxAgeMs)', async () => {
    const recentPart1 = path.join(tempDir, '1001.job_active_1.part');
    const recentPart2 = path.join(tempDir, '1002.job_instance2.part');
    await fs.writeFile(recentPart1, Buffer.from('data1'));
    await fs.writeFile(recentPart2, Buffer.from('data2'));

    // Файлы только что созданы — возраст < 1 секунды
    const removed = await cleanupStalePartFiles({ maxAgeMs: 60 * 1000 });
    assert.deepEqual(removed, []);

    const exists1 = await fs
      .access(recentPart1)
      .then(() => true)
      .catch(() => false);
    const exists2 = await fs
      .access(recentPart2)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists1, true, 'Свежий .part файл 1 должен сохраниться');
    assert.equal(exists2, true, 'Свежий .part файл другого инстанса должен сохраниться');
  });

  it('cleanupStalePartFiles удаляет только файлы старше maxAgeMs', async () => {
    const stalePart = path.join(tempDir, '2001.crashed_job.part');
    const recentPart = path.join(tempDir, '2002.current_job.part');
    await fs.writeFile(stalePart, Buffer.from('stale data'));
    await fs.writeFile(recentPart, Buffer.from('recent data'));

    // Искусственно состариваем stalePart на 2 часа назад
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stalePart, twoHoursAgo, twoHoursAgo);

    const removed = await cleanupStalePartFiles({ maxAgeMs: 60 * 60 * 1000 }); // порог 1 час
    assert.equal(removed.length, 1);
    assert.equal(removed[0], '2001.crashed_job.part');

    const staleExists = await fs
      .access(stalePart)
      .then(() => true)
      .catch(() => false);
    const recentExists = await fs
      .access(recentPart)
      .then(() => true)
      .catch(() => false);
    assert.equal(staleExists, false, 'Устаревший файл должен быть удалён');
    assert.equal(recentExists, true, 'Свежий файл должен сохраниться');
  });

  it('cleanupStalePartFiles НЕ удаляет файлы активных задач из activeJobIds, даже если они старые', async () => {
    const activeOldPart = path.join(tempDir, '3001.active_long_job.part');
    const stalePart = path.join(tempDir, '3002.dead_job.part');
    await fs.writeFile(activeOldPart, Buffer.from('active long running data'));
    await fs.writeFile(stalePart, Buffer.from('dead data'));

    // Состариваем оба файла на 25 часов назад
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(activeOldPart, dayAgo, dayAgo);
    await fs.utimes(stalePart, dayAgo, dayAgo);

    const activeSet = new Set(['active_long_job']);
    const removed = await cleanupStalePartFiles({
      maxAgeMs: 24 * 60 * 60 * 1000,
      activeJobIds: activeSet,
    });

    assert.equal(removed.length, 1);
    assert.equal(removed[0], '3002.dead_job.part');

    const activeExists = await fs
      .access(activeOldPart)
      .then(() => true)
      .catch(() => false);
    const staleExists = await fs
      .access(stalePart)
      .then(() => true)
      .catch(() => false);
    assert.equal(activeExists, true, 'Файл активной задачи не должен удаляться');
    assert.equal(staleExists, false, 'Мёртвый файл должен быть удалён');
  });

  it('cleanupStalePartFiles не трогает .osz, .json и другие файлы независимо от их возраста', async () => {
    const oszFile = path.join(tempDir, '4001.osz');
    const jsonFile = path.join(tempDir, '.state.json');
    const partFile = path.join(tempDir, '4001.old.part');

    await fs.writeFile(oszFile, Buffer.from('osz'));
    await fs.writeFile(jsonFile, Buffer.from('{}'));
    await fs.writeFile(partFile, Buffer.from('part'));

    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(oszFile, longAgo, longAgo);
    await fs.utimes(jsonFile, longAgo, longAgo);
    await fs.utimes(partFile, longAgo, longAgo);

    const removed = await cleanupStalePartFiles({ maxAgeMs: 1000 });
    assert.deepEqual(removed, ['4001.old.part']);

    assert.equal(
      await fs
        .access(oszFile)
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(
      await fs
        .access(jsonFile)
        .then(() => true)
        .catch(() => false),
      true,
    );
  });

  it('cleanupJobPartFiles удаляет файлы только указанной задачи и сохраняет файлы других задач', async () => {
    const myJobPart1 = path.join(tempDir, '5001.my_target_job.part');
    const myJobPart2 = path.join(tempDir, '5002.my_target_job.part');
    const otherJobPart = path.join(tempDir, '5001.other_job.part');

    await fs.writeFile(myJobPart1, Buffer.from('a'));
    await fs.writeFile(myJobPart2, Buffer.from('b'));
    await fs.writeFile(otherJobPart, Buffer.from('c'));

    await cleanupJobPartFiles({ id: 'my_target_job' });

    assert.equal(
      await fs
        .access(myJobPart1)
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      await fs
        .access(myJobPart2)
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      await fs
        .access(otherJobPart)
        .then(() => true)
        .catch(() => false),
      true,
      'Файл другой задачи должен остаться',
    );
  });

  it('STALE_PART_MAX_AGE_MS по умолчанию составляет 24 часа', () => {
    assert.equal(STALE_PART_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });
});
