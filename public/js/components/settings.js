// @ts-check
import { byId, toAny, formatPluralRu, setStatus, notify } from '../utils.js';
import { api } from '../api.js';

let osuSettings = {
  osuPath: '',
  songsDir: null,
  valid: false,
  songsCount: 0,
  checkExisting: true,
  postDownloadAction: 'none',
};

export function getOsuSettings() {
  return osuSettings;
}

/**
 * @param {any} s
 */
export function setOsuSettings(s) {
  osuSettings = s;
}

function getPostActionInputs() {
  return (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function')
    ? /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="post-download-action"]')])
    : [];
}

/**
 * @param {any} settings
 * @param {boolean} [updateInput=true]
 */
export function renderOsuSettings(settings, updateInput = true) {
  const osuPathInput = /** @type {HTMLInputElement | null} */ (byId('osu-path-input'));
  const checkboxCheckExisting = /** @type {HTMLInputElement | null} */ (byId('checkbox-check-existing'));
  const postActionInputs = getPostActionInputs();
  const osuDot = byId('osu-dot');
  const osuText = byId('osu-text');

  osuSettings = {
    osuPath: settings?.osuPath || '',
    songsDir: settings?.songsDir || null,
    valid: Boolean(settings?.valid),
    songsCount: Number(settings?.songsCount || 0),
    checkExisting: settings?.checkExisting !== undefined ? Boolean(settings.checkExisting) : true,
    postDownloadAction: ['none', 'move', 'extract', 'copy'].includes(settings?.postDownloadAction)
      ? settings.postDownloadAction
      : 'none',
  };

  if (updateInput && osuPathInput && typeof document !== 'undefined' && document.activeElement !== osuPathInput) {
    osuPathInput.value = osuSettings.osuPath;
  }
  if (checkboxCheckExisting) {
    checkboxCheckExisting.checked = osuSettings.checkExisting;
  }
  postActionInputs.forEach(input => {
    input.checked = input.value === osuSettings.postDownloadAction;
    const option = byId(`option-action-${input.value}`);
    option?.classList.toggle('selected', input.checked);
  });

  const extraDetails = /** @type {HTMLDetailsElement | null} */ (byId('extra-actions-details'));
  if (extraDetails && (osuSettings.postDownloadAction === 'move' || osuSettings.postDownloadAction === 'copy')) {
    extraDetails.open = true;
  }

  if (osuDot) {
    osuDot.className = `session-dot${osuSettings.valid ? ' connected' : ''}`;
  }
  if (osuText) {
    if (osuSettings.valid && osuSettings.songsDir) {
      osuText.textContent = `Подключено: найдено ${formatPluralRu(osuSettings.songsCount, 'набор', 'набора', 'наборов')} карт`;
    } else if (osuSettings.osuPath) {
      osuText.textContent = 'Папка Songs не найдена по указанному пути';
    } else {
      osuText.textContent = 'Путь к игре osu! не настроен';
    }
  }
}

export async function loadOsuSettings() {
  try {
    const data = await api('/api/osu/settings');
    renderOsuSettings(data);
    return data;
  } catch {
    renderOsuSettings(null);
  }
}

/**
 * @param {boolean | { osuPath?: string, checkExisting?: boolean, postDownloadAction?: string }} [patchOrToast=true]
 * @param {boolean} [maybeToast]
 * @param {(() => Promise<void>)} [recheckCollection]
 */
