import { reactive } from 'vue';

import { probeUserImage } from '@/st/images';

/**
 * 「檔案已不在」的圖片路徑冊(模組級、會話內有效)。
 *
 * 為什麼需要它:相簿現在能直接刪 user/images 下的檔案,但那張圖的指標還躺在某個聊天的
 * `message.extra.bbiImage` 裡——相簿按**目錄**列圖,指標在**某個聊天**裡,兩者之間沒有反向
 * 索引,而掃全庫反查不可行(實測單使用者 chats 目錄 7 GB / 1243 個 jsonl,且 /api/chats/get
 * 無分頁)。所以刪檔案必然留下破指標,卡片側只能靠「執行時發現它 404」來降級。
 *
 * 為什麼必須放元件外:與 collapseState.ts / genState.ts 同理——卡片的生命週期由水合決定,
 * 任一兄弟槽位出圖都會重建整樓卡片,標記若存在元件 ref 裡,重建後破圖會原地復活。
 *
 * 為什麼不寫回 extra:那需要 saveChat() 落盤,而「檔案沒了」是磁碟的客觀狀態,不是聊天資料;
 * 且使用者完全可能把檔案恢復回來。會話內記住即可,重新整理後由 <img> 的 @error 重新發現。
 */

/** 歸一化後的路徑集合。reactive 讓卡片的 computed 能跟著它重算。 */
const missing = reactive(new Set<string>());

/**
 * 歸一化圖片路徑,給「extra 裡的 path」與「相簿拼出來的 src」找一個能相等的寫法。
 * **本冊讀寫兩側、以及相簿的提示詞快取鍵,共用這一個口徑**——兩套寫法不對賬,
 * 相簿刪完圖卡片照樣顯示破圖。
 *
 * 兩邊天生不一樣:extra 裡的 entry.path 是服務端 clientRelativePath 原樣返回的**未編碼**
 * 中文路徑,而相簿的 src 是逐段 encodeURIComponent 過的;前導斜槓也有無不定
 * (storage.ts 刪除分支的 `/^\/?user\/images\//` 就是為此寫的)。統一解碼 + 去前導斜槓後再比。
 */
export function normalizeImagePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* 半截百分號編碼:解不開就按原文比,總好過拋錯 */
  }
  return decoded.replace(/^\/+/, '');
}

/** 記下這張圖的檔案已經沒了(呼叫方須先確認確實是 404,別把網路抖動記成刪除)。 */
export function markImageMissing(path: string): void {
  if (path) missing.add(normalizeImagePath(path));
}

/** 批次版本(相簿一次刪多張)。 */
export function markImagesMissing(paths: Iterable<string>): void {
  for (const path of paths) markImageMissing(path);
}

export function isImageMissing(path: string): boolean {
  return !!path && missing.has(normalizeImagePath(path));
}

/** 正在確認的路徑:同一張圖的多次 error 只探一次(重水合會重掛 <img>,error 會再來)。 */
const probing = new Set<string>();

/**
 * `<img>` 報 error 後呼叫:**先確認真是 404 再標記**。
 *
 * 不能一 error 就標記缺失——`<img>` 的 error 分不清「檔案沒了」和「網斷了/服務端 500」,
 * 把掉線記成刪除,使用者網一抖就會看見滿屏「檔案已刪除」,而且重新整理前好不了。
 * 故這裡補一次 HEAD:只有服務端明確說 404 才落冊,分不清(probe 返回 null)就什麼都不做,
 * 讓瀏覽器的破圖佔位留著,下次重掛時自然重試。
 *
 * 只認 user/images 下的圖:user/files 裡的老圖本外掛不刪,沒有「被相簿刪掉」這條路徑。
 */
export async function confirmImageMissing(path: string): Promise<boolean> {
  if (!path || !/^\/?user\/images\//.test(normalizeImagePath(path))) return false;
  const key = normalizeImagePath(path);
  if (missing.has(key)) return true;
  if (probing.has(key)) return false;
  probing.add(key);
  try {
    const probe = await probeUserImage(path);
    // null = 分不清,絕不落冊
    if (probe && !probe.exists) {
      missing.add(key);
      return true;
    }
    return false;
  } finally {
    probing.delete(key);
  }
}

/** 僅供測試:清空本冊。 */
export function resetMissingImages(): void {
  missing.clear();
  probing.clear();
}
