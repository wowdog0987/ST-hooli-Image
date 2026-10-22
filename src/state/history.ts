import { reactive } from 'vue';

import type { ChatMsg } from '@/api/client';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';

/**
 * 請求歷史(副 API 推理 + 生圖)的模組級記憶體 store。
 *
 * **刻意不持久化**:重新整理頁面即清空,不進 settings、不落 localStorage。
 * 這是除錯輔助——出問題時回看這一輪發了什麼、收到什麼,而不是要長期儲存的資產。
 * 想留證據請在頁面裡複製出去。
 *
 * 為什麼放模組級而非元件裡:請求由 autoTag/Card 等處發起,歷史頁可能壓根沒開啟過;
 * 記錄必須活得比任何元件都長。與 floor/genState.ts 同構。
 *
 * 【重要】本模組的所有寫入函式都必須是「不會拋」的:呼叫方在真實業務路徑上
 * (發請求、出圖),歷史記錄失敗絕不能連累主流程。故 record() 內部吞異常,
 * 且呼叫方仍應用 safe*() 包裝(見 api/client.ts 的用法)。
 */

/** 條數上限。副 API 的提示詞很大(世界書+角色庫+正文),不封頂幾十條就是幾十 MB。 */
const MAX_RECORDS = 50;

/**
 * 單條文本留存上限。超出截斷並標註原長——
 * buildAutoTagMessages 拼出的 system 提示詞輕鬆上萬字,50 條全量留存記憶體吃不消。
 */
const MAX_CONTENT = 20_000;

export type HistoryKind = 'llm' | 'image';

/** running 是進行中;aborted 是使用者主動取消(與 error 分開,不是故障)。 */
export type HistoryStatus = 'running' | 'ok' | 'error' | 'aborted';

interface BaseRecord {
  /** 自增序號,**不用 Date.now()**:同一毫秒內併發的多個請求會撞成同一 id。 */
  id: number;
  kind: HistoryKind;
  status: HistoryStatus;
  startedAt: number;
  /** 完成後才有;進行中為 null。 */
  durationMs: number | null;
  /** status='error' 時的錯誤資訊,其餘為空串。 */
  error: string;
}

export interface LlmRecord extends BaseRecord {
  kind: 'llm';
  /** 用途標籤:'自動 tag' / '角色外貌轉換' / 'ComfyUI 工作流配置' 等,由呼叫點傳入。 */
  source: string;
  /** 渠道名;未指派渠道(跟隨主 API)時為 FOLLOW_MAIN_API。 */
  channelName: string;
  model: string;
  stream: boolean;
  /** 完整提示詞(已按 MAX_CONTENT 截斷)。 */
  messages: ChatMsg[];
  /** 返回正文(已截斷)。 */
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * token 數是否為本地估算。
   * 真值只在「自建渠道 + 非流式」時拿得到(ST 代理原樣透傳上游 usage);
   * 流式與跟隨主 API 只能用 ST 分詞器估——而它用的是**主介面當前模型**的分詞器,
   * 與副 API 渠道模型未必同源。故 UI 必須用 ≈ 區分,不能與真值混顯。
   */
  tokensEstimated: boolean;
}

export interface ImageRecord extends BaseRecord {
  kind: 'image';
  backend: 'nai' | 'comfyui';
  /** NAI 模型名 / ComfyUI 當前工作流預設名。 */
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  /** 樓層座標:詳情裡據此指回是哪一樓哪個槽位。圖片本身不存(見檔案頭)。 */
  floor: number;
  seq: number;
}

export type HistoryRecord = LlmRecord | ImageRecord;

/** 跟隨主 API 時的渠道名佔位。 */
export const FOLLOW_MAIN_API = '跟隨主 API';

/**
 * 全部記錄,**新的在前**(頁面直接 v-for,不用每次 reverse)。
 * 因此「丟最舊」= 從尾部 pop。
 */
export const records = reactive<HistoryRecord[]>([]);

let nextId = 1;

/** 超長文本截斷並標註原長;短文本原樣返回(不產生新字串)。 */
export function truncate(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_CONTENT) return text;
  return `${text.slice(0, MAX_CONTENT)}\n…(已截斷，原長 ${text.length} 字元)`;
}

/** 中日韓表意文字/假名/諺文/全形標點:這些大致 1 字 = 1 token。 */
const CJK_PATTERN =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/**
 * 單段文本的 token 粗估(同步、純本地)。
 *
 * 為什麼不用 ST 的 getTokenCountAsync:那是非同步 HTTP(打 /api/tokenizers/…),
 * 展開一條 8 段的記錄就是 8 個請求;而這裡的數字只用於**段與段之間比大小**
 * (「哪段把提示詞撐爆了」),不需要精確。
 *
 * 口徑:中日韓按 1 字 1 token,其餘(拉丁字母/數字/符號)按 4 字元 1 token——
 * BPE 分詞器的通用經驗值。**必然與真實用量有出入**,故 UI 上一律帶 ≈ 顯示,
 * 也不要拿各段之和去對標題行那個真值(那是上游 usage,口徑不同)。
 */
