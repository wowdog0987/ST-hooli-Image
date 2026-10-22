/**
 * SillyTavern getContext() 的薄封裝 + 型別。
 * 整個擴充套件只通過這裡接觸宿主,穩定且單點。
 * 執行時 getContext 掛在 window.SillyTavern 上(ST 的穩定擴充套件 API)。
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  swipes?: string[];
  swipe_info?: Array<{ extra?: Record<string, unknown> }>;
  swipe_id?: number;
  send_date?: string;
  extra?: Record<string, unknown>;
}

/**
 * 是不是一條「劇情訊息」——即 ST 的真·系統訊息之外的一切,**含被 /hide 隱藏的普通樓**。
 *
 * 判據只看 extra.type:ST 只給 narrator/comment/sys 這類真系統訊息蓋這個戳
 * (system-messages.js、slash-commands.js 的 /role system),而 /hide 只翻 is_system、
 * 不碰 extra(chats.js hideChatMessageRange)。所以隱藏的普通樓在這裡是 true——
 * 隱藏的語義是「不進提示詞」,不是「不是劇情」,ST 自己也這麼認:messageFormatting
 * 對隱藏樓有一句 `// Let hidden messages have markdown`,強行把 isSystem 置回 false,
 * 好讓它照常吃 markdown 與正則(我們的錨點正則也是靠這條才在隱藏樓生效)。
 *
 * **只有這一份**:樓層按鈕的顯隱、自動 tag 的目標閘門、歷史上下文的取捨共用它。
 * 各寫一份的後果是活生生的 bug——舊版 actionButton 直接讀 DOM 的 is_system 屬性,
 * 隱藏樓一律不給按鈕,而 runner 其實放行,使用者看到的就是「有的樓沒有按鈕」。
 */
export function isStoryMessage(message: STMessage | undefined): message is STMessage {
  if (!message || typeof message.mes !== 'string' || !message.mes.trim()) return false;
  return !(message.is_system && typeof message.extra?.type === 'string');
}

/** 劇情訊息裡的 AI 樓(使用者樓不算)。樓層按鈕與自動 tag 的目標樓判據。 */
export function isAiStoryMessage(message: STMessage | undefined): message is STMessage {
  return isStoryMessage(message) && !message.is_user;
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  CHAT_CHANGED: string;
  MESSAGE_EDITED: string;
  MESSAGE_UPDATED: string;
  MESSAGE_SWIPED: string;
  MESSAGE_DELETED: string;
  [k: string]: string;
}

/** 角色卡(只用到極少欄位;avatar 是穩定唯一鍵,name 可能重名) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  characters?: STCharacter[];
  /** 當前角色在 characters 中的索引(字串/數字);群聊時為空 */
  characterId?: string | number;
  /** 當前群組 id;非群聊為空 */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveChat: () => Promise<void>;
  reloadCurrentChat?: () => Promise<void>;
  updateMessageBlock?: (
    messageId: number,
    message: STMessage,
    options?: { rerenderMessage?: boolean },
  ) => unknown;
  /** 擴充套件全域性設定物件(= extension_settings,寫進伺服器 settings.json,跨裝置同步)。ST 穩定 API。 */
  extensionSettings?: Record<string, unknown>;
  /** 防抖儲存全域性設定(連同 extensionSettings 落盤到伺服器)。ST 穩定 API。 */
  saveSettingsDebounced?: () => void;
  /**
   * 用「當前主 API」(主介面正在用的聊天補全/文本補全設定)發一次性補全。來源 script.js,ST 穩定 API。
   * prompt 傳訊息陣列時只發這些訊息、不帶聊天歷史/角色卡;api 預設=main_api(使用者當前主 API)。
   * 內部走 sendOpenAIRequest('quiet', …),quiet 強制非流式,返回清洗後的整段文本。
   */
  generateRaw?: (params: {
    prompt: Array<{ role: string; content: string }> | string;
    api?: string | null;
    systemPrompt?: string;
    responseLength?: number | null;
    prefill?: string;
    jsonSchema?: unknown;
  }) => Promise<string>;
  /** 展開 {{char}}/{{user}} 等宏。帶角色卡描述時,欄位裡可能含宏,需用它還原。ST 穩定 API。 */
  substituteParams?: (content: string) => string;
  /**
   * 用當前分詞器數 token。ST 穩定 API(tokenizers.js)。
   * 【口徑】用的是**主介面當前 API/模型**的分詞器,與副 API 渠道的模型未必同源,
   * 故結果只能當估算(UI 上以 ≈ 標註),不能與上游返回的真實 usage 混為一談。
   */
  getTokenCountAsync?: (str: string, padding?: number) => Promise<number>;
  /**
   * 按文本啟用世界書條目(關鍵詞觸發 + constant 常駐)。ST 穩定 API(world-info.js)。
   * chat 為待掃描文本陣列(由舊到新);isDryRun=true 僅掃描不觸發副作用事件。
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** @深度條目:{depth, role, entries: string[]}。很多藍燈條目在這裡 */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** 作者注前/後條目(content 字串陣列) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** 全部已載入的世界書檔名(全域性 + 角色綁定)。ST 穩定 API。 */
  getWorldInfoNames?: () => string[];
  /** 主上下文最大 token(給 getWorldInfoPrompt 的預算引數) */
  maxContext?: number;
  // 相容舊式命名
  event_types?: STEventTypes;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
}

