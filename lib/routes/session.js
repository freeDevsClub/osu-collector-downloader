// @ts-check
"use strict";

const crypto = require('node:crypto');
const { json, log } = require('../config.js');
const { MIRRORS, mirrorCooldownRemaining } = require('../mirrors.js');
const {
  sessions,
  getSession,
  setTokenCookie,
  cookieOptions,
  parseCookies,
  addRedaction,
  removeRedaction,
} = require('../security.js');
const { readJson, handleMethodNotAllowed } = require('./helpers.js');

/**
 * Обработчик GET /api/mirrors.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleMirrors(req, res, url) {
  if (req.method !== 'GET') return handleMethodNotAllowed(req, res, ['GET']);
  return json(res, 200, {
    mirrors: MIRRORS.map(mirror => ({ id: mirror.id, label: mirror.label, cooldownMs: mirrorCooldownRemaining(mirror) })),
  });
}

/**
 * Обработчик GET / POST / DELETE /api/session.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleSession(req, res, url) {
  if (req.method === 'GET') {
    return json(res, 200, { connected: Boolean(getSession(req)) });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    let session = typeof body?.session === 'string' ? body.session.trim() : '';
    if (session.toLowerCase().startsWith('osu_session=')) {
      session = session.slice('osu_session='.length).trim();
    }
    if (session.length < 20 || session.length > 1024 || !/^[a-zA-Z0-9%_\-\.=/+|]+$/.test(session)) {
      return json(res, 400, {
        error: 'Некорректный формат cookie osu_session. Ожидается токен сессии osu.ppy.sh (без пробелов и спецсимволов).'
      });
    }
    const cookies = parseCookies(req.headers.cookie);
    const existingToken = cookies['osu_collector_token'];
    if (existingToken) {
      const existing = sessions.get(existingToken);
      if (existing) {
        removeRedaction(existing.value);
        sessions.delete(existingToken);
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { value: session, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    addRedaction(session);
    log('info', 'session.saved');
    setTokenCookie(res, req, token);
    return json(res, 200, { connected: true });
  }

  if (req.method === 'DELETE') {
    const token = parseCookies(req.headers.cookie)['osu_collector_token'];
    if (token) {
      const entry = sessions.get(token);
      if (entry) removeRedaction(entry.value);
      sessions.delete(token);
    }
    log('info', 'session.cleared', { hadSession: Boolean(token) });
    res.setHeader('Set-Cookie', `osu_collector_token=; ${cookieOptions(req, 0)}`);
    return json(res, 200, { connected: false });
  }

  return handleMethodNotAllowed(req, res, ['GET', 'POST', 'DELETE']);
}

/**
 * Регистрирует маршруты сессий и зеркал в роутере.
 * @param {import('../router.js').Router} router
 */
function registerSessionRoutes(router) {
  router.exact('/api/mirrors', handleMirrors);
  router.exact('/api/session', handleSession);
}

module.exports = {
  handleMirrors,
  handleSession,
  registerSessionRoutes,
};

