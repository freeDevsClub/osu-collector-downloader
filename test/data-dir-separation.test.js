// @ts-check
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { ROOT, getDownloadsDir, getDataDir } = require('../lib/config.js');
const {
  jobs,
  getStateFilePath,
  getLegacyStateFilePath,
  saveStateToDisk,
  loadStateFromDisk,
  waitForPendingSaveState,
} = require('../lib/jobs.js');
const { getSettingsFilePath, getLegacySettingsFilePath, loadSettings, saveSettings } = require('../lib/osu.js');
const { bootstrapServer, resetBootstrap } = require('../server.js');

describe('Разделение каталога загрузок и каталога данных/конфигурации (Data Dir Separation)', () => {
  let tempBaseDir;
  let tempDownloadsDir;
  let tempDataDir;
  let originalDownloadsEnv;
  let originalDataEnv;
  let originalConfigEnv;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-dir-test-'));
    tempDownloadsDir = path.join(tempBaseDir, 'custom-downloads');
    tempDataDir = path.join(tempBaseDir, 'custom-data');

    originalDownloadsEnv = process.env.DOWNLOADS_DIR;
    originalDataEnv = process.env.DATA_DIR;
    originalConfigEnv = process.env.CONFIG_DIR;

    delete process.env.DOWNLOADS_DIR;
    delete process.env.DATA_DIR;
    delete process.env.CONFIG_DIR;

    jobs.clear();
    resetBootstrap();
  });

  afterEach(async () => {
    await waitForPendingSaveState();
    jobs.clear();
    resetBootstrap();

    if (originalDownloadsEnv !== undefined) process.env.DOWNLOADS_DIR = originalDownloadsEnv;
    else delete process.env.DOWNLOADS_DIR;

    if (originalDataEnv !== undefined) process.env.DATA_DIR = originalDataEnv;
    else delete process.env.DATA_DIR;

    if (originalConfigEnv !== undefined) process.env.CONFIG_DIR = originalConfigEnv;
    else delete process.env.CONFIG_DIR;

    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('getDataDir возвращает <ROOT>/data по умолчанию при отсутствии переменных окружения', () => {
    assert.equal(getDataDir(), path.join(ROOT, 'data'));
    assert.equal(getDownloadsDir(), path.join(ROOT, 'downloads'));
  });

  it('getDataDir учитывает DATA_DIR и CONFIG_DIR с приоритетом DATA_DIR', () => {
    process.env.CONFIG_DIR = path.join(tempBaseDir, 'from-config-dir');
    assert.equal(getDataDir(), path.resolve(path.join(tempBaseDir, 'from-config-dir')));

    process.env.DATA_DIR = path.join(tempBaseDir, 'from-data-dir');
    assert.equal(getDataDir(), path.resolve(path.join(tempBaseDir, 'from-data-dir')));
  });

  it('переопределение DOWNLOADS_DIR не меняет путь к .state.json и .settings.json', () => {
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    // DATA_DIR не переопределён — остаётся дефолтным в ROOT/data
    assert.equal(getDownloadsDir(), tempDownloadsDir);
    assert.equal(getDataDir(), path.join(ROOT, 'data'));
    assert.equal(getStateFilePath(), path.join(ROOT, 'data', '.state.json'));
    assert.equal(getSettingsFilePath(), path.join(ROOT, 'data', '.settings.json'));
    assert.equal(getLegacyStateFilePath(), path.join(tempDownloadsDir, '.state.json'));
    assert.equal(getLegacySettingsFilePath(), path.join(tempDownloadsDir, '.settings.json'));
  });

  it('переопределение DATA_DIR изолирует пути конфигурации и не влияет на DOWNLOADS_DIR', () => {
    process.env.DATA_DIR = tempDataDir;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    assert.equal(getDownloadsDir(), tempDownloadsDir);
    assert.equal(getDataDir(), tempDataDir);
    assert.equal(getStateFilePath(), path.join(tempDataDir, '.state.json'));
    assert.equal(getSettingsFilePath(), path.join(tempDataDir, '.settings.json'));
  });

  it('saveStateToDisk сохраняет файл .state.json в DATA_DIR, а не в DOWNLOADS_DIR', async () => {
    process.env.DATA_DIR = tempDataDir;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    await fs.mkdir(tempDataDir, { recursive: true });
    await fs.mkdir(tempDownloadsDir, { recursive: true });

    jobs.set('test_sep_job', {
      id: 'test_sep_job',
      method: 'mirror',
      setIds: [1001],
      doneIds: new Set([1001]),
      skipIds: new Set(),
      errIds: new Set(),
      errorsById: new Map(),
      extraFailures: 0,
      mapsById: new Map([[1001, { id: 1001, label: 'Artist - Title' }]]),
      status: 'finished',
      message: 'Готово',
      createdAt: Date.now(),
    });

    await saveStateToDisk();

    const expectedState = path.join(tempDataDir, '.state.json');
    const unexpectedState = path.join(tempDownloadsDir, '.state.json');

    const stateExistsInData = await fs
      .access(expectedState)
      .then(() => true)
      .catch(() => false);
    const stateExistsInDownloads = await fs
      .access(unexpectedState)
      .then(() => true)
      .catch(() => false);

    assert.equal(stateExistsInData, true, 'Файл .state.json должен быть сохранён в DATA_DIR');
    assert.equal(stateExistsInDownloads, false, 'Файл .state.json НЕ должен создаваться в DOWNLOADS_DIR');
  });

  it('saveSettings сохраняет файл .settings.json в DATA_DIR, а не в DOWNLOADS_DIR', async () => {
    process.env.DATA_DIR = tempDataDir;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    await fs.mkdir(tempDataDir, { recursive: true });
    await fs.mkdir(tempDownloadsDir, { recursive: true });

    await saveSettings({ checkExisting: false, postDownloadAction: 'copy' });

    const expectedSettings = path.join(tempDataDir, '.settings.json');
    const unexpectedSettings = path.join(tempDownloadsDir, '.settings.json');

    const existsInData = await fs
      .access(expectedSettings)
      .then(() => true)
      .catch(() => false);
    const existsInDownloads = await fs
      .access(unexpectedSettings)
      .then(() => true)
      .catch(() => false);

    assert.equal(existsInData, true, 'Файл .settings.json должен быть сохранён в DATA_DIR');
    assert.equal(existsInDownloads, false, 'Файл .settings.json НЕ должен создаваться в DOWNLOADS_DIR');
  });

  it('loadStateFromDisk восстанавливает задачи из legacy-файла в DOWNLOADS_DIR, если в DATA_DIR файл отсутствует', async () => {
    process.env.DATA_DIR = tempDataDir;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    await fs.mkdir(tempDownloadsDir, { recursive: true });
    await fs.mkdir(tempDataDir, { recursive: true });

    const legacyStateFile = path.join(tempDownloadsDir, '.state.json');
    const legacyPayload = {
      version: 1,
      savedAt: Date.now(),
      jobs: [
        {
          id: 'job_legacy_restore',
          method: 'mirror',
          setIds: [5555],
          doneIds: [5555],
          skipIds: [],
          errIds: [],
          errors: [],
          status: 'finished',
          message: 'Завершено (из legacy)',
          createdAt: Date.now() - 10000,
        },
      ],
    };
    await fs.writeFile(legacyStateFile, JSON.stringify(legacyPayload), 'utf8');

    // В DATA_DIR файла пока нет:
    const dataStateFile = path.join(tempDataDir, '.state.json');
    assert.equal(
      await fs
        .access(dataStateFile)
        .then(() => true)
        .catch(() => false),
      false,
    );

    const restored = await loadStateFromDisk();
    assert.equal(restored, true, 'loadStateFromDisk должен успешно восстановить задачи из legacy-файла');
    assert.equal(jobs.has('job_legacy_restore'), true);
    assert.equal(jobs.get('job_legacy_restore')?.status, 'finished');

    // При последующем сохранении пишется уже в DATA_DIR:
    await saveStateToDisk();
    assert.equal(
      await fs
        .access(dataStateFile)
        .then(() => true)
        .catch(() => false),
      true,
    );
  });

  it('loadSettings восстанавливает настройки из legacy-файла в DOWNLOADS_DIR, если в DATA_DIR файл отсутствует', async () => {
    process.env.DATA_DIR = tempDataDir;
    process.env.DOWNLOADS_DIR = tempDownloadsDir;

    await fs.mkdir(tempDownloadsDir, { recursive: true });
    await fs.mkdir(tempDataDir, { recursive: true });

    const legacySettingsFile = path.join(tempDownloadsDir, '.settings.json');
    const legacyConfig = {
      checkExisting: false,
      postDownloadAction: 'extract',
    };
    await fs.writeFile(legacySettingsFile, JSON.stringify(legacyConfig), 'utf8');

    // В DATA_DIR файла нет:
    const dataSettingsFile = path.join(tempDataDir, '.settings.json');
    assert.equal(
      await fs
        .access(dataSettingsFile)
        .then(() => true)
        .catch(() => false),
      false,
    );

    const loaded = loadSettings();
    assert.equal(loaded.checkExisting, false);
    assert.equal(loaded.postDownloadAction, 'extract');

    // При последующем сохранении пишется уже в DATA_DIR:
    await saveSettings({ postDownloadAction: 'move' });
    assert.equal(
      await fs
        .access(dataSettingsFile)
        .then(() => true)
        .catch(() => false),
      true,
    );
  });

  it('bootstrapServer создаёт обе директории (DATA_DIR и DOWNLOADS_DIR) при запуске', async () => {
    process.env.DATA_DIR = path.join(tempBaseDir, 'bootstrap-data');
    process.env.DOWNLOADS_DIR = path.join(tempBaseDir, 'bootstrap-downloads');

    await bootstrapServer();

    const dataDirStat = await fs.stat(process.env.DATA_DIR);
    const downloadsDirStat = await fs.stat(process.env.DOWNLOADS_DIR);

    assert.equal(dataDirStat.isDirectory(), true);
    assert.equal(downloadsDirStat.isDirectory(), true);
  });
});
