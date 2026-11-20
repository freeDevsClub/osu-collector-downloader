"use strict";

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../lib/config.js');
const { safeJobForClient } = require('../lib/jobs.js');

/** @type {any} */
let updateJob;

before(async () => {
  ({ updateJob } = await import('../public/js/components/downloads.js'));
});

describe('Компактный UI прогресса и выпадающий список параллельных загрузок (Issue #4)', () => {
  it('safeJobForClient включает массив activeTransfers с детальной информацией о каждом потоке', () => {
    const job = {
      id: 'job_parallel_ui',
      method: 'mirror',
      collectionName: 'Test Coll',
      setIds: [100, 200, 300],
      doneIds: new Set([100]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      mapsById: new Map([
        [200, { label: 'Camellia - GHOST' }],
        [300, { label: 'Xi - FREEDOM DiVE' }],
      ]),
      activeTransfers: new Map([
        [200, { setId: 200, setName: 'Camellia - GHOST', mirror: 'osu.direct', bytes: 5000, totalBytes: 10000 }],
        [300, { setId: 300, setName: 'Xi - FREEDOM DiVE', mirror: 'Hinamizawa', bytes: 3000, totalBytes: 12000 }],
      ]),
      status: 'running',
    };

    const clientJob = safeJobForClient(job);
    assert.ok(Array.isArray(clientJob.activeTransfers));
    assert.equal(clientJob.activeTransfers.length, 2);

    const t1 = clientJob.activeTransfers[0];
    assert.equal(t1.setId, 200);
    assert.equal(t1.setName, 'Camellia - GHOST');
    assert.equal(t1.mirror, 'osu.direct');
    assert.equal(t1.bytes, 5000);
    assert.equal(t1.totalBytes, 10000);
    assert.equal(t1.percent, 50);

    const t2 = clientJob.activeTransfers[1];
    assert.equal(t2.setId, 300);
    assert.equal(t2.setName, 'Xi - FREEDOM DiVE');
    assert.equal(t2.mirror, 'Hinamizawa');
    assert.equal(t2.bytes, 3000);
    assert.equal(t2.totalBytes, 12000);
    assert.equal(t2.percent, 25);
  });

  it('index.html содержит компактную структуру выпадающего списка и не содержит устаревших громоздких элементов', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');

    // Проверяем наличие новых элементов
    assert.match(html, /<details\s+id="transfers-details"\s+class="transfers-dropdown">/);
    assert.match(html, /<summary\s+class="transfers-summary">/);
    assert.match(html, /<span\s+id="progress-label">Подготовка…<\/span>/);
    assert.match(html, /<span\s+id="transfers-chevron"\s+class="transfers-chevron"/);
    assert.match(html, /<div\s+id="transfers-list"\s+class="transfers-list"><\/div>/);
    assert.match(html, /<div\s+id="progress-track"\s+class="progress-track"/);

    // Проверяем удаление избыточных устаревших блоков
    assert.equal(html.includes('class="transfer-details"'), false, 'transfer-details должен быть удалён из index.html');
    assert.equal(html.includes('id="transfer-track"'), false, 'Второй прогресс-бар transfer-track должен быть удалён');
    assert.equal(html.includes('id="transfer-bar"'), false, 'transfer-bar должен быть удалён');
    assert.equal(html.includes('id="transfer-bytes"'), false, 'transfer-bytes должен быть удалён');
    assert.equal(html.includes('id="transfer-label"'), false, 'transfer-label должен быть удалён');
  });

  it('style.css содержит стили для выпадающего списка параллельных загрузок и анимации шеврона', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf-8');

    assert.match(css, /\.transfers-dropdown/);
    assert.match(css, /\.transfers-summary/);
    assert.match(css, /\.transfers-chevron/);
    assert.match(css, /\.transfers-dropdown\[open\]\s*\.transfers-chevron\s*\{[^}]*transform:\s*rotate\(180deg\)/);
    assert.match(css, /\.transfers-list/);
    assert.match(css, /\.transfer-item/);
    assert.match(css, /\.transfer-item-bar\s*\{[^}]*width:\s*var\(--progress,\s*0%\)/);
  });

  it('updateJob формирует компактную строку вида "Загрузка… n из n" и обновляет список потоков', () => {
    let styleProps = {};
    const mockProgressBar = {
      style: {
        setProperty: (k, v) => { styleProps[k] = v; },
      },
    };
    const mockProgressPercent = { textContent: '' };
    const mockProgressLabel = { textContent: '' };
    const mockProgressTrack = { setAttribute: () => {} };
    const mockTransfersDetails = { open: true };
    const mockTransfersChevron = { hidden: false };

    /** @type {any[]} */
    const createdElements = [];
    const mockTransfersList = {
      children: [],
      innerHTML: '',
      replaceChildren: () => { mockTransfersList.children = []; },
      appendChild: (el) => { mockTransfersList.children.push(el); },
    };

    /** @type {Record<string, any>} */
    const elements = {
      'progress-bar': mockProgressBar,
      'progress-percent': mockProgressPercent,
      'progress-label': mockProgressLabel,
      'progress-track': mockProgressTrack,
      'transfers-details': mockTransfersDetails,
      'transfers-chevron': mockTransfersChevron,
      'transfers-list': mockTransfersList,
      'downloaded-count': { textContent: '' },
      'skipped-count': { textContent: '' },
      'failed-count': { textContent: '' },
    };

    const origDocument = /** @type {any} */ (global).document;
    /** @type {any} */ (global).document = {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => {
        const el = {
          tagName: tag,
          className: '',
          textContent: '',
          title: '',
          style: {
            setProperty: (k, v) => { el.style[k] = v; },
          },
          appendChild: (c) => { el.children = el.children || []; el.children.push(c); },
        };
        createdElements.push(el);
        return el;
      },
    };

    try {
      const mockJob = {
        id: 'job_compact_test',
        total: 50,
        completed: 12,
        downloaded: 12,
        skipped: 0,
        failed: 0,
        status: 'running',
        activeTransfers: [
          { setId: 101, setName: 'Song A', mirror: 'osu.direct', bytes: 2000, totalBytes: 4000, percent: 50 },
          { setId: 102, setName: 'Song B', mirror: 'Hinamizawa', bytes: 1000, totalBytes: 5000, percent: 20 },
        ],
      };

      updateJob(mockJob);

      // Проверяем компактную строку статуса
      assert.equal(mockProgressLabel.textContent, 'Загрузка… 12 из 50');
      assert.equal(mockProgressPercent.textContent, '24%');

      // Проверяем, что в transfers-list отрендерились 2 активных потока
      assert.equal(mockTransfersList.children.length, 2);

      // Проверяем отображение статуса для других состояний
      updateJob({ ...mockJob, status: 'paused', completed: 15 });
      assert.equal(mockProgressLabel.textContent, 'Пауза · 15 из 50');

      updateJob({ ...mockJob, status: 'finished', completed: 50 });
      assert.equal(mockProgressLabel.textContent, 'Завершено · 50 из 50');

      updateJob({ ...mockJob, status: 'finished_with_errors', completed: 48, failed: 2 });
      assert.equal(mockProgressLabel.textContent, 'Завершено с ошибками · 48 из 50');

      updateJob({ ...mockJob, status: 'cancelled', completed: 15 });
      assert.equal(mockProgressLabel.textContent, 'Остановлено · 15 из 50');
    } finally {
      /** @type {any} */ (global).document = origDocument;
    }
  });
});
