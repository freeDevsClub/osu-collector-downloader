// @ts-check
import { byId, toAny, notify } from './utils.js';

/**
 * @param {string} url
 * @param {any} [options={}]
 * @returns {Promise<any>}
 */
export async function api(url, options = {}) {
  // Таймаут на каждый запрос: зависший локальный сервер не должен оставлять вечное «Ищем…».
  const timeoutMs = options.timeoutMs ?? 20000;
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      notify(data.error || 'Требуется авторизация. Откройте приложение по ссылке из консоли.');
    }
    const err = /** @type {any} */ (new Error(data.error || `Ошибка запроса (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return data;
}

let sessionConnected = false;

export function isSessionConnected() {
  return sessionConnected;
}

/**
 * @param {boolean} val
 */
export function setSessionConnected(val) {
  sessionConnected = Boolean(val);
}

export function updateSessionSaveButton() {
  const sessionInput = /** @type {HTMLInputElement | null} */ (byId('session-cookie'));
  const sessionRiskConfirm = /** @type {HTMLInputElement | null} */ (byId('session-risk-confirm'));
  const button = /** @type {HTMLButtonElement | null} */ (byId('session-save'));
  if (!button) return;
  const val = sessionInput ? sessionInput.value.trim() : '';
  const cleanVal = val.toLowerCase().startsWith('osu_session=') ? val.slice('osu_session='.length).trim() : val;
  const validLength = cleanVal.length >= 20 && cleanVal.length <= 1024;
  const confirmed = Boolean(sessionRiskConfirm?.checked);
  button.disabled = !validLength || !confirmed;
}

/**
 * @param {boolean} connected
 * @param {(() => void)} [updateDownloadBtn]
 */
export function renderSessionState(connected, updateDownloadBtn) {
  sessionConnected = connected;
  byId('session-dot')?.classList.toggle('connected', connected);
  const textEl = byId('session-text');
  if (textEl) {
    textEl.textContent = connected ? 'Сессия сохранена в памяти (до 6 ч или до перезапуска)' : 'Сессия не добавлена';
  }
  const clearBtn = byId('session-clear');
  if (clearBtn) clearBtn.hidden = !connected;
  const sessionInput = /** @type {HTMLInputElement | null} */ (byId('session-cookie'));
  if (sessionInput) {
    sessionInput.placeholder = connected
      ? 'Сессия активна в памяти (вставьте новую для замены)'
      : 'Вставьте значение cookie osu_session';
  }
  const sessionRiskConfirm = /** @type {HTMLInputElement | null} */ (byId('session-risk-confirm'));
  if (sessionRiskConfirm) {
    sessionRiskConfirm.checked = false;
  }
  updateSessionSaveButton();
  if (typeof updateDownloadBtn === 'function') {
    updateDownloadBtn();
  }
}

/**
 * @param {{ updateDownloadButton?: () => void }} [options={}]
 */
export function initSessionUi(options = {}) {
  const sessionInput = /** @type {HTMLInputElement | null} */ (byId('session-cookie'));
  const sessionRiskConfirm = /** @type {HTMLInputElement | null} */ (byId('session-risk-confirm'));
  const sessionForm = byId('session-form');
  const sessionClear = byId('session-clear');

  sessionInput?.addEventListener('input', updateSessionSaveButton);
  sessionRiskConfirm?.addEventListener('change', updateSessionSaveButton);

  sessionForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    let session = sessionInput ? sessionInput.value.trim() : '';
    if (session.toLowerCase().startsWith('osu_session=')) {
      session = session.slice('osu_session='.length).trim();
    }
    if (!session) return;
    if (!sessionRiskConfirm?.checked) {
      notify('Подтвердите понимание рисков безопасности перед сохранением.');
      return;
    }
    if (session.length < 20 || session.length > 1024 || !/^[a-zA-Z0-9%_\-.=/+|]+$/.test(session)) {
      notify('Некорректный формат cookie. Ожидается токен сессии osu.ppy.sh (без пробелов и спецсимволов).');
      return;
    }
    const button = /** @type {HTMLButtonElement | null} */ (byId('session-save'));
    if (button) button.disabled = true;
    try {
      await api('/api/session', { method: 'POST', body: JSON.stringify({ session }) });
      if (sessionInput) sessionInput.value = '';
      renderSessionState(true, options.updateDownloadButton);
      notify('Сессия сохранена в оперативной памяти (до 6 часов либо до перезапуска).');
    } catch (rawError) {
      notify(toAny(rawError).message);
    } finally {
      updateSessionSaveButton();
    }
  });

  sessionClear?.addEventListener('click', async () => {
    try {
      await api('/api/session', { method: 'DELETE' });
      renderSessionState(false, options.updateDownloadButton);
      notify('Сессия удалена из памяти приложения.');
    } catch (rawError) {
      notify(toAny(rawError).message);
    }
  });
}
