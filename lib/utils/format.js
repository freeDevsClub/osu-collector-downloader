// @ts-check
"use strict";

/**
 * Форматирует объём данных в человекочитаемый вид (Б, КБ, МБ, ГБ).
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const ruPluralRules = new Intl.PluralRules('ru-RU');

/**
 * Склоняет существительное с числительным согласно правилам русского языка.
 * @param {number} count
 * @param {string} one - форма для 1 (например, "набор")
 * @param {string} few - форма для 2-4 (например, "набора")
 * @param {string} many - форма для 5-20 (например, "наборов")
 * @returns {string}
 */
function pluralizeRu(count, one, few, many) {
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
 * Возвращает строку с числом и правильно склонённым существительным (например, "1 набор", "2 набора", "5 наборов").
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function formatPluralRu(count, one, few, many) {
  return `${count} ${pluralizeRu(count, one, few, many)}`;
}

module.exports = {
  formatBytes,
  pluralizeRu,
  formatPluralRu,
};

