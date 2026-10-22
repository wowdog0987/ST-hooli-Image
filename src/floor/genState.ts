import { reactive } from 'vue';

/**
 * 樓層卡片「生成執行態」的模組級 store。
 *
 * 為什麼必須放在元件外:卡片的生命週期由水合決定,不由它自己決定。任一槽位出圖成功都會
 * 調 hydrateMessage 重水合,而重水合會解除安裝**整樓**卡片(hydrate.ts)——ST 重渲染樓層時
 * 錨點 DOM 本身也會重建。執行態若存在元件 ref 裡,卡片一被重建就清零:兄弟卡片的
 * 「生成中…」憑空消失、退回 pending,而 autoGenerate 標記早已消費掉不會再跑。
 * 把 phase/error/controller 提到這裡,卡片退化成純展示層,重建後按 key 認領回自己的狀態。
 *
 * key = chatId|messageId|swipeId|seq,與 floor/registry.ts、floor/autoGenerate.ts 同構
 * (DESIGN-FLOOR-UI.md §8.1 的「任務身份」)。
 */

/** 執行態相位。派生態(pending/ready/stale)由卡片按 props 自行判斷,不進 store。 */
export type GenPhase = 'queued' | 'generating' | 'error';

export interface GenRecord {
  phase: GenPhase;
  /** error 相位的錯誤資訊;其餘相位為空串。 */
  error: string;
  /**
   * 佇列中前面還有幾個任務(ComfyUI 服務端佇列)。
   * 0 = 已輪到自己執行;null = 未知(NAI 無佇列概念,或佇列介面不可用)。
   */
  queueAhead: number | null;
  /**
   * 限流退避進度:非 null 表示請求失敗了、正在等著重試(見 backends/naiRateLimit.ts)。
   * 必須讓使用者看見 —— 否則卡片會掛著一動不動的「生成中…」幾十秒,
   * 使用者只會以為卡死了,再點一次,那就白白多壓一個請求上去。
   */
  retry: { attempt: number; max: number } | null;
  /**
   * 發起時的 promptHash。重水合後卡片用它確認「在途任務屬於當前提示詞」——
   * 使用者中途改了 tag,key 不變但 hash 變,舊任務的結果已無意義(見 reconcile)。
   */
  hash: string;
  /**
   * 本次任務的唯一票據。**key 不足以標識任務**:同一槽位可以先後跑多個任務
   * (取消後重繪、reconcile 後重來),它們共用 key。舊任務遲到的回撥必須憑票據認領,
   * 否則會改到新任務的記錄上——例如 A 被 abort 後以非 AbortError 失敗(HTTP 500/429
   * 與 abort 撞在一起),其 catch 會把**正在跑的 B** 標成 error:UI 顯示紅字報錯、
   * 「取消」按鈕變回「重繪」,使用者還能在 B 之上再開一個任務。
   */
  token: number;
}

