// @ts-check
import { byId } from '../utils.js';
import { api } from '../api.js';

/** @type {Array<{ id: string, label: string, cooldownUntil: number }>} */
let mirrorStatus = [];

export function getMirrorStatus() {
  return mirrorStatus;
}

/**
 * @param {Array<{ id: string, label: string, cooldownUntil: number }>} list
 */
export function setMirrorStatus(list) {
  mirrorStatus = list || [];
}

export function renderMirrors() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return; // фоновая вкладка не нуждается в обновлениях
  const container = byId('mirror-status');
  if (!container) return;
  container.replaceChildren();
  const now = Date.now();
  for (const mirror of mirrorStatus) {
    const row = document.createElement('div');
    row.className = 'mirror-row';
    const cooling = mirror.cooldownUntil > now;
    const dot = document.createElement('span');
    dot.className = `session-dot${cooling ? ' cooling' : ' connected'}`;
    const name = document.createElement('span');
    name.className = 'mirror-name';
    name.textContent = mirror.label;
    const state = document.createElement('span');
    state.className = `mirror-state${cooling ? ' cooling' : ''}`;
    state.textContent = cooling ? `пауза ${Math.ceil((mirror.cooldownUntil - now) / 1000)} с` : 'доступно';
    row.append(dot, name, state);
    container.append(row);
  }
}

/**
 * @param {Array<{ id: string, label: string, cooldownMs?: number }>} mirrors
 */
export function updateMirrorsFromData(mirrors) {
  mirrorStatus = (mirrors || []).map((mirror) => ({
    id: mirror.id,
    label: mirror.label,
    cooldownUntil: mirror.cooldownMs && mirror.cooldownMs > 0 ? Date.now() + mirror.cooldownMs : 0,
  }));
  renderMirrors();
}

export async function loadMirrors() {
  try {
    const data = await api('/api/mirrors');
    if (Array.isArray(data.mirrors)) {
      updateMirrorsFromData(data.mirrors);
    }
  } catch {}
}

export function hasActiveCooldowns() {
  const now = Date.now();
  return mirrorStatus.some((m) => m.cooldownUntil && m.cooldownUntil > now);
}

/**
 * @param {{ getActiveJob?: () => any }} [options={}]
 */
export function initMirrorsUi(options = {}) {
  if (typeof window === 'undefined') return;

  // Отсчёт пауз зеркал перерисовывается каждую секунду только при наличии активных кулдаунов.
  setInterval(() => {
    if (hasActiveCooldowns()) renderMirrors();
  }, 1000);

  // Фоновый опрос зеркал запускается только при открытой вкладке, когда нет активной задачи, но есть остывающие зеркала.
  setInterval(() => {
    const active = options.getActiveJob ? options.getActiveJob() : null;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !active && hasActiveCooldowns()) {
      void loadMirrors();
    }
  }, 4000);
}