/** 一條已啟用的世界書條目(checkWorldInfo 返回的條目物件;只取渲染/拼接用到的欄位)。 */
export interface WorldInfoEntry {
  /** 所屬世界書檔名 */
  world?: string;
  /** 條目備註/標題 */
  comment?: string;
  /** 條目正文 */
  content?: string;
  [k: string]: unknown;
}

/** checkWorldInfo 的返回結構(只宣告我們要用的欄位)。 */
interface CheckWorldInfoResult {
  /** 全部啟用條目(已完成掃描/遞迴/預算,是最終該進提示詞的集合) */
  allActivatedEntries?: Set<WorldInfoEntry> | Map<string, WorldInfoEntry>;
  [k: string]: unknown;
}

type CheckWorldInfoFn = (
  chat: string[],
  maxContext: number,
  isDryRun: boolean,
  globalScanData?: Record<string, unknown>,
) => Promise<CheckWorldInfoResult>;

/**
 * 取 ST 的 checkWorldInfo(getContext 未暴露,從 /scripts/world-info.js 動態取)。
 * 與 getWorldInfoPrompt 不同:它返回**條目物件集合**(帶 world/comment/content),
 * 才能逐條渲染——而 getWorldInfoPrompt 只吐拼好的字串,元資訊全丟。
 * 取不到(舊版/路徑變動)時返回 null,呼叫方據此降級回 getWorldInfoPrompt。
 */
export async function getCheckWorldInfo(): Promise<CheckWorldInfoFn | null> {
  try {
    // 變數持有路徑,避免 Vite/vue-tsc 把它當本地模組解析
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    const fn = mod.checkWorldInfo;
    return typeof fn === 'function' ? (fn as CheckWorldInfoFn) : null;
  } catch {
    return null;
  }
}

/**
 * ST-Prompt-Template(提示詞模板外掛)掛在 globalThis 的執行器介面(見其 exports.ts)。
 * 只用到 prepareContext + evalTemplate:前者備好含變數/世界書上下文的 env,
 * 後者對含 <% %> 的文本跑 EJS。用於讓副 API 讀到的世界書拿到「執行後」的成品,而非原文。
 * 外掛未安裝時 globalThis.EjsTemplate 為 undefined,呼叫方據此降級。
 */
export interface EjsTemplateApi {
  prepareContext: (context?: Record<string, unknown>, end?: number) => Promise<Record<string, unknown>>;
  evalTemplate: (
    code: string,
    context?: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
}

/** 取 ST-Prompt-Template 暴露的模板執行器;未安裝/介面不完整時返回 null(呼叫方降級為不執行 EJS)。 */
export function getEjsTemplate(): EjsTemplateApi | null {
  const api = (globalThis as { EjsTemplate?: Partial<EjsTemplateApi> }).EjsTemplate;
  if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') {
    return api as EjsTemplateApi;
  }
  return null;
}

interface SillyTavernGlobal {
  getContext?: () => STContext;
}

/** 取 ST 上下文;ST 尚未就緒時返回 null(呼叫方負責輪詢/延後)。 */
export function getContext(): STContext | null {
  try {
    const st = (window as unknown as { SillyTavern?: SillyTavernGlobal }).SillyTavern;
    return st?.getContext?.() ?? null;
  } catch {
    return null;
  }
}
