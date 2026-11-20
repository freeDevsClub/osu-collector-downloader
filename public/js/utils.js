// @ts-check

/**
 * @param {string} id
 * @returns {any}
 */
export const byId = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);

/**
 * @param {unknown} err
 * @returns {any}
 */
export const toAny = err => /** @type {any} */ (err);

const ruPluralRules = new Intl.PluralRules('ru-RU');

/**
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
export function pluralizeRu(count, one, few, many) {
  const rule = ruPluralRules.select(Math.abs(count));
  switch (rule) {
    case 'one':
      return one;
    case 'few':
      return few;
    case 'many':
    default:
      return many;
  }
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
export function formatPluralRu(count, one, few, many) {
  return `${count} ${pluralizeRu(count, one, few, many)}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 Б';
  if (value < 1024) return `${Math.round(value)} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

/**
 * @param {HTMLElement | null} element
 * @param {string} [text='']
 * @param {string} [tone='']
 */
export function setStatus(element, text = '', tone = '') {
  if (!element) return;
  element.textContent = text;
  element.className = `status${tone ? ` ${tone}` : ''}`;
}

/** @type {any} */
let notifyTimer = null;

/**
 * @param {string} text
 */
export function notify(text) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

