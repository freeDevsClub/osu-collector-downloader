// @ts-check
"use strict";

const dns = require('node:dns/promises');
const net = require('node:net');
const { PORT, json } = require('./config.js');

const activeRedactions = new Set();

/**
 * Регистрирует секретную строку для маскирования в логах и сообщениях об ошибках.
 * @param {string | null | undefined} secret
 */
function addRedaction(secret) {
  if (secret && typeof secret === 'string' && secret.length >= 4) {
    activeRedactions.add(secret);
  }
}

/**
 * Удаляет секретную строку из списка маскирования.
 * @param {string | null | undefined} secret
 */
function removeRedaction(secret) {
  if (secret && typeof secret === 'string') {
    activeRedactions.delete(secret);
  }
}

/**
 * Очищает список зарегистрированных секретов.
 */
function clearRedactions() {
  activeRedactions.clear();
}

/**
 * Маскирует конфиденциальные данные (токены, секреты) и переносы строк в ошибках.
 * @param {any} error
 * @returns {string}
 */
function safeErrorMessage(error) {
  let message = String(error?.message || error || 'Unknown error').replace(/[\r\n\t]/g, ' ');
  for (const secret of activeRedactions) {
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
  return Object.fromEntries(header.split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

/**
 * Проверяет, что HTTP-запрос пришёл строго локально и не является межсайтовым (CSRF/Fetch Metadata).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean}
 */
function ensureLocalRequest(req, res) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  const secFetchSite = req.headers['sec-fetch-site'];
  const localHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
  const localOrigin = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}` || origin === `http://[::1]:${PORT}`;
  if (!localHost || !localOrigin) {
    json(res, 403, { error: 'Доступ разрешён только с этого компьютера.' });
    return false;
  }
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    const pathname = (req.url || '').split('?')[0];
    const isOauthCallback = pathname === '/oauth/callback' && req.method === 'GET';
    if (!isOauthCallback) {
      json(res, 403, { error: 'Межсайтовые запросы запрещены (Sec-Fetch-Site).' });
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
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true;
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
  if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:0' || normalized === '0:0:0:0:0:0:0:1') return true;
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
  if (/^f[cd]/i.test(normalized)) return true;    // fc00::/7 unique local
  if (/^ff/i.test(normalized)) return true;       // ff00::/8 multicast
  if (normalized.startsWith('100:') || normalized.startsWith('2001:db8:') || normalized.startsWith('2002:')) return true;
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
 * Асинхронно проверяет безопасность целевого URL редиректа зеркала с резолвом DNS (защита от SSRF).
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function mirrorRedirectAllowed(url) {
  if (url.protocol !== 'https:') return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
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
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  addRedaction,
  removeRedaction,
  clearRedactions,
  safeErrorMessage,
  parseCookies,
  ensureLocalRequest,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  lookupHost,
  redirectHostAllowed,
  mirrorRedirectAllowed,
};