export function slotKey(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

/** 展示態:進 reactive,卡片 computed 直接讀。 */
const records = reactive(new Map<string, GenRecord>());

/**
 * AbortController 另存一張普通 Map,不進 reactive:
 * controller 不是展示資料,包成 Proxy 只有開銷沒有收益。
 */
const controllers = new Map<string, AbortController>();

export function getGenRecord(key: string): GenRecord | undefined {
  return records.get(key);
}

/** 單調遞增的任務票據。 */
let nextToken = 1;

/** 本次任務的控制代碼:signal 傳給後端,token 用於所有回寫(防舊任務改到新任務頭上)。 */
export interface GenHandle {
  signal: AbortSignal;
  token: number;
}

/**
 * 開始一次生成:登記執行態並返回本次任務控制代碼。
 * 同 key 已有在途任務時先中止舊的(同一槽位不允許兩個任務並存,後發者為準)。
 */
export function beginGen(key: string, hash: string, phase: GenPhase = 'generating'): GenHandle {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  const token = nextToken++;
  records.set(key, { phase, error: '', queueAhead: null, retry: null, hash, token });
  return { signal: controller.signal, token };
}

/** 票據不符 = 呼叫來自已被取代的舊任務,一律忽略。 */
function owned(key: string, token: number): GenRecord | null {
  const record = records.get(key);
  return record && record.token === token ? record : null;
}

/** 本任務是否仍是該槽位的當前任務(落盤前自檢,別把舊任務的圖寫進 extra)。 */
export function isCurrentGen(key: string, token: number): boolean {
  return !!owned(key, token);
}

/** 相位推進(queued → generating):任務不變,只改展示。 */
export function setGenPhase(key: string, token: number, phase: GenPhase): void {
  const record = owned(key, token);
  if (record) record.phase = phase;
}

/** 更新排隊位置(ComfyUI 輪詢期間上報)。 */
export function setQueueAhead(key: string, token: number, ahead: number | null): void {
  const record = owned(key, token);
  if (record) record.queueAhead = ahead;
}

/** 更新限流退避進度(NAI 重試期間上報;傳 null 表示已不在退避中)。 */
export function setGenRetry(
  key: string,
  token: number,
  retry: { attempt: number; max: number } | null,
): void {
  const record = owned(key, token);
  if (record) record.retry = retry;
}

/** 生成成功/放棄:清執行態,卡片回落到派生態(ready/stale/pending)。 */
export function clearGen(key: string, token?: number): void {
  // 不帶 token 表示無條件清(取消/全量重建);帶 token 時只有本任務仍在位才清
  if (token !== undefined && !owned(key, token)) return;
  controllers.delete(key);
  records.delete(key);
}

/** 生成失敗:保留 error 相位與資訊(重水合後仍能看到失敗原因),controller 已無用。 */
export function failGen(key: string, token: number, message: string): void {
  const record = owned(key, token);
  if (!record) return;
  controllers.delete(key);
  record.phase = 'error';
  record.error = message;
  record.queueAhead = null;
  // 退避已經結束(重試次數用盡才走到這兒),別讓紅字上面還掛著「稍後重試」
  record.retry = null;
}

/** 使用者取消:中止在途請求並清執行態。無在途任務時是安全空操作。 */
export function cancelGen(key: string): void {
  controllers.get(key)?.abort();
  clearGen(key);
}

/**
 * 提示詞已變時的對賬:在途任務的 hash 與當前卡片 hash 不一致 → 該任務屬於舊提示詞,
 * 中止並清掉(卡片隨即按 stale/pending 展示)。error 相位同理作廢,不然改完 tag
 * 還掛著上一版的報錯。返回 true 表示確實清理了。
 */
export function reconcileGen(key: string, hash: string): boolean {
  const record = records.get(key);
  if (!record || record.hash === hash) return false;
  cancelGen(key);
  return true;
}

/** 中止並清空全部(切聊天 / 刪樓後的全量重建)。 */
export function clearAllGen(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  records.clear();
}

/**
 * 中止並清掉某 swipe 下「已不存在的槽位」記錄(seq >= keepCount)。
 *
 * 為什麼需要它:reconcileGen 只能由**掛載著的卡片**觸發,而槽位可能整個消失——
 * 使用者把 tag 從正文裡刪掉、或 swipe 到 tag 更少的一版,那些槽位再也沒有卡片來對賬,
 * 記錄(尤其 failGen 留下的 error)會永久留在 Map 裡;之後同一 key 若重新出現
 * (重新生成 tag,回到相同 messageId|swipeId|seq),新卡片會認領到上一輪的舊報錯。
 *
 * **只刪越界槽位**,不動 seq < keepCount 的:hydrateMessage 在每次出圖成功後都會跑,
 * 那時兄弟槽位往往正在生成中,連它們一起清會把在途請求全 abort 掉
 * ——那正是本次重構要修的 bug,不能在這兒以另一種形式復現。
 */
export function pruneGenSlots(
  chatId: string,
  messageId: number,
  swipeId: number,
  keepCount: number,
): void {
  const prefix = `${chatId}|${messageId}|${swipeId}|`;
  for (const key of [...records.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const seq = Number(key.slice(prefix.length));
    if (Number.isInteger(seq) && seq >= keepCount) cancelGen(key);
  }
}

/** 當前在途(queued/generating)任務數,按後端併發閘門統計用。 */
export function activeGenCount(): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.phase === 'queued' || record.phase === 'generating') count++;
  }
  return count;
}
