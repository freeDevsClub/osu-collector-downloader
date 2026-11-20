'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { server } = require('../server.js');
const { jobs, setActiveJob, getActiveJob } = require('../lib/jobs.js');
const { PORT } = require('../lib/config.js');

describe('HTTP-методы и статусы (405 Method Not Allowed & 404 warn suppression)', () => {
  let appServer;
  let appPort;

  before(async () => {
    appServer = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    appPort = /** @type {import('node:net').AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
    }
  });

  beforeEach(() => {
    jobs.clear();
    setActiveJob(null);
  });

  /**
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} [headers]
   * @param {string} [body]
   */
  async function request(method, path, headers = {}, body = '') {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${appPort}${path}`,
        {
          method,
          headers: {
            Host: `127.0.0.1:${PORT}`,
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            let jsonBody = null;
            try {
              jsonBody = JSON.parse(data);
            } catch {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: jsonBody,
              rawText: data,
            });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('возвращает 405 Method Not Allowed с заголовком Allow для неверных глаголов на API-маршрутах', async () => {
    // 1. GET /api/downloads (поддерживается только POST)
    const resDownloads = await request('GET', '/api/downloads');
    assert.equal(resDownloads.status, 405);
    assert.equal(resDownloads.headers['allow'], 'POST');
    assert.match(resDownloads.body?.error, /Метод не поддерживается/);

    // 2. PUT /api/session (поддерживаются GET, POST, DELETE)
    const resSession = await request('PUT', '/api/session');
    assert.equal(resSession.status, 405);
    assert.equal(resSession.headers['allow'], 'GET, POST, DELETE');
    assert.match(resSession.body?.error, /Метод не поддерживается/);

    // 3. POST /api/mirrors (поддерживается только GET)
    const resMirrors = await request('POST', '/api/mirrors');
    assert.equal(resMirrors.status, 405);
    assert.equal(resMirrors.headers['allow'], 'GET');

    // 4. POST /api/downloads/active (поддерживается только GET)
    const resActive = await request('POST', '/api/downloads/active');
    assert.equal(resActive.status, 405);
    assert.equal(resActive.headers['allow'], 'GET');

    // 5. GET /api/downloads/:id/cancel (поддерживается только POST)
    const resCancel = await request('GET', '/api/downloads/1234567890abcdef1234567890abcdef/cancel');
    assert.equal(resCancel.status, 405);
    assert.equal(resCancel.headers['allow'], 'POST');

    // 6. GET /api/downloads/:id/resume (поддерживается только POST)
    const resResume = await request('GET', '/api/downloads/1234567890abcdef1234567890abcdef/resume');
    assert.equal(resResume.status, 405);
    assert.equal(resResume.headers['allow'], 'POST');

    // 7. GET /api/downloads/:id/retry-failed (поддерживается только POST)
    const resRetry = await request('GET', '/api/downloads/1234567890abcdef1234567890abcdef/retry-failed');
    assert.equal(resRetry.status, 405);
    assert.equal(resRetry.headers['allow'], 'POST');

    // 8. POST /api/downloads/:id (поддерживается только GET)
    const resJob = await request('POST', '/api/downloads/1234567890abcdef1234567890abcdef');
    assert.equal(resJob.status, 405);
    assert.equal(resJob.headers['allow'], 'GET');

    // 9. POST /api/collections/123 (поддерживается только GET)
    const resColl = await request('POST', '/api/collections/12345');
    assert.equal(resColl.status, 405);
    assert.equal(resColl.headers['allow'], 'GET');

    // 10. GET /api/collections (поддерживается только POST)
    const resCollRoot = await request('GET', '/api/collections');
    assert.equal(resCollRoot.status, 405);
    assert.equal(resCollRoot.headers['allow'], 'POST');

    // 11. PUT /api/session (поддерживаются только GET, POST, DELETE)
    const resSessionPut = await request('PUT', '/api/session');
    assert.equal(resSessionPut.status, 405);
    assert.equal(resSessionPut.headers['allow'], 'GET, POST, DELETE');
  });

  it('возвращает 204 No Content с заголовком Allow для OPTIONS запросов к API', async () => {
    const resOptions = await request('OPTIONS', '/api/downloads');
    assert.equal(resOptions.status, 204);
    assert.equal(resOptions.headers['allow'], 'POST');
  });

  it('возвращает 405 Method Not Allowed для неверных методов на статических маршрутах и 404 для неизвестных', async () => {
    // POST на корень (/) -> 405
    const resRootPost = await request('POST', '/');
    assert.equal(resRootPost.status, 405);
    assert.equal(resRootPost.headers['allow'], 'GET, HEAD');

    // POST на /app.js -> 405
    const resAppPost = await request('POST', '/app.js');
    assert.equal(resAppPost.status, 405);
    assert.equal(resAppPost.headers['allow'], 'GET, HEAD');

    // POST на /style.css -> 405
    const resStylePost = await request('POST', '/style.css');
    assert.equal(resStylePost.status, 405);
    assert.equal(resStylePost.headers['allow'], 'GET, HEAD');

    // GET на /style.css -> 200 text/css и строгий CSP без unsafe-inline
    const resStyleGet = await request('GET', '/style.css');
    assert.equal(resStyleGet.status, 200);
    assert.match(resStyleGet.headers['content-type'], /^text\/css/);
    assert.match(resStyleGet.headers['content-security-policy'], /style-src 'self'/);
    assert.doesNotMatch(resStyleGet.headers['content-security-policy'], /unsafe-inline/);

    // GET на /index.html -> строгий CSP без unsafe-inline
    const resIndexGet = await request('GET', '/index.html');
    assert.equal(resIndexGet.status, 200);
    assert.match(resIndexGet.headers['content-security-policy'], /style-src 'self'/);
    assert.doesNotMatch(resIndexGet.headers['content-security-policy'], /unsafe-inline/);

    // Неизвестный маршрут API -> 404
    const resUnknownApi = await request('GET', '/api/completely-unknown-route');
    assert.equal(resUnknownApi.status, 404);
    assert.equal(resUnknownApi.body?.error, 'API-маршрут не найден.');

    // Неизвестный статический файл -> 404
    const resUnknownStatic = await request('GET', '/unknown_file_123.txt');
    assert.equal(resUnknownStatic.status, 404);
    assert.equal(resUnknownStatic.rawText, 'Not found');
  });

  it('GET /api/downloads/active при отсутствии задачи возвращает 404 и не логирует warn в консоль', async () => {
    const originalWarn = console.warn;
    /** @type {string[]} */
    const warnLogs = [];
    console.warn = (...args) => {
      warnLogs.push(args.join(' '));
    };

    try {
      assert.equal(getActiveJob(), null);
      const res = await request('GET', '/api/downloads/active');
      assert.equal(res.status, 404);
      assert.equal(res.body?.error, 'Нет активной загрузки.');

      // Даём завершиться событию finish
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Убеждаемся, что среди warn-логов нет события http.request.completed для /api/downloads/active
      const activeWarn = warnLogs.find(
        (logStr) => logStr.includes('http.request.completed') && logStr.includes('/api/downloads/active'),
      );
      assert.equal(activeWarn, undefined, 'GET /api/downloads/active не должен создавать warn-лог при штатном 404');
    } finally {
      console.warn = originalWarn;
    }
  });
});
