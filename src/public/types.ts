import type { Orientation } from '@/backends/size';
import type { BackendId } from '@/state/settings';
import type { CharTagField } from '@/state/charTags';

/**
 * 虎哩繪公開介面的資料結構(DTO)。**第三方外掛的契約面。**
 *
 * 紀律(與Horae src/public/types.ts 同款,第三方作者學一套就夠):
 * - apiVersion 獨立於 pluginVersion:前者是**本檔案這些結構**的版本,外掛版本天天漲,
 *   它不漲。第三方按 apiVersion 判相容,不該去解析 pluginVersion 的語義。
 * - 只增不改不刪:加可選欄位是安全的;改欄位含義 / 刪欄位一律要升 apiVersion。
 *   因此本檔案刻意**不暴露**內部型別的全部欄位——暴露出去就再也收不回來了
 *   (例:CharTagEntry.history 有 50 條變更記錄,第三方拿它沒用,先不給)。
 * - 一律是**普通可克隆物件**:不含函式、不含 Vue reactive 代理、不含 class 例項。
 *   跨外掛 bundle 邊界 instanceof 一律失效,故錯誤也走 code 欄位而非自定義 Error 子類。
 */

export const PUBLIC_API_VERSION = 1 as const;

export interface PublicCapabilities {
  /** globalThis.STBaiBaiImage 可用。 */
  globalApi: true;
  /** 能讀角色庫(getCharacters)。 */
  characterLibrary: true;
  /** 能調生圖(generate)。 */
  generate: true;
  /** 生成的圖能落盤進虎哩繪相簿(generate 的 save 選項)。 */
  saveToGallery: true;
  /** ready/changed 事件可用。 */
  events: true;
}

/** 一個角色的外貌欄位。鍵與虎哩繪設定頁的「角色庫」逐項對應。 */
export type PublicCharacterFields = Record<CharTagField, string>;

export interface PublicCharacter {
  /** 角色名。**逐字原樣**,不音譯不規範化(生圖 tag 與正文靠它對齊)。 */
  name: string;
  /**
   * 可直接用於生圖的完整 tag 串。
   * 由 fields 按固定順序(同人身份→性別→頭髮→眼睛→膚色→體型→標誌特徵→著裝)拼成;
   * 老條目只有整串 raw 時即為 raw 本身。**推薦直接用這個**,別自己拼 fields。
   */
  tag: string;
  /** 分欄位的外貌(要自己挑著用時才需要)。 */
  fields: PublicCharacterFields;
  /** 自然語言外貌描述(可空)。 */
  nl: string;
  /**
   * 這條檔案從哪來:
   * - 'manual' 使用者手寫 / 手動編輯過
   * - 'ai'     AI 在劇情裡建的檔或改過
   * - 'book'   從Horae的角色記憶同步來
   */
  source: 'book' | 'manual' | 'ai';
  /**
   * 作用域:
   * - 'global' 全域性角色庫(跨聊天,只由使用者手動維護,AI 改不動)
   * - 'chat'   本聊天的檔案(手動基線 + AI 在樓層裡的變更重放而來)
   */
  scope: 'global' | 'chat';
  /** 建檔時那句「為什麼長這樣」(多為空串)。 */
  desc: string;
}

export interface GetCharactersOptions {
  /**
   * 取「第 floor 樓之前」的角色庫快照(ST 零基 mesid,不含該樓)。
   *
   * 為什麼會需要它:角色檔案隨劇情演進(AI 在某樓給角色換了髮色),要為**歷史某一樓**
   * 出圖就得用那一樓當時的檔案,拿當前庫會把後來的變更也畫進去。
   * 省略 = 當前(全部樓層重放完)的庫。
   */
  floor?: number;
}

export interface PublicCharacterList {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /** 角色庫每次變更遞增;拿它做快取失效判斷。 */
  revision: number;
  /** 快照對應的樓層(省略 floor 時為 null = 當前)。 */
  floor: number | null;
  characters: PublicCharacter[];
}

export interface PublicBackendStatus {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /** 使用者當前選的出圖後端。 */
  backend: BackendId;
  /** 後端是否已配齊、能出圖。false 時 generate 會拋 code='not_configured'。 */
  configured: boolean;
  /** NAI 為模型名;ComfyUI 為當前工作流預設名。**不含服務地址與 API Key。** */
  model: string;
  /**
   * 當前後端是否支援 characters(多角色提示)。
   * NAI 4.5/V5 為 true;**ComfyUI 恆為 false**——傳了會被靜默丟棄,
   * 故要畫多角色時請先看這裡,別等出圖完才發現。
   */
  supportsCharacters: boolean;
  /** configured=false 時的人話原因(可直接展示給使用者);已就緒為空串。 */
  reason: string;
}

/** 多角色提示裡的一位(NAI 4.5/V5 的 Character Prompt)。 */
export interface PublicCharacterPrompt {
  /** 角色名,僅用於標識,不進提示詞。 */
  name: string;
  /** 該角色的 tag(通常取 PublicCharacter.tag)。 */
  tag: string;
  /** 該角色的自然語言描述(可空)。 */
  nl?: string;
}

