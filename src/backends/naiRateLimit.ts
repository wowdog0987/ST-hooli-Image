/**
 * NAI 限流自愈:重試策略 + 全域性節奏狀態。
 *
 * 為什麼需要:generate-image 是瀏覽器直連的阻塞式 POST,沒有服務端佇列。原先吃到 429
 * 就直接把卡片標紅交給使用者手點,而且錯誤是**按槽位隔離**的 —— 被限流時閘門照舊一個接
 * 一個往下泵(release → pump → 立刻發下一個 → 又 429),打出一串密集失敗請求,恰恰
 * 最像濫用。這裡補三樣:
 *
 * 1. **錯誤分類**:429 / 5xx / 網路級失敗才重試;400/401/402 這類配置錯誤立刻拋。
 *    不分類的話,一個填錯的 key 會被退避重試放大成四倍請求量。
 * 2. **退避重試**:指數退避 + 抖動,並把對方給的 Retry-After 當下界。
 * 3. **全域性冷卻**:429 不只讓當前請求退避,還給**整個閘門**上冷卻
 *    (floor/genQueue.ts 取槽後等待),否則其餘槽位會在同一秒裡接著撞上去。
 *
 * 另加相鄰請求最小間隔,給「正常出圖耗時撐不出間隔」的場合兜底(小圖/低步數/快速失敗重發)。
 *
 * 狀態刻意做成模組級:節奏按**賬號**生效,不按卡片,閘門(floor)與後端(backends/nai)
 * 讀寫的必須是同一份。所有時間戳都可注入,故整個策略層不用假時鐘就能單測。
 */

/** 總嘗試次數上限(含首發):1 次首發 + 3 次重試。 */
export const NAI_MAX_ATTEMPTS = 4;

/** 相鄰兩次 NAI 請求的最小間隔。正常出圖耗時遠大於此,只在連發/快速失敗時起作用。 */
export const NAI_MIN_INTERVAL_MS = 1500;

/** 吃到 429 但對方沒給 Retry-After 時的預設全域性冷卻。 */
export const NAI_RATE_LIMIT_COOLDOWN_MS = 15_000;

/** 退避基數。 */
const BACKOFF_BASE_MS = 2000;

/**
 * 單次等待上限,同時也是 Retry-After 的採信上限。
 * 設上限的理由:對方(或第三方映象)給個 Retry-After: 3600 時,卡片不該無聲無息掛一小時——
 * 等到上限還不行就把錯誤拋給使用者,讓他自己決定。
 */
const MAX_WAIT_MS = 60_000;

/* ============ 純策略 ============ */

/**
 * 使用者主動取消:一律不重試。
 * 鴨子型別判 name,不用 `instanceof DOMException`——本模組的輸入既可能是瀏覽器的
 * DOMException,也可能是 fetch/上游包裝出的普通 Error,認名字才兩邊都蓋得住。
 */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
}

/**
 * 這個狀態碼值不值得重試。
 * 408/429 是明確的「慢點/重來」;5xx 是服務端臨時故障(含第三方映象常見的 Cloudflare 52x)。
 * 501 例外:那是「壓根沒實現」,重試到世界盡頭也一樣。
 */
export function isRetryableNaiStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/**
 * 該不該重試。**故意只吃原始值**(錯誤物件 + 狀態碼),不認識 NaiError ——
 * 否則 naiRateLimit ↔ nai 互相 import 成環。
 *
 * 無狀態碼的分兩種:fetch 的 TypeError 是網路級失敗(斷網/CORS/拒連),值得重試;
 * 我們自己拋的校驗/解析錯誤(「zip 包內沒有圖片」之類)重試一萬次也是同一個結果,不重試。
 */
export function shouldRetryNai(error: unknown, status: number | undefined): boolean {
  if (isAbortError(error)) return false;
  if (status !== undefined) return isRetryableNaiStatus(status);
  return error instanceof TypeError;
}

/**
 * 解析 Retry-After 響應頭:支援「秒數」與「HTTP 日期」兩種寫法,取不到返回 null。
 * 結果夾到 [0, MAX_WAIT_MS]。
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, MAX_WAIT_MS) : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_WAIT_MS);
}

/**
 * 第 attempt 次重試(1 起)該等多久。
 *
 * 抖動只在 50%–100% 區間取:下界保住基本退避力度,隨機化則避免多張卡同時醒來又撞一起。
 * Retry-After 當**下界**用 —— 對方明確說了等多久,不能比它更早回去敲門。
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), MAX_WAIT_MS);
  const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), MAX_WAIT_MS);
}

/* ============ 全域性節奏狀態 ============ */

let cooldownUntil = 0;
/**
 * 上一次請求發出的時刻。初值 -Infinity 而非 0:0 的語義是「1970 年發過一次」,
 * 只在 now 遠大於最小間隔時才碰巧等價於「沒發過」。-Infinity 讓「從未發過 → 無需等待」
 * 與時鐘取值無關地成立。
 */
let lastStartAt = Number.NEGATIVE_INFINITY;
let minIntervalMs = NAI_MIN_INTERVAL_MS;

/** 429 冷卻的下界:見 noteNaiRateLimited。 */
const MIN_COOLDOWN_MS = 1000;

