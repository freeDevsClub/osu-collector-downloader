// @ts-check
'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const { HOST, PORT, json, tokenCookie, localApiTokenCookie, isTestEnv } = require('./config.js');

const sessions = new Map();

/**
 * Генерирует параметры заголовка Set-Cookie для сессионного токена.
 * Локальное приложение работает по HTTP на 127.0.0.1 без HTTPS,
 * поэтому флаг Secure не выставляется во избежание DoS на cookie сессии через поддельный x-forwarded-proto.
 * @param {any} [req]
 * @param {number} [maxAge]
 * @returns {string}
 */
function cookieOptions(req, maxAge) {
  const resolvedMaxAge = typeof req === 'number' ? req : (maxAge ?? 0);
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${resolvedMaxAge}`;
}

/**
 * Устанавливает куки сессионного токена в ответе.
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 */
function setTokenCookie(res, req, token) {
  res.setHeader('Set-Cookie', `${tokenCookie}=${token}; ${cookieOptions(req, 60 * 60 * 6)}`);
}

/**
 * Извлекает значение osu_session из активной сессии запроса.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
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

/**
 * Удаляет истёкшие сессии и очищает их секреты из activeRedactions.
 */
function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      if (session?.value) removeRedaction(session.value);
      sessions.delete(token);
    }
  }
}

/** @type {Map<string, number>} */
const activeRedactions = new Map();

let localApiToken = process.env.API_TOKEN || crypto.randomBytes(24).toString('hex');
let apiTokenRequired = !isTestEnv;
let initialCookieGranted = false;
let serverStartedAt = Date.now();
const INITIAL_COOKIE_WINDOW_MS = Math.max(0, Number(process.env.INITIAL_COOKIE_WINDOW_MS ?? 60_000));

addRedaction(localApiToken);

/**
 * Возвращает текущий локальный токен аутентификации API.
 * @returns {string}
 */
function getApiToken() {
  return localApiToken;
}

/**
 * Устанавливает кастомный локальный токен API (например, для тестов).
 * @param {string} token
 */
function setApiToken(token) {
  if (typeof token === 'string' && token.length > 0) {
    if (localApiToken) removeRedaction(localApiToken);
    localApiToken = token;
    addRedaction(localApiToken);
  }
}

/**
 * Генерирует новый случайный локальный токен API и сбрасывает статус выдачи куки.
 * @returns {string}
 */
function resetApiToken() {
  if (localApiToken) removeRedaction(localApiToken);
  localApiToken = process.env.API_TOKEN || crypto.randomBytes(24).toString('hex');
  addRedaction(localApiToken);
  initialCookieGranted = false;
  serverStartedAt = Date.now();
  return localApiToken;
}

/**
 * Проверяет, требуется ли аутентификация по токену для изменяющих запросов.
 * @returns {boolean}
 */
function isApiTokenRequired() {
  if (process.env.DISABLE_API_TOKEN === '1') return false;
  if (process.env.REQUIRE_API_TOKEN === '1') return true;
  return apiTokenRequired;
}

/**
 * Включает или выключает требование токена API для изменяющих запросов.
 * @param {boolean} required
 */
function setApiTokenRequired(required) {
  apiTokenRequired = Boolean(required);
}

/**
 * Проверяет, была ли уже выдана одноразовая сессионная cookie клиенту.
 * Считается выданной, если уже зафиксирована выдача либо истекло окно ожидания первого запуска.
 * @returns {boolean}
 */
function isInitialCookieGranted() {
  if (initialCookieGranted) return true;
  if (Date.now() - serverStartedAt > INITIAL_COOKIE_WINDOW_MS) return true;
  return false;
}

/**
 * Задаёт статус выдачи одноразовой сессионной cookie.
 * При сбросе в false также обновляет метку времени старта сервера.
 * @param {boolean} [granted=true]
 */
function setInitialCookieGranted(granted = true) {
  initialCookieGranted = Boolean(granted);
  if (!initialCookieGranted) {
    serverStartedAt = Date.now();
  }
}

/**
 * Устанавливает временную метку старта сервера для контроля окна первичной выдачи cookie.
 * @param {number} [timestamp=Date.now()]
 */
function setServerStartedAt(timestamp = Date.now()) {
  serverStartedAt = Number(timestamp);
}

/**
 * Выполняет безопасное сравнение двух токенов за константное время (защита от timing attacks).
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
function safeCompareTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Извлекает токен авторизации из заголовков (X-API-Token, Authorization Bearer),
 * cookie (osu_local_token) или query-параметра (?token=).
 * @param {import('node:http').IncomingMessage} req
 * @param {URL | null} [url]
 * @returns {string | null}
 */
function extractTokenFromRequest(req, url) {
  const headerToken = req.headers['x-api-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[localApiTokenCookie]) {
    return cookies[localApiTokenCookie];
  }
  let queryUrl = url;
  if (!queryUrl && req.url) {
    try {
      queryUrl = new URL(req.url, 'http://127.0.0.1');
    } catch {}
  }
  if (queryUrl && typeof queryUrl.searchParams?.get === 'function') {
    const queryToken = queryUrl.searchParams.get('token');
    if (queryToken) return queryToken;
  }
  return null;
}

/**
 * Проверяет наличие и валидность токена локального API в запросе.
 * @param {import('node:http').IncomingMessage} req
 * @param {URL | null} [url]
 * @returns {boolean}
 */
function verifyApiToken(req, url) {
  const token = extractTokenFromRequest(req, url);
  if (!token) return false;
  return safeCompareTokens(token, getApiToken());
}

/**
 * Регистрирует секретную строку для маскирования в логах и сообщениях об ошибках.
 * Использует счётчик ссылок (ref-count), чтобы один и тот же секрет оставался
 * замаскированным, пока активна хотя бы одна сессия или токен с ним.
 * @param {string | null | undefined} secret
 */
function addRedaction(secret) {
  if (secret && typeof secret === 'string' && secret.length >= 4) {
    const count = activeRedactions.get(secret) || 0;
    activeRedactions.set(secret, count + 1);
  }
}

/**
 * Декрементирует счётчик использования секрета и удаляет его из списка маскирования,
 * когда число активных пользователей секрета становится равным нулю.
 * @param {string | null | undefined} secret
 */
function removeRedaction(secret) {
  if (secret && typeof secret === 'string') {
    const count = activeRedactions.get(secret);
    if (count !== undefined) {
      if (count <= 1) {
        activeRedactions.delete(secret);
      } else {
        activeRedactions.set(secret, count - 1);
      }
    }
  }
}

/**
 * Очищает список зарегистрированных секретов.
 */
function clearRedactions() {
  activeRedactions.clear();
}

/**
 * Возвращает количество уникальных активных секретов в списке маскирования.
 * @returns {number}
 */
function getActiveRedactionsCount() {
  return activeRedactions.size;
}

/**
 * Маскирует конфиденциальные данные (токены, секреты) и переносы строк в ошибках.
 * @param {any} error
 * @returns {string}
 */
function safeErrorMessage(error) {
  let message = String(error?.message || error || 'Unknown error').replace(/[\r\n\t]/g, ' ');
  for (const secret of activeRedactions.keys()) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, 300);
}

/**
 * Парсит заголовок Cookie в объект { name: value }.
 * @param {string} [header]
 * @returns {Record<string, string>}
 */
function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const separator = part.indexOf('=');
        return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
      })
      .filter(([name]) => name),
  );
}

/**
 * Проверяет, что HTTP-запрос пришёл строго локально и не является межсайтовым (CSRF/Fetch Metadata).
 * Для изменяющих методов (POST, PUT, DELETE, PATCH) при активной защите токеном проверяет наличие и валидность токена.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ mutating?: boolean, url?: URL | null }} [options]
 * @returns {boolean}
 */
function ensureLocalRequest(req, res, options = {}) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  const secFetchSite = req.headers['sec-fetch-site'];
  const actualPort = req.socket?.localPort;
  const localHost =
    host === `127.0.0.1:${PORT}` ||
    host === `localhost:${PORT}` ||
    host === `[::1]:${PORT}` ||
    (actualPort &&
      (host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}` || host === `[::1]:${actualPort}`));
  const localOrigin =
    !origin ||
    origin === `http://127.0.0.1:${PORT}` ||
    origin === `http://localhost:${PORT}` ||
    origin === `http://[::1]:${PORT}` ||
    (actualPort &&
      (origin === `http://127.0.0.1:${actualPort}` ||
        origin === `http://localhost:${actualPort}` ||
        origin === `http://[::1]:${actualPort}`));
  if (!localHost || !localOrigin) {
    json(res, 403, { error: 'Доступ разрешён только с этого компьютера.' });
    return false;
  }
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    json(res, 403, { error: 'Межсайтовые запросы запрещены (Sec-Fetch-Site).' });
    return false;
  }

  let url = options.url || null;
  if (!url && req.url) {
    try {
      url = new URL(req.url, `http://${req.headers.host || `${HOST || '127.0.0.1'}:${PORT}`}`);
    } catch {}
  }

  const isSseEvents = Boolean(url && /^\/api\/downloads(?:\/[^/]+)?\/events$/.test(url.pathname));

  const isMutating =
    options.mutating ??
    (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method || '') ||
      Boolean(url && url.pathname === '/api/osu/browse') ||
      isSseEvents);

  if (isMutating && isApiTokenRequired()) {
    if (!verifyApiToken(req, url)) {
      json(res, 401, { error: 'Отсутствует или недействителен токен авторизации API.' });
      return false;
    }
  }

  return true;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (Carrier-Grade NAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local, Cloud Metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved
  return false;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:0' ||
    normalized === '0:0:0:0:0:0:0:1'
  )
    return true;
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    const parts = v4.split(':');
    if (parts.length === 2) {
      const p1 = parseInt(parts[0], 16);
      const p2 = parseInt(parts[1], 16);
      if (!Number.isNaN(p1) && !Number.isNaN(p2)) {
        return isPrivateIPv4([p1 >> 8, p1 & 0xff, p2 >> 8, p2 & 0xff].join('.'));
      }
    }
    return true;
  }
  if (/^fe[89ab]/i.test(normalized)) return true; // fe80::/10 link-local
  if (/^f[cd]/i.test(normalized)) return true; // fc00::/7 unique local
  if (/^ff/i.test(normalized)) return true; // ff00::/8 multicast
  if (normalized.startsWith('100:') || normalized.startsWith('2001:db8:') || normalized.startsWith('2002:'))
    return true;
  return false;
}

