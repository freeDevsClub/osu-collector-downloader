'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resetBootstrap } = require('../server.js');
const { getApiToken, resetApiToken } = require('../lib/security.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('SEC-001: Безопасность токена API при запуске сервера', () => {
  it('startServer не логирует токен в структурированный лог server.started и выводит URL в stderr', async () => {
    const testEnv = await setupIsolatedTestEnv('sec-001-');
    resetBootstrap();

    const logs = [];
    const stderrChunks = [];

    const originalLog = console.log;
    const originalStderrWrite = process.stderr.write;

    console.log = (msg) => {
      logs.push(String(msg));
    };
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    let appServer;
    try {
      appServer = await startServer(0, '127.0.0.1', { requireToken: true });
      const token = getApiToken();

      // Проверяем структурированные логи в stdout (console.log)
      const serverStartedLog = logs.find((l) => l.includes('server.started'));
      assert.ok(serverStartedLog, 'Лог server.started должен быть зафиксирован в stdout');

      const parsed = JSON.parse(serverStartedLog);
      assert.equal(parsed.event, 'server.started');
      assert.equal(parsed.url, undefined, 'Поле url не должно присутствовать в structured логе server.started');
      assert.equal(
        serverStartedLog.includes(token),
        false,
        'Токен API не должен присутствовать в JSON логах server.started',
      );

      // Проверяем вывод в stderr для пользователя
      const stderrOutput = stderrChunks.join('');
      assert.ok(stderrOutput.includes(`/?token=${token}`), 'URL с токеном должен выводиться напрямую в stderr');
    } finally {
      console.log = originalLog;
      process.stderr.write = originalStderrWrite;
      if (appServer) {
        await new Promise((resolve) => appServer.close(resolve));
      }
      resetApiToken();
      resetBootstrap();
      if (testEnv) {
        await testEnv.cleanup();
      }
    }
  });

  it('SEC-005: startServer логирует предупреждение security.api_token_disabled при DISABLE_API_TOKEN=1', async () => {
    const testEnv = await setupIsolatedTestEnv('sec-005-');
    resetBootstrap();
    const prevDisable = process.env.DISABLE_API_TOKEN;
    process.env.DISABLE_API_TOKEN = '1';

    const warnLogs = [];
    const originalConsoleWarn = console.warn;
    console.warn = (msg) => {
      warnLogs.push(String(msg));
    };

    let appServer;
    try {
      appServer = await startServer(0, '127.0.0.1', { requireToken: false });
      const warningLog = warnLogs.find((l) => l.includes('security.api_token_disabled'));
      assert.ok(warningLog, 'Предупреждение security.api_token_disabled должно быть зафиксировано');

      const parsed = JSON.parse(warningLog);
      assert.equal(parsed.event, 'security.api_token_disabled');
      assert.equal(parsed.level, 'warn');
      assert.match(parsed.message, /API token check DISABLED/);
    } finally {
      if (prevDisable !== undefined) {
        process.env.DISABLE_API_TOKEN = prevDisable;
      } else {
        delete process.env.DISABLE_API_TOKEN;
      }
      console.warn = originalConsoleWarn;
      if (appServer) {
        await new Promise((resolve) => appServer.close(resolve));
      }
      resetApiToken();
      resetBootstrap();
      if (testEnv) {
        await testEnv.cleanup();
      }
    }
  });
});
