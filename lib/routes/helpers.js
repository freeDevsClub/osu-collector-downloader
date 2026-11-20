// @ts-check
"use strict";

const { MAX_BODY, HttpError, json } = require('../config.js');

/**
 * Корректно закрывает входящий поток и лежащий под ним сокет
 * после завершения ответа клиенту (или немедленно, если это изолированный поток).
 * @param {import('node:http').IncomingMessage | any} req
 */
function closeStreamOrSocket(req) {
  if (!req) return;
  const res = req.res || req.socket?._httpMessage;
  if (res) {
    // В HTTP с Connection: close Node.js закрывает сокет при завершении res.end().
    // Страховочный таймер обеспечивает принудительный разрыв сокета, если клиент завис или флудит.
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
async function readJson(req, { maxBody = MAX_BODY } = {}) {
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
      'Allow': allowHeader,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  return json(res, 405, { error: 'Метод не поддерживается.' }, { 'Allow': allowHeader });
}

module.exports = {
  closeStreamOrSocket,
  readJson,
  handleMethodNotAllowed,
};

