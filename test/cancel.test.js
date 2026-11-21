'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { jobs, getActiveJob, setActiveJob, jobCounters } = require('../lib/jobs.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

const { server } = require('../server.js');

describe('Отмена задач и обработчик POST /api/downloads/:id/cancel', () => {
  let appServer;
  let appPort;
  let testEnv;

  before(async () => {
    testEnv = await setupIsolatedTestEnv('cancel-test-');

    appServer = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
  });

  async function postCancel(jobId) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${appPort}/api/downloads/${jobId}/cancel`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(body) });
            } catch {
              resolve({ status: res.statusCode, text: body });
            }
          });
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  }

  it('успешно отменяет задачу со статусом finished_with_errors и deferred > 0', async () => {
    const job = createTestJob({
      id: 'a1b2c3d4e5f67890123456789abcdef0',
      collectionId: '123',
      collectionName: 'Test Deferred Cancel',
      setIds: [1, 2, 3],
      doneIds: [1],
      status: 'finished_with_errors',
      message: 'Загрузка завершена с отложенными наборами',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const initialCounters = jobCounters(job);
    assert.equal(initialCounters.deferred, 2);

    const res = await postCancel(job.id);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'cancelled');
    assert.equal(res.data.message, 'Загрузка остановлена.');
    assert.equal(job.status, 'cancelled');
    assert.equal(getActiveJob(), null, 'activeJob должен быть сброшен в null');
    assert.ok(typeof job.finishedAt === 'number');
  });

  it('успешно отменяет задачу в статусе paused', async () => {
    const job = createTestJob({
      id: 'b1b2c3d4e5f67890123456789abcdef1',
      collectionId: '124',
      collectionName: 'Test Paused Cancel',
      setIds: [1, 2],
      status: 'paused',
      message: 'Зеркала остывают',
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await postCancel(job.id);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'cancelled');
    assert.equal(job.status, 'cancelled');
    assert.equal(getActiveJob(), null);
  });

  it('успешно отменяет задачу в статусе running', async () => {
    let aborted = false;
    const abortController = new AbortController();
    abortController.signal.addEventListener('abort', () => {
      aborted = true;
    });

    const job = createTestJob({
      id: 'c1b2c3d4e5f67890123456789abcdef2',
      collectionId: '125',
      collectionName: 'Test Running Cancel',
      setIds: [1, 2],
      status: 'running',
      message: 'Скачивание...',
      abortController,
    });
    jobs.set(job.id, job);
    setActiveJob(job);

    const res = await postCancel(job.id);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'cancelled');
    assert.equal(job.status, 'cancelled');
    assert.equal(aborted, true, 'AbortSignal должен быть активирован');
    assert.equal(getActiveJob(), null);
  });

  it('возвращает 404 при попытке отменить несуществующую задачу', async () => {
    const res = await postCancel('deadbeef1234567890abcdef12345678');
    assert.equal(res.status, 404);
    assert.ok(/не найдена/i.test(res.data.error));
  });

  it('идемпотентно обрабатывает повторную отмену уже отменённой задачи', async () => {
    const job = createTestJob({
      id: 'd1b2c3d4e5f67890123456789abcdef3',
      collectionId: '126',
      collectionName: 'Already Cancelled',
      setIds: [1],
      status: 'cancelled',
      message: 'Загрузка остановлена.',
    });
    jobs.set(job.id, job);

    const res = await postCancel(job.id);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'cancelled');
  });
});
