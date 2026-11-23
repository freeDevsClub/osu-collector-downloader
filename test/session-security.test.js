'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { server } = require('../server.js');
const { sessions, getActiveRedactionsCount, cookieOptions } = require('../lib/security.js');
const { PORT, ROOT } = require('../lib/config.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('Безопасность сессий и cookie osu_session (/api/session)', () => {
  let appServer;
  let appPort;
  let testEnv;

  before(async () => {
    testEnv = await setupIsolatedTestEnv('session-sec-test-');
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
    sessions.clear();
  });

  /**
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} [headers]
   * @param {any} [body]
   */
  async function apiRequest(method, path, headers = {}, body = null) {
    const payload = body !== null ? JSON.stringify(body) : '';
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${appPort}${path}`,
        {
          method,
          headers: {
            Host: `127.0.0.1:${PORT}`,
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
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
      if (payload) req.write(payload);
      req.end();
    });
  }

  describe('Валидация формата cookie osu_session', () => {
    it('отклоняет пустые или пробельные значения', async () => {
      const res1 = await apiRequest('POST', '/api/session', {}, { session: '' });
      assert.equal(res1.status, 400);
      assert.match(res1.body?.error, /Некорректный формат/);

      const res2 = await apiRequest('POST', '/api/session', {}, { session: '   ' });
      assert.equal(res2.status, 400);
      assert.match(res2.body?.error, /Некорректный формат/);
    });

    it('отклоняет значения короче 20 символов', async () => {
      const res = await apiRequest('POST', '/api/session', {}, { session: 'too_short_cookie_12' });
      assert.equal(res.status, 400);
      assert.match(res.body?.error, /Некорректный формат/);
    });

    it('отклоняет значения длиннее 1024 символов', async () => {
      const res = await apiRequest('POST', '/api/session', {}, { session: 'a'.repeat(1025) });
      assert.equal(res.status, 400);
      assert.match(res.body?.error, /Некорректный формат/);
    });

    it('отклоняет значения с пробелами, новыми строками и служебными символами', async () => {
      // С пробелом
      const resSpace = await apiRequest(
        'POST',
        '/api/session',
        {},
        { session: 'session token with spaces inside 12345' },
      );
      assert.equal(resSpace.status, 400);
      assert.match(resSpace.body?.error, /Некорректный формат/);

      // С точкой с запятой
      const resSemi = await apiRequest('POST', '/api/session', {}, { session: 'session_token_12345;path=/;httponly' });
      assert.equal(resSemi.status, 400);

      // С переводом строки
      const resNl = await apiRequest(
        'POST',
        '/api/session',
        {},
        { session: 'session_token_12345\r\nInjected: header' },
      );
      assert.equal(resNl.status, 400);

      // С кавычками или HTML
      const resQuote = await apiRequest(
        'POST',
        '/api/session',
        {},
        { session: 'session_token_12345<script>alert(1)</script>' },
      );
      assert.equal(resQuote.status, 400);
    });

    it('автоматически обрезает префикс osu_session= и пробелы', async () => {
      const rawCookie = '  osu_session=valid_base64_or_hex_token_1234567890abcdef  ';
      const res = await apiRequest('POST', '/api/session', {}, { session: rawCookie });
      assert.equal(res.status, 200);
      assert.equal(res.body?.connected, true);

      // Проверяем, что в сессиях сохранён очищенный токен
      const tokenMatch = res.headers['set-cookie']?.[0]?.match(/osu_collector_token=([^;]+)/);
      assert.ok(tokenMatch);
      const stored = sessions.get(tokenMatch[1]);
      assert.equal(stored?.value, 'valid_base64_or_hex_token_1234567890abcdef');
    });

    it('принимает валидные символы base64, URL-encoded и спецзнаки Laravel сессий (+, /, %, -, _, ., =, |)', async () => {
      const validToken = 'eyJpdiI6IjEyMyIsInZhbHVlIjoiYWJjKy8lXy0uPXwifQ==';
      const res = await apiRequest('POST', '/api/session', {}, { session: validToken });
      assert.equal(res.status, 200);
      assert.equal(res.body?.connected, true);
    });
  });

  describe('Жизненный цикл сессии (GET, POST, DELETE)', () => {
    it('GET возвращает connected: false, когда cookie нет', async () => {
      const res = await apiRequest('GET', '/api/session');
      assert.equal(res.status, 200);
      assert.equal(res.body?.connected, false);
    });

    it('POST сохраняет сессию в памяти и возвращает connected: true, GET подтверждает статус', async () => {
      const resPost = await apiRequest('POST', '/api/session', {}, { session: 'my_very_secret_session_token_1234567' });
      assert.equal(resPost.status, 200);
      assert.equal(resPost.body?.connected, true);

      const cookieHeader = resPost.headers['set-cookie']?.[0];
      assert.ok(cookieHeader);
      assert.match(cookieHeader, /HttpOnly/i);
      assert.match(cookieHeader, /SameSite=Strict/i);

      const tokenMatch = cookieHeader.match(/osu_collector_token=([^;]+)/);
      assert.ok(tokenMatch);
      const cookie = `osu_collector_token=${tokenMatch[1]}`;

      // Проверяем статус через GET с переданной кукой
      const resGet = await apiRequest('GET', '/api/session', { Cookie: cookie });
      assert.equal(resGet.status, 200);
      assert.equal(resGet.body?.connected, true);
    });

    it('DELETE корректно очищает сессию и обнуляет cookie', async () => {
      const resPost = await apiRequest('POST', '/api/session', {}, { session: 'session_to_be_deleted_1234567890' });
      const cookieHeader = resPost.headers['set-cookie']?.[0];
      const tokenMatch = cookieHeader?.match(/osu_collector_token=([^;]+)/);
      assert.ok(tokenMatch);
      const cookie = `osu_collector_token=${tokenMatch[1]}`;

      const resDelete = await apiRequest('DELETE', '/api/session', { Cookie: cookie });
      assert.equal(resDelete.status, 200);
      assert.equal(resDelete.body?.connected, false);

      // Проверяем, что в памяти сессия удалена
      assert.equal(sessions.size, 0);

      // Проверяем Set-Cookie с истекшим сроком
      const delCookieHeader = resDelete.headers['set-cookie']?.[0];
      assert.ok(delCookieHeader);
      assert.match(delCookieHeader, /Max-Age=0/i);
    });

    it('QUAL-001: cookieOptions формирует параметры куки без флага Secure даже при x-forwarded-proto: https', () => {
      const mockReq = /** @type {any} */ ({ headers: { 'x-forwarded-proto': 'https' } });
      const opts = cookieOptions(mockReq, 3600);
      assert.equal(opts, 'Path=/; HttpOnly; SameSite=Strict; Max-Age=3600');
      assert.doesNotMatch(opts, /;\s*Secure/i);
    });

    it('QUAL-001: POST /api/session не выставляет флаг Secure при наличии заголовка x-forwarded-proto: https', async () => {
      const resPost = await apiRequest(
        'POST',
        '/api/session',
        { 'X-Forwarded-Proto': 'https' },
        { session: 'session_fake_token_1234567890_abcdef' },
      );
      const cookieHeader = resPost.headers['set-cookie']?.[0];
      assert.ok(cookieHeader);
      assert.match(cookieHeader, /Path=\//);
      assert.match(cookieHeader, /HttpOnly/i);
      assert.match(cookieHeader, /SameSite=Strict/i);
      assert.doesNotMatch(cookieHeader, /;\s*Secure/i);
    });
  });

  describe('UI и разметка index.html', () => {
    it('index.html скрывает osu_session под спойлер и содержит чекбокс подтверждения рисков', async () => {
      const htmlPath = path.join(ROOT, 'index.html');
      const html = await fs.promises.readFile(htmlPath, 'utf8');

      // 1. Спойлер с расширенными настройками
      assert.match(html, /id="session-advanced-details"/);
      assert.match(html, /class="extra-methods-details"/);

      // 2. Чекбокс подтверждения рисков передачи сессии
      assert.match(html, /id="session-risk-confirm"/);

      // 3. Кнопка сохранения сессии изначально disabled
      assert.match(html, /id="session-save"[^>]*disabled/);

      // 4. Карточка скачивания — номер 3
      assert.match(html, /<h2>3\. Скачивание<\/h2>/);

      // 5. Предупреждение о полном доступе к аккаунту
      assert.match(html, /Полный доступ к аккаунту/);

      // 6. Стили вынесены в отдельный файл style.css, инлайн-стили отсутствуют
      assert.match(html, /<link rel="stylesheet" href="\/style\.css" \/>/);
      assert.doesNotMatch(html, /<style/i);
      assert.doesNotMatch(html, /\bstyle=/i);

      // 7. Проверка стилей чекбокса в style.css
      const cssPath = path.join(ROOT, 'style.css');
      const css = await fs.promises.readFile(cssPath, 'utf8');
      assert.match(css, /\.session-confirm-label\s*input\s*\{[^}]*width:\s*16px;/);
      assert.match(css, /\.session-confirm-label\s*input\s*\{[^}]*height:\s*16px;/);
    });
  });
});
