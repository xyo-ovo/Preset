/* ===== PMM_GROUP_STITCH_DRAG_V29811：柏宝箱整组拖拽（缝合/跨面板）性能与可用性增强 =====
 * 设计原则：
 * 1. 不接管业务 drop 逻辑，只补齐「分组头可拖」+「拖动期间不卡顿」+「松手不误折叠」。
 * 2. 与 V266 / V290 的拖拽兼容层共存：它们负责把触摸/Windows 指针手势合成为 drag 事件，
 *    本补丁只做增强，不重复派发 dragstart/drop。
 * 3. 所有操作 try/catch 包裹，任何异常都不影响主面板。
 */
;(() => {
  'use strict';
  const TOP = (() => { try { return window.top || window; } catch (_) { return window; } })();
  const DOC = (() => { try { return TOP.document || document; } catch (_) { return document; } })();
  const ROOT_SELECTOR = '#preset-manager-main-panel';
  const API_KEY = '__PMM_GROUP_STITCH_DRAG_V29811__';
  const STYLE_ID = 'pmm-group-stitch-drag-style';
  const HEADER_SELECTOR = '.section-header';
  const CARD_SELECTOR = '[data-section-id]';
  const ITEM_SELECTOR = '[data-prompt-id]';
  const NAME_SELECTOR = '.section-header__name';
  const DRAG_CLASS = 'pmm-group-drag-active';
  const DRAGGING_CLASS = 'pmm-group-dragging';
  const CLICK_SUPPRESS_MS = 420;

  try { TOP[API_KEY]?.cleanup?.(); } catch (_) {}

  let observer = null;
  let suppressClickUntil = 0;
  let session = null;
  let installed = false;

  /* 兼容 runtime scope 包装：workshop 通过 window.__PMM_RUNTIME_SCOPE__ 把 DOM 操作代理到父窗口 */
  function pmmRuntimeResource(target) { return TOP.__PMM_RUNTIME_SCOPE__?.own?.(target) || target; }

  function installStyle() {
    DOC.getElementById(STYLE_ID)?.remove();
    const style = pmmRuntimeResource(DOC).createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
html.${DRAG_CLASS}, html.${DRAG_CLASS} body { cursor: grabbing !important; }
html.${DRAG_CLASS} ${ROOT_SELECTOR} { user-select: none !important; -webkit-user-select: none !important; }
/* 整组拖动时：关掉所有会触发重绘的过渡/阴影/滤镜，避免 N 条同时重排造成卡顿 */
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-card,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-item,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .section-card,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .section-group,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .section-header {
  transition: none !important;
  animation: none !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
}
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-card,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-item {
  contain: layout paint style !important;
}
/* 被拖动的整组条目只做极轻的视觉提示，避免每帧刷新 */
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-card--dragging,
html.${DRAG_CLASS} ${ROOT_SELECTOR} .prompt-item--dragging {
  opacity: .5 !important;
  transform: none !important;
}
${ROOT_SELECTOR} ${HEADER_SELECTOR}.${DRAGGING_CLASS} {
  opacity: .66;
  cursor: grabbing;
}
${ROOT_SELECTOR} ${HEADER_SELECTOR}[draggable="true"] { cursor: grab; }
${ROOT_SELECTOR} ${HEADER_SELECTOR}[draggable="true"]:active { cursor: grabbing; }
`;
    (pmmRuntimeResource(DOC.head || DOC.documentElement)).appendChild(style);
  }

  function isEditingHeader(header) {
    return Boolean(header.classList.contains('section-header--editing')
      || header.querySelector('.section-header__input, input, textarea'));
  }

  /* 给分组头补 draggable：只在 Vue 没有渲染 draggable 时补一次，不动已有属性 */
  function ensureDraggable(header) {
    try {
      if (!header || header.getAttribute('draggable') === 'true' || isEditingHeader(header)) return;
      header.setAttribute('draggable', 'true');
    } catch (_) {}
  }

  function scan(root = DOC) {
    try {
      if (root?.nodeType === 1 && root.matches?.(`${ROOT_SELECTOR} ${CARD_SELECTOR} > ${HEADER_SELECTOR}`)) {
        ensureDraggable(root);
      }
      root?.querySelectorAll?.(`${ROOT_SELECTOR} ${CARD_SELECTOR} > ${HEADER_SELECTOR}, ${ROOT_SELECTOR} ${CARD_SELECTOR} ${HEADER_SELECTOR}`)
        ?.forEach(ensureDraggable);
    } catch (_) {}
  }

  function readGroupPayload(header) {
    const card = header.closest(CARD_SELECTOR);
    if (!card) return null;
    const sectionId = String(card.getAttribute('data-section-id') || '').trim();
    if (!sectionId) return null;
    const title = String(header.querySelector(NAME_SELECTOR)?.textContent || header.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const ids = Array.from(card.querySelectorAll(ITEM_SELECTOR))
      .map(el => String(el.getAttribute('data-prompt-id') || '').trim())
      .filter(Boolean);
    return { sectionId, title, ids };
  }

  function markDragging(header) {
    try { DOC.documentElement.classList.add(DRAG_CLASS); } catch (_) {}
    try { header.classList.add(DRAGGING_CLASS); } catch (_) {}
  }

  function clearDragging() {
    session = null;
    try { DOC.documentElement.classList.remove(DRAG_CLASS); } catch (_) {}
    try {
      DOC.querySelectorAll(`${HEADER_SELECTOR}.${DRAGGING_CLASS}`)
        .forEach(el => el.classList.remove(DRAGGING_CLASS));
    } catch (_) {}
  }

  function finishDrag(shouldSuppressClick) {
    if (!session) return;
    clearDragging();
    if (shouldSuppressClick) suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
  }

  /* 捕获阶段记录整组 payload：Vue 自己的 dragstart 仍会执行，本函数只补充 dataTransfer */
  function onDragStart(event) {
    try {
      const target = event.target;
      const header = target?.closest?.(HEADER_SELECTOR);
      if (!header || !header.closest?.(ROOT_SELECTOR)) return;
      /* 从分组头里按下按钮/输入框时不参与整组拖动 */
      if (target.closest?.('button,input,textarea,select,a,[contenteditable="true"]')) return;
      const payload = readGroupPayload(header);
      if (!payload) return;
      session = { ...payload, header, transfer: event.dataTransfer || null };
      markDragging(header);
      const transfer = event.dataTransfer;
      if (transfer) {
        try { transfer.effectAllowed = 'copyMove'; } catch (_) {}
        try {
          /* 只在 Vue 没写数据时补一个标记，绝不覆盖已有数据 */
          if (!transfer.getData?.('text/plain')) {
            transfer.setData('text/plain', `pmm-section:${payload.sectionId}`);
          }
        } catch (_) {}
      }
      try { TOP.__PMM_GROUP_DRAG_PAYLOAD__ = { ...payload }; } catch (_) {}
    } catch (_) {}
  }

  function onDragEnd() {
    try { finishDrag(true); } catch (_) {}
    try { TOP.__PMM_GROUP_DRAG_PAYLOAD__ = null; } catch (_) {}
  }

  function onDrop() {
    /* drop 后紧跟着的 dragend 也会触发，这里只负责抑制随后的 click */
    try { finishDrag(true); } catch (_) {}
    try { TOP.__PMM_GROUP_DRAG_PAYLOAD__ = null; } catch (_) {}
  }

  function onClickCapture(event) {
    if (Date.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    try {
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch (_) {}
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && session) finishDrag(false);
  }

  function onWindowBlur() {
    if (session) finishDrag(false);
  }

  function install() {
    if (installed) return;
    installed = true;
    installStyle();
    scan();
    try {
      observer = new TOP.MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) scan(node);
        }
      });
      pmmRuntimeResource(observer).observe(DOC.documentElement, { childList: true, subtree: true });
    } catch (_) {
      observer = null;
    }
    pmmRuntimeResource(DOC).addEventListener('dragstart', onDragStart, true);
    pmmRuntimeResource(DOC).addEventListener('dragend', onDragEnd, true);
    pmmRuntimeResource(DOC).addEventListener('drop', onDrop, true);
    pmmRuntimeResource(DOC).addEventListener('click', onClickCapture, true);
    pmmRuntimeResource(DOC).addEventListener('keydown', onKeyDown, true);
    pmmRuntimeResource(TOP).addEventListener('blur', onWindowBlur);
    console.info('[预设工坊] V2.98.11 已加载：柏宝箱分组可整组拖动到缝合预设，拖动期间关闭重绘动画。');
  }

  function cleanup() {
    if (!installed) return;
    installed = false;
    try { pmmRuntimeResource(observer)?.disconnect?.(); } catch (_) {}
    observer = null;
    clearDragging();
    try {
      pmmRuntimeResource(DOC).removeEventListener('dragstart', onDragStart, true);
      pmmRuntimeResource(DOC).removeEventListener('dragend', onDragEnd, true);
      pmmRuntimeResource(DOC).removeEventListener('drop', onDrop, true);
      pmmRuntimeResource(DOC).removeEventListener('click', onClickCapture, true);
      pmmRuntimeResource(DOC).removeEventListener('keydown', onKeyDown, true);
      pmmRuntimeResource(TOP).removeEventListener('blur', onWindowBlur);
    } catch (_) {}
    try { DOC.getElementById(STYLE_ID)?.remove(); } catch (_) {}
    try { if (TOP[API_KEY]?.cleanup === cleanup) delete TOP[API_KEY]; } catch (_) {}
  }

  try {
    TOP[API_KEY] = { cleanup, install, get session() { return session; } };
    globalThis[API_KEY] = TOP[API_KEY];
  } catch (_) {}

  if (DOC.readyState === 'loading') {
    pmmRuntimeResource(DOC).addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
