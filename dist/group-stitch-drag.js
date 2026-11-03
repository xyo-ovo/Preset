/* ===== PMM_GROUP_STITCH_DRAG_V29812：柏宝箱整组拖拽增强（轻量版） =====
 * V2.98.11 的两个问题：
 * 1. 给条目加 contain: layout paint style → 影响 getBoundingClientRect/elementFromPoint，
 *    拖放位置判定失真，还触发额外布局计算；
 * 2. MutationObserver 在整个 document 上 subtree 扫描 → 拖动时 DOM 一变化就全树 querySelectorAll，
 *    单条拖动也被拖慢。
 * 本版只保留「分组头可拖」+「拖动期间关掉重绘动画」+「松手不误折叠」，
 * 不再干预 dataTransfer，不再给条目加 contain，observer 只盯面板根节点并做 rAF 节流。
 */
;(() => {
  'use strict';
  const TOP = (() => { try { return window.top || window; } catch (_) { return window; } })();
  const DOC = (() => { try { return TOP.document || document; } catch (_) { return document; } })();
  const ROOT_SELECTOR = '#preset-manager-main-panel';
  const API_KEY = '__PMM_GROUP_STITCH_DRAG_V29812__';
  const STYLE_ID = 'pmm-group-stitch-drag-style';
  const HEADER_SELECTOR = '.section-header';
  const CARD_SELECTOR = '[data-section-id]';
  const DRAG_CLASS = 'pmm-group-drag-active';
  const DRAGGING_CLASS = 'pmm-group-dragging';
  const CLICK_SUPPRESS_MS = 300;

  try { TOP[API_KEY]?.cleanup?.(); } catch (_) {}

  let observer = null;
  let scanFrame = 0;
  let pendingNodes = [];
  let suppressClickUntil = 0;
  let session = null;
  let installed = false;

  function pmmRuntimeResource(target) { return TOP.__PMM_RUNTIME_SCOPE__?.own?.(target) || target; }

  function installStyle() {
    DOC.getElementById(STYLE_ID)?.remove();
    const style = pmmRuntimeResource(DOC).createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* 只关掉会触发重绘/合成的属性，不碰 layout 计算 */
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
${ROOT_SELECTOR} ${HEADER_SELECTOR}.${DRAGGING_CLASS} {
  opacity: .7;
  cursor: grabbing;
}
${ROOT_SELECTOR} ${HEADER_SELECTOR}[draggable="true"] { cursor: grab; }
${ROOT_SELECTOR} ${HEADER_SELECTOR}[draggable="true"]:active { cursor: grabbing; }
`;
    (pmmRuntimeResource(DOC.head || DOC.documentElement)).appendChild(style);
  }

  function isEditingHeader(header) {
    return Boolean(header.classList.contains('section-header--editing')
      || header.querySelector('.section-header__input'));
  }

  function ensureDraggable(header) {
    try {
      if (!header || header.getAttribute('draggable') === 'true' || isEditingHeader(header)) return;
      header.setAttribute('draggable', 'true');
    } catch (_) {}
  }

  function scanNode(node) {
    try {
      if (!node || node.nodeType !== 1) return;
      if (node.matches?.(`${CARD_SELECTOR} > ${HEADER_SELECTOR}`)) ensureDraggable(node);
      const list = node.querySelectorAll?.(`${CARD_SELECTOR} > ${HEADER_SELECTOR}`);
      if (list?.length) list.forEach(ensureDraggable);
    } catch (_) {}
  }

  function flushScan() {
    scanFrame = 0;
    const nodes = pendingNodes;
    pendingNodes = [];
    for (const node of nodes) scanNode(node);
  }

  function queueScan(node) {
    pendingNodes.push(node);
    if (scanFrame) return;
    scanFrame = pmmRuntimeResource(TOP).requestAnimationFrame
      ? pmmRuntimeResource(TOP).requestAnimationFrame(flushScan)
      : pmmRuntimeResource(TOP).setTimeout(flushScan, 16);
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

  /* 只记录会话用于样式与 click 抑制，绝不改 dataTransfer，避免影响 Vue 的位置判定 */
  function onDragStart(event) {
    try {
      const target = event.target;
      const header = target?.closest?.(HEADER_SELECTOR);
      if (!header || !header.closest?.(ROOT_SELECTOR)) return;
      if (target.closest?.('button,input,textarea,select,a,[contenteditable="true"]')) return;
      session = { header };
      markDragging(header);
    } catch (_) {}
  }

  function onDragEnd() {
    try { finishDrag(true); } catch (_) {}
  }

  function onDrop() {
    try { finishDrag(true); } catch (_) {}
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
    try {
      DOC.querySelectorAll(`${ROOT_SELECTOR} ${CARD_SELECTOR} > ${HEADER_SELECTOR}`)
        .forEach(ensureDraggable);
    } catch (_) {}
    try {
      const root = DOC.querySelector(ROOT_SELECTOR);
      if (root) {
        observer = new TOP.MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node?.nodeType === 1) queueScan(node);
            }
          }
        });
        /* 只盯面板内部，不再整页 subtree 扫描 */
        pmmRuntimeResource(observer).observe(root, { childList: true, subtree: true });
      }
    } catch (_) {
      observer = null;
    }
    pmmRuntimeResource(DOC).addEventListener('dragstart', onDragStart, true);
    pmmRuntimeResource(DOC).addEventListener('dragend', onDragEnd, true);
    pmmRuntimeResource(DOC).addEventListener('drop', onDrop, true);
    pmmRuntimeResource(DOC).addEventListener('click', onClickCapture, true);
    pmmRuntimeResource(DOC).addEventListener('keydown', onKeyDown, true);
    pmmRuntimeResource(TOP).addEventListener('blur', onWindowBlur);
    console.info('[预设工坊] V2.98.12 已加载：分组可整组拖动，拖动期间只关重绘不碰布局。');
  }

  function cleanup() {
    if (!installed) return;
    installed = false;
    try { pmmRuntimeResource(observer)?.disconnect?.(); } catch (_) {}
    observer = null;
    pendingNodes = [];
    if (scanFrame) {
      try {
        if (pmmRuntimeResource(TOP).cancelAnimationFrame) pmmRuntimeResource(TOP).cancelAnimationFrame(scanFrame);
        else pmmRuntimeResource(TOP).clearTimeout(scanFrame);
      } catch (_) {}
      scanFrame = 0;
    }
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
