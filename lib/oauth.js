// @ts-check
"use strict";

const crypto = require('node:crypto');
const {
  CALLBACK_URL,
  ENABLE_OAUTH,
  isOAuthEnabled,
  HttpError,
  log,
  OAUTH_AUTHORIZE_ENDPOINT,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  OAUTH_TOKEN_ENDPOINT,
  tokenCookie,
  USER_AGENT,
} = require('./config.js');
const {
  addRedaction,
  removeRedaction,
  parseCookies,
  safeErrorMessage,
} = require('./security.js');

const sessions = new Map();
const oauthConfig = { clientId: null, clientSecret: null };
const oauthToken = { accessToken: null, refreshToken: null, expiresAt: 0, scope: null, kind: null };
const oauthStates = new Map();

function cookieOptions(req, maxAge) {
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function setTokenCookie(res, req, token) {
  res.setHeader('Set-Cookie', `${tokenCookie}=${token}; ${cookieOptions(req, 60 * 60 * 6)}`);
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[tokenCookie];
  const entry = token ? sessions.get(token) : null;
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return entry.value;
}

function oauthConfigured() {
  return Boolean(oauthConfig.clientId && oauthConfig.clientSecret);
}

function buildAuthorizeUrl(state = '') {
  const url = new URL(OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', String(oauthConfig.clientId));
  url.searchParams.set('redirect_uri', CALLBACK_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'public identify');
  if (state) url.searchParams.set('state', state);
  return url.href;
}

function oauthStatus() {
  const connected = Boolean((oauthToken.accessToken && oauthToken.expiresAt > Date.now()) || oauthToken.refreshToken);
  return {
    configured: oauthConfigured(),
    connected,
    kind: oauthToken.kind,
    scope: oauthToken.scope,
    expiresAt: connected ? oauthToken.expiresAt : null,
    clientId: oauthConfig.clientId,
    callbackUrl: CALLBACK_URL,
    authorizeUrl: oauthConfigured() ? buildAuthorizeUrl() : null,
  };
}

function clientIdPayload() {
  const numeric = Number(oauthConfig.clientId);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : oauthConfig.clientId;
}

function storeOsuToken(data, kind) {
  const oldAccess = oauthToken.accessToken;
  const oldRefresh = oauthToken.refreshToken;
  if (oldAccess && oldAccess !== data.access_token) {
    removeRedaction(oldAccess);
  }
  if (oldRefresh && data.refresh_token && oldRefresh !== data.refresh_token) {
    removeRedaction(oldRefresh);
  }
  const expiresInSeconds = Number(data.expires_in);
  oauthToken.accessToken = data.access_token;
  oauthToken.refreshToken = data.refresh_token || oauthToken.refreshToken || null;
  oauthToken.scope = typeof data.scope === 'string' ? data.scope : null;
  oauthToken.kind = kind;
  oauthToken.expiresAt = Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600) * 1000;
  addRedaction(oauthToken.accessToken);
  addRedaction(oauthToken.refreshToken);
}

async function postOsuToken(payload, event, kind) {
  const startedAt = Date.now();
  const form = new URLSearchParams({
    client_id: String(clientIdPayload()),
    client_secret: oauthConfig.clientSecret,
    ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)),
  });
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = (data.error_description || data.error || raw.replace(/\s+/g, ' ').slice(0, 200) || `HTTP ${response.status}`).slice(0, 300);
    const safeDetail = safeErrorMessage(detail);
    log('error', event, { grant: payload.grant_type, status: response.status, durationMs: Date.now() - startedAt, detail: safeDetail });
    const err = /** @type {any} */ (new HttpError(response.status === 400 || response.status === 401 ? 502 : response.status, `osu! отклонил запрос токена (HTTP ${response.status}): ${safeDetail}`));
    err.status = response.status;
    err.upstreamStatus = response.status;
    err.oauthError = data.error || null;
    throw err;
  }
  if (!data.access_token) {
    log('error', event, { grant: payload.grant_type, durationMs: Date.now() - startedAt, detail: 'no access_token in response' });
    throw new HttpError(502, 'osu! вернул ответ без access_token.');
  }
  storeOsuToken(data, kind);
  log('info', event, {
    grant: payload.grant_type,
    scope: oauthToken.scope,
    expiresInSeconds: Math.round((oauthToken.expiresAt - Date.now()) / 1000),
    hasRefreshToken: Boolean(oauthToken.refreshToken),
    durationMs: Date.now() - startedAt,
  });
  return oauthToken;
}

