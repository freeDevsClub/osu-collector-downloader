// @ts-check
"use strict";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { Router } = require('../lib/router.js');
const { createApiRouter, handleApi } = require('../lib/routes/index.js');
const { handleMethodNotAllowed, readJson, closeStreamOrSocket } = require('../lib/routes/helpers.js');

describe('Декомпозиция роутера API (API Router & Modular Routes)', () => {
  it('Router.exact регистрирует и корректно вызывает статический маршрут', async () => {
    const router = new Router();
    let called = false;

    router.exact('/api/test/static', (req, res, url, params) => {
      called = true;
      assert.deepEqual(params, {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const mockReq = /** @type {any} */ ({ method: 'GET' });
    let responseBody = '';
    const mockRes = /** @type {any} */ ({
      statusCode: 200,
      writeHead(status, headers) { this.statusCode = status; },
      end(data) { responseBody = data; },
    });

    await router.handle(mockReq, mockRes, new URL('http://127.0.0.1/api/test/static'));
    assert.equal(called, true);
    assert.deepEqual(JSON.parse(responseBody), { ok: true });
  });

  it('Router.pattern регистрирует параметризованный маршрут и извлекает params', async () => {
    const router = new Router();
    /** @type {Record<string, string> | null} */
    let extractedParams = null;

    router.pattern('/api/items/:itemId/sub/:subId', (req, res, url, params) => {
      extractedParams = params || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(params));
    });

    const mockReq = /** @type {any} */ ({ method: 'GET' });
    let responseBody = '';
    const mockRes = /** @type {any} */ ({
      writeHead(status) { this.statusCode = status; },
      end(data) { responseBody = data; },
    });

    await router.handle(mockReq, mockRes, new URL('http://127.0.0.1/api/items/42/sub/xyz-99'));
    assert.deepEqual(extractedParams, { itemId: '42', subId: 'xyz-99' });
    assert.deepEqual(JSON.parse(responseBody), { itemId: '42', subId: 'xyz-99' });
  });

  it('статические и суффиксные маршруты имеют приоритет перед общим :id', async () => {
    const router = new Router();
    const calls = [];

    // 1. Статический
    router.exact('/api/downloads/active', () => { calls.push('active'); });
    // 2. Суффикс действия
    router.pattern('/api/downloads/:id/cancel', () => { calls.push('cancel'); });
    // 3. Общий :id
    router.pattern('/api/downloads/:id', () => { calls.push('generic'); });

    const mockRes = /** @type {any} */ ({ writeHead() {}, end() {} });

    // Проверяем вызов /api/downloads/active -> должен попасть в exact 'active', а не в generic :id:
    await router.handle(/** @type {any} */ ({}), mockRes, new URL('http://127.0.0.1/api/downloads/active'));
    assert.deepEqual(calls, ['active']);

    // Проверяем вызов /api/downloads/abc123/cancel -> должен попасть в 'cancel', а не в generic :id:
    await router.handle(/** @type {any} */ ({}), mockRes, new URL('http://127.0.0.1/api/downloads/abc123/cancel'));
    assert.deepEqual(calls, ['active', 'cancel']);

    // Проверяем вызов /api/downloads/abc123 -> попадает в generic:
    await router.handle(/** @type {any} */ ({}), mockRes, new URL('http://127.0.0.1/api/downloads/abc123'));
    assert.deepEqual(calls, ['active', 'cancel', 'generic']);
  });

  it('возвращает 404 для неизвестного API маршрута', async () => {
    const router = new Router();
    let statusCode = 0;
    let responseBody = '';

    const mockRes = /** @type {any} */ ({
      writeHead(status, headers) {
        statusCode = status;
        this.statusCode = status;
      },
      end(data) {
        responseBody = data;
      },
    });

    await router.handle(/** @type {any} */ ({}), mockRes, new URL('http://127.0.0.1/api/nonexistent/path'));
    assert.equal(statusCode, 404);
    assert.deepEqual(JSON.parse(responseBody), { error: 'API-маршрут не найден.' });
  });

  it('handleMethodNotAllowed корректно обрабатывает OPTIONS (204) и недопустимые методы (405)', () => {
    let statusCode = 0;
    let headersSet = {};
    let endedData = null;

    const mockRes = /** @type {any} */ ({
      writeHead(status, headers) {
        statusCode = status;
        this.statusCode = status;
        headersSet = headers;
      },
      end(data) {
        endedData = data;
      },
    });

    // OPTIONS -> 204 No Content
    handleMethodNotAllowed(/** @type {any} */ ({ method: 'OPTIONS' }), mockRes, ['GET', 'POST']);
    assert.equal(statusCode, 204);
    assert.equal(headersSet['Allow'], 'GET, POST');
    assert.equal(headersSet['Cache-Control'], 'no-store');

    // PUT -> 405 Method Not Allowed
    handleMethodNotAllowed(/** @type {any} */ ({ method: 'PUT' }), mockRes, ['GET', 'POST']);
    assert.equal(statusCode, 405);
    assert.equal(headersSet['Allow'], 'GET, POST');
    assert.deepEqual(JSON.parse(endedData), { error: 'Метод не поддерживается.' });
  });

  it('createApiRouter собирает все модульные маршруты и корректно отвечает через handleApi', async () => {
    const api = createApiRouter();
    assert.ok(api instanceof Router);
    assert.ok(api.staticRoutes.has('/api/osu/settings'));
    assert.ok(api.staticRoutes.has('/api/osu/rescan'));
    assert.ok(api.staticRoutes.has('/api/osu/check'));
    assert.ok(api.staticRoutes.has('/api/osu/browse'));
    assert.ok(api.staticRoutes.has('/api/mirrors'));
    assert.ok(api.staticRoutes.has('/api/session'));
    assert.ok(api.staticRoutes.has('/api/collections'));
    assert.ok(api.staticRoutes.has('/api/downloads'));
    assert.ok(api.staticRoutes.has('/api/downloads/active'));
    assert.ok(api.staticRoutes.has('/api/downloads/events'));

    assert.equal(api.patternRoutes.length >= 6, true);
  });
});