/**
 * 記一次 429:給整個閘門上冷卻。
 *
 * **只延後不提前** —— 併發 ≥2 時幾個槽位可能接連撞上,後來的短冷卻不該把前面的長冷卻沖掉。
 * **下界 1s** —— 哪怕對方給的是 `Retry-After: 0`(或一個已過期的日期),429 也總該讓閘門
 * 喘一口氣;一個「立刻重來」的 429 最容易滾成連發死迴圈,那正是要防的東西。
 */
export function noteNaiRateLimited(
  retryAfterMs: number | null,
  now: number = Date.now(),
): void {
  const requested = retryAfterMs ?? NAI_RATE_LIMIT_COOLDOWN_MS;
  const until = now + Math.min(Math.max(requested, MIN_COOLDOWN_MS), MAX_WAIT_MS);
  if (until > cooldownUntil) cooldownUntil = until;
}

/** 記一次請求發出的時刻(最小間隔的基準)。取槽後與每次重試前都要記。 */
export function noteNaiRequestStart(now: number = Date.now()): void {
  lastStartAt = now;
}

/** 現在還得等多久才允許發下一個請求:冷卻剩餘與最小間隔剩餘取大。 */
export function naiPacingDelayMs(now: number = Date.now()): number {
  return Math.max(0, cooldownUntil - now, lastStartAt + minIntervalMs - now);
}

/** 冷卻剩餘(僅供展示/診斷;閘門判斷用 naiPacingDelayMs)。 */
export function naiCooldownRemainingMs(now: number = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

/**
 * 最小間隔的唯一旋鈕。生產程式碼不調(常量即口徑),留給單測把間隔關掉,
 * 好讓「併發」與「節奏」兩組測試互不干擾。
 */
export function setNaiMinInterval(ms: number): void {
  minIntervalMs = Math.max(0, ms);
}

/** 復位節奏狀態(不動最小間隔,那是 setNaiMinInterval 的事)。 */
export function resetNaiPacing(): void {
  cooldownUntil = 0;
  lastStartAt = Number.NEGATIVE_INFINITY;
}

/* ============ 可取消的等待 ============ */

/**
 * setTimeout 的可取消版:等待期間使用者點「取消」要立刻拋 AbortError,
 * 不能讓卡片按著「取消」還傻等幾十秒退避。
 *
 * (backends/comfyui.ts 有一份同形的私有實現。刻意不合並:那是另一個後端的內部工具,
 * 為一個 15 行的 promise 原語讓 comfy 去 import nai 的模組不值當。)
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ============ 重試執行器 ============ */

/** 重試進度回報:卡片據此把「生成中…」換成重試文案。 */
export interface NaiRetryInfo {
  /** 即將開始的是第幾次重試(1 起)。 */
  attempt: number;
  /** 最多重試幾次。 */
  max: number;
  /** 本次要等多久(ms)。 */
  waitMs: number;
  /** 觸發本次重試的錯誤。 */
  error: unknown;
}

export interface NaiRetryOptions {
  signal?: AbortSignal;
  onRetry?: (info: NaiRetryInfo) => void;
  /** 等待實現。留給單測注入,免得跑一遍測試真睡幾十秒。 */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 鴨子型別取狀態碼與 Retry-After:不 import NaiError,免成環(見 shouldRetryNai)。 */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorRetryAfterMs(error: unknown): number | null {
  const ms = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === 'number' ? ms : null;
}

/**
 * 跑一次 NAI 請求,失敗且可重試則退避後重來,最多 NAI_MAX_ATTEMPTS 次。
 *
 * run 必須是**可重跑**的:呼叫方要把「只該做一次」的準備工作(拼引數、讀 vibe 資料)
 * 留在外面,只把真正發請求的那一段包進來。
 *
 * 等待時長取「本次退避」與「全域性節奏」的大值:併發 ≥2 時別的槽位可能剛吃到 429 並
 * 上了更長的冷卻,本次重試也得一併遵守,否則冷卻只攔得住新任務、攔不住重試。
 */
export async function runNaiWithRetry<T>(
  run: () => Promise<T>,
  opts: NaiRetryOptions = {},
): Promise<T> {
  const { signal, onRetry, delay = abortableDelay } = opts;
  const maxRetries = NAI_MAX_ATTEMPTS - 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const status = errorStatus(error);
      // 不可重試(取消 / key 錯 / 訂閱過期 / 引數非法)或次數用盡:原樣丟擲,
      // 保住原錯誤資訊 —— 使用者要看的是「API Key 錯誤」,不是「重試 4 次後失敗」。
      if (attempt > maxRetries || !shouldRetryNai(error, status)) throw error;

      const retryAfterMs = errorRetryAfterMs(error);
      // 429 = 對方明確說「太快了」。除了自己退避,還要給整個閘門上冷卻,
      // 否則佇列裡其餘任務會在同一秒接著撞上去 —— 那串密集失敗才是封號風險所在。
      if (status === 429) noteNaiRateLimited(retryAfterMs);

      const waitMs = Math.max(retryDelayMs(attempt, retryAfterMs), naiPacingDelayMs());
      onRetry?.({ attempt, max: maxRetries, waitMs, error });
      console.warn(
        `[虎哩繪] NAI 請求失敗,${Math.round(waitMs / 1000)}s 後重試(第 ${attempt}/${maxRetries} 次):`,
        error,
      );
      await delay(waitMs, signal);
      noteNaiRequestStart();
    }
  }
}