let oauthTokenSync = null;

async function ensureOsuToken() {
  if (!oauthConfigured()) throw new HttpError(400, 'OAuth-приложение не настроено: укажите Client ID и Client Secret.');
  if (oauthToken.accessToken && oauthToken.expiresAt > Date.now() + 5000) return oauthToken.accessToken;
  if (oauthTokenSync) return oauthTokenSync;

  if (!oauthToken.refreshToken) throw new HttpError(401, 'OAuth-токен истёк или ещё не получен — авторизуйтесь через osu! заново.');

  oauthTokenSync = (async () => {
    try {
      await postOsuToken({ grant_type: 'refresh_token', refresh_token: oauthToken.refreshToken, scope: oauthToken.scope || 'public identify' }, 'oauth.token.refreshed', oauthToken.kind);
      return oauthToken.accessToken;
    } catch (error) {
      const err = /** @type {any} */ (error);
      const status = err?.upstreamStatus ?? err?.status ?? (err instanceof HttpError ? err.httpStatus : null);
      const isInvalidGrant = err?.oauthError === 'invalid_grant' || /invalid_grant/i.test(err?.message || '');
      const permanent = (typeof status === 'number' && status >= 400 && status < 500) || isInvalidGrant;
      if (permanent) {
        removeRedaction(oauthToken.accessToken);
        removeRedaction(oauthToken.refreshToken);
        oauthToken.accessToken = null;
        oauthToken.refreshToken = null;
        oauthToken.expiresAt = 0;
        oauthToken.kind = null;
        oauthToken.scope = null;
      }
      log('warn', 'oauth.token.refresh_failed', { error: safeErrorMessage(error), permanent, upstreamStatus: err?.upstreamStatus || null });
      throw new HttpError(permanent ? 401 : 503, permanent
        ? 'Не удалось обновить OAuth-токен — войдите через osu! повторно.'
        : `osu! недоступен при обновлении OAuth-токена — попробуйте позже. ${safeErrorMessage(error)}`);
    } finally {
      oauthTokenSync = null;
    }
  })();
  return oauthTokenSync;
}

async function handleOauthCallback(req, res, url) {
  if (!isOAuthEnabled()) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'OAuth-авторизация отключена (запустите сервер с ENABLE_OAUTH=1).' }));
  }
  const finish = (query, status = 302) => {
    res.writeHead(status, { Location: `/?${query}`, 'Cache-Control': 'no-store' });
    res.end();
  };
  const fail = reason => {
    log('warn', 'oauth.callback.failed', { reason: safeErrorMessage(reason) });
    finish(`oauth_error=${encodeURIComponent(safeErrorMessage(reason))}`);
  };

  const providerError = url.searchParams.get('error');
  if (providerError) return fail(url.searchParams.get('error_description') || providerError);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail('В ответе osu! нет code или state.');
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) return fail('Некорректный или просроченный параметр state — повторите вход.');

  const cookies = parseCookies(req.headers.cookie);
  const clientNonce = cookies[OAUTH_STATE_COOKIE];
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=0`);
  if (!clientNonce || clientNonce !== entry.nonce) {
    return fail('Несовпадение сессии OAuth (защита от CSRF) — повторите вход из того же браузера.');
  }

  if (!oauthConfigured()) return fail('OAuth-приложение больше не настроено.');

  try {
    await postOsuToken({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL }, 'oauth.token.issued', 'authorization_code');
    finish('oauth=connected');
  } catch (error) {
    fail(/** @type {any} */ (error).message);
  }
}

function pruneSessionsAndOauth() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      if (session?.value) removeRedaction(session.value);
      sessions.delete(token);
    }
  }
  for (const [state, entry] of oauthStates) {
    if (entry?.expiresAt <= now) oauthStates.delete(state);
  }
  if (oauthToken.accessToken && oauthToken.expiresAt <= now && !oauthToken.refreshToken) {
    removeRedaction(oauthToken.accessToken);
    oauthToken.accessToken = null;
    oauthToken.expiresAt = 0;
    oauthToken.kind = null;
    oauthToken.scope = null;
  }
}

module.exports = {
  sessions,
  oauthConfig,
  oauthToken,
  oauthStates,
  cookieOptions,
  setTokenCookie,
  getSession,
  oauthConfigured,
  buildAuthorizeUrl,
  oauthStatus,
  storeOsuToken,
  postOsuToken,
  ensureOsuToken,
  handleOauthCallback,
  pruneSessionsAndOauth,
};
