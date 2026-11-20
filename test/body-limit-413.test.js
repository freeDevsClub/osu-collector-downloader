'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Readable } = require('node:stream');

const { server } = require('../server.js');
const { readJson, closeStreamOrSocket } = require('../lib/utils/http.js');
const { PORT, MAX_BODY, HttpError } = require('../lib/config.js');

describe('Лимит размера тела запроса (HTTP 413) и закрытие сокетов в readJson', () => {
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

  describe('Модульные тесты readJson', () => {
    it('успешно парсит валидный JSON-объект', async () => {
      const stream = Readable.from([JSON.stringify({ key: 'value', number: 42 })]);
      const result = await readJson(stream);
      assert.deepEqual(result, { key: 'value', number: 42 });
    });

    it('выбрасывает HttpError(400) при некорректном JSON', async () => {
      const stream = Readable.from(['{ not valid json ']);
      await assert.rejects(
        () => readJson(stream),
        (/** @type {any} */ err) => {
          assert.equal(err instanceof HttpError, true);
          assert.equal(err.status, 400);
          assert.match(err.message, /Некорректный JSON/);
          return true;
        },
      );
    });

    it('выбрасывает HttpError(400) если тело запроса массив или примитив', async () => {
      const streamArr = Readable.from(['[1, 2, 3]']);
      await assert.rejects(
        () => readJson(streamArr),
        (/** @type {any} */ err) => {
          assert.equal(err instanceof HttpError, true);
          assert.equal(err.status, 400);
          assert.match(err.message, /Ожидался JSON-объект/);
          return true;
        },
      );

      const streamNum = Readable.from(['12345']);
      await assert.rejects(
        () => readJson(streamNum),
        (/** @type {any} */ err) => {
          assert.equal(err instanceof HttpError, true);
          assert.equal(err.status, 400);
          assert.match(err.message, /Ожидался JSON-объект/);
          return true;
        },
      );
    });

    it('выбрасывает HttpError(413) и уничтожает поток при превышении maxBody', async () => {
      const largeChunk = 'a'.repeat(200);
      const stream = Readable.from([largeChunk]);

      await assert.rejects(
        () => readJson(stream, { maxBody: 100 }),
        (/** @type {any} */ err) => {
          assert.equal(err instanceof HttpError, true);
          assert.equal(err.status, 413);
          assert.match(err.message, /Слишком большой запрос/);
          return true;
        },
      );

      // Проверяем, что поток был корректно уничтожен
      assert.equal(stream.destroyed, true);
    });

    it('выбрасывает HttpError(413) на основе заголовка Content-Length до вычитывания чанков', async () => {
      let readAttempted = false;
      const stream = new Readable({
        read() {
          readAttempted = true;
          this.push('some data');
        },
      });
      // @ts-ignore
      stream.headers = { 'content-length': '5000000' };

      await assert.rejects(
        () => readJson(stream, { maxBody: 1000 }),
        (/** @type {any} */ err) => {
          assert.equal(err instanceof HttpError, true);
          assert.equal(err.status, 413);
          return true;
        },
      );

      assert.equal(stream.destroyed, true);
      assert.equal(readAttempted, false, 'Чтение чанков не должно начинаться при превышении Content-Length');
    });
  });

  describe('Интеграционные тесты через HTTP-сервер', () => {
    it('POST /api/osu/settings возвращает 413 и Connection: close при теле больше MAX_BODY', async () => {
      const oversizedPayload = JSON.stringify({
        osuPath: 'D:\\osu!',
        dummy: 'x'.repeat(MAX_BODY + 1024),
      });

      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${appPort}/api/osu/settings`,
          {
            method: 'POST',
            headers: {
              Host: `127.0.0.1:${PORT}`,
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(oversizedPayload)),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              let body = null;
              try {
                body = JSON.parse(data);
              } catch {}
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body,
              });
            });
          },
        );
        req.on('error', reject);
        req.write(oversizedPayload);
        req.end();
      });

      assert.equal(res.status, 413);
      assert.equal(res.headers['connection'], 'close');
      assert.match(res.body?.error, /Слишком большой запрос/);
    });

    it('POST /api/osu/browse возвращает 413 и не проглатывает ошибку через .catch', async () => {
      const oversizedPayload = JSON.stringify({
        initialPath: 'C:\\',
        flood: 'z'.repeat(MAX_BODY + 2048),
      });

      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${appPort}/api/osu/browse`,
          {
            method: 'POST',
            headers: {
              Host: `127.0.0.1:${PORT}`,
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(oversizedPayload)),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              let body = null;
              try {
                body = JSON.parse(data);
              } catch {}
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body,
              });
            });
          },
        );
        req.on('error', reject);
        req.write(oversizedPayload);
        req.end();
      });

      assert.equal(res.status, 413);
      assert.equal(res.headers['connection'], 'close');
      assert.match(res.body?.error, /Слишком большой запрос/);
    });

    it('POST /api/downloads возвращает 413 при превышении лимита', async () => {
      const oversizedPayload = JSON.stringify({
        collectionId: '123',
        setIds: Array.from({ length: 10000 }, (_, i) => i + 1),
        extra: 'y'.repeat(MAX_BODY),
      });

      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${appPort}/api/downloads`,
          {
            method: 'POST',
            headers: {
              Host: `127.0.0.1:${PORT}`,
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(oversizedPayload)),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              let body = null;
              try {
                body = JSON.parse(data);
              } catch {}
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body,
              });
            });
          },
        );
        req.on('error', reject);
        req.write(oversizedPayload);
        req.end();
      });

      assert.equal(res.status, 413);
      assert.equal(res.headers['connection'], 'close');
      assert.match(res.body?.error, /Слишком большой запрос/);
    });

    it('закрывает TCP-соединение на уровне сокета при отправке потока с превышением MAX_BODY', async () => {
      const totalBytes = MAX_BODY + 4096;
      let serverClosedCleanly = false;
      let receivedData = '';

      await new Promise((resolve, reject) => {
        const client = net.createConnection({ port: appPort }, () => {
          // Отправляем HTTP POST запрос с большим Content-Length
          client.write(
            `POST /api/osu/check HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${PORT}\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${totalBytes}\r\n` +
              `\r\n`,
          );

          // Шлём первый чанк, превышающий MAX_BODY
          client.write('{"setIds":[' + '1,'.repeat(Math.floor(MAX_BODY / 2)) + '1]}');
        });

        client.on('data', (chunk) => {
          receivedData += chunk.toString('utf8');
        });

        client.on('close', () => {
          serverClosedCleanly = true;
          resolve(undefined);
        });

        client.on('error', (err) => {
          // ECONNRESET или EPIPE допустимы при закрытии сервером сокета
          resolve(undefined);
        });

        setTimeout(() => {
          client.destroy();
          resolve(undefined);
        }, 3000);
      });

      assert.match(receivedData, /HTTP\/1\.1 413 Payload Too Large/);
      assert.match(receivedData, /Connection: close/i);
      assert.match(receivedData, /Слишком большой запрос/);
    });
  });
});
