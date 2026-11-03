import { readWorkshopMode, installWorkshopModeSettings } from './workshop-mode.js?v=2.98.61';
const EXTENSION_NAME = '🧩预设工坊';
const EXTENSION_VERSION = '2.98.61';
const RUNTIME_ID = 'TH-script--🧩预设工坊（GitHub 扩展）--2f53f6af-3c9e-4c71-bc52-9f635be25300';
const LEGACY_IFRAME_PREFIX = 'TH-script--🧩预设工坊';
const EXTENSION_FOLDER_NAME = 'ST-Preset-Workshop';
const HELPER_WAIT_TIMEOUT = 60_000;
const LEGACY_GRACE_PERIOD = 3_000;
const VERSION_CHECK_INTERVAL = 30_000;
const RAPID_VERSION_CHECK_INTERVAL = 750;
const RAPID_VERSION_CHECK_TIMEOUT = 65_000;
const UPDATE_MANAGER_SETTLE_DELAY = 1_500;
const UPDATE_MANAGER_CLOSE_POLL_INTERVAL = 50;
const TOP_NOTIFICATION_STORAGE_KEY = 'pmm_top_notifications_enabled_v1';

let versionCheckTimer = null;
let versionCheckBusy = false;
let rapidVersionCheckTimer = null;
let rapidVersionCheckStopTimer = null;
let nativeUpdateReloadTimer = null;
let nativeUpdateReloadPending = false;
let singleExtensionUpdatePending = false;
let bulkExtensionUpdateInProgress = false;
let startupPromise = null;
let runtimeGeneration = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function topNotificationsEnabled() {
  try { return globalThis.localStorage?.getItem(TOP_NOTIFICATION_STORAGE_KEY) !== '0'; }
  catch (_) { return true; }
}

function notify(type, message) {
  if (!topNotificationsEnabled()) {
    const logger = type === 'error' ? console.error : type === 'warning' ? console.warn : (console.debug || console.info);
    logger?.call(console, `[${EXTENSION_NAME}][顶部通知已关闭]`, message);
    return;
  }
  const toast = globalThis.toastr?.[type];
  if (typeof toast === 'function') {
    toast(message, EXTENSION_NAME);
  }
}

async function readInstalledVersion() {
  const manifestUrl = new URL('../manifest.json', import.meta.url);
  manifestUrl.searchParams.set('_pmm_version_check', String(Date.now()));
  const response = await fetch(manifestUrl, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`读取扩展版本失败：HTTP ${response.status}`);
  }
  const manifest = await response.json();
  return String(manifest?.version || '').trim();
}

