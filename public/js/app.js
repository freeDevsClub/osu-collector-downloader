// @ts-check
import { byId, setStatus } from './utils.js';
import { api, renderSessionState, initSessionUi } from './api.js';
import { loadMirrors, initMirrorsUi } from './components/mirrors.js';
import { loadOsuSettings, initSettingsUi } from './components/settings.js';
import { recheckCollectionOsu, initCollectionUi } from './components/collection.js';
import { updateDownloadButton, restoreJob, initDownloadsUi, getActiveJob } from './components/downloads.js';

export * from './utils.js';
export * from './api.js';
export * from './components/mirrors.js';
export * from './components/settings.js';
export * from './components/collection.js';
export * from './components/downloads.js';

export async function initialize() {
  initSessionUi({ updateDownloadButton });
  initMirrorsUi({ getActiveJob });
  initSettingsUi({ recheckCollection: () => recheckCollectionOsu({ updateDownloadButton }) });
  initCollectionUi({ updateDownloadButton });
  initDownloadsUi({ loadMirrors });

  const [sessionRes] = await Promise.allSettled([api('/api/session'), loadMirrors(), loadOsuSettings()]);

  if (sessionRes.status === 'fulfilled') {
    renderSessionState(Boolean(sessionRes.value?.connected), updateDownloadButton);
  } else {
    renderSessionState(false, updateDownloadButton);
    const error = sessionRes.reason;
    const collectionStatus = byId('collection-status');
    if (error?.name === 'TimeoutError') {
      setStatus(collectionStatus, 'Локальный сервер не отвечает — он запущен?', 'error');
    } else {
      setStatus(
        collectionStatus,
        `Не удалось подключиться к локальному серверу: ${error?.message || 'ошибка сети'}`,
        'error',
      );
    }
  }

  updateDownloadButton();
  await restoreJob();
}

if (typeof window !== 'undefined') {
  initialize();
}
