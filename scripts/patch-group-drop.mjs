/**
 * PMM_GROUP_DROP_POSITION_V29812
 *
 * 问题：分组跨面板拖到某个条目上时，j() 里只要目标条目属于某个 section，
 * 就会传 { mergeIntoSection:true } → handleCrossPanelDrop 里
 * moveItemsToSectionById(..., 'end')，把整组追加到 section 末尾，忽略 before/after 位置。
 *
 * 修复：只有 'into'（拖到条目中间）才合并到 section 末尾；
 * before / after（拖动时出现横线的位置）改为传 void 0，让 handleCrossPanelDrop
 * 按 targetId + position 插入，并创建同名新分组。
 *
 * 只改这一处压缩代码，其余逻辑保持原样。脚本幂等，重复执行不会重复改。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'dist/workshop-v3.02.js';
const MARKER = 'PMM_GROUP_DROP_POSITION_V29812';

const source = readFileSync(FILE, 'utf8');
if (source.includes(MARKER)) {
  console.log('[patch-group-drop] 已经打过补丁，跳过。');
  process.exit(0);
}

const before = "if(o&&r.sectionGroupMode){const i=_pmmDropSectionId||await S.getItemSectionById(e,r.presetName);if(i){if(a!==r.side)A.length>0&&s('cross-panel-drop',A,e,n,i,{...o,mergeIntoSection:!0});else{";
const after = "if(o&&r.sectionGroupMode){/*" + MARKER + "*/const i=_pmmDropSectionId||await S.getItemSectionById(e,r.presetName);if(i){if(a!==r.side)A.length>0&&s('cross-panel-drop',A,e,n,'into'===n?i:void 0,'into'===n?{...o,mergeIntoSection:!0}:o);else{";

const hits = source.split(before).length - 1;
if (hits !== 1) {
  console.error(`[patch-group-drop] 期望匹配 1 处，实际 ${hits} 处，压缩代码可能已变化，请人工检查。`);
  process.exit(1);
}

writeFileSync(FILE, source.replace(before, after), 'utf8');
console.log('[patch-group-drop] 已修复：分组拖动 before/after 按位置插入，into 仍然合并到分组末尾。');