async function checkForInstalledUpdate() {
  if (versionCheckBusy || bulkExtensionUpdateInProgress || document.visibilityState === 'hidden') return;
  versionCheckBusy = true;
  try {
    const nextVersion = await readInstalledVersion();
    if (!nextVersion || nextVersion === EXTENSION_VERSION) return;

    /* 给扩展更新器一点时间写完全部文件，再确认一次，避免在更新中途刷新。 */
    await sleep(900);
    if (document.visibilityState === 'hidden') return;
    if (await readInstalledVersion() !== nextVersion) return;

    const followsNativeSingleUpdate = nativeUpdateReloadPending || singleExtensionUpdatePending;
    if (followsNativeSingleUpdate) {
      deferNativeSingleUpdateReload();
      return;
    } else {
      stopVersionWatcher();
      notify('info', `扩展已更新至 v${nextVersion}，正在自动刷新酒馆`);
      await sleep(450);
    }
    globalThis.__PMM_PERFORMANCE_GUARD_V275__?.markReloadReason?.('extension-update');
    globalThis.location.reload();
  } catch (error) {
    console.debug(`[${EXTENSION_NAME}] 暂未检测到可自动载入的新版本。`, error);
  } finally {
    versionCheckBusy = false;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') void checkForInstalledUpdate();
}

function extensionBlockName(block) {
  return String(block?.dataset?.name || '').replace(/^\/+/, '').trim();
}

function isOwnExtensionBlock(block) {
  return extensionBlockName(block).endsWith(EXTENSION_FOLDER_NAME);
}

function isOwnSingleUpdateSpinning() {
  return [...document.querySelectorAll('.extension_block')].some(block => (
    isOwnExtensionBlock(block)
    && Boolean(block.querySelector('.btn_update .fa-spin, .btn_update.fa-spin'))
  ));
}

function stopRapidVersionCheck(resetPending = true) {
  if (rapidVersionCheckTimer !== null) {
    globalThis.clearInterval(rapidVersionCheckTimer);
    rapidVersionCheckTimer = null;
  }
  if (rapidVersionCheckStopTimer !== null) {
    globalThis.clearTimeout(rapidVersionCheckStopTimer);
    rapidVersionCheckStopTimer = null;
  }
  if (resetPending) singleExtensionUpdatePending = false;
}

function startRapidVersionCheck() {
  stopRapidVersionCheck(false);
  singleExtensionUpdatePending = true;
  void checkForInstalledUpdate();
  rapidVersionCheckTimer = globalThis.setInterval(
    () => void checkForInstalledUpdate(),
    RAPID_VERSION_CHECK_INTERVAL,
  );
  rapidVersionCheckStopTimer = globalThis.setTimeout(
    () => stopRapidVersionCheck(),
    RAPID_VERSION_CHECK_TIMEOUT,
  );
}

function clearPendingExtensionUpdateReload() {
  if (nativeUpdateReloadTimer !== null) {
    globalThis.clearTimeout(nativeUpdateReloadTimer);
    nativeUpdateReloadTimer = null;
  }
  nativeUpdateReloadPending = false;
  document.removeEventListener('click', handlePendingExtensionManagerClose, true);
}

function markExtensionUpdateReload() {
  clearPendingExtensionUpdateReload();
  globalThis.__PMM_PERFORMANCE_GUARD_V275__?.markReloadReason?.('extension-update');
  globalThis.location.reload();
}

function activeExtensionManagerDialog() {
  return [...document.querySelectorAll('dialog')].find(dialog => (
    dialog.open && Boolean(dialog.querySelector('.extensions_info'))
  )) || null;
}

function waitForExtensionManagerClose(dialog) {
  if (nativeUpdateReloadTimer !== null) globalThis.clearTimeout(nativeUpdateReloadTimer);
  const deadline = Date.now() + 3_000;
  const check = () => {
    nativeUpdateReloadTimer = null;
    if (dialog?.isConnected && dialog.open && Date.now() < deadline) {
      nativeUpdateReloadTimer = globalThis.setTimeout(check, UPDATE_MANAGER_CLOSE_POLL_INTERVAL);
      return;
    }
    markExtensionUpdateReload();
  };
  nativeUpdateReloadTimer = globalThis.setTimeout(check, 0);
}

function handlePendingExtensionManagerClose(event) {
  if (!nativeUpdateReloadPending) return;
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return;
  const closeButton = target.closest('.popup-button-ok');
  const dialog = closeButton?.closest('dialog');
  if (!dialog?.querySelector('.extensions_info')) return;
  waitForExtensionManagerClose(dialog);
}

function deferNativeSingleUpdateReload() {
  if (nativeUpdateReloadPending) return;
  stopVersionWatcher();
  nativeUpdateReloadPending = true;
  document.addEventListener('click', handlePendingExtensionManagerClose, true);
  /* 更新器会先关闭旧窗口并重建扩展列表；给新窗口留出挂载时间。 */
  nativeUpdateReloadTimer = globalThis.setTimeout(() => {
    nativeUpdateReloadTimer = null;
    if (nativeUpdateReloadPending && !activeExtensionManagerDialog()) markExtensionUpdateReload();
  }, UPDATE_MANAGER_SETTLE_DELAY);
}

function scheduleNativeSingleUpdateReload() {
  if (bulkExtensionUpdateInProgress || nativeUpdateReloadPending) return false;
  if (!singleExtensionUpdatePending && !isOwnSingleUpdateSpinning()) return false;

  deferNativeSingleUpdateReload();
  return true;
}

function handleNativeExtensionManagerClick(event) {
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return;

  const toolbar = target.closest('.extensions_toolbar');
  const toolbarButton = target.closest('button');
  if (toolbar && toolbarButton) {
    const updateButtons = [...toolbar.querySelectorAll('button')].slice(0, 2);
    if (updateButtons.includes(toolbarButton)) {
      bulkExtensionUpdateInProgress = true;
      stopRapidVersionCheck();
      return;
    }
  }

  const updateButton = target.closest('.btn_update');
  const extensionBlock = updateButton?.closest('.extension_block');
  if (updateButton && isOwnExtensionBlock(extensionBlock)) {
    bulkExtensionUpdateInProgress = false;
    startRapidVersionCheck();
  }
}

/**
 * SillyTavern 官方扩展更新钩子：仅在单独点击本扩展更新按钮时安排刷新。
 * 批量更新继续交给酒馆完成全部任务后统一刷新。
 */
export function onUpdate() {
  scheduleNativeSingleUpdateReload();
}

function startVersionWatcher() {
  if (versionCheckTimer !== null) return;
  void checkForInstalledUpdate();
  versionCheckTimer = globalThis.setInterval(() => void checkForInstalledUpdate(), VERSION_CHECK_INTERVAL);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('click', handleNativeExtensionManagerClick, true);
}

function stopVersionWatcher() {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.removeEventListener('click', handleNativeExtensionManagerClick, true);
  stopRapidVersionCheck();
  if (versionCheckTimer !== null) {
    globalThis.clearInterval(versionCheckTimer);
    versionCheckTimer = null;
  }
}

function findLegacyRuntime() {
  return [...document.querySelectorAll('iframe[id]')].find(
    iframe => iframe.id !== RUNTIME_ID && iframe.id.startsWith(LEGACY_IFRAME_PREFIX),
  );
}

async function waitForLegacyRuntime() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LEGACY_GRACE_PERIOD) {
    const legacyRuntime = findLegacyRuntime();
    if (legacyRuntime) {
      return legacyRuntime;
    }
    await sleep(100);
  }
  return null;
}

