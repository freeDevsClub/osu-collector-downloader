"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  sessions,
  oauthToken,
  oauthConfig,
  storeOsuToken,
  pruneSessionsAndOauth,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  safeErrorMessage,
  server,
} = require('../server.js');
const { PORT } = require('../lib/config.js');

describe('Утечка секретов в activeRedactions и ротация токенов', () => {
  let serverInstance;
  let serverPort;
  let prevEnableOauth;

  before(async () => {
    prevEnableOauth = process.env.ENABLE_OAUTH;
    process.env.ENABLE_OAUTH = '1';
    serverInstance = server.listen(0, '127.0.0.1');
    await new Promise(resolve => serverInstance.once('listening', resolve));
    serverPort = /** @type {import('node:net').AddressInfo} */ (serverInstance.address()).port;
  });

  after(async () => {
    if (prevEnableOauth !== undefined) process.env.ENABLE_OAUTH = prevEnableOauth;
    else delete process.env.ENABLE_OAUTH;
    await new Promise(resolve => serverInstance.close(resolve));
    clearRedactions();
    sessions.clear();
  });

  beforeEach(() => {
    clearRedactions();
    sessions.clear();
    oauthToken.accessToken = null;
    oauthToken.refreshToken = null;
    oauthToken.expiresAt = 0;
    oauthConfig.clientSecret = '';
  });

  it('pruneSessionsAndOauth удаляет секреты просроченных сессий из activeRedactions', () => {
    const now = Date.now();
    const tokenExpired = 'session_token_expired';
    const secretExpired = 'secret_cookie_expired_99999';
    sessions.set(tokenExpired, { value: secretExpired, expiresAt: now - 1000 });
    addRedaction(secretExpired);

    const tokenActive = 'session_token_active';
    const secretActive = 'secret_cookie_active_88888';
    sessions.set(tokenActive, { value: secretActive, expiresAt: now + 3600 * 1000 });
    addRedaction(secretActive);

    assert.equal(getActiveRedactionsCount(), 2);
    assert.equal(safeErrorMessage(`err ${secretExpired} and ${secretActive}`), 'err [redacted] and [redacted]');

    pruneSessionsAndOauth();

    // Просроченная сессия удалена из sessions И её секрет удалён из activeRedactions
    assert.equal(sessions.has(tokenExpired), false);
    assert.equal(sessions.has(tokenActive), true);
    assert.equal(getActiveRedactionsCount(), 1);

    // Секрет активной сессии всё ещё маскируется, а просроченный больше не занимает память
    assert.equal(safeErrorMessage(`err ${secretExpired} and ${secretActive}`), `err ${secretExpired} and [redacted]`);
  });

  it('storeOsuToken удаляет старый accessToken и refreshToken из activeRedactions при ротации', () => {
    // 1. Первичное получение токена
    storeOsuToken({
      access_token: 'osu_access_token_v1_12345678',
      refresh_token: 'osu_refresh_token_v1_87654321',
      expires_in: 3600,
      scope: 'public identify',
    }, 'authorization_code');

    assert.equal(getActiveRedactionsCount(), 2);
    assert.equal(safeErrorMessage('Tokens: osu_access_token_v1_12345678 osu_refresh_token_v1_87654321'), 'Tokens: [redacted] [redacted]');

    // 2. Ротация токена: osu! возвращает новый access_token и новый refresh_token
    storeOsuToken({
      access_token: 'osu_access_token_v2_newaccess999',
      refresh_token: 'osu_refresh_token_v2_newrefresh999',
      expires_in: 3600,
      scope: 'public identify',
    }, 'refresh_token');

    // Старые токены v1 должны быть вычищены, количество активных секретов остаётся 2 (а не растёт до 4)
    assert.equal(getActiveRedactionsCount(), 2);
    assert.equal(
      safeErrorMessage('Old: osu_access_token_v1_12345678, New: osu_access_token_v2_newaccess999'),
      'Old: osu_access_token_v1_12345678, New: [redacted]'
    );
    assert.equal(
      safeErrorMessage('OldRef: osu_refresh_token_v1_87654321, NewRef: osu_refresh_token_v2_newrefresh999'),
      'OldRef: osu_refresh_token_v1_87654321, NewRef: [redacted]'
    );
  });

  it('HTTP API POST /api/session и DELETE /api/session корректно очищают старые секреты', async () => {
    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };

    // 1. Сохраняем сессию 1
    const res1 = await fetch(`http://127.0.0.1:${serverPort}/api/session`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ session: 'session_cookie_initial_111111111111' }),
    });
    assert.equal(res1.status, 200);
    assert.equal(getActiveRedactionsCount(), 1);
    const cookieHeader = res1.headers.get('set-cookie');
    assert.ok(cookieHeader);
    const tokenMatch = cookieHeader.match(/osu_collector_token=([^;]+)/);
    assert.ok(tokenMatch);
    const cookie1 = `osu_collector_token=${tokenMatch[1]}`;

    // 2. Пользователь перезаписывает сессию в том же браузере новой сессией 2
    const res2 = await fetch(`http://127.0.0.1:${serverPort}/api/session`, {
      method: 'POST',
      headers: { ...localHeaders, Cookie: cookie1 },
      body: JSON.stringify({ session: 'session_cookie_second_2222222222222' }),
    });
    assert.equal(res2.status, 200);
    // Количество секретов в памяти не должно расти (старая сессия 1 вычищена)
    assert.equal(getActiveRedactionsCount(), 1);
    assert.equal(
      safeErrorMessage('s1: session_cookie_initial_111111111111 s2: session_cookie_second_2222222222222'),
      's1: session_cookie_initial_111111111111 s2: [redacted]'
    );

    const cookieHeader2 = res2.headers.get('set-cookie');
    assert.ok(cookieHeader2);
    const tokenMatch2 = cookieHeader2.match(/osu_collector_token=([^;]+)/);
    assert.ok(tokenMatch2);
    const cookie2 = `osu_collector_token=${tokenMatch2[1]}`;

    // 3. Выход из системы (DELETE /api/session) удаляет сессию и секрет
    const res3 = await fetch(`http://127.0.0.1:${serverPort}/api/session`, {
      method: 'DELETE',
      headers: { ...localHeaders, Cookie: cookie2 },
    });
    assert.equal(res3.status, 200);
    assert.equal(getActiveRedactionsCount(), 0);
    assert.equal(sessions.size, 0);
  });

  it('HTTP API POST /api/oauth/config вычищает старый Client Secret при смене', async () => {
    const localHeaders = {
      Host: `127.0.0.1:${PORT}`,
      'Content-Type': 'application/json',
    };

    // 1. Сохраняем первоначальный секрет OAuth
    const res1 = await fetch(`http://127.0.0.1:${serverPort}/api/oauth/config`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ clientId: '12345', clientSecret: 'oauth_super_secret_initial_key_111' }),
    });
    assert.equal(res1.status, 200);
    assert.equal(getActiveRedactionsCount(), 1);
    assert.equal(
      safeErrorMessage('Secret: oauth_super_secret_initial_key_111'),
      'Secret: [redacted]'
    );

    // 2. Обновляем секрет OAuth на новый
    const res2 = await fetch(`http://127.0.0.1:${serverPort}/api/oauth/config`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ clientId: '12345', clientSecret: 'oauth_super_secret_second_key_222' }),
    });
    assert.equal(res2.status, 200);
    // Количество активных секретов не должно увеличиваться (старый удалён)
    assert.equal(getActiveRedactionsCount(), 1);
    assert.equal(
      safeErrorMessage('Old: oauth_super_secret_initial_key_111, New: oauth_super_secret_second_key_222'),
      'Old: oauth_super_secret_initial_key_111, New: [redacted]'
    );
  });
});