export async function saveOsuSettings(patchOrToast = true, maybeToast, recheckCollection) {
  const osuPathInput = /** @type {HTMLInputElement | null} */ (byId('osu-path-input'));
  const checkboxCheckExisting = /** @type {HTMLInputElement | null} */ (byId('checkbox-check-existing'));
  const postActionInputs = getPostActionInputs();
  const osuPathSave = /** @type {HTMLButtonElement | null} */ (byId('osu-path-save'));
  const osuStatus = byId('osu-status');

  /** @type {{ osuPath?: string, checkExisting?: boolean, postDownloadAction?: string }} */
  let patch = {};
  let showToast = true;

  if (typeof patchOrToast === 'object' && patchOrToast !== null) {
    patch = patchOrToast;
    showToast = maybeToast !== undefined ? Boolean(maybeToast) : false;
  } else {
    showToast = Boolean(patchOrToast);
    patch = {
      osuPath: osuPathInput ? osuPathInput.value.trim() : osuSettings.osuPath,
      checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
      postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
    };
  }

  const isPathUpdate = patch.osuPath !== undefined;

  if (isPathUpdate && osuPathSave) osuPathSave.disabled = true;
  setStatus(osuStatus, isPathUpdate ? 'Сохраняю настройки osu!…' : 'Обновляю настройки…');
  try {
    const data = await api('/api/osu/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    renderOsuSettings(data, isPathUpdate);
    if (isPathUpdate) {
      if (data.valid) {
        setStatus(osuStatus, `Настройки сохранены. Найдено ${formatPluralRu(data.songsCount, 'набор', 'набора', 'наборов')} карт в osu! Songs.`, 'success');
        if (showToast) notify(`osu! Songs подключена (${formatPluralRu(data.songsCount, 'набор', 'набора', 'наборов')}).`);
      } else {
        setStatus(osuStatus, 'Путь сохранён (папка osu! отключена).', '');
        if (showToast) notify('Настройки osu! обновлены.');
      }
    } else {
      setStatus(osuStatus, 'Настройки osu! сохранены.', 'success');
      if (showToast) notify('Настройки osu! сохранены.');
    }
    if (typeof recheckCollection === 'function') {
      await recheckCollection();
    }
  } catch (err) {
    if (!isPathUpdate) {
      if (checkboxCheckExisting) {
        checkboxCheckExisting.checked = osuSettings.checkExisting;
      }
      postActionInputs.forEach(input => {
        input.checked = input.value === osuSettings.postDownloadAction;
        const option = byId(`option-action-${input.value}`);
        option?.classList.toggle('selected', input.checked);
      });
    }
    const message = toAny(err).message;
    setStatus(osuStatus, message, 'error');
    if (showToast) notify(`Ошибка: ${message}`);
  } finally {
    if (isPathUpdate && osuPathSave) osuPathSave.disabled = false;
  }
}

/**
 * @param {(() => Promise<void>)} [recheckCollection]
 */
export async function rescanOsuSongs(recheckCollection) {
  const osuRescan = /** @type {HTMLButtonElement | null} */ (byId('osu-rescan'));
  const osuStatus = byId('osu-status');
  if (osuRescan) osuRescan.disabled = true;
  setStatus(osuStatus, 'Сканирую папку osu! Songs…');
  try {
    const data = await api('/api/osu/rescan', { method: 'POST' });
    osuSettings.songsCount = Number(data.count || 0);
    renderOsuSettings(osuSettings, false);
    setStatus(osuStatus, `Сканирование завершено: найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт.`, 'success');
    notify(`Найдено ${formatPluralRu(data.count, 'набор', 'набора', 'наборов')} карт в osu! Songs.`);
    if (typeof recheckCollection === 'function') {
      await recheckCollection();
    }
  } catch (err) {
    const message = toAny(err).message;
    setStatus(osuStatus, message, 'error');
    notify(message);
  } finally {
    if (osuRescan) osuRescan.disabled = false;
  }
}

/**
 * @param {{ recheckCollection?: () => Promise<void> }} [options={}]
 */
export function initSettingsUi(options = {}) {
  const osuPathBrowse = /** @type {HTMLButtonElement | null} */ (byId('osu-path-browse'));
  const osuPathSave = byId('osu-path-save');
  const osuPathInput = /** @type {HTMLInputElement | null} */ (byId('osu-path-input'));
  const osuRescan = byId('osu-rescan');
  const checkboxCheckExisting = /** @type {HTMLInputElement | null} */ (byId('checkbox-check-existing'));
  const postActionInputs = getPostActionInputs();
  const osuStatus = byId('osu-status');

  if (osuPathBrowse) {
    osuPathBrowse.addEventListener('click', async () => {
      if (osuPathBrowse.disabled) return;
      osuPathBrowse.disabled = true;
      const originalText = osuPathBrowse.textContent;
      osuPathBrowse.textContent = 'Выбор…';
      setStatus(osuStatus, 'Открыт Проводник — выберите папку osu! или Songs…');
      try {
        const currentVal = osuPathInput ? osuPathInput.value.trim() : osuSettings.osuPath;
        /** @type {any} */
        const data = await api('/api/osu/browse', {
          method: 'POST',
          body: JSON.stringify({ initialPath: currentVal }),
          timeoutMs: 190000,
        });
        if (data && data.path) {
          if (osuPathInput) {
            osuPathInput.value = data.path;
          }
          await saveOsuSettings({
            osuPath: data.path,
            checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
            postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
          }, true, options.recheckCollection);
        } else {
          setStatus(osuStatus, 'Выбор папки отменён.', '');
        }
      } catch (err) {
        const message = toAny(err).message;
        setStatus(osuStatus, `Не удалось открыть Проводник: ${message}`, 'error');
      } finally {
        osuPathBrowse.disabled = false;
        osuPathBrowse.textContent = originalText;
      }
    });
  }

  if (osuPathSave) {
    osuPathSave.addEventListener('click', () => {
      const osuPath = osuPathInput ? osuPathInput.value.trim() : '';
      void saveOsuSettings({
        osuPath,
        checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
        postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
      }, true, options.recheckCollection);
    });
  }

  if (osuPathInput) {
    osuPathInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const osuPath = osuPathInput.value.trim();
        void saveOsuSettings({
          osuPath,
          checkExisting: checkboxCheckExisting ? checkboxCheckExisting.checked : osuSettings.checkExisting,
          postDownloadAction: postActionInputs.find(i => i.checked)?.value || osuSettings.postDownloadAction,
        }, true, options.recheckCollection);
      }
    });
  }

  if (osuRescan) {
    osuRescan.addEventListener('click', () => {
      void rescanOsuSongs(options.recheckCollection);
    });
  }

  if (checkboxCheckExisting) {
    checkboxCheckExisting.addEventListener('change', () => {
      void saveOsuSettings({ checkExisting: checkboxCheckExisting.checked }, false, options.recheckCollection);
    });
  }

  postActionInputs.forEach(input => {
    input.addEventListener('change', () => {
      postActionInputs.forEach(i => {
        byId(`option-action-${i.value}`)?.classList.toggle('selected', i.checked);
      });
      void saveOsuSettings({ postDownloadAction: input.value }, false, options.recheckCollection);
    });
  });
}