async function waitForTavernHelper() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HELPER_WAIT_TIMEOUT) {
    if (globalThis.TavernHelper?._bind && globalThis._ && globalThis.$) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

function buildRuntimeDocument() {
  const snapshotOnly = readWorkshopMode() === 'snapshots';
  const appendRuntimeVersion = source => {
    const url = new URL(source);
    url.searchParams.set('pmm-version', EXTENSION_VERSION);
    return url.href;
  };
  const parentJqueryUrl = appendRuntimeVersion(new URL('../bridge/parent-jquery.js', import.meta.url).href);
  const predefineUrl = appendRuntimeVersion(new URL('../bridge/predefine.js', import.meta.url).href);
  const workshopUrl = appendRuntimeVersion(new URL('./workshop-v3.02.js', import.meta.url).href);
  /* 柏宝箱整组拖拽增强：必须排在 workshop 之后，才能在它建好面板后补上分组拖动能力。 */
  const groupStitchDragUrl = appendRuntimeVersion(new URL('./group-stitch-drag.js', import.meta.url).href);
  const snapshotOnlyUrl = appendRuntimeVersion(new URL('./snapshot-only.js', import.meta.url).href);
  const presetContentEditorUrl = appendRuntimeVersion(new URL('./preset-content-editor.js', import.meta.url).href);
  const worldbookStitchUrl = appendRuntimeVersion(new URL('./worldbook-stitch-test3.js', import.meta.url).href);
  const sharedFavoritesUrl = appendRuntimeVersion(new URL('./shared-favorites.js', import.meta.url).href);
  const worldbookSnapshotsUrl = appendRuntimeVersion(new URL('./worldbook-snapshots.js', import.meta.url).href);
  const worldbookLoaderKey = '__PMM_LOAD_WORLDBOOK_STITCH__';
  const regexManagerUrl = appendRuntimeVersion(new URL('./regex-manager.js', import.meta.url).href);
  const resourcesUrl = appendRuntimeVersion(new URL('./runtime-resources.js', import.meta.url).href);

  return `<!DOCTYPE html>
<html>
<head>
<base href="${location.origin}/">
${snapshotOnly ? '' : '<script src="https://testingcf.jsdelivr.net/npm/vue/dist/vue.runtime.global.prod.min.js"></script><script src="https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js"></script>'}
<script src="${parentJqueryUrl}"></script>
<script src="${predefineUrl}"></script>
${snapshotOnly ? '' : '<script src="https://testingcf.jsdelivr.net/gh/N0VI028/JS-Slash-Runner/src/iframe/node_modules/log.js"></script>'}
</head>
<body>
<script type="module">
import {createRuntimeScope} from ${JSON.stringify(resourcesUrl)};
window.__PMM_RUNTIME_SCOPE__ = createRuntimeScope(window);
</script>
${snapshotOnly ? '' : `<script>
(() => {
  let loading;
  window.__PMM_LOAD_REGEX_MANAGER__ = () => loading ||= import(${JSON.stringify(regexManagerUrl)}).catch(error => { loading = null; throw error; });
})();
(() => {
  const source = ${JSON.stringify(worldbookStitchUrl)};
  const loaderKey = ${JSON.stringify(worldbookLoaderKey)};
  const apiKey = '__PMM_WORLDBOOK_STITCH_TEST3__';
  let loading = null;

  const currentApi = () => {
    try { return window.parent?.[apiKey] || null; } catch (_) { return null; }
  };

  window[loaderKey] = () => {
    const ready = currentApi();
    if (typeof ready?.open === 'function') return Promise.resolve(ready);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = source;
      script.addEventListener('load', () => {
        const api = currentApi();
        if (typeof api?.open === 'function') resolve(api);
        else reject(new Error('世界书模块没有提供打开接口'));
      }, { once: true });
      script.addEventListener('error', () => reject(new Error('世界书模块载入失败')), { once: true });
      document.head.append(script);
    }).catch(error => {
      loading = null;
      throw error;
    });
    return loading;
  };
})();
</script>`}
${snapshotOnly ? `<script type="module" src="${snapshotOnlyUrl}"></script>` : `<script type="module" src="${presetContentEditorUrl}"></script>
<script type="module" src="${worldbookSnapshotsUrl}"></script>
<script type="module" src="${sharedFavoritesUrl}"></script>
<script type="module" src="${workshopUrl}"></script>
<script type="module" src="${groupStitchDragUrl}"></script>`}
</body>
</html>`;
}