/**
 * Проверяет, является ли IP приватным, loopback, link-local (cloud metadata) или CGNAT.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

const DNS_LOOKUP_TIMEOUT_MS = 5000;

/**
 * @param {string} host
 * @returns {Promise<import('node:dns').LookupAddress[]>}
 */
async function lookupHost(host) {
  let timer;
  try {
    return await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timeout')), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Проверяет, разрешён ли хост для редиректа при скачивании через osu!.
 * @param {URL} url
 * @returns {boolean}
 */
function redirectHostAllowed(url) {
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return host === 'ppy.sh' || host.endsWith('.ppy.sh');
}

/**
 * Создаёт функцию lookup для http/https агента или request, закрепляющую проверенные IP-адреса
 * (защита от DNS Rebinding / TOCTOU).
 * @param {import('node:dns').LookupAddress[]} addresses
 * @returns {(hostname: string, opts: any, cb: (err: Error | null, addressOrAddresses?: any, family?: number) => void) => void}
 */
function createPinnedLookup(addresses) {
  const safeAddresses = (addresses || []).filter((a) => a && a.address && !isPrivateIp(a.address));
  return (hostname, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (safeAddresses.length === 0) {
      return cb(new Error(`SSRF: все IP-адреса для хоста ${hostname} заблокированы или отсутствуют`));
    }
    if (opts && opts.all) {
      return cb(null, safeAddresses);
    }
    const match = opts && opts.family ? safeAddresses.find((a) => a.family === opts.family) : safeAddresses[0];
    const chosen = match || safeAddresses[0];
    return cb(null, chosen.address, chosen.family);
  };
}

/**
 * Асинхронно проверяет безопасность целевого URL редиректа зеркала с резолвом DNS (защита от SSRF).
 * Опционально сохраняет проверенные публичные IP-адреса в outPinned для предотвращения DNS Rebinding.
 * @param {URL} url
 * @param {{ addresses?: import('node:dns').LookupAddress[] }} [outPinned]
 * @returns {Promise<boolean>}
 */
async function mirrorRedirectAllowed(url, outPinned) {
  if (url.protocol !== 'https:') return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }
  // Запрещены прямые IP-адреса: зеркало обязано перенаправлять на доменное имя CDN
  if (net.isIP(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return false;
  }
  try {
    const addresses = await lookupHost(host);
    if (!addresses || addresses.length === 0) return false;
    for (const entry of addresses) {
      if (isPrivateIp(entry.address)) {
        return false;
      }
    }
    if (outPinned && typeof outPinned === 'object') {
      outPinned.addresses = addresses;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  sessions,
  cookieOptions,
  setTokenCookie,
  getSession,
  pruneSessions,
  activeRedactions,
  addRedaction,
  removeRedaction,
  clearRedactions,
  getActiveRedactionsCount,
  safeErrorMessage,
  parseCookies,
  localApiTokenCookie,
  getApiToken,
  setApiToken,
  resetApiToken,
  isApiTokenRequired,
  setApiTokenRequired,
  isInitialCookieGranted,
  setInitialCookieGranted,
  INITIAL_COOKIE_WINDOW_MS,
  setServerStartedAt,
  safeCompareTokens,
  extractTokenFromRequest,
  verifyApiToken,
  ensureLocalRequest,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  lookupHost,
  redirectHostAllowed,
  mirrorRedirectAllowed,
  createPinnedLookup,
};