export function roughTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  // for...of 按碼點遍歷,代理對(emoji/罕見漢字)算一個字元而非兩個
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return Math.round(cjk + rest / 4);
}

function truncateMessages(messages: ChatMsg[]): ChatMsg[] {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => ({ role: m.role, content: truncate(m.content) }));
}

/** 壓入一條並維持封頂。新記錄進頭部,超出時從尾部(最舊)丟棄。 */
function push(record: HistoryRecord): void {
  records.unshift(record);
  while (records.length > MAX_RECORDS) records.pop();
}

/**
 * 按 id 找記錄。返回 undefined 表示已被擠出封頂——
 * 長請求期間若前面湧進 50 條新記錄,它就沒了,此時 finish/fail 是安全空操作。
 */
function find(id: number): HistoryRecord | undefined {
  return records.find(r => r.id === id);
}

export interface LlmBegin {
  source: string;
  channelName: string;
  model: string;
  stream: boolean;
  messages: ChatMsg[];
}

/** 登記一次副 API 請求,返回 id 供後續 finish/fail。 */
export function beginLlm(info: LlmBegin): number {
  const id = nextId++;
  push({
    id,
    kind: 'llm',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    source: info.source,
    channelName: info.channelName,
    model: info.model,
    stream: info.stream,
    messages: truncateMessages(info.messages),
    response: '',
    promptTokens: null,
    completionTokens: null,
    tokensEstimated: false,
  });
  return id;
}

export interface LlmFinish {
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensEstimated: boolean;
}

export function finishLlm(id: number, info: LlmFinish): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
  record.response = truncate(info.response);
  record.promptTokens = info.promptTokens;
  record.completionTokens = info.completionTokens;
  record.tokensEstimated = info.tokensEstimated;
}

/**
 * 請求失敗或被取消。aborted 與 error 分開:前者是使用者主動取消,不是故障,
 * UI 用中性色而非紅色。
 */
export function failLlm(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** 估算 token 補錄:請求已成功但真值拿不到時,估算結果晚於 finishLlm 到達。 */
export function patchLlmTokens(id: number, promptTokens: number | null, completionTokens: number | null): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  // 已有真值時不覆蓋(非流式路徑拿到了 usage,估算結果作廢)
  if (!record.tokensEstimated && record.promptTokens !== null) return;
  record.promptTokens = promptTokens;
  record.completionTokens = completionTokens;
  record.tokensEstimated = true;
}

export interface ImageBegin {
  backend: 'nai' | 'comfyui';
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  floor: number;
  seq: number;
}

/** 登記一次生圖請求。圖片結果不進 store(dataURL 會爆記憶體,且圖已落盤進 ST)。 */
export function beginImage(info: ImageBegin): number {
  const id = nextId++;
  push({
    id,
    kind: 'image',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    backend: info.backend,
    model: info.model,
    prompt: truncate(info.prompt),
    nl: truncate(info.nl),
    negative: truncate(info.negative),
    characters: info.characters.map(character => ({
      name: truncate(character.name),
      tag: truncate(character.tag),
      nl: truncate(character.nl),
    })),
    seed: info.seed,
    size: info.size,
    floor: info.floor,
    seq: info.seq,
  });
  return id;
}

export function finishImage(id: number): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
}

export function failImage(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** 清空(頁面上的「清空」按鈕)。 */
export function clearHistory(): void {
  records.splice(0, records.length);
}

/** 測試用:復位到乾淨狀態(含 id 計數器)。 */
export function resetHistory(): void {
  clearHistory();
  nextId = 1;
}

/** 測試用:暴露封頂常量,免得單測裡寫死數字與實現脫節。 */
export const HISTORY_LIMITS = { MAX_RECORDS, MAX_CONTENT } as const;

/**
 * 埋點呼叫的統一包裝:記錄失敗一律靜默降級,**絕不向上拋**。
 *
 * 歷史是除錯輔助,而呼叫點全在真實業務路徑上(發請求、出圖)——
 * 讓記錄邏輯把生圖/tag 搞掛是本末倒置。所有 begin/finish/fail 都該經過這裡。
 */
export function safeHistory<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    console.debug('[虎哩繪] 請求歷史記錄失敗(已忽略)', e);
    return null;
  }
}
