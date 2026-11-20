// @ts-check
"use strict";

const { Router } = require('../router.js');
const { registerOsuRoutes } = require('./osu.js');
const { registerSessionRoutes } = require('./session.js');
const { registerCollectionRoutes } = require('./collections.js');
const { registerDownloadRoutes } = require('./downloads.js');
const helpers = require('./helpers.js');

/**
 * Инициализирует и настраивает центральный маршрутизатор приложения.
 * @returns {Router}
 */
function createApiRouter() {
  const router = new Router();

  // Регистрация модульных контроллеров:
  registerOsuRoutes(router);
  registerSessionRoutes(router);
  registerCollectionRoutes(router);
  registerDownloadRoutes(router);

  return router;
}

const apiRouter = createApiRouter();

/**
 * Диспетчер API-запросов.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<any>}
 */
function handleApi(req, res, url) {
  return apiRouter.handle(req, res, url);
}

module.exports = {
  Router,
  createApiRouter,
  apiRouter,
  handleApi,
  ...helpers,
};

