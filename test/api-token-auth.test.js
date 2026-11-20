"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const {
  server,
  startServer,
} = require('../server.js');
const {
  getApiToken,
  setApiToken,
  resetApiToken,
  isApiTokenRequired,
  setApiTokenRequired,
  isInitialCookieGranted,
  setInitialCookieGranted,
  safeCompareTokens,
  extractTokenFromRequest,
  verifyApiToken,
  localApiTokenCookie,
  safeErrorMessage,
} = require('../lib/security.js');

const { PORT } = require('../lib/config.js');

describe('Аутентификация локального API через сессионный токен (защита от локальных процессов)', () => {
  let appServer;
  let appPort;

  before(async () => {
    appServer = server.listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    appPort = /** @type {net.AddressInfo} */ (appServer.address()).port;
  });

  after(async () => {
    setApiTokenRequired(false);
    resetApiToken();
    if (appServer) {
      await new Promise(resolve => appServer.close(resolve));
    }
  });

  beforeEach(() => {
    setApiTokenRequired(true);
    setInitialCookieGranted(true); // По умолчанию в тестах считаем, что одноразовый куки уже распределен
  });

  /**
   * Вспомогательная функция для HTTP-запросов к тестовому серверу
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} [headers]
   * @param {any} [body]
   * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: any, text: string }>}
   */
  async function request(method, path, headers = {}, body = null) {
    const payload = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${appPort}${path}`,
        {
          method,
          headers: {
            Host: `127.0.0.1:${PORT}`,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
            ...headers,
          },
        },
        res => {
          let text = '';
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => {
            let jsonBody = null;
            try {
              jsonBody = JSON.parse(text);
            } catch {}
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: jsonBody,
              text,
            });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  describe('Проверка обязательности токена для мутирующих запросов', () => {
    it('блокирует POST /api/downloads без токена с кодом 401 Unauthorized', async () => {
      const res = await request('POST', '/api/downloads', {}, { url: 'https://osu.ppy.sh/community/matches/1' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('блокирует POST /api/osu/settings без токена с кодом 401', async () => {
      const res = await request('POST', '/api/osu/settings', {}, { osuPath: 'C:\\osu' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('блокирует DELETE /api/session без токена с кодом 401', async () => {
      const res = await request('DELETE', '/api/session');
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('блокирует GET /api/osu/browse без токена (открытие диалогового окна системы)', async () => {
      const res = await request('GET', '/api/osu/browse');
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('отклоняет запросы с неверным токеном в заголовке X-API-Token', async () => {
      const res = await request('POST', '/api/osu/settings', { 'x-api-token': 'wrong-token-value' }, { osuPath: 'C:\\osu' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('отклоняет запросы с неверным токеном в Authorization: Bearer', async () => {
      const res = await request('POST', '/api/osu/settings', { 'authorization': 'Bearer fake_token' }, { osuPath: 'C:\\osu' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('отклоняет запросы с неверным токеном в cookie osu_local_token', async () => {
      const res = await request('POST', '/api/osu/settings', { 'cookie': `${localApiTokenCookie}=invalid_token` }, { osuPath: 'C:\\osu' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('отклоняет запросы с неверным токеном в URL query (?token=wrong)', async () => {
      const res = await request('POST', '/api/osu/settings?token=badtoken', {}, { osuPath: 'C:\\osu' });
      assert.equal(res.status, 401);
      assert.match(res.body?.error, /Отсутствует или недействителен токен авторизации API/);
    });

    it('разрешает неманипулирующие GET-запросы без токена (чтение настроек и зеркал)', async () => {
      const resSettings = await request('GET', '/api/osu/settings');
      assert.equal(resSettings.status, 200);

      const resMirrors = await request('GET', '/api/mirrors');
      assert.equal(resMirrors.status, 200);

      const resSession = await request('GET', '/api/session');
      assert.equal(resSession.status, 200);
      assert.equal(resSession.body.connected, false);
    });
  });

  describe('Успешная авторизация различными способами передачи токена', () => {
    it('успешно принимает запрос с заголовком X-API-Token', async () => {
      const token = getApiToken();
      const res = await request('POST', '/api/osu/settings', { 'x-api-token': token }, {});
      assert.equal(res.status, 200);
    });

    it('успешно принимает запрос с заголовком Authorization: Bearer <token>', async () => {
      const token = getApiToken();
      const res = await request('POST', '/api/osu/settings', { 'authorization': `Bearer ${token}` }, {});
      assert.equal(res.status, 200);
    });

    it('успешно принимает запрос с cookie osu_local_token', async () => {
      const token = getApiToken();
      const res = await request('POST', '/api/osu/settings', { 'cookie': `${localApiTokenCookie}=${token}` }, {});
      assert.equal(res.status, 200);
    });

    it('успешно принимает запрос с query-параметром ?token=<token>', async () => {
      const token = getApiToken();
      const res = await request('POST', `/api/osu/settings?token=${token}`, {}, {});
      assert.equal(res.status, 200);
    });

    it('успешно выполняет DELETE /api/session с валидным токеном', async () => {
      const token = getApiToken();
      const res = await request('DELETE', '/api/session', { 'x-api-token': token });
      assert.equal(res.status, 200);
      assert.equal(res.body?.connected, false);
    });
  });

  describe('Статическая раздача и выдача сессионной cookie при открытии в браузере', () => {
    it('GET /?token=<valid> выдаёт HttpOnly; SameSite=Strict cookie и выполняет редирект 302 на /', async () => {
      const token = getApiToken();
      const res = await request('GET', `/?token=${token}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/');
      const setCookie = String(res.headers['set-cookie'] || '');
      assert.match(setCookie, new RegExp(`${localApiTokenCookie}=${token}`));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Path=\//i);
    });

    it('GET /?token=<invalid> отклоняется с кодом 403 Forbidden', async () => {
      const res = await request('GET', '/?token=malicious_process_guess');
      assert.equal(res.status, 403);
      assert.match(res.body?.error, /Недействительный токен авторизации/);
      assert.equal(res.headers['set-cookie'], undefined);
    });

    it('GET /index.html?token=<valid> также валидирует токен и редиректит на /', async () => {
      const token = getApiToken();
      const res = await request('GET', `/index.html?token=${token}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/');
      assert.match(String(res.headers['set-cookie'] || ''), new RegExp(`${localApiTokenCookie}=${token}`));
    });

    it('GET / при первом запуске (initialCookieGranted=false) выдаёт одноразовую cookie легитимному клиенту', async () => {
      setInitialCookieGranted(false);
      const res = await request('GET', '/');
      assert.equal(res.status, 200);
      const setCookie = String(res.headers['set-cookie'] || '');
      assert.match(setCookie, new RegExp(`${localApiTokenCookie}=${getApiToken()}`));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.equal(isInitialCookieGranted(), true);
    });

    it('GET / при повторном обращении без cookie не выдаёт токен повторно посторонним процессам', async () => {
      setInitialCookieGranted(true);
      const res = await request('GET', '/');
      assert.equal(res.status, 200);
      assert.equal(res.headers['set-cookie'], undefined);
    });
  });

  describe('Безопасность токенов и защита от утечек', () => {
    it('safeCompareTokens устойчив к timing attacks и не падает на пустых или несовпадающих по длине строках', () => {
      const token = getApiToken();
      assert.equal(safeCompareTokens(token, token), true);
      assert.equal(safeCompareTokens(token, token.slice(0, -1)), false);
      assert.equal(safeCompareTokens(token, 'a'.repeat(token.length)), false);
      assert.equal(safeCompareTokens('', token), false);
      assert.equal(safeCompareTokens(null, token), false);
      assert.equal(safeCompareTokens(token, undefined), false);
      assert.equal(safeCompareTokens(null, null), false);
    });

    it('resetApiToken генерирует новый криптографический токен и обновляет маскирование', () => {
      const oldToken = getApiToken();
      const newToken = resetApiToken();
      assert.notEqual(oldToken, newToken);
      assert.equal(typeof newToken, 'string');
      assert.equal(newToken.length >= 32, true);
      assert.equal(getApiToken(), newToken);
    });

    it('safeErrorMessage автоматически маскирует токен API в сообщениях об ошибках ([redacted])', () => {
      const token = getApiToken();
      const testError = new Error(`Connection failed with token: ${token}`);
      const masked = safeErrorMessage(testError);
      assert.equal(masked.includes(token), false, 'Токен не должен присутствовать в тексте ошибки');
      assert.match(masked, /\[redacted\]/);
    });

    it('setApiTokenRequired(false) отключает проверку токена для гибкости тестов', async () => {
      setApiTokenRequired(false);
      const res = await request('POST', '/api/osu/settings', {}, {});
      assert.equal(res.status, 200);
    });
  });
});
