"use strict";

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../server.js');
const {
  sessions,
  pruneSessions,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  safeErrorMessage,
} = require('../lib/security.js');
const { PORT } = require('../lib/config.js');

describe('Утечка секретов в activeRedactions и ротация токенов', () => {
  let serverInstance;
  let serverPort;

  before(async () => {
    serverInstance = server.listen(0, '127.0.0.1');
    await new Promise(resolve => serverInstance.once('listening', resolve));
    serverPort = /** @type {import('node:net').AddressInfo} */ (serverInstance.address()).port;
  });

  after(async () => {
    await new Promise(resolve => serverInstance.close(resolve));
    clearRedactions();
    sessions.clear();
  });

  beforeEach(() => {
    clearRedactions();
    sessions.clear();
  });

  it('pruneSessions удаляет секреты просроченных сессий из activeRedactions', () => {
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

    pruneSessions();

    // Просроченная сессия удалена из sessions И её секрет удалён из activeRedactions
    assert.equal(sessions.has(tokenExpired), false);
    assert.equal(sessions.has(tokenActive), true);
    assert.equal(getActiveRedactionsCount(), 1);

    // Секрет активной сессии всё ещё маскируется, а просроченный больше не занимает память
    assert.equal(safeErrorMessage(`err ${secretExpired} and ${secretActive}`), `err ${secretExpired} and [redacted]`);
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
});
