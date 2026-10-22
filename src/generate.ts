/**
 * 「一次出圖」的共用中段 —— 樓層卡片與公開介面的唯一生成入口。
 *
 * 原本這段活全寫在 Card.vue 的 generate() 裡,與槽位執行態(beginGen/failGen)、
 * 落盤(saveImageResult)、重水合(hydrateMessage)纏在一起。公開介面要讓第三方
 * 「自己決定圖顯示在哪」,要的恰恰是**掐頭去尾的中段**:
 *
 *   前(呼叫方):登記執行態 / 校驗引數
 *   ★ 中(本模組):NAI 閘門 → 按 backend 分派 → 拿到圖
 *   後(呼叫方):落盤、顯示、收尾埋點
 *
 * **閘門不可繞過**,這是本模組存在的首要理由:直接調 backends/nai.ts 的
 * generateNaiImage 會跑在 floor/genQueue.ts 的併發閘門與全域性節奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全域性冷卻、相鄰請求最小間隔、退避重試)當場失效。第三方併發呼叫
 * 是常態,繞過去的症狀是使用者 NAI 賬號吃一串密集 429 —— 而使用者只會認為虎哩繪壞了。
 * 故公開介面與卡片共用本函式,閘門在這裡包死。
 *
 * 本模組**刻意不碰**:樓層座標、genState、extra、水合、請求歷史埋點。
 * 埋點留給呼叫方是有意為之:一條歷史記錄的「成功」判據各家不同——樓層卡片要等
 * saveImageResult 落盤成功才算成,還要把「圖拿到了卻因任務被取代而丟棄」記成已取消;
 * 本模組只知道請求本身的成敗,替呼叫方下結論會把那兩種情形謊報成成功。
 * 故 decideSeed 單獨匯出:呼叫方先定種子(埋點需要它)、再把它顯式傳進來。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { validateSimpleConfig } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { generateNaiImage, naiRandomSeed, naiSupportsCharacterPrompts } from '@/backends/nai';
import type { Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import { activeComfyPreset, activeNaiEndpoint, effectiveComfyConn, effectiveNai, settings, type BackendId } from '@/state/settings';

/** 一次生成的輸入。與協議層 ImageInsertion 同形,但不含正文位置資訊。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然語言部分(可空)。 */
  nl?: string;
  /** 本畫面動態負面(可空)。ComfyUI 走 %negative_prompt%;NAI 的負面取渠道配置,不吃這個。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI 不支援(見 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /** 畫幅方向;預設豎屏。具體畫素取渠道配置裡的橫豎尺寸。 */
  size?: Orientation;
  /** 本次種子。由呼叫方經 decideSeed() 先行確定(埋點要在發請求前拿到它)。 */
  seed: number;
}

/** 生成過程中的進度上報(卡片用它顯示排隊位置與退避進度)。 */
export interface GenerateProgress {
  /** 已取得閘門槽位、請求即將發出(NAI 從「排隊中」進入「生成中」的時機)。 */
  onStart?: () => void;
  /** ComfyUI 服務端佇列裡前面還有幾個;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避進度;傳 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次實際使用的種子(原樣回傳,呼叫方不必自己記)。 */
  seed: number;
  backend: BackendId;
  /**
   * characters 是否真的發給了後端。
   * ComfyUI 鏈路**不支援**多角色提示(comfyui.ts / comfyTemplates.ts 全程不讀該欄位),
   * 傳了也是靜默丟棄 —— 故顯式回報,呼叫方據此決定要不要提示使用者換後端。
   * 不在這裡「降級拼進 prompt」:那正是 0.2.3 修掉的重疊軀幹問題(一張圖裡多份完整外貌)。
   */
  charactersApplied: boolean;
}

/** 後端就緒狀態。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI 為模型名;ComfyUI 為當前工作流預設名。 */
  model: string;
  /** 當前後端是否支援 characters(NAI 4.5/V5 為 true,ComfyUI 恆 false)。 */
  supportsCharacters: boolean;
  /** configured=false 時的人話原因;已就緒為空串。 */
  reason: string;
}

