// @ts-check
"use strict";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  Job,
  JobStateMachine,
  JOB_STATUSES,
  VALID_JOB_TRANSITIONS,
  createJob,
} = require('../lib/job.js');
const { serializeJob, deserializeJob } = require('../lib/jobs.js');

describe('Нормализация сущности Job и машина состояний (Job State Machine)', () => {
  it('createJob инициализирует полную унифицированную схему со значениями по умолчанию', () => {
    const job = createJob({
      collectionId: 12345,
      collectionName: 'My Awesome Collection',
      setIds: [101, 102, 103],
    });

    assert.ok(job instanceof Job);
    assert.equal(typeof job.id, 'string');
    assert.equal(job.id.length >= 16, true);
    assert.equal(job.method, 'mirror');
    assert.equal(job.noVideo, false);
    assert.equal(job.collectionId, 12345);
    assert.equal(job.collectionName, 'My Awesome Collection');
    assert.deepEqual(job.setIds, [101, 102, 103]);
    assert.equal(job.total, 3);

    // Коллекции и мапы инициализированы и пусты:
    assert.ok(job.doneIds instanceof Set);
    assert.equal(job.doneIds.size, 0);
    assert.ok(job.skipIds instanceof Set);
    assert.equal(job.skipIds.size, 0);
    assert.ok(job.errIds instanceof Set);
    assert.equal(job.errIds.size, 0);
    assert.ok(job.errorsById instanceof Map);
    assert.equal(job.errorsById.size, 0);
    assert.ok(job.mapsById instanceof Map);
    assert.equal(job.mapsById.size, 0);
    assert.ok(job.activeTransfers instanceof Map);
    assert.equal(job.activeTransfers.size, 0);

    // Счётчики и прогресс:
    assert.equal(job.extraFailures, 0);
    assert.equal(job.currentBytes, 0);
    assert.equal(job.currentTotalBytes, null);
    assert.equal(job.currentPercent, 0);
    assert.equal(job.currentMirror, null);
    assert.equal(job.currentSetId, null);
    assert.equal(job.currentSetName, null);

    // Статус и сообщения:
    assert.equal(job.status, 'preparing');
    assert.equal(job.message, '');
    assert.equal(job.autoResumeAt, null);
    assert.equal(job.autoResumeCount, 0);
    assert.equal(job.autoResumeTimer, null);
    assert.equal(job.abortController, null);
    assert.equal(job.pausedAt, null);
    assert.equal(job.finishedAt, null);
    assert.equal(job.retryOnlyIds, null);

    // Служебные поля:
    assert.equal(job._lastEmit, 0);
    assert.equal(job._emitTimer, null);
    assert.equal(job._cachedSerializedMaps, null);
    assert.equal(job._cachedStaticMetadata, null);
    assert.equal(job._prepared, false);
    assert.equal(job.notifyUpdate, null);
  });

  it('выбрасывает ошибку при попытке создать Job с недопустимым начальным статусом', () => {
    assert.throws(
      // @ts-ignore
      () => new Job({ status: 'unknown_status' }),
      /Недопустимый начальный статус задачи: «unknown_status»/
    );
  });

  it('JobStateMachine корректно валидирует переходы состояний', () => {
    // Самопереходы (idempotent):
    for (const status of JOB_STATUSES) {
      assert.equal(JobStateMachine.isValidTransition(status, status), true);
    }

    // preparing:
    assert.equal(JobStateMachine.isValidTransition('preparing', 'queued'), true);
    assert.equal(JobStateMachine.isValidTransition('preparing', 'running'), true);
    assert.equal(JobStateMachine.isValidTransition('preparing', 'paused'), true);
    assert.equal(JobStateMachine.isValidTransition('preparing', 'finished_with_errors'), true);
    assert.equal(JobStateMachine.isValidTransition('preparing', 'cancelled'), true);
    assert.equal(JobStateMachine.isValidTransition('preparing', 'finished'), false);

    // queued:
    assert.equal(JobStateMachine.isValidTransition('queued', 'running'), true);
    assert.equal(JobStateMachine.isValidTransition('queued', 'paused'), true);
    assert.equal(JobStateMachine.isValidTransition('queued', 'finished'), true);
    assert.equal(JobStateMachine.isValidTransition('queued', 'finished_with_errors'), true);
    assert.equal(JobStateMachine.isValidTransition('queued', 'cancelled'), true);
    assert.equal(JobStateMachine.isValidTransition('queued', 'preparing'), true);

    // running:
    assert.equal(JobStateMachine.isValidTransition('running', 'paused'), true);
    assert.equal(JobStateMachine.isValidTransition('running', 'finished'), true);
    assert.equal(JobStateMachine.isValidTransition('running', 'finished_with_errors'), true);
    assert.equal(JobStateMachine.isValidTransition('running', 'cancelled'), true);
    assert.equal(JobStateMachine.isValidTransition('running', 'preparing'), false);
    assert.equal(JobStateMachine.isValidTransition('running', 'queued'), false);

    // paused:
    assert.equal(JobStateMachine.isValidTransition('paused', 'queued'), true);
    assert.equal(JobStateMachine.isValidTransition('paused', 'running'), true);
    assert.equal(JobStateMachine.isValidTransition('paused', 'cancelled'), true);
    assert.equal(JobStateMachine.isValidTransition('paused', 'finished_with_errors'), true);
    assert.equal(JobStateMachine.isValidTransition('paused', 'finished'), false);

    // finished:
    assert.equal(JobStateMachine.isValidTransition('finished', 'queued'), true);
    assert.equal(JobStateMachine.isValidTransition('finished', 'running'), false);
    assert.equal(JobStateMachine.isValidTransition('finished', 'cancelled'), false);

    // finished_with_errors:
    assert.equal(JobStateMachine.isValidTransition('finished_with_errors', 'queued'), true);
    assert.equal(JobStateMachine.isValidTransition('finished_with_errors', 'cancelled'), true);
    assert.equal(JobStateMachine.isValidTransition('finished_with_errors', 'running'), false);

    // cancelled (terminal):
    for (const status of JOB_STATUSES) {
      if (status !== 'cancelled') {
        assert.equal(JobStateMachine.isValidTransition('cancelled', status), false);
      }
    }
  });

  it('Job.status setter переводит задачу в допустимые статусы и обновляет таймштампы', () => {
    const job = createJob({ setIds: [1, 2] });

    // preparing -> queued
    job.status = 'queued';
    assert.equal(job.status, 'queued');
    assert.equal(job.isActive(), true);
    assert.equal(job.isTerminal(), false);

    // queued -> running
    job.status = 'running';
    assert.equal(job.status, 'running');
    assert.equal(job.isActive(), true);

    // running -> paused
    job.status = 'paused';
    assert.equal(job.status, 'paused');
    assert.equal(job.isPaused(), true);
    assert.ok(Number.isFinite(job.pausedAt));
    assert.equal(job.finishedAt, null);

    // paused -> queued (resume)
    job.status = 'queued';
    assert.equal(job.status, 'queued');
    assert.equal(job.pausedAt, null);

    // queued -> running
    job.status = 'running';

    // running -> finished
    job.status = 'finished';
    assert.equal(job.status, 'finished');
    assert.equal(job.isTerminal(), true);
    assert.ok(Number.isFinite(job.finishedAt));
    assert.equal(job.pausedAt, null);
  });

  it('переход в cancelled автоматически вызывает abortController.abort() и очищает autoResume', () => {
    const abortController = new AbortController();
    const job = createJob({
      status: 'queued',
      abortController,
      autoResumeAt: Date.now() + 5000,
      autoResumeTimer: setTimeout(() => {}, 10000),
    });

    assert.equal(abortController.signal.aborted, false);
    assert.notEqual(job.autoResumeTimer, null);

    job.status = 'cancelled';

    assert.equal(job.status, 'cancelled');
    assert.equal(job.isCancelled(), true);
    assert.equal(job.isTerminal(), true);
    assert.equal(abortController.signal.aborted, true);
    assert.equal(job.autoResumeTimer, null);
    assert.equal(job.autoResumeAt, null);
    assert.ok(Number.isFinite(job.finishedAt));
  });

  it('выбрасывает ошибку при недопустимом переходе статуса', () => {
    const job = createJob({ status: 'running' });

    assert.throws(
      // @ts-ignore
      () => { job.status = 'preparing'; },
      /Недопустимый переход состояния задачи .* «running» → «preparing»/
    );

    assert.throws(
      // @ts-ignore
      () => { job.status = 'invalid_bogus_status'; },
      /Неизвестный статус задачи: «invalid_bogus_status»/
    );
  });

  it('для отмененной задачи (cancelled) попытки перевода в другие статусы безопасно игнорируются', () => {
    const job = createJob({ status: 'running' });
    job.status = 'cancelled';
    assert.equal(job.status, 'cancelled');

    // Имитируем фоновое завершение воркера или catch-блок после отмены:
    const changedFinished = job.transitionTo('finished');
    assert.equal(changedFinished, false);
    assert.equal(job.status, 'cancelled');

    const changedFailed = job.transitionTo('finished_with_errors');
    assert.equal(changedFailed, false);
    assert.equal(job.status, 'cancelled');

    job.status = 'finished';
    assert.equal(job.status, 'cancelled');
  });

  it('deserializeJob возвращает полноценный экземпляр Job с работающими методами и машиной состояний', () => {
    const rawData = {
      id: 'job_deser_test',
      method: 'mirror',
      collectionId: '987',
      collectionName: 'Deser Collection',
      setIds: [5001, 5002],
      doneIds: [5001],
      skipIds: [],
      errIds: [5002],
      errors: [{ id: 5002, name: 'Map 5002', error: 'HTTP 404' }],
      status: 'paused',
      message: 'На паузе',
    };

    const job = deserializeJob(rawData);
    assert.ok(job instanceof Job);
    assert.equal(job.id, 'job_deser_test');
    assert.equal(job.total, 2);
    assert.equal(job.isPaused(), true);
    assert.ok(job.doneIds.has(5001));
    assert.ok(job.errIds.has(5002));
    assert.equal(job.errorsById.get(5002)?.error, 'HTTP 404');

    // Проверяем работу машины состояний на десериализованном объекте:
    assert.equal(job.canTransitionTo('queued'), true);
    job.status = 'queued';
    assert.equal(job.status, 'queued');

    const serialized = serializeJob(job);
    assert.equal(serialized.status, 'queued');
    assert.equal(serialized.id, 'job_deser_test');
  });
});
