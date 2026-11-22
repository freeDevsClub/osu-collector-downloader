'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Семантика форм и доступность (a11y) в index.html', () => {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  it('бэйдж в header содержит семантическую роль role="note" для aria-label', () => {
    assert.match(
      html,
      /<div\s+class="badge"\s+role="note"\s+aria-label="Только на этом компьютере"/,
      'Бейдж должен иметь role="note" для легитимного использования aria-label',
    );
  });

  it('группа радиокнопок пост-обработки использует семантический fieldset с legend и radiogroup', () => {
    assert.match(
      html,
      /<fieldset\s+class="[^"]*post-download-fieldset[^"]*"\s+role="radiogroup"\s+aria-labelledby="post-download-legend">/,
      'Пост-обработка должна быть обёрнута в fieldset с role="radiogroup" и aria-labelledby',
    );
    assert.match(
      html,
      /<legend\s+id="post-download-legend">Что делать со скачанными картами:<\/legend>/,
      'Внутри fieldset должен присутствовать legend с текстом и id заголовка',
    );
  });

  it('в index.html отсутствуют несемантические одиночные теги <label> без for или вложенного контрола', () => {
    // Ищем все теги <label>
    const labelRegex = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
    let match;
    while ((match = labelRegex.exec(html)) !== null) {
      const attrs = match[1];
      const content = match[2];
      const hasFor = /\bfor\s*=\s*["'][^"']+["']/i.test(attrs);
      const hasNestedControl = /<(?:input|select|textarea)\b/i.test(content);
      assert.ok(
        hasFor || hasNestedControl,
        `Тег <label ${attrs}> должен либо содержать атрибут "for", либо оборачивать контрол ввода: ${match[0]}`,
      );
    }
  });

  it('все радиокнопки post-download-action находятся внутри post-download-fieldset', () => {
    const fieldsetMatch = html.match(/<fieldset[^>]*post-download-fieldset[\s\S]*?<\/fieldset>/i);
    assert.ok(fieldsetMatch, 'fieldset post-download-fieldset должен присутствовать');
    const fieldsetContent = fieldsetMatch[0];

    assert.ok(fieldsetContent.includes('id="action-extract"'));
    assert.ok(fieldsetContent.includes('id="action-none"'));
    assert.ok(fieldsetContent.includes('id="action-move"'));
    assert.ok(fieldsetContent.includes('id="action-copy"'));
  });
});

