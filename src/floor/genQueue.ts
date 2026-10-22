/**
 * NAI 併發閘門 + 全域性節奏。
 *
 * 為什麼只有 NAI 需要:兩個後端的排隊模型不同——
 * - ComfyUI:POST /prompt 拿到 prompt_id 即入**服務端**佇列,輪詢各查各的 history,
 *   一次性全發出去由 ComfyUI 自己順序執行。客戶端再加佇列純屬多餘,還白拖慢。
 * - NAI:generate-image 是一次阻塞式 POST,等到圖出來才返回,沒有佇列概念。
 *   併發幾個就是幾條連線同時壓過去,容易吃 429(見 backends/nai.ts 的錯誤對映)。
 *
 * 故閘門只包 NAI,上限使用者可調(預設 1)。ComfyUI 路徑不經過這裡。
 *
 * 閘門只管**同時幾個**,管不了**多快一個**:release 後立刻 pump,下一個任務在同一個
 * tick 就發出去了。被限流時這會打出一串密集失敗請求(429 → release → 立刻再來 → 429),
 * 恰恰最像濫用。故取到槽後還要等一段全域性節奏(相鄰請求最小間隔 + 429 冷卻),
 * 口徑收在 backends/naiRateLimit.ts。
 */

import {
  abortableDelay,
  naiPacingDelayMs,
  noteNaiRequestStart,
  resetNaiPacing,
} from '@/backends/naiRateLimit';

let limit = 1;
let running = 0;
/** 等待佇列:先進先出,resolve 後拿到執行權。 */
const waiting: Array<() => void> = [];

/** 設定併發上限(1 起步)。調大時立刻放行等待中的任務。 */
export function setNaiConcurrency(value: number): void {
  limit = Math.max(1, Math.floor(value) || 1);
  pump();
}

function pump(): void {
  while (running < limit && waiting.length) {
    const next = waiting.shift();
    if (!next) break;
    running++;
    next();
  }
}

/**
 * 取得一個執行槽。返回 release 函式,**必須**在 finally 裡呼叫,否則閘門洩漏。
 * signal 已取消時直接拋 AbortError,不佔用槽位。
 *
 * 返回前還會等完全域性節奏(最小間隔 + 429 冷卻),故呼叫方拿到 release 時即可立刻發請求。
 */
export async function acquireNaiSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');

  if (running < limit) {
    running++;
  } else {
    await new Promise<void>((resolve, reject) => {
      // 排隊期間被取消:從佇列摘除並拋錯,不能讓它之後還佔一個槽
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  let released = false;
  const release = () => {
    if (released) return; // 冪等:重複 release 不會把 running 減穿
    released = true;
    running--;
    pump();
  };

  // 節奏等待**持槽進行**,這是關鍵:若放在取槽之前,上限內的 N 個任務會一起等完同一段
  // 再一起發,節流形同虛設。持槽等待才能讓第 N 個真正排在第 N-1 個之後。
  // 迴圈而非單次:等待期間別的槽位可能吃到 429 把冷卻又推後了,醒來得重新問一次。
  try {
    for (let wait = naiPacingDelayMs(); wait > 0; wait = naiPacingDelayMs()) {
      await abortableDelay(wait, signal);
    }
  } catch (error) {
    // 等待期間被取消:必須把槽還回去。漏一格就永久少一格併發,漏滿就再也發不出請求。
    release();
    throw error;
  }
  noteNaiRequestStart();

  return release;
}

/** 當前是否需要排隊(用於卡片顯示「排隊中」而非「生成中」)。 */
export function naiSlotBusy(): boolean {
  return running >= limit;
}

/** 測試用:復位閘門與全域性節奏。放行(而非丟棄)等待者,避免遺留 promise 永掛。 */
export function resetNaiGate(): void {
  limit = 1;
  running = 0;
  resetNaiPacing();
  const pending = waiting.splice(0, waiting.length);
  for (const grant of pending) grant();
}
