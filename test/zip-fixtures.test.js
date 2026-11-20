// @ts-check
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { verifyZipFile } = require('../lib/downloader.js');
const { extractZip } = require('../lib/osu.js');
const { FIXTURES_DIR } = require('./fixtures/generate-zip-fixtures.js');

describe('Тестирование с реальными ZIP/OSZ фикстурами', () => {
  /** @type {string} */
  let tempBaseDir;

  before(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zip-fixtures-test-'));
  });

  after(async () => {
    if (tempBaseDir) {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('Валидные архивы (.osz / ZIP / ZIP64)', () => {
    it('valid-standard.osz: верифицируется и успешно распаковывается со всеми файлами и валидацией beatmap', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'valid-standard.osz');
      const targetDir = path.join(tempBaseDir, 'out-valid-standard');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        const valid = await verifyZipFile(handle, stat.size);
        assert.equal(valid, true, 'verifyZipFile должен вернуть true для валидного .osz');
      } finally {
        await handle.close();
      }

      const count = await extractZip(fixturePath, targetDir, {
        validateBeatmap: true,
        expectedSetId: 12345,
      });

      assert.equal(count, 4, 'Должно быть извлечено 4 файла');
      assert.equal(fs.existsSync(path.join(targetDir, 'audio.mp3')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'bg.jpg')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'sb', 'sprites', 'particle.png')), true);

      // Проверяем наличие .osu файла и его содержимое
      const files = await fs.promises.readdir(targetDir);
      const osuFile = files.find((f) => f.endsWith('.osu'));
      assert.ok(osuFile, 'В распакованной папке должен быть .osu файл');
      const content = await fs.promises.readFile(path.join(targetDir, osuFile), 'utf8');
      assert.match(content, /BeatmapSetID:12345/);
      assert.match(content, /osu file format v14/);
    });

    it('valid-stored.osz: верифицируется и корректно распаковывает файлы без сжатия (метод STORED 0)', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'valid-stored.osz');
      const targetDir = path.join(tempBaseDir, 'out-valid-stored');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        assert.equal(await verifyZipFile(handle, stat.size), true);
      } finally {
        await handle.close();
      }

      const count = await extractZip(fixturePath, targetDir, {
        validateBeatmap: true,
        expectedSetId: 12345,
      });

      assert.equal(count, 3);
      assert.equal(fs.existsSync(path.join(targetDir, 'audio.mp3')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'map.osu')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'bg.jpg')), true);

      const audio = await fs.promises.readFile(path.join(targetDir, 'audio.mp3'), 'utf8');
      assert.equal(audio, 'STORED_AUDIO_BYTES_UNCOMPRESSED');
    });

    it('valid-zip64.osz: верифицирует сигнатуры ZIP64 и корректно распаковывает данные из extra fields', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'valid-zip64.osz');
      const targetDir = path.join(tempBaseDir, 'out-valid-zip64');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        assert.equal(await verifyZipFile(handle, stat.size), true);
      } finally {
        await handle.close();
      }

      const count = await extractZip(fixturePath, targetDir, {
        validateBeatmap: true,
        expectedSetId: 12345,
      });

      assert.equal(count, 3);
      assert.equal(fs.existsSync(path.join(targetDir, 'map.osu')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'audio.mp3')), true);
      const audio = await fs.promises.readFile(path.join(targetDir, 'audio.mp3'), 'utf8');
      assert.equal(audio, 'ZIP64_AUDIO_PAYLOAD_TEST');
    });

    it('empty.zip: верифицируется как валидный пустой архив, но extractZip отклоняет его', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'empty.zip');
      const targetDir = path.join(tempBaseDir, 'out-empty');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        assert.equal(await verifyZipFile(handle, stat.size), true);
      } finally {
        await handle.close();
      }

      await assert.rejects(() => extractZip(fixturePath, targetDir), /архив пуст \(0 файлов\)/);
      assert.equal(fs.existsSync(targetDir), false);
    });
  });

  describe('Поврежденные архивы и целостность данных', () => {
    it('corrupted-crc.osz: отклоняется при несовпадении CRC32 с атомарной очисткой staging', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'corrupted-crc.osz');
      const targetDir = path.join(tempBaseDir, 'out-corrupted-crc');

      await assert.rejects(() => extractZip(fixturePath, targetDir), /Несоответствие контрольной суммы CRC32/);

      // Целевой папки не должно существовать
      assert.equal(fs.existsSync(targetDir), false);

      // Проверяем отсутствие оставшихся staging папок
      const entries = await fs.promises.readdir(tempBaseDir);
      const leftovers = entries.filter((e) => e.startsWith('.tmp_extract_'));
      assert.equal(leftovers.length, 0);
    });

    it('corrupted-truncated.osz: verifyZipFile возвращает false, а extractZip выбрасывает ошибку EOCD', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'corrupted-truncated.osz');
      const targetDir = path.join(tempBaseDir, 'out-corrupted-truncated');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        assert.equal(await verifyZipFile(handle, stat.size), false);
      } finally {
        await handle.close();
      }

      await assert.rejects(() => extractZip(fixturePath, targetDir), /сигнатура EOCD не найдена/);
      assert.equal(fs.existsSync(targetDir), false);
    });

    it('corrupted-no-eocd.bin: отклоняется верификатором и extractZip', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'corrupted-no-eocd.bin');
      const targetDir = path.join(tempBaseDir, 'out-corrupted-no-eocd');

      const handle = await fs.promises.open(fixturePath, 'r');
      try {
        const stat = await handle.stat();
        assert.equal(await verifyZipFile(handle, stat.size), false);
      } finally {
        await handle.close();
      }

      await assert.rejects(() => extractZip(fixturePath, targetDir), /сигнатура EOCD не найдена/);
      assert.equal(fs.existsSync(targetDir), false);
    });

    it('corrupted-bad-local-magic.osz: выбрасывает ошибку поврежденного локального заголовка', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'corrupted-bad-local-magic.osz');
      const targetDir = path.join(tempBaseDir, 'out-bad-magic');

      await assert.rejects(
        () => extractZip(fixturePath, targetDir),
        /Поврежден локальный заголовок файла в ZIP-архиве/,
      );
      assert.equal(fs.existsSync(targetDir), false);
    });
  });

  describe('Безопасность путей (Zip Slip, NTFS ADS, зарезервированные имена)', () => {
    it('unsafe-zip-slip.osz: предотвращает запись файлов за пределы целевой директории', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'unsafe-zip-slip.osz');
      const targetDir = path.join(tempBaseDir, 'out-zip-slip');

      const count = await extractZip(fixturePath, targetDir);
      assert.equal(count, 1, 'Должен быть извлечен только безопасный файл map.osu');

      // Проверяем, что evil-file.txt не появился ни в tempBaseDir, ни в корне
      assert.equal(fs.existsSync(path.join(tempBaseDir, 'evil-file.txt')), false);
      assert.equal(fs.existsSync(path.join(tempBaseDir, 'evil2.txt')), false);
      assert.equal(fs.existsSync(path.join(targetDir, 'map.osu')), true);
    });

    it('unsafe-ntfs-ads.osz: фильтрует альтернативные потоки данных NTFS (:)', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'unsafe-ntfs-ads.osz');
      const targetDir = path.join(tempBaseDir, 'out-ntfs-ads');

      const count = await extractZip(fixturePath, targetDir);
      assert.equal(count, 2, 'Должны быть извлечены map.osu и valid.txt, а ADS stream пропущен');

      assert.equal(fs.existsSync(path.join(targetDir, 'map.osu')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'valid.txt')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'audio.mp3:hidden_stream')), false);
    });

    it('unsafe-windows-reserved.osz: отфильтровывает зарезервированные имена устройств Windows (CON, NUL, AUX, COM1)', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'unsafe-windows-reserved.osz');
      const targetDir = path.join(tempBaseDir, 'out-windows-reserved');

      const count = await extractZip(fixturePath, targetDir);
      assert.equal(count, 1, 'Должен быть извлечен только map.osu');

      assert.equal(fs.existsSync(path.join(targetDir, 'map.osu')), true);
      assert.equal(fs.existsSync(path.join(targetDir, 'CON')), false);
      assert.equal(fs.existsSync(path.join(targetDir, 'nul.txt')), false);
      assert.equal(fs.existsSync(path.join(targetDir, 'AUX.mp3')), false);
      assert.equal(fs.existsSync(path.join(targetDir, 'com1.dat')), false);
    });
  });

  describe('Валидация beatmap структуры (.osu и BeatmapSetID)', () => {
    it('invalid-no-osu.osz: отклоняется при validateBeatmap: true', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'invalid-no-osu.osz');
      const targetDir = path.join(tempBaseDir, 'out-no-osu');

      await assert.rejects(
        () => extractZip(fixturePath, targetDir, { validateBeatmap: true }),
        /архив не содержит файлов карт \(\.osu\)/,
      );
      assert.equal(fs.existsSync(targetDir), false);
    });

    it('invalid-bad-osu-header.osz: отклоняется при отсутствии валидного формата osu', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'invalid-bad-osu-header.osz');
      const targetDir = path.join(tempBaseDir, 'out-bad-header');

      await assert.rejects(
        () => extractZip(fixturePath, targetDir, { validateBeatmap: true }),
        /ни один файл \.osu не содержит валидного заголовка формата osu!/,
      );
      assert.equal(fs.existsSync(targetDir), false);
    });

    it('invalid-mismatched-setid.osz: отклоняется при несовпадении BeatmapSetID', async () => {
      const fixturePath = path.join(FIXTURES_DIR, 'invalid-mismatched-setid.osz');
      const targetDir = path.join(tempBaseDir, 'out-mismatched-setid');

      await assert.rejects(
        () => extractZip(fixturePath, targetDir, { validateBeatmap: true, expectedSetId: 12345 }),
        /Несоответствие BeatmapSetID: архив содержит карты для набора \(99999\), ожидался 12345/,
      );
      assert.equal(fs.existsSync(targetDir), false);
    });
  });
});