/**
 * 當前後端能不能出圖。**唯一判據**,卡片(configured)與公開介面共用。
 *
 * ComfyUI 要按模式分別校驗(custom 要工作流 JSON;simple 要模型/VAE/CLIP 選齊,
 * 與出圖組裝同一口徑 validateSimpleConfig,避免「卡片能點、出圖才報錯」);NAI 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = settings.nai.model;
    // 支援與否只看模型,與配沒配齊無關:第三方要在出圖前就知道該不該傳 characters
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    // 地址與 key 取**當前接入點**那一份(見 effectiveNai);渠道級 nai.url/nai.key 是存量欄位。
    // reason 裡刻意**不帶接入點名字**:它會經 getBackendStatus 原樣遞給第三方,而名字是使用者
    // 自己敲的——有人就拿站點域名當名字,帶上等於把地址漏進公開返回值(見 public/api.ts 白名單)。
    // 少了名字也不難定位:面板下拉裡選中的就是這條。
    const conn = activeNaiEndpoint();
    if (!conn.url.trim()) {
      return { ...base, configured: false, reason: '當前 NAI 接入點未填寫服務地址' };
    }
    if (!conn.key.trim()) {
      return { ...base, configured: false, reason: '當前 NAI 接入點未填寫 API Key' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    if (!settings.comfyui.url.trim()) {
      return { ...base, configured: false, reason: '未填寫 ComfyUI 服務地址' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: '當前工作流預設未填寫工作流 JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  // webui 只剩存量型別(設定遷移會把它歸一成 comfyui/nai),真出現就是「沒選後端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出圖後端未選擇,請在虎哩繪「渠道」頁選擇出圖渠道',
  };
}

/**
 * 定本次種子。**必須在發請求前定好**:一是部分取樣器節點不接受 -1 自動隨機,
 * 二是埋點與落盤(entry.seed)都要記下它,事後「同種子再來一張」才有依據。
 *
 * 口徑:顯式指定 > NAI 面板固定種子(>0)> 隨機。
 * NAI 與 ComfyUI 的隨機上界不同(各自協議的合法範圍),故分開取。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return settings.nai.seed > 0 ? settings.nai.seed : naiRandomSeed();
  return randomSeed();
}

/**
 * 按當前設定出一張圖。**樓層卡片與公開介面的唯一生成路徑。**
 *
 * 不負責落盤、不負責顯示、不登記執行態、不做埋點 —— 那些是呼叫方的事。
 * signal 一路透傳到 fetch/輪詢;取消時拋 AbortError(DOMException)。
 *
 * 閘門紀律(見 floor/genQueue.ts):NAI 路徑必須持槽發請求,release 放在 finally,
 * 漏一格就永久少一格併發。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // 兜底:卡片側已用 configured 攔在按鈕上,公開介面側也會先報 not_configured。
  // 真漏到這裡說明上游判據漂了,寧可明說也別發一個註定 401/404 的請求。
  if (!status.configured) throw new Error(status.reason || '出圖後端未配置');

  const isNai = status.backend === 'nai';
  const characters = input.characters ?? [];
  // 支援與否由後端說了算:ComfyUI 恆不支援;NAI 看模型是否 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  let release: (() => void) | null = null;
  try {
    // 持槽:取到槽位後本函式內一直持有,直到 finally 釋放
    if (isNai) release = await acquireNaiSlot(signal);
    progress.onStart?.();

    const size = input.size ?? 'portrait';
    const result = isNai
      ? await generateNaiImage(
          effectiveNai(),
          // characters 原樣透傳:不支援的模型由 buildNaiParameters 自己濾掉(同一口徑
          // naiSupportsCharacterPrompts),在這兒再濾一遍只會多一處會漂的判據
          { prompt: input.prompt, nl: input.nl ?? '', characters, seed: input.seed, size },
          signal,
          { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
        )
      : await generateComfyImage(
          effectiveComfyConn(),
          {
            prompt: input.prompt,
            nl: input.nl ?? '',
            negative_prompt: input.negative ?? '',
            seed: input.seed,
            size,
          },
          signal,
          { onQueue: ahead => progress.onQueue?.(ahead) },
        );

    // 退避文案到此為止:圖已拿到,落盤還要一會兒,不該繼續顯示「稍後重試」
    progress.onRetry?.(null);
    return { result, seed: input.seed, backend: status.backend, charactersApplied };
  } finally {
    release?.();
  }
}
