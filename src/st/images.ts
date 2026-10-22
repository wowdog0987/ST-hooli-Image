import { getContext } from '@/st/context';

/**
 * ST 圖片儲存（user/images）的上傳/刪除/列舉封裝,對應服務端 /api/images/*。
 *
 * 與 floor/upload.ts 的 /api/files/* 分工:files 是平鋪目錄、無子目錄概念;
 * images 支援 ch_name 子目錄(服務端 ensureDirectoryExistence 自動遞迴建立),
 * 故按「資料夾」歸類的資源(畫師串預覽圖、聊天生成圖片)走這裡。
 *
 * 返回的路徑形如 /user/images/<資料夾>/<檔名>,可直接作 <img src>。
 */

export class ImageStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImageStoreError';
  }
}

/**
 * 畫師串預覽圖的固定子目錄(user/images 下)。
 * 常量名:CJK + 下劃線經服務端 sanitize-filename 原樣保留。
 * 動態角色目錄名也由上傳介面清洗，無需額外請求 sanitize-filename。
 */
export const ARTIST_PREVIEW_FOLDER = '柏宝绘_画师串';

async function postImage(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new ImageStoreError('SillyTavern 上下文不可用');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/**
 * 上傳 base64 圖片到 user/images/<folder>/,返回可訪問的相對路徑(/user/images/...)。
 *
 * filename 可帶副檔名,服務端統一替換為 format;同名靜默覆蓋——
 * 呼叫方用穩定檔名(如畫師串 id)即可讓「換預覽圖」原地覆蓋,不攢孤兒檔案。
 */
export async function uploadUserImage(
  folder: string,
  filename: string,
  base64: string,
  format: string,
): Promise<string> {
  const { ok, status, text } = await postImage('/api/images/upload', {
    image: base64,
    format,
    ch_name: folder,
    filename,
  });
  if (!ok) {
    throw new ImageStoreError(
      `圖片上傳失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* 響應不是 JSON,落到下方統一報錯 */
  }
  if (!path) throw new ImageStoreError('圖片上傳失敗：服務端未返回路徑');
  return path;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 列出 user/images 下的一級子目錄名(相簿按角色分組的唯一名字來源)。
 *
 * 落盤檔名裡的角色名是雜湊(見 floor/storage.ts imageFileName),可讀名只能從目錄名還原,
 * 故相簿必須先取目錄、再逐目錄列圖,不能反過來從檔名推。
 */
export async function listUserImageFolders(): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/folders', {});
  if (!ok) {
    throw new ImageStoreError(
      `讀取圖片目錄失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/**
 * 列出某個目錄下的圖片檔名(僅檔名,不含路徑),返回順序即服務端排序結果。
 *
 * ⚠ 服務端對不存在的目錄會 mkdir 遞迴建立(images.js /list),故只能拿
 * listUserImageFolders() 的結果去列——憑空猜目錄名會在 user/images 下攢出空資料夾。
 */
export async function listUserImages(
  folder: string,
  options: { sortField?: 'date' | 'name'; sortOrder?: 'asc' | 'desc' } = {},
): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/list', {
    folder,
    sortField: options.sortField ?? 'date',
    sortOrder: options.sortOrder ?? 'desc',
  });
  if (!ok) {
    throw new ImageStoreError(
      `讀取圖片列表失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/**
 * 探一張圖的存在性與體積:HEAD 靜態路由取 Content-Length,不下載圖片本身。
 *
 * 為什麼非 HEAD 不可:`/api/images/list` **只返回檔名**,既無 size 也無 mtime
 * (服務端 util.js getImages 只 map 出 dirent.name),而相簿要顯示體積、卡片要判斷
 * 「這張圖是不是真沒了」,都只能逐張問。實測 HEAD 走 users.js 的 createRouteHandler →
 * res.sendFile,響應 1~2ms 且無 body,比列表介面改造便宜得多。
 *
 * 走裸 fetch 不帶 headers——靜態路由不需要鑑權頭(與 backends/vibeStore.ts loadVibeData 同款)。
 *
 * 返回值刻意三分:
 * - `{ exists: true, size }`   檔案在,size 為位元組數(缺 Content-Length 時為 null);
 * - `{ exists: false }`        服務端明確說沒有(404);
 * - `null`                     **分不清**(網路錯誤/超時/5xx)。
 *
 * 第三態是關鍵:卡片憑它決定要不要把圖示記成「已刪除」。把一次掉線當成刪除,
 * 會讓使用者網一抖就看見滿屏「檔案已刪除」。
 */
export async function probeUserImage(
  path: string,
  timeoutMs = 8000,
): Promise<{ exists: true; size: number | null } | { exists: false } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method: 'HEAD', signal: controller.signal });
    if (response.status === 404) return { exists: false };
    if (!response.ok) return null;
    // 必須先判空再轉數字:header 缺失時 get() 返回 null,而 `Number(null)` 是 **0** 不是 NaN,
    // 直接轉會把「不知道多大」謊報成「0 位元組」,分組體積憑空少算一張。
    const raw = response.headers.get('content-length');
    const length = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return { exists: true, size: Number.isFinite(length) && length >= 0 ? length : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 刪除 user/images 下的圖片。返回 false 表示檔案本就不存在(無需清理)。 */
export async function deleteUserImage(path: string): Promise<boolean> {
  const { ok, status, text } = await postImage('/api/images/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new ImageStoreError(
    `圖片刪除失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
    status,
  );
}
