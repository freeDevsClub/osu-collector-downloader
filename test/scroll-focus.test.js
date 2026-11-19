"use strict";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../lib/config.js');
const { finishJob } = require('../app.js');

describe('Устранение бага со скроллом и потерей фокуса при отмене/завершении задачи (Issue #1)', () => {
  it('finishJob не вызывает blur на document.body или document.documentElement, предотвращая блокировку скролла колесиком', () => {
    const origDocument = global.document;
    const origWindow = global.window;
    const origHTMLElement = global.HTMLElement;

    let bodyBlurCalled = false;
    let windowFocusCalled = false;

    class MockHTMLElement {
      blur() {
        bodyBlurCalled = true;
      }
    }

    const mockBody = new MockHTMLElement();
    const mockDocument = {
      body: mockBody,
      documentElement: new MockHTMLElement(),
      activeElement: mockBody,
      getElementById() {
        return null;
      },
    };

    const mockWindow = {
      focus() {
        windowFocusCalled = true;
      },
    };

    try {
      /** @type {any} */ (global).HTMLElement = MockHTMLElement;
      /** @type {any} */ (global).document = mockDocument;
      /** @type {any} */ (global).window = mockWindow;

      finishJob({ id: 'job_test_scroll', status: 'cancelled' });

      assert.equal(bodyBlurCalled, false, 'document.body.blur() НЕ должен вызываться, чтобы браузер не сбрасывал фокус окна');
      assert.equal(windowFocusCalled, true, 'window.focus() должен вызываться для гарантированного возвращения событий мыши и колесика');
    } finally {
      /** @type {any} */ (global).document = origDocument;
      /** @type {any} */ (global).window = origWindow;
      /** @type {any} */ (global).HTMLElement = origHTMLElement;
    }
  });

  it('finishJob корректно блюрит интерактивные элементы при их наличии и возвращает фокус окну', () => {
    const origDocument = global.document;
    const origWindow = global.window;
    const origHTMLElement = global.HTMLElement;

    let buttonBlurCalled = false;
    let windowFocusCalled = false;

    class MockHTMLElement {
      blur() {
        buttonBlurCalled = true;
      }
    }

    const mockButton = new MockHTMLElement();

    const mockDocument = {
      body: new MockHTMLElement(),
      documentElement: new MockHTMLElement(),
      activeElement: mockButton,
      getElementById() {
        return null;
      },
    };

    const mockWindow = {
      focus() {
        windowFocusCalled = true;
      },
    };

    try {
      /** @type {any} */ (global).HTMLElement = MockHTMLElement;
      /** @type {any} */ (global).document = mockDocument;
      /** @type {any} */ (global).window = mockWindow;

      finishJob({ id: 'job_test_button_blur', status: 'cancelled' });

      assert.equal(buttonBlurCalled, true, 'Кнопка или активный контрол должен блюриться');
      assert.equal(windowFocusCalled, true, 'Фокус возвращается окну');
    } finally {
      /** @type {any} */ (global).document = origDocument;
      /** @type {any} */ (global).window = origWindow;
      /** @type {any} */ (global).HTMLElement = origHTMLElement;
    }
  });

  it('index.html не содержит tabindex="0" на списке карт, исключая захват фокуса и блокировку клавиш скролла', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
    assert.doesNotMatch(html, /<ul[^>]*id="map-list"[^>]*tabindex/i);
  });

  it('style.css не содержит overscroll-behavior-y: contain на списках, обеспечивая плавный чейнинг колесика мыши к окну', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf-8');
    assert.doesNotMatch(css, /overscroll-behavior-y:\s*contain/i);
  });

  it('style.css не содержит content-visibility: auto и contain-intrinsic-size на карточках карт, исключая layout thrashing и рывки скроллбара', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf-8');
    assert.doesNotMatch(css, /content-visibility:\s*auto/i);
    assert.doesNotMatch(css, /contain-intrinsic-size/i);
  });
});

