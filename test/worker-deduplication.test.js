'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  createJob,
  createQueueIterator,
  checkAndSkipIfAvailable,
  processSetDownload,
  runDownloadPool,
  finalizeJobStatus,
  clearAutoResume,
} = require('../lib/jobs.js');
const downloader = require('../lib/downloader.js');

describe('Устранение дублирования воркеров скачивания (Worker Deduplication & Helpers)', () => {
  describe('createQueueIterator', () => {
    it('последовательно отдаёт элементы очереди и завершается null', () => {
      const getNext = createQueueIterator([101, 102, 103]);
      assert.equal(getNext(), 101);
      assert.equal(getNext(), 102);
      assert.equal(getNext(), 103);
      assert.equal(getNext(), null);
      assert.equal(getNext(), null);
    });

    it('пропускает элементы, уже присутствующие в doneIds и skipIds', () => {
      const doneIds = new Set([102]);
      const skipIds = new Set([104]);
      const getNext = createQueueIterator([101, 102, 103, 104, 105], { doneIds, skipIds });

      assert.equal(getNext(), 101);
      assert.equal(getNext(), 103);
      assert.equal(getNext(), 105);
      assert.equal(getNext(), null);
    });

    it('учитывает retryOnlyIds при повторном запуске', () => {
      const retryOnlyIds = new Set([103, 105]);
      const doneIds = new Set([101]);
      const getNext = createQueueIterator([101, 102, 103, 104, 105], { retryOnlyIds, doneIds });

      assert.equal(getNext(), 103);
      assert.equal(getNext(), 105);
      assert.equal(getNext(), null);
    });
  });

  describe('checkAndSkipIfAvailable', () => {
    it('пропускает набор, если он уже скачан на диск в виде валидного zip', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-dedup-test-'));
      const oldDownloadsDir = process.env.DOWNLOADS_DIR;
      process.env.DOWNLOADS_DIR = tempDir;

      try {
        const validZipBuffer = Buffer.from([
          0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x50,
          0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        await fs.writeFile(path.join(tempDir, '2001.osz'), validZipBuffer);

        const job = createJob({
          id: 'job_test_skip_file',
          collectionId: 'c1',
          collectionName: 'Test',
          method: 'mirror',
          status: 'running',
          setIds: [2001],
        });
        job.errIds.add(2001);
        job.errorsById.set(2001, { id: 2001, name: 'Набор 2001', error: 'old error' });

        const deferredSetIds = new Set([2001]);
        const skipped = await checkAndSkipIfAvailable(2001, job, { isDeferred: true, deferredSetIds });

        assert.equal(skipped, true);
        assert.ok(job.skipIds.has(2001));
        assert.ok(!job.errIds.has(2001));
        assert.ok(!job.errorsById.has(2001));
        assert.ok(!deferredSetIds.has(2001));
      } finally {
        if (oldDownloadsDir !== undefined) process.env.DOWNLOADS_DIR = oldDownloadsDir;
        else delete process.env.DOWNLOADS_DIR;
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('возвращает false для отсутствующего файла', async () => {
      const job = createJob({
        id: 'job_test_no_file',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [9999999],
      });
      const skipped = await checkAndSkipIfAvailable(9999999, job);
      assert.equal(skipped, false);
      assert.ok(!job.skipIds.has(9999999));
    });
  });

  describe('processSetDownload', () => {
    it('обрабатывает остывание зеркала (deferSet) на первом проходе и добавляет в deferredSetIds', async () => {
      const job = createJob({
        id: 'job_test_defer_1',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [3001],
      });
      const stopContext = { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false };
      const deferredSetIds = new Set();

      const deferError = new Error('Rate limit');
      /** @type {any} */ (deferError).deferSet = true;

      const auth = { kind: 'custom' };
      const originalDownloadSet = downloader.downloadSet;
      downloader.downloadSet = async () => {
        throw deferError;
      };

      try {
        await processSetDownload(3001, {
          job,
          auth,
          stopContext,
          deferredSetIds,
          isDeferred: false,
        });

        assert.ok(deferredSetIds.has(3001));
        assert.equal(stopContext.stopForCooldown, false);
        assert.ok(job.message.includes('часть зеркал остывает'));
        assert.equal(job.activeTransfers?.size, 0);
      } finally {
        downloader.downloadSet = originalDownloadSet;
      }
    });

    it('на повторном проходе (isDeferred = true) deferSet вызывает остановку по остыванию stopForCooldown', async () => {
      const job = createJob({
        id: 'job_test_defer_final',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [3002],
      });
      const stopContext = { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false };
      const deferredSetIds = new Set([3002]);

      const deferError = new Error('Rate limit again');
      /** @type {any} */ (deferError).deferSet = true;

      const auth = { kind: 'custom' };
      const originalDownloadSet = downloader.downloadSet;
      downloader.downloadSet = async () => {
        throw deferError;
      };

      try {
        await processSetDownload(3002, {
          job,
          auth,
          stopContext,
          deferredSetIds,
          isDeferred: true,
        });

        assert.equal(stopContext.stopForCooldown, true);
        assert.ok(job.message.includes('зеркала остывают — загрузка приостановлена'));
      } finally {
        downloader.downloadSet = originalDownloadSet;
      }
    });

    it('обрабатывает нехватку места ENOSPC и выставляет stopForNoSpace', async () => {
      const job = createJob({
        id: 'job_test_enospc',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [3003],
      });
      const stopContext = { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false };
      const enospcError = new Error('ENOSPC: no space left on device');
      /** @type {any} */ (enospcError).code = 'ENOSPC';

      const auth = { kind: 'custom' };
      const originalDownloadSet = downloader.downloadSet;
      downloader.downloadSet = async () => {
        throw enospcError;
      };

      try {
        await processSetDownload(3003, {
          job,
          auth,
          stopContext,
          isDeferred: false,
        });

        assert.equal(stopContext.stopForNoSpace, true);
        assert.ok(job.message.includes('ENOSPC'));
      } finally {
        downloader.downloadSet = originalDownloadSet;
      }
    });
  });

  describe('runDownloadPool', () => {
    it('распределяет задачи между воркерами и реагирует на флаг остановки', async () => {
      const job = createJob({
        id: 'job_test_pool',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [4001, 4002, 4003, 4004],
      });
      const stopContext = { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false };
      const processed = [];

      const originalDownloadSet = downloader.downloadSet;
      downloader.downloadSet = async (setId) => {
        processed.push(setId);
        if (setId === 4002) {
          stopContext.stopAfterCurrent = true;
        }
      };

      const getNextSetId = createQueueIterator(job.setIds);

      try {
        await runDownloadPool({
          job,
          auth: { kind: 'custom' },
          getNextSetId,
          concurrency: 1,
          stopContext,
        });

        assert.deepEqual(processed, [4001, 4002]);
      } finally {
        downloader.downloadSet = originalDownloadSet;
      }
    });
  });

  describe('finalizeJobStatus', () => {
    it('переводит задачу в paused при наличии отложенных карт', () => {
      const job = createJob({
        id: 'job_test_finalize_paused',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [5001, 5002],
      });
      job.doneIds.add(5001);

      const stopContext = { stopAfterCurrent: false, stopForCooldown: true, stopForNoSpace: false };
      try {
        finalizeJobStatus(job, stopContext);

        assert.equal(job.status, 'paused');
        assert.ok(job.pausedAt > 0);
        assert.equal(job.finishedAt, undefined);
        assert.ok(job.message.includes('Зеркала временно ограничили загрузки'));
      } finally {
        clearAutoResume(job);
      }
    });

    it('переводит задачу в finished_with_errors при наличии ошибок без отложенных карт', () => {
      const job = createJob({
        id: 'job_test_finalize_errors',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [5001],
      });
      job.errIds.add(5001);

      finalizeJobStatus(job, { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false });

      assert.equal(job.status, 'finished_with_errors');
      assert.ok(job.finishedAt > 0);
      assert.ok(job.message.includes('Готово с ошибками: 1'));
    });

    it('переводит задачу в finished при полной успешной загрузке', () => {
      const job = createJob({
        id: 'job_test_finalize_done',
        collectionId: 'c1',
        collectionName: 'Test',
        method: 'mirror',
        status: 'running',
        setIds: [5001],
      });
      job.doneIds.add(5001);

      finalizeJobStatus(job, { stopAfterCurrent: false, stopForCooldown: false, stopForNoSpace: false });

      assert.equal(job.status, 'finished');
      assert.ok(job.finishedAt > 0);
      assert.equal(job.message, 'Все доступные наборы загружены.');
    });
  });
});