export interface GenerateRequest {
  /** 正向 danbooru 短 tag。**必填且不能為空**(空串拋 code='invalid_args')。 */
  prompt: string;
  /** 自然語言描述(可空)。 */
  nl?: string;
  /**
   * 本畫面的動態負面(可空)。
   * 只對 ComfyUI 生效(填進工作流的 %negative_prompt%);NAI 的負面取使用者渠道配置。
   */
  negative?: string;
  /**
   * 多角色提示。需 supportsCharacters 為 true 才會生效,
   * 結果裡的 charactersApplied 會明說這次到底用上了沒有。
   */
  characters?: PublicCharacterPrompt[];
  /** 畫幅方向;預設 'portrait'。具體畫素取使用者在渠道頁配的橫豎尺寸。 */
  size?: Orientation;
  /** 指定種子(正整數)。省略 = 按使用者設定決定(NAI 面板固定種子,否則隨機)。 */
  seed?: number;
  /**
   * 落盤進虎哩繪相簿,**預設 true**。
   *
   * true:圖存進 user/images/柏宝绘_<character>/ 並寫側寫 json,於是
   *       使用者能在虎哩繪相簿頁裡按角色分組看到它、連提示詞一起。
   * false:只返回 dataUrl,不碰磁碟——適合「預覽一下就丟」的用法。
   *
   * ⚠ 落盤**不寫聊天記錄**:圖不會出現在任何樓層的正文裡,也不佔樓層卡片。
   *   圖顯示在哪裡由你決定,這正是本介面存在的意義。
   */
  save?: boolean;
  /**
   * 落盤歸到哪個角色名下(相簿的分組名,即目錄 柏宝绘_<character>)。
   * 省略 = 當前聊天的角色名。save=false 時無意義。
   */
  character?: string;
}

export interface GenerateOptions {
  /** 取消本次生成。取消時拋 code='aborted'。 */
  signal?: AbortSignal;
  /** 進度回撥(可選)。任何一次回撥拋錯都只會被記進 console,不影響生成。 */
  onProgress?: (progress: PublicGenerateProgress) => void;
}

export interface PublicGenerateProgress {
  /**
   * - 'queued'     在虎哩繪的 NAI 併發閘門裡排隊(等別的請求讓出槽位)
   * - 'generating' 請求已發出,後端正在畫
   * - 'queued-remote' 在 ComfyUI **服務端**佇列裡(ahead 為前面還有幾個)
   * - 'retrying'   被限流了,正在退避重試(attempt/max)
   * - 'saving'     圖已拿到,正在落盤
   */
  phase: 'queued' | 'generating' | 'queued-remote' | 'retrying' | 'saving';
  /** phase='queued-remote' 時前面還有幾個;未知為 null。 */
  ahead?: number | null;
  /** phase='retrying' 時的第幾次/共幾次。 */
  attempt?: number;
  max?: number;
}

export interface GenerateResult {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /**
   * 圖片的 data URL(形如 data:image/png;base64,…),可直接 <img src>。
   *
   * 刻意用 data URL 而不是 blob URL:blob 要配對 revokeObjectURL,
   * 忘了就洩漏、替你 revoke 又會讓你的 <img> 突然變空白。data URL 沒這些坑,
   * 代價是字串比較大——用完別長期留在記憶體裡。
   */
  dataUrl: string;
  /** 圖片格式,如 'png' / 'jpg'。 */
  format: string;
  /**
   * 落盤後的 ST 靜態路徑(形如 /user/images/柏宝绘_小雪/bbi_….png),可直接 <img src>。
   * save=false 或落盤失敗時為 null——**落盤失敗不拋錯**,圖已經在 dataUrl 裡了,
   * 不能因為存不進相簿就讓你連圖都拿不到。
   */
  path: string | null;
  /** 本次實際使用的種子(隨機時也給,想復現就把它填回 seed)。 */
  seed: number;
  /** 實際出圖的後端。 */
  backend: BackendId;
  /**
   * characters 是否真的發給了後端。
   * 你傳了 characters 但這裡是 false = 被丟棄了(通常是使用者在用 ComfyUI)。
   * 虎哩繪**刻意不降級把角色拼進 prompt**:那會畫出多份軀幹重疊的圖。
   */
  charactersApplied: boolean;
}

/**
 * 出錯時丟擲的 Error 上掛的 code。**按 code 分支,別匹配 message 文案**
 * (message 是給人看的中文,會隨版本改;也別用 instanceof,跨 bundle 一律失效)。
 */
export type PublicErrorCode =
  /** 使用者取消(你傳的 signal 觸發了)。 */
  | 'aborted'
  /** 使用者還沒配好出圖後端;reason 在 getBackendStatus() 裡。 */
  | 'not_configured'
  /** 入參不合法(prompt 空、seed 不是數字之類)。 */
  | 'invalid_args'
  /** 被後端限流,且虎哩繪的自動退避重試已用盡。 */
  | 'rate_limited'
  /** 後端報錯(網路不通、工作流有問題、API Key 失效……)。 */
  | 'backend_error';

/** 掛了 code 的 Error。用 `'code' in error` 判斷,不要 instanceof。 */
export interface PublicError extends Error {
  code: PublicErrorCode;
}

export interface PublicChangeNotice {
  type: 'ready' | 'changed';
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  revision: number;
  chatId: string | null;
  capabilities: PublicCapabilities;
}

export type PublicChangeListener = (notice: PublicChangeNotice) => void;

export interface STBaiBaiImageApi {
  /** 本介面資料結構的版本。第三方按它判相容(當前恆為 1)。 */
  readonly apiVersion: typeof PUBLIC_API_VERSION;
  /** 虎哩繪外掛版本(僅供展示/排查,別解析它做相容判斷)。 */
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  /** 取虎哩繪已記錄的角色列表(含可直接出圖的 tag)。返回深複製,改它不影響虎哩繪。 */
  getCharacters(options?: GetCharactersOptions): PublicCharacterList;
  /** 出圖前先問問:後端配好了嗎、支不支援多角色。 */
  getBackendStatus(): PublicBackendStatus;
  /** 調虎哩繪生圖。圖返回給你,顯示在哪由你決定。 */
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>;
  /** 訂閱角色庫變更;返回取消訂閱的函式。 */
  subscribe(listener: PublicChangeListener): () => void;
}
