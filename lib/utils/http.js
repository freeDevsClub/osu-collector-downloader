// @ts-check
"use strict";

const { HttpError } = require('../errors.js');

/**
 * Отправляет клиенту JSON-ответ.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} value
 * @param {Record<string, string>} [headers]
 */
function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

/**
 * Корректно закрывает входящий поток и лежащий под ним сокет
 * после завершения ответа клиенту (или немедленно, если это изолированный поток).
 * @param {import('node:http').IncomingMessage | any} req
 */
function closeStreamOrSocket(req) {
  if (!req) return;
  const res = req.res || req.socket?._httpMessage;
  if (res) {
    const timer = setTimeout(() => {
      if (!req.destroyed && typeof req.destroy === 'function') req.destroy();
      const sock = req.socket || res.socket;
      if (sock && !sock.destroyed && typeof sock.destroy === 'function') sock.destroy();
    }, 1000);
    timer.unref();
  } else if (!req.destroyed && typeof req.destroy === 'function') {
    req.destroy();
  }
}

/**
 * Читает тело HTTP-запроса с лимитом размера и парсит его как JSON.
 * При превышении лимита размера немедленно прекращает чтение (drains / closes stream)
 * и уничтожает поток запроса после отправки ответа 413.
 * @param {import('node:http').IncomingMessage | any} req
 * @param {{ maxBody?: number }} [options]
 * @returns {Promise<any>}
 */
async function readJson(req, { maxBody = 64 * 1024 } = {}) {
  const contentLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBody) {
    if (typeof req.resume === 'function') req.resume();
    closeStreamOrSocket(req);
    throw new HttpError(413, 'Слишком большой запрос.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBody) {
      if (typeof req.resume === 'function') req.resume();
      closeStreamOrSocket(req);
      throw new HttpError(413, 'Слишком большой запрос.');
    }
    chunks.push(buf);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Ожидался JSON-объект в теле запроса.');
  }
  return parsed;
}

module.exports = {
  json,
  closeStreamOrSocket,
  readJson,
};
