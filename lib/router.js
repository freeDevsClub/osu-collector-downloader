// @ts-check
"use strict";

const { json } = require('./config.js');
const { handleMethodNotAllowed } = require('./routes/helpers.js');

/**
 * @callback RouteHandler
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {Record<string, string>} [params]
 * @returns {Promise<any> | any}
 */

/**
 * @typedef {Object} PatternRoute
 * @property {RegExp} regex
 * @property {string[]} paramNames
 * @property {RouteHandler} handler
 */

/**
 * Легковесный производительный маршрутизатор запросов API.
 * Поддерживает $O(1)$ сопоставление для статических маршрутов
 * и упорядоченное регулярное сопоставление для параметризованных маршрутов.
 */
class Router {
  constructor() {
    /** @type {Map<string, RouteHandler>} */
    this.staticRoutes = new Map();
    /** @type {PatternRoute[]} */
    this.patternRoutes = [];
  }

  /**
   * Регистрирует статический маршрут с точным совпадением пути.
   * @param {string} pathname
   * @param {RouteHandler} handler
   * @returns {this}
   */
  exact(pathname, handler) {
    this.staticRoutes.set(pathname, handler);
    return this;
  }

  /**
   * Регистрирует маршрут с параметрами пути (например, '/api/collections/:id').
   * @param {string | RegExp} pattern
   * @param {RouteHandler} handler
   * @returns {this}
   */
  pattern(pattern, handler) {
    if (pattern instanceof RegExp) {
      this.patternRoutes.push({
        regex: pattern,
        paramNames: [],
        handler,
      });
      return this;
    }

    const paramNames = [];
    const regexSource = pattern
      .replace(/\/+/g, '/')
      .replace(/:([a-zA-Z0-9_]+)/g, (_, paramName) => {
        paramNames.push(paramName);
        return '([a-zA-Z0-9_\\-]+)';
      });

    this.patternRoutes.push({
      regex: new RegExp(`^${regexSource}$`),
      paramNames,
      handler,
    });
    return this;
  }

  /**
   * Обрабатывает входящий API-запрос, находя соответствующий маршрут.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<any>}
   */
  async handle(req, res, url) {
    const pathname = url.pathname;

    // 1. Быстрый O(1) поиск по точным статическим маршрутам:
    const staticHandler = this.staticRoutes.get(pathname);
    if (staticHandler) {
      return await staticHandler(req, res, url, {});
    }

    // 2. Поиск по параметризованным маршрутам:
    for (const route of this.patternRoutes) {
      const match = pathname.match(route.regex);
      if (match) {
        /** @type {Record<string, string>} */
        const params = {};
        if (route.paramNames.length > 0) {
          route.paramNames.forEach((name, idx) => {
            params[name] = match[idx + 1];
          });
        } else {
          for (let i = 1; i < match.length; i++) {
            params[`param${i}`] = match[i];
          }
        }
        return await route.handler(req, res, url, params);
      }
    }

    // 3. Маршрут не найден:
    return json(res, 404, { error: 'API-маршрут не найден.' });
  }
}

module.exports = {
  Router,
};

