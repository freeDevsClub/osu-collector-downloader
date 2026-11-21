// @ts-check
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resetSettingsForTest, invalidateCachedSongs } = require('../../lib/osu.js');
const { invalidateCachedDownloads } = require('../../lib/downloader.js');
const { jobs, setActiveJob, clearSaveStateTimer, waitForPendingSaveState } = require('../../lib/jobs.js');

/**
 * @typedef {Object} IsolatedTestEnv
 * @property {string} tempBaseDir
 * @property {string} tempDownloadsDir
 * @property {string} tempDataDir
 * @property {() => Promise<void>} cleanup
 */

/**
 * Создает изолированное временное окружение для тестов:
 * - Выделяет временные папки для DOWNLOADS_DIR и DATA_DIR
 * - Удаляет CONFIG_DIR
 * - Сбрасывает in-memory кэши (osu settings, cached songs, downloads cache, active jobs, timers)
 * - Гарантированно восстанавливает оригинальные переменные окружения в cleanup()
 *
 * @param {string} [prefix='test-env-']
 * @returns {Promise<IsolatedTestEnv>}
 */
async function setupIsolatedTestEnv(prefix = 'test-env-') {
  const tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const tempDownloadsDir = path.join(tempBaseDir, 'downloads');
  const tempDataDir = path.join(tempBaseDir, 'data');

  await fs.mkdir(tempDownloadsDir, { recursive: true });
  await fs.mkdir(tempDataDir, { recursive: true });

  const prevDownloads = process.env.DOWNLOADS_DIR;
  const prevData = process.env.DATA_DIR;
  const prevConfig = process.env.CONFIG_DIR;

  process.env.DOWNLOADS_DIR = tempDownloadsDir;
  process.env.DATA_DIR = tempDataDir;
  delete process.env.CONFIG_DIR;

  resetSettingsForTest();
  invalidateCachedSongs();
  invalidateCachedDownloads();

  return {
    tempBaseDir,
    tempDownloadsDir,
    tempDataDir,
    async cleanup() {
      await waitForPendingSaveState();
      clearSaveStateTimer();
      jobs.clear();
      setActiveJob(null);
      resetSettingsForTest();
      invalidateCachedSongs();
      invalidateCachedDownloads();

      if (prevDownloads !== undefined) {
        process.env.DOWNLOADS_DIR = prevDownloads;
      } else {
        delete process.env.DOWNLOADS_DIR;
      }

      if (prevData !== undefined) {
        process.env.DATA_DIR = prevData;
      } else {
        delete process.env.DATA_DIR;
      }

      if (prevConfig !== undefined) {
        process.env.CONFIG_DIR = prevConfig;
      } else {
        delete process.env.CONFIG_DIR;
      }

      try {
        await fs.rm(tempBaseDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

module.exports = {
  setupIsolatedTestEnv,
};