export async function startPresetWorkshop() {
  if (startupPromise) return startupPromise;
  const generation = runtimeGeneration;
  const pending = startRuntime(generation);
  startupPromise = pending;
  try { return await pending; }
  finally { if (startupPromise === pending) startupPromise = null; }
}

async function startRuntime(generation) {
  installWorkshopModeSettings();
  startVersionWatcher();
  const currentRuntime = document.getElementById(RUNTIME_ID);
  if (currentRuntime) {
    return currentRuntime;
  }

  const legacyRuntime = findLegacyRuntime();
  if (legacyRuntime) {
    console.warn(`[${EXTENSION_NAME}] 检测到旧版酒馆助手脚本，扩展运行实例未重复启动。`);
    notify('warning', '检测到旧版脚本，请先停用旧版后再使用扩展版');
    return null;
  }

  if (!(await waitForTavernHelper())) {
    const message = '未检测到酒馆助手，请先安装并启用酒馆助手';
    console.error(`[${EXTENSION_NAME}] ${message}`);
    notify('error', message);
    return null;
  }

  if (generation !== runtimeGeneration) return null;
  const delayedLegacyRuntime = await waitForLegacyRuntime();
  if (generation !== runtimeGeneration) return null;
  if (delayedLegacyRuntime) {
    console.warn(`[${EXTENSION_NAME}] 检测到稍后启动的旧版酒馆助手脚本，扩展运行实例未重复启动。`);
    notify('warning', '检测到旧版脚本，请先停用旧版后再使用扩展版');
    return null;
  }

  const iframe = document.createElement('iframe');
  iframe.id = RUNTIME_ID;
  iframe.name = RUNTIME_ID;
  iframe.hidden = true;
  iframe.srcdoc = buildRuntimeDocument();
  document.body.appendChild(iframe);

  iframe.addEventListener('load', () => {
    console.info(`[${EXTENSION_NAME}] GitHub 扩展运行环境已启动（v${EXTENSION_VERSION}）`);
  }, { once: true });

  return iframe;
}

export function stopPresetWorkshop() {
  runtimeGeneration++;
  startupPromise = null;
  stopVersionWatcher();
  clearPendingExtensionUpdateReload();
  try { globalThis.__PMM_PRESET_CONTENT_EDITOR_V1__?.cleanup?.(); } catch (_) {}
  try { globalThis.__PMM_PRESET_SNAPSHOT_LINKS__?.cleanup?.(); } catch (_) {}
  try { globalThis.__PMM_PRESET_SNAPSHOT_STORAGE__?.cleanup?.(); } catch (_) {}
  const runtime = document.getElementById(RUNTIME_ID);
  runtime?.contentWindow?.__PMM_RUNTIME_SCOPE__?.dispose();
  runtime?.remove();
}

let restarting = null;
export function restartPresetWorkshop() {
  if (restarting) return restarting;
  restarting = (async () => {
    stopPresetWorkshop();
    const runtime = await startPresetWorkshop();
    if (!runtime) throw Error('工坊启动失败，请检查酒馆助手是否启用');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('工坊启动超时，请稍后重试')), 30000);
      runtime.addEventListener('load', () => {clearTimeout(timer);resolve();}, {once:true});
    });
  })().finally(() => { restarting = null; });
  return restarting;
}

globalThis.__ST_PRESET_WORKSHOP__ = {
  start: startPresetWorkshop,
  stop: stopPresetWorkshop,
  restart: restartPresetWorkshop,
  version: EXTENSION_VERSION,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void startPresetWorkshop(), { once: true });
} else {
  void startPresetWorkshop();
}
