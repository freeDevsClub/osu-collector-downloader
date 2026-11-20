"use strict";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { log, LOG_DEBUG } = require('../lib/logger.js');
const { HttpError } = require('../lib/errors.js');
const { formatBytes, pluralizeRu, formatPluralRu } = require('../lib/utils/format.js');
const { sleep, sleepWithSignal, anySignal } = require('../lib/utils/async.js');
const { json, readJson, closeStreamOrSocket } = require('../lib/utils/http.js');

describe('Модульные утилиты (lib/logger, lib/errors, lib/utils/*)', () => {
  describe('lib/logger.js', () => {
    it('логирует события в формате JSON в правильный поток', () => {
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;
      const captured = [];

      console.log = (msg) => captured.push({ level: 'info', msg });
      console.warn = (msg) => captured.push({ level: 'warn', msg });
      console.error = (msg) => captured.push({ level: 'error', msg });

      try {
        log('info', 'test.info', { detail: 123 });
        log('warn', 'test.warn', { warning: 'foo' });
        log('error', 'test.error', { error: 'bar' });

        assert.equal(captured.length, 3);
        const parsed0 = JSON.parse(captured[0].msg);
        assert.equal(parsed0.level, 'info');
        assert.equal(parsed0.event, 'test.info');
        assert.equal(parsed0.detail, 123);
        assert.ok(parsed0.time);

        const parsed1 = JSON.parse(captured[1].msg);
        assert.equal(parsed1.level, 'warn');
        assert.equal(parsed1.event, 'test.warn');

        const parsed2 = JSON.parse(captured[2].msg);
        assert.equal(parsed2.level, 'error');
        assert.equal(parsed2.event, 'test.error');
      } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
      }
    });
  });

  describe('lib/errors.js', () => {
    it('HttpError наследуется от Error и хранит статус', () => {
      const err = new HttpError(404, 'Не найдено');
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'HttpError');
      assert.equal(err.status, 404);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, 'Не найдено');

      err.httpStatus = 400;
      assert.equal(err.status, 400);
    });
  });

  describe('lib/utils/format.js', () => {
    it('formatBytes форматирует байты корректно', () => {
      assert.equal(formatBytes(0), '0 Б');
      assert.equal(formatBytes(512), '512 Б');
      assert.equal(formatBytes(1024), '1.0 КБ');
      assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 МБ');
      assert.equal(formatBytes(1024 * 1024 * 1024 * 2), '2.0 ГБ');
      assert.equal(formatBytes(-1), 'unknown');
      assert.equal(formatBytes(NaN), 'unknown');
    });

    it('pluralizeRu и formatPluralRu корректно склоняют русские слова', () => {
      assert.equal(pluralizeRu(1, 'набор', 'набора', 'наборов'), 'набор');
      assert.equal(pluralizeRu(2, 'набор', 'набора', 'наборов'), 'набора');
      assert.equal(pluralizeRu(3, 'набор', 'набора', 'наборов'), 'набора');
      assert.equal(pluralizeRu(4, 'набор', 'набора', 'наборов'), 'набора');
      assert.equal(pluralizeRu(5, 'набор', 'набора', 'наборов'), 'наборов');
      assert.equal(pluralizeRu(11, 'набор', 'набора', 'наборов'), 'наборов');
      assert.equal(pluralizeRu(21, 'набор', 'набора', 'наборов'), 'набор');
      assert.equal(pluralizeRu(24, 'набор', 'набора', 'наборов'), 'набора');

      assert.equal(formatPluralRu(1, 'карта', 'карты', 'карт'), '1 карта');
      assert.equal(formatPluralRu(3, 'карта', 'карты', 'карт'), '3 карты');
      assert.equal(formatPluralRu(10, 'карта', 'карты', 'карт'), '10 карт');
    });
  });

  describe('lib/utils/async.js', () => {
    it('sleep выдерживает паузу', async () => {
      const start = Date.now();
      await sleep(20);
      assert.ok(Date.now() - start >= 15);
    });

    it('sleepWithSignal мгновенно отклоняется, если сигнал уже прерван', async () => {
      const ac = new AbortController();
      ac.abort(new Error('Already aborted'));
      await assert.rejects(() => sleepWithSignal(1000, ac.signal), {
        message: 'Already aborted',
      });
    });

    it('sleepWithSignal прерывает ожидание по сигналу', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('Aborted mid-wait')), 20);
      await assert.rejects(() => sleepWithSignal(2000, ac.signal), {
        message: 'Aborted mid-wait',
      });
    });

    it('anySignal объединяет несколько сигналов', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const combined = anySignal([ac1.signal, ac2.signal]);

      assert.equal(combined.aborted, false);
      ac2.abort('reason2');
      assert.equal(combined.aborted, true);
    });
  });

  describe('lib/utils/http.js', () => {
    it('json формирует корректный ответ с заголовками', () => {
      let writtenStatus = null;
      let writtenHeaders = null;
      let writtenData = '';

      const mockRes = {
        writeHead(status, headers) {
          writtenStatus = status;
          writtenHeaders = headers;
        },
        end(data) {
          writtenData = data;
        },
      };

      /** @type {any} */ (json)(mockRes, 201, { success: true }, { 'X-Custom': 'val' });
      assert.equal(writtenStatus, 201);
      assert.ok(writtenHeaders);
      assert.equal(writtenHeaders['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(writtenHeaders['X-Custom'], 'val');
      assert.deepEqual(JSON.parse(writtenData), { success: true });
    });

    it('readJson парсит тело JSON', async () => {
      const stream = Readable.from([JSON.stringify({ a: 1, b: 'test' })]);
      const res = await readJson(/** @type {any} */ (stream));
      assert.deepEqual(res, { a: 1, b: 'test' });
    });

    it('readJson отклоняет невалидный JSON', async () => {
      const stream = Readable.from(['{not a json']);
      await assert.rejects(() => readJson(/** @type {any} */ (stream)), (err) => {
        return err instanceof HttpError && err.status === 400;
      });
    });

    it('readJson отклоняет превышение maxBody с кодом 413', async () => {
      const stream = Readable.from(['{"a":"' + 'x'.repeat(200) + '"}']);
      await assert.rejects(() => readJson(/** @type {any} */ (stream), { maxBody: 50 }), (err) => {
        return err instanceof HttpError && err.status === 413;
      });
    });
  });
});
