// @ts-check
'use strict';

const { readJson, closeStreamOrSocket, json } = require('../utils/http.js');

/**
 * Отправляет ответ 405 Method Not Allowed с заголовком Allow.
 * Для запросов OPTIONS возвращает 204 No Content со списком поддерживаемых методов.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} allowed
 */
function handleMethodNotAllowed(req, res, allowed) {
  const allowHeader = allowed.join(', ');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      Allow: allowHeader,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  return json(res, 405, { error: 'Метод не поддерживается.' }, { Allow: allowHeader });
}

module.exports = {
  closeStreamOrSocket,
  readJson,
  handleMethodNotAllowed,
};
