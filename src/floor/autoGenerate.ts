/**
 * 「寫入 tag 後自動生成圖片」握手(autoTag.autoGenerate,預設開)。
 *
 * 時序:runner 寫入 tag 前為每個新槽位掛上標記 → applyMessageText 內部觸發
 * MESSAGE_EDITED / MESSAGE_UPDATED → 樓層重渲染、卡片水合掛載 →
 * 卡片 onMounted 消費本槽位標記並自動開始生成。
 *
 * 標記一次性:消費即刪,重水合不會重複觸發;樓層懶渲染(群聊等)時標記暫存,
 * 等樓層真正渲染再消費;切聊天/刪樓時整體清空,避免汙染其它聊天或舊槽位。
 *
 * 兩種模式(mode):
 * - 'auto':自動流程(runner 寫完 tag)。僅在「這條提示詞還沒有圖」時才開跑,
 *   已有結果/在途任務時讓位給使用者手動操作。
 * - 'force':使用者明確點了「應用並重新生成」(提示詞編輯彈窗)。無條件開跑 ——
 *   來回改回舊提示詞時該桶可能已有歷史(phase=ready),但使用者要的就是新圖。
 */

/** 標記模式:見檔案頭註釋。 */
export type AutoGenerateMode = 'auto' | 'force';

/** 卡片展示相位(與 Card.vue 的 Phase 同構;這裡只列判定用得到的)。 */
export type AutoGeneratePhase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const flags = new Map<string, AutoGenerateMode>();

function key(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

export function markForAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
  mode: AutoGenerateMode = 'auto',
): void {
  flags.set(key(chatId, messageId, swipeId, seq), mode);
}

/** 消費本槽位的自動生成標記:有則刪除並返回其模式(只觸發一次),無則 null。 */
export function consumeAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
): AutoGenerateMode | null {
  const k = key(chatId, messageId, swipeId, seq);
  const mode = flags.get(k);
  if (mode === undefined) return null;
  flags.delete(k);
  return mode;
}

/**
 * 該不該真的開跑。**刻意做成純函式**:Card.vue 沒有單測(倉裡沒裝 jsdom /
 * @vue/test-utils,vitest 跑在 node 環境),判定留在元件裡就鎖不住。
 *
 * 'auto' 放過 pending 與 **stale**:stale 的含義正是「tag 變了、當前提示詞還沒有圖」,
 * 這恰恰是該自動出圖的時刻。曾經這裡只放 pending,導致樓層「重新生成 tag」在已出過圖的
 * 樓層上靜默失效(新 tag 寫進去了、卡片卻停在舊圖不動);多 tag 樓層更怪 —— 有舊圖的
 * 槽位被攔、純新增的槽位照跑,看起來「一半在生成一半不動」。
 *
 * ready / queued / generating / error 仍然不放:已有本提示詞的結果、已有在途任務,
 * 或上一輪剛失敗(重試交給使用者點,免得錯誤配置下自動重試打滿後端)。
 */
export function shouldAutoGenerate(mode: AutoGenerateMode, phase: AutoGeneratePhase): boolean {
  if (mode === 'force') return true;
  return phase === 'pending' || phase === 'stale';
}

/** 撤銷某樓層的全部標記(寫回正文失敗時呼叫)。 */
export function clearAutoGenerateForFloor(chatId: string, messageId: number): void {
  const prefix = `${chatId}|${messageId}|`;
  for (const k of [...flags.keys()]) {
    if (k.startsWith(prefix)) flags.delete(k);
  }
}

/** 清空全部標記(切聊天 / 刪樓後的全量重建時呼叫)。 */
export function clearAutoGenerateFlags(): void {
  flags.clear();
}
