'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { buildMirrorUrl, DEFAULT_MIRRORS } = require('../lib/config.js');
const { downloadSet, appendNoVideo, estimateRequiredDiskSpace } = require('../lib/downloader.js');
const { safeJobForClient } = require('../lib/jobs.js');
const { createTestJob } = require('./helpers/job-factory.js');
const { setupIsolatedTestEnv } = require('./helpers/test-env.js');

describe('Режим скачивания «Без видео» (No Video)', () => {
  let server;
  let serverPort;
  let requestedUrls = [];
  let testEnv;

  const validZipBuffer = Buffer.from([
    // Local file header (30 bytes)
    0x50, 0x4b, 0x03, 0x04, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // EOCD (22 bytes)
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  before(async () => {
    testEnv = await setupIsolatedTestEnv('novideo-test-');

    server = http.createServer((req, res) => {
      requestedUrls.push(req.url);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validZipBuffer.length),
      });
      res.end(validZipBuffer);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    serverPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it('appendNoVideo корректно добавляет параметр к URL', () => {
    assert.equal(appendNoVideo('https://osu.direct/d/123'), 'https://osu.direct/d/123?noVideo=1');
    assert.equal(
      appendNoVideo('https://mirror.example.com/api?id=123'),
      'https://mirror.example.com/api?id=123&noVideo=1',
    );
    assert.equal(appendNoVideo('https://osu.direct/d/123?noVideo=1'), 'https://osu.direct/d/123?noVideo=1');
  });

  it('buildMirrorUrl формирует ссылки с noVideo и без него', () => {
    assert.equal(buildMirrorUrl('https://osu.direct/d/{id}', 555), 'https://osu.direct/d/555');
    assert.equal(buildMirrorUrl('https://osu.direct/d/{id}', 555, false), 'https://osu.direct/d/555');
    assert.equal(buildMirrorUrl('https://osu.direct/d/{id}', 555, true), 'https://osu.direct/d/555?noVideo=1');
    assert.equal(
      buildMirrorUrl('https://osu.direct/d/{id}', 555, { noVideo: true }),
      'https://osu.direct/d/555?noVideo=1',
    );
  });

  it('DEFAULT_MIRRORS поддерживают noVideo', () => {
    for (const mirror of DEFAULT_MIRRORS) {
      const normalUrl = mirror.build(12345);
      assert.equal(normalUrl.includes('noVideo=1'), false);
      const noVideoUrl = mirror.build(12345, { noVideo: true });
      assert.equal(noVideoUrl.includes('noVideo=1'), true);
    }
  });

  it('estimateRequiredDiskSpace снижает оценку требуемого места при noVideo: true', async () => {
    const setIds = [990001, 990002, 990003];
    const normalEst = await estimateRequiredDiskSpace(setIds, false);
    const noVideoEst = await estimateRequiredDiskSpace(setIds, true);
    assert.equal(normalEst, 3 * 10 * 1024 * 1024); // 30 МБ
    assert.equal(noVideoEst, 3 * 3 * 1024 * 1024); // 9 МБ
  });

  it('downloadSet передаёт параметр noVideo=1 в запрос при включённом режиме', async () => {
    requestedUrls = [];
    const testMirror = {
      id: 'mock_novideo_mirror',
      label: 'Mock NoVideo Mirror',
      build: (id, opts) => buildMirrorUrl(`http://127.0.0.1:${serverPort}/d/{id}`, id, opts),
    };

    const jobNoVideo = createTestJob({
      id: 'job_nv_true',
      noVideo: true,
    });

    await downloadSet(88001, { kind: 'mirror', mirror: testMirror }, jobNoVideo);
    assert.equal(requestedUrls.length, 1);
    assert.ok(requestedUrls[0].includes('noVideo=1'), `Ожидался noVideo=1 в URL, получено: ${requestedUrls[0]}`);

    requestedUrls = [];
    const jobWithVideo = createTestJob({
      id: 'job_nv_false',
      noVideo: false,
    });

    await downloadSet(88002, { kind: 'mirror', mirror: testMirror }, jobWithVideo);
    assert.equal(requestedUrls.length, 1);
    assert.equal(
      requestedUrls[0].includes('noVideo=1'),
      false,
      `noVideo=1 не должен присутствовать в URL: ${requestedUrls[0]}`,
    );
  });

  it('safeJobForClient корректно возвращает noVideo клиенту', () => {
    const job1 = createTestJob({
      id: 'test_job_novideo_client',
      method: 'mirror',
      noVideo: true,
      collectionName: 'No Video Collection',
      setIds: [1],
    });
    const client1 = safeJobForClient(job1);
    assert.equal(client1.noVideo, true);

    const job2 = createTestJob({
      id: 'test_job_video_client',
      method: 'mirror',
      noVideo: false,
      collectionName: 'Video Collection',
      setIds: [1],
    });
    const client2 = safeJobForClient(job2);
    assert.equal(client2.noVideo, false);
  });
});
