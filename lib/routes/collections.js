// @ts-check
"use strict";

const { json } = require('../config.js');
const { readJson, handleMethodNotAllowed } = require('./helpers.js');
const { extractCollectionId, fetchCollection } = require('../collector.js');
const osu = require('../osu.js');

/**
 * Обработчик POST /api/collections (получение метаданных коллекции по URL).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleCreateCollection(req, res, url) {
  if (req.method !== 'POST') return handleMethodNotAllowed(req, res, ['POST']);
  const body = await readJson(req);
  const collectionId = extractCollectionId(body?.url);
  const data = await fetchCollection(collectionId);
  const { installedSetIds, downloadedSetIds } = osu.classifyCollectionSets(data.setIds);
  return json(res, 200, {
    id: data.id,
    name: data.name,
    uploader: data.uploader,
    count: data.count,
    beatmapCount: data.beatmapCount,
    maps: data.maps,
    setIds: data.setIds,
    metadataComplete: Boolean(data.metadataComplete),
    metadataDegraded: Boolean(data.metadataDegraded),
    metadataProgress: Number(data.metadataProgress || 0),
    installedSetIds,
    downloadedSetIds,
  });
}

/**
 * Обработчик GET /api/collections/:id (поллинг и пагинация метаданных).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ id?: string }} [params]
 */
async function handleGetCollection(req, res, url, params) {
  if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
  const collectionId = params?.id;
  if (!collectionId) return json(res, 400, { error: 'Не указан идентификатор коллекции.' });

  const data = await fetchCollection(collectionId);

  const isPoll = url.searchParams.get('poll') === '1' || url.searchParams.get('poll') === 'true';
  const hasSince = url.searchParams.has('since');
  const isStatusOnly = url.searchParams.get('statusOnly') === '1' || url.searchParams.get('statusOnly') === 'true';
  const skipClassify = isPoll || hasSince || isStatusOnly || url.searchParams.get('classify') === '0';

  if (isStatusOnly) {
    return json(res, 200, {
      id: data.id,
      name: data.name,
      count: data.count,
      beatmapCount: data.beatmapCount,
      metadataComplete: Boolean(data.metadataComplete),
      metadataDegraded: Boolean(data.metadataDegraded),
      metadataProgress: Number(data.metadataProgress || 0),
    });
  }

  let maps = data.maps;
  let offset = 0;

  if (hasSince) {
    const sinceParam = Number(url.searchParams.get('since'));
    const since = Number.isSafeInteger(sinceParam) && sinceParam >= 0 ? sinceParam : 0;
    const progress = Number(data.metadataProgress || 0);
    offset = since;
    if (since >= progress) {
      maps = [];
    } else {
      maps = data.maps.slice(since, progress);
    }
  }

  if (skipClassify) {
    return json(res, 200, {
      id: data.id,
      name: data.name,
      uploader: data.uploader,
      count: data.count,
      beatmapCount: data.beatmapCount,
      maps,
      offset,
      setIds: hasSince ? [] : data.setIds,
      metadataComplete: Boolean(data.metadataComplete),
      metadataDegraded: Boolean(data.metadataDegraded),
      metadataProgress: Number(data.metadataProgress || 0),
    });
  }

  const { installedSetIds, downloadedSetIds } = osu.classifyCollectionSets(data.setIds);
  return json(res, 200, {
    id: data.id,
    name: data.name,
    uploader: data.uploader,
    count: data.count,
    beatmapCount: data.beatmapCount,
    maps,
    offset,
    setIds: data.setIds,
    metadataComplete: Boolean(data.metadataComplete),
    metadataDegraded: Boolean(data.metadataDegraded),
    metadataProgress: Number(data.metadataProgress || 0),
    installedSetIds,
    downloadedSetIds,
  });
}

/**
 * Регистрирует маршруты коллекций в роутере.
 * @param {import('../router.js').Router} router
 */
function registerCollectionRoutes(router) {
  router.exact('/api/collections', handleCreateCollection);
  router.pattern('/api/collections/:id', handleGetCollection);
}

module.exports = {
  handleCreateCollection,
  handleGetCollection,
  registerCollectionRoutes,
};
