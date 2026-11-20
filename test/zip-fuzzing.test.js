// @ts-check
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { verifyZipFile } = require('../lib/downloader.js');
const { extractZip } = require('../lib/osu.js');
const { FIXTURES_DIR, buildZip, buildZip64 } = require('./fixtures/generate-zip-fixtures.js');

describe('Фаззинг и стресс-тестирование парсера ZIP/OSZ (verifyZipFile и extractZip)', () => {
  /** @type {string} */
  let tempBaseDir;

  before(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zip-fuzz-test-'));
  });

  after(async () => {
    if (tempBaseDir) {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('Мутационный фаззинг (Случайные байтовые мутации валидных архивов)', () => {
    it('устойчив к 100 итерациям случайных битовых и байтовых мутаций без крашей процесса и утечек дескрипторов', async () => {
      const validBuffer = await fs.promises.readFile(path.join(FIXTURES_DIR, 'valid-standard.osz'));
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        // Клонируем буфер и делаем 1..15 случайных повреждений
        const mutated = Buffer.from(validBuffer);
        const mutationsCount = 1 + (i % 15);
        for (let m = 0; m < mutationsCount; m++) {
          const pos = crypto.randomInt(0, mutated.length);
          mutated[pos] = crypto.randomInt(0, 256);
        }

        const fuzzFile = path.join(tempBaseDir, `fuzz_mutated_${i}.osz`);
        const fuzzOut = path.join(tempBaseDir, `fuzz_out_${i}`);
        await fs.promises.writeFile(fuzzFile, mutated);

        // 1. Тестируем verifyZipFile
        const handle = await fs.promises.open(fuzzFile, 'r');
        try {
          const res = await verifyZipFile(handle, mutated.length);
          assert.equal(typeof res, 'boolean', 'verifyZipFile должен всегда возвращать boolean');
        } finally {
          await handle.close();
        }

        // 2. Тестируем extractZip: должен либо успешно распаковать, либо безопасно выбросить ошибку
        try {
          await extractZip(fuzzFile, fuzzOut);
        } catch (err) {
          // Ожидаемая контролируемая ошибка
          assert.ok(err instanceof Error, 'Ошибка должна быть экземпляром Error');
        } finally {
          // Проверяем отсутствие мусора при сбое
          if (!fs.existsSync(fuzzOut)) {
            const entries = await fs.promises.readdir(tempBaseDir);
            const orphanStaging = entries.filter((e) => e.startsWith(`.tmp_extract_fuzz_out_${i}`));
            assert.equal(orphanStaging.length, 0, `Staging директория должна быть очищена на итерации ${i}`);
          }
          await fs.promises.rm(fuzzFile, { force: true }).catch(() => {});
          await fs.promises.rm(fuzzOut, { recursive: true, force: true }).catch(() => {});
        }
      }
    });
  });

  describe('Граничные размеры и псевдослучайные последовательности байт', () => {
    const boundarySizes = [0, 1, 4, 10, 21, 22, 23, 64, 512, 1024, 65535, 65557, 70000];

    for (const size of boundarySizes) {
      it(`корректно обрабатывает произвольный буфер размера ${size} байт`, async () => {
        const randomBuf = crypto.randomBytes(size);
        const testFile = path.join(tempBaseDir, `boundary_${size}.bin`);
        const testOut = path.join(tempBaseDir, `boundary_out_${size}`);
        await fs.promises.writeFile(testFile, randomBuf);

        const handle = await fs.promises.open(testFile, 'r');
        try {
          const res = await verifyZipFile(handle, size);
          assert.equal(typeof res, 'boolean');
        } finally {
          await handle.close();
        }

        if (size < 22) {
          await assert.rejects(() => extractZip(testFile, testOut), /размер файла меньше 22 байт/);
        } else {
          try {
            await extractZip(testFile, testOut);
          } catch (err) {
            assert.ok(err instanceof Error);
          }
        }

        await fs.promises.rm(testFile, { force: true }).catch(() => {});
        await fs.promises.rm(testOut, { recursive: true, force: true }).catch(() => {});
      });
    }
  });

  describe('Побайтовое усечение архива (Truncation Fuzzing)', () => {
    it('безопасно отклоняет побайтово усеченный архив на 50 шагах среза с конца', async () => {
      const validBuffer = await fs.promises.readFile(path.join(FIXTURES_DIR, 'valid-standard.osz'));

      for (let cut = 1; cut <= 50; cut++) {
        const truncated = validBuffer.subarray(0, validBuffer.length - cut);
        const truncFile = path.join(tempBaseDir, `trunc_${cut}.osz`);
        const truncOut = path.join(tempBaseDir, `trunc_out_${cut}`);
        await fs.promises.writeFile(truncFile, truncated);

        const handle = await fs.promises.open(truncFile, 'r');
        try {
          const res = await verifyZipFile(handle, truncated.length);
          assert.equal(typeof res, 'boolean');
        } finally {
          await handle.close();
        }

        try {
          await extractZip(truncFile, truncOut);
        } catch (err) {
          assert.ok(err instanceof Error);
        } finally {
          assert.equal(fs.existsSync(truncOut), false, 'Целевая папка не должна создаваться при усеченном архиве');
          await fs.promises.rm(truncFile, { force: true }).catch(() => {});
        }
      }
    });
  });

  describe('Стресс-тестирование заголовков и аномальных значений ZIP64', () => {
    it('отклоняет архив с экстремальным значением totalEntries в ZIP64 (превышение лимита файлов)', async () => {
      // Собираем ZIP64 с аномальным количеством файлов
      const fakeZip64 = buildZip64([{ name: 'file.txt', content: 'test content' }]);

      // Подменяем totalEntries в ZIP64 EOCD на 9999999
      // EOCD64 начинается с 0x06064b50
      const eocd64Idx = fakeZip64.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
      assert.ok(eocd64Idx !== -1);
      fakeZip64.writeBigUInt64LE(9999999n, eocd64Idx + 32);

      const filePath = path.join(tempBaseDir, 'crazy_total_entries.osz');
      const outDir = path.join(tempBaseDir, 'crazy_total_out');
      await fs.promises.writeFile(filePath, fakeZip64);

      await assert.rejects(() => extractZip(filePath, outDir), /превышает лимит/);
      assert.equal(fs.existsSync(outDir), false);

      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    });

    it('отклоняет архив со смещением центрального каталога, выходящим за пределы файла', async () => {
      const zipBuf = buildZip([{ name: 'map.osu', content: 'osu file format v14' }]);

      // В EOCD смещение центрального каталога находится на позиции end - 6 (4 байта)
      const cdOffsetPos = zipBuf.length - 6;
      zipBuf.writeUInt32LE(0x7fffffff, cdOffsetPos); // Огромный оффсет

      const filePath = path.join(tempBaseDir, 'overflow_cd_offset.osz');
      const outDir = path.join(tempBaseDir, 'overflow_cd_out');
      await fs.promises.writeFile(filePath, zipBuf);

      await assert.rejects(() => extractZip(filePath, outDir), /центральный каталог выходит за пределы файла/);
      assert.equal(fs.existsSync(outDir), false);

      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    });

    it('отклоняет архив с некорректным localHeaderOffset в центральном каталоге', async () => {
      const zipBuf = buildZip([{ name: 'map.osu', content: 'osu file format v14', localHeaderOffset: 0x7fffffff }]);

      const filePath = path.join(tempBaseDir, 'bad_lh_offset.osz');
      const outDir = path.join(tempBaseDir, 'bad_lh_out');
      await fs.promises.writeFile(filePath, zipBuf);

      await assert.rejects(() => extractZip(filePath, outDir), /Поврежден локальный заголовок файла в ZIP-архиве/);
      assert.equal(fs.existsSync(outDir), false);

      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    });

    it('verifyZipFile корректно обрабатывает некорректные нечисловые аргументы размера', async () => {
      const fakeHandle = { read: async () => ({ bytesRead: 0 }) };
      // @ts-ignore
      assert.equal(await verifyZipFile(fakeHandle, null), false);
      // @ts-ignore
      assert.equal(await verifyZipFile(fakeHandle, undefined), false);
      // @ts-ignore
      assert.equal(await verifyZipFile(fakeHandle, 'not_a_number'), false);
      assert.equal(await verifyZipFile(fakeHandle, NaN), false);
      assert.equal(await verifyZipFile(fakeHandle, -100), false);
      assert.equal(await verifyZipFile(fakeHandle, Infinity), false);
    });
  });
});
