// @ts-check
"use strict";

const { json, log, HttpError } = require('../config.js');
const { safeErrorMessage } = require('../security.js');
const { readJson, handleMethodNotAllowed } = require('./helpers.js');
const {
  getSettings: getOsuSettings,
  saveSettings: saveOsuSettings,
  getCachedOsuSongsAsync,
  classifyCollectionSets,
  selectFolderDialog,
} = require('../osu.js');

/**
 * Обработчик GET / POST /api/osu/settings.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleOsuSettings(req, res, url) {
  if (req.method === 'GET') {
    return json(res, 200, getOsuSettings());
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    try {
      const updated = await saveOsuSettings(body);
      return json(res, 200, updated);
    } catch (err) {
      return json(res, 400, { error: safeErrorMessage(err) });
    }
  }
  return handleMethodNotAllowed(req, res, ['GET', 'POST']);
}

/**
 * Обработчик POST /api/osu/rescan.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleOsuRescan(req, res, url) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const settings = getOsuSettings();
  if (!settings.valid || !settings.songsDir) {
    return json(res, 400, { error: 'Директория Songs не настроена или недоступна.' });
  }
  const songs = await getCachedOsuSongsAsync(settings.songsDir, true);
  settings.songsCount = songs.size;
  return json(res, 200, { count: songs.size, songsCount: songs.size });
}

/**
 * Обработчик POST /api/osu/check.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleOsuCheck(req, res, url) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const body = await readJson(req);
  const setIds = Array.isArray(body?.setIds) ? body.setIds : [];
  const classification = classifyCollectionSets(setIds);
  return json(res, 200, classification);
}

/**
 * Обработчик GET / POST /api/osu/browse.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleOsuBrowse(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return handleMethodNotAllowed(req, res, ['GET', 'POST']);
  }
  let initialPath = '';
  if (req.method === 'POST') {
    const body = await readJson(req).catch(err => {
      if (err instanceof HttpError && err.status === 413) throw err;
      return {};
    });
    initialPath = typeof body?.initialPath === 'string' ? body.initialPath : '';
  } else {
    initialPath = url.searchParams.get('initialPath') || '';
  }
  try {
    const selected = await selectFolderDialog(initialPath);
    return json(res, 200, { path: selected, cancelled: !selected });
  } catch (err) {
    log('warn', 'osu.browse.failed', { error: safeErrorMessage(err) });
    return json(res, 500, { error: safeErrorMessage(err) });
  }
}

/**
 * Регистрирует маршруты интеграции osu! в роутере.
 * @param {import('../router.js').Router} router
 */
function registerOsuRoutes(router) {
  router.exact('/api/osu/settings', handleOsuSettings);
  router.exact('/api/osu/rescan', handleOsuRescan);
  router.exact('/api/osu/check', handleOsuCheck);
  router.exact('/api/osu/browse', handleOsuBrowse);
}

module.exports = {
  handleOsuSettings,
  handleOsuRescan,
  handleOsuCheck,
  handleOsuBrowse,
  registerOsuRoutes,
};

