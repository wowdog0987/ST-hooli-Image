import type { ComfyImageResult } from '@/backends/comfyui';
import { utf8ToBase64 } from '@/base64';
import { normalizeImagePath } from '@/floor/missingImages';
import { deleteUploadedFile, uploadBase64File } from '@/floor/upload';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { deleteUserImage, uploadUserImage } from '@/st/images';
import { settings } from '@/state/settings';

/**
 * 樓層卡片結果儲存層（DESIGN-FLOOR-UI.md §7）。
 *
 * 兩層分離：
 * - 新圖片二進位制 → ST 檔案系統（user/images/柏宝绘_<角色名>/），extra 只存指標 path。
 *   舊 user/files 圖片保留原位，不遷移、不刪除。
 * - 後設資料 → message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }
 *   按 swipeId 分桶（滑動互不汙染）；promptHash 鍵下是歷史列表（時間正序，
 *   最新在末尾，卡片翻頁瀏覽）；水合時用當前 tag 原文重算 hash 做 stale 檢測。
 *
 * 資料夾名由 ST 上傳介面清洗，目錄內保留原有檔案命名：
 *   bbi_<characterNameHash>_<swipeId>_<promptHash>-<generationId>.<ext>
 *
 * 另有第三層「側寫」（sidecar，見 sidecarFileName）：與圖片同名的 .json，落在 user/files。
 * 只為相簿服務——相簿跨全部聊天按目錄列圖，而提示詞只存在某一個聊天的 extra 裡，
 * 掃全庫 JSONL 反查不可行（實測單個角色目錄就有 GB 級、且 /api/chats/get 無分頁）。
 */

export interface BbiImageEntry {
  /** 本次生成唯一 id。 */
  generationId: string;
  /** ST 靜態路徑 /user/images/... 或舊 /user/files/...（<img src> 直接引用）。 */
  path: string;
  /** 生成時使用的完整 tag 原文（含 <hooli_image> 殼），與 promptHash 輸入一致。 */
  prompt: string;
  /** 本次生成種子；第四步種子策略落地前固定 null。 */
  seed: number | null;
  status: 'ready' | 'error';
  createdAt: number;
  /** 生成時所在槽位序號（樓層內第 N 個 tag）。多 tag 樓層按位置隔離結果；
   *  舊資料缺失時按 entrySeq() 回退為 0。 */
  slotSeq?: number;
}

/** [swipeId][promptHash] = 歷史 entry 列表。 */
export type BbiImageStore = Record<string, Record<string, BbiImageEntry[]>>;

export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';

/* —— hash 與命名 —— */

/** cyrb53 派生：同步、確定、對聊天級提示詞足夠分散；輸出 14 位 hex。 */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function generationId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 平鋪檔名：角色卡名稱雜湊化，避免中文名稱被替換成連續下劃線。 */
export function imageFileName(
  characterName: string,
  swipeId: number,
  hash: string,
  genId: string,
  ext: string,
): string {
  const characterHash = promptHash(characterName.trim() || 'unknown');
  return `bbi_${characterHash}_${swipeId}_${hash}-${genId}.${ext}`;
}

/* —— 側寫後設資料（sidecar） —— */

/** 側寫 json 的內容。v 是版本號：日後想加 backend/model 時靠它分辨老檔案。 */
export interface BbiImageSidecar {
  v: 1;
  /** 可讀角色名（圖片檔名裡那個是雜湊，還原不回來）。 */
  character: string;
  /** 生成時使用的完整 tag 原文（含 <hooli_image> 殼），與 entry.prompt 同源。 */
  prompt: string;
  seed: number | null;
  createdAt: number;
}

/**
 * 由圖片檔名推出側寫檔名（換掉副檔名而已）。**讀寫兩側唯一口徑**。
 *
 * 之所以能這麼算、不用維護索引：/api/files/upload 是 `path.join(dir, body.name)` 原樣落盤
 * （files.js，只校驗不清洗），故上傳時給什麼名字、事後就能憑同一個純函式算回來。
 * 而圖片名 bbi_<hash>_<swipe>_<promptHash>-<genId> 恰好全在
 * validateAssetFileName 的白名單 /^[a-zA-Z0-9_\-.]+$/ 內，天然合規。
 *
 * 側寫只能放 user/files:/api/images/upload 的 format 必須是媒體副檔名，json 不在其列，
 * 塞不進圖片自己的目錄。
 */
export function sidecarFileName(imageFile: string): string {
  const base = imageFile.replace(/\.[^./]*$/, '');
  return `${base}.json`;
}

/** 由圖片路徑（/user/images/…）推出側寫的可訪問路徑；不是本外掛的圖片則返回空串。 */
export function sidecarPathFor(imagePath: string): string {
  const file = imagePath.split('/').pop() ?? '';
  // 只認自家命名的圖:外來檔案算出來的名字必然 404，白刷一輪請求
  if (!/^bbi_[a-zA-Z0-9_]+-[a-zA-Z0-9]+\.[a-z0-9]+$/i.test(file)) return '';
  return `/user/files/${sidecarFileName(file)}`;
}

/* —— extra 讀寫（純函式） —— */

export function readStore(message: STMessage): BbiImageStore | null {
  const extra = message.extra;
  if (!extra || typeof extra[BBI_IMAGE_EXTRA_KEY] !== 'object' || extra[BBI_IMAGE_EXTRA_KEY] === null) {
    return null;
  }
  return extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
}

/** hash 匹配的最新一條結果（卡片 ready）。 */
/** 舊資料（無 slotSeq 欄位）回退為槽位 0。 */
function entrySeq(entry: BbiImageEntry): number {
  return entry.slotSeq ?? 0;
}

/**
 * 同提示詞的全部歷史（時間正序，最新在末尾）。卡片翻頁用。
 * anySeq=true(本樓只有這一條是這個提示詞)時不看槽位:追加一張插在它前面、讓它的 seq 往後推,
 * 圖片照樣跟著提示詞走。同一樓有兩條相同提示詞時才用 seq 區分。
 */
export function historyEntries(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
  anySeq = false,
): BbiImageEntry[] {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list) return [];
  return anySeq ? [...list] : list.filter(entry => entrySeq(entry) === seq);
}

/** hash 匹配且位於同一槽位的最新一條結果（卡片 ready）。 */
export function latestEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (entrySeq(list[i]) === seq) return list[i];
  }
  return null;
}

/** 當前 hash 無該槽位結果時，其它提示詞（stale）在同一槽位的最新一條（卡片 stale）。
 *  只取同槽位：相鄰 tag 的結果不會被誤當成這個 tag 的歷史。
 *  liveHashes:本樓現存各 tag 的 hash——它們的圖屬於那些 tag 自己,不能借給別人當舊圖。 */
export function latestStaleEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
  liveHashes?: ReadonlySet<string>,
): BbiImageEntry | null {
  const bucket = store?.[String(swipeId)];
  if (!bucket) return null;
  let latest: BbiImageEntry | null = null;
  for (const [key, list] of Object.entries(bucket)) {
    if (key === hash || list.length === 0 || liveHashes?.has(key)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (entrySeq(list[i]) !== seq) continue;
      const candidate = list[i];
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
      break; // 該桶內最新的一條即可
    }
  }
  return latest;
}

/** 不可變式追加一條歷史（返回新 store，原 store 不動）。 */
export function appendEntry(
  store: BbiImageStore,
  swipeId: number,
  hash: string,
  entry: BbiImageEntry,
): BbiImageStore {
  const swipeKey = String(swipeId);
  const next: BbiImageStore = { ...store };
  next[swipeKey] = { ...(store[swipeKey] ?? {}) };
  next[swipeKey][hash] = [...(store[swipeKey]?.[hash] ?? []), entry];
  return next;
}

/* —— CAS 寫回 —— */

/**
 * 讀-改-寫迴圈：mutate 基於當前 store 返回新 store，寫回前校驗引用未被
 * 併發寫入替換，衝突則基於最新 store 重試（DESIGN-FLOOR-UI.md §7.2）。
 */
export async function mutateStore(
  ctx: STContext,
  messageId: number,
  mutate: (store: BbiImageStore) => BbiImageStore,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const message = ctx.chat[messageId];
    if (!message) return false;
    if (!message.extra) message.extra = {};
    let store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined;
    if (!store) {
      // 首次建立：同步寫回空物件確立引用（無 await，無競態視窗）
      message.extra[BBI_IMAGE_EXTRA_KEY] = {};
      store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
    }
    const next = mutate(store);
    if (message.extra[BBI_IMAGE_EXTRA_KEY] !== store) continue; // 併發寫入，重試
    message.extra[BBI_IMAGE_EXTRA_KEY] = next;
    await ctx.saveChat();
    return true;
  }
  console.warn('[虎哩繪] extra 寫入重試耗盡，放棄本次寫入');
  return false;
}

/* —— 儲存流程 —— */

async function resultToBase64(result: ComfyImageResult): Promise<string> {
  if (result.url.startsWith('data:')) {
    // server 代理模式：data URL 去字首直接用
    const comma = result.url.indexOf(',');
    return result.url.slice(comma + 1);
  }
  // browser 直連模式：blob URL → blob → base64（分塊拼接防棧溢位）
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`讀取圖片失敗 (${response.status})`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* —— 可選 JPG 轉存(settings.storage.saveAsJpeg) —— */

/** 轉碼質量：視覺無損檔。不併設滑條——極少數不滿意直接關開關即可，免多一項配置。 */
const JPEG_QUALITY = 0.9;

function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new FileReader();
  return new Promise((resolve, reject) => {
    buffer.onload = () => {
      const dataUrl = String(buffer.result ?? '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('轉碼後圖片格式無效'));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    buffer.onerror = () => reject(new Error('轉碼後圖片讀取失敗'));
    buffer.readAsDataURL(blob);
  });
}

/**
 * 把原圖重編碼為 JPG(固定質量 0.9,自底向上重繪消除 alpha)。
 * PNG → canvas → JPEG：丟掉內嵌生成引數(NAI tEXt / ComfyUI 工作流塊)，換來
 * 約為原體積 10–20% 的檔案——這是有意為之的取捨，開關預設關。
 * 注：canvas 解碼即屏敔一切後設資料，無需額外「抹除」步驟。
 */
async function reencodeAsJpeg(source: Blob): Promise<Blob> {
  // createImageBitmap 比 <img> 快且不進 DOM；但部分環境(如 iOS Safari 舊版)對
  // EXIF 取向敏感度不同，這裡顯式 imageOrientation: 'none' 保持畫素原樣
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D 上下文不可用');
    // JPG 無 alpha 通道：先鋪白底再繪圖，否則透明區域被壓成黑色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('JPG 編碼失敗'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * 按設定準備待落盤的圖片：開關開啟時重編碼為 JPG，關閉時原樣返回。
 * 轉碼鏈路任何一步失敗都回退原格式——寧可多佔磁碟也不能把圖開壞或丟失。
 */
export async function prepareImageForStorage(result: ComfyImageResult): Promise<{
  base64: string;
  format: string;
}> {
  if (settings.storage.saveAsJpeg) {
    try {
      // data URL/blob URL 都能被 fetch 成 Blob
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`讀取圖片失敗 (${response.status})`);
      const original = await response.blob();
      // 本就是 JPG(webp 等不可再壓)時直接跳過重編碼，避免二次有損
      if (result.format !== 'jpg' && result.format !== 'jpeg') {
        const jpeg = await reencodeAsJpeg(original);
        return { base64: await blobToBase64(jpeg), format: 'jpg' };
      }
      return { base64: await blobToBase64(original), format: result.format };
    } catch (error) {
      console.warn('[虎哩繪] JPG 轉碼失敗，本次回退儲存原格式', error);
    }
  }
  return { base64: await resultToBase64(result), format: result.format };
}

/**
 * 圖片二進位制 + 側寫 json 落盤。**存圖的唯一物理路徑**,樓層與公開介面共用。
 *
 * 不碰聊天記錄:樓層側隨後自己寫 extra 指標,公開介面側壓根沒有指標要寫
 * (第三方自己決定圖顯示在哪,圖不進任何樓層正文)。
 *
 * 檔名與目錄必須走這裡,不能各自另起一套:
 * - 目錄 `柏宝绘_<角色名>` 是相簿的**唯一**分組依據(index.vue 只列 FOLDER_PREFIX 開頭的目錄),
 *   名字換個字首,圖存下去了但相簿裡看不見;
 * - 檔名 `bbi_…-<genId>.<ext>` 要能被 sidecarPathFor 的正則認出來,否則它返回空串、
 *   相簿壓根不去請求側寫 —— 症狀是圖在、提示詞空白、**且沒有任何報錯**。
 */
async function uploadImageWithSidecar(
  characterName: string,
  swipeId: number,
  hash: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
): Promise<{ path: string; genId: string; createdAt: number; imageFile: string }> {
  const genId = generationId();
  // 先按設定決定落盤格式(開關開啟時重編碼為 JPG),檔名字尾跟隨實際格式
  const { base64, format } = await prepareImageForStorage(result);
  const imageFile = imageFileName(characterName, swipeId, hash, genId, format);
  const path = await uploadUserImage(`柏宝绘_${characterName}`, imageFile, base64, format);
  const createdAt = Date.now();

  // 側寫:相簿跨聊天瀏覽時,提示詞只能從這裡拿。
  // **失敗只警告不拋** —— 圖已經存好了,絕不能因為一個附屬 json 讓整次存圖失敗;
  // 使用者寧可少看一段提示詞,也不能丟圖。
  const sidecar: BbiImageSidecar = { v: 1, character: characterName, prompt: tag, seed, createdAt };
  try {
    await uploadBase64File(sidecarFileName(imageFile), utf8ToBase64(JSON.stringify(sidecar)));
  } catch (error) {
    console.warn('[虎哩繪] 側寫後設資料寫入失敗（不影響圖片）', error);
  }

  return { path, genId, createdAt, imageFile };
}

/**
 * 存一張**不屬於任何樓層**的圖(公開介面 STBaiBaiImage.generate 的 save 路徑)。
 *
 * 與 saveImageResult 的分工:那個存完還要寫 extra 指標、觸發重水合,讓樓層卡片顯示它;
 * 這個只把檔案放進相簿就收工 —— 第三方外掛自己決定圖顯示在哪(這正是公開介面的意義),
 * 虎哩繪不替它往聊天記錄裡塞任何東西。
 *
 * swipeId 固定 0:檔名裡那一格本是「同一樓的第幾個 swipe」,外部圖沒有樓層座標,
 * 取 0 只為讓檔名保持同一格式(相簿與 sidecarPathFor 都靠格式認圖)。
 * 唯一性由 genId 保證,不靠這一格。
 */
export async function saveExternalImage(
  characterName: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
): Promise<string> {
  const name = characterName.trim() || '未命名角色';
  const { path } = await uploadImageWithSidecar(name, 0, promptHash(tag), tag, seed, result);
  return path;
}

/**
 * 完整儲存流程（DESIGN-FLOOR-UI.md §7.6）：
 * 圖片二進位制落盤 → extra 寫指標（先檔案後指標，避免孤兒指標）；
 * 指標寫失敗則檔案留作孤兒，由後續清理兜底。
 */
export async function saveImageResult(
  messageId: number,
  swipeId: number,
  seq: number,
  tag: string,
  seed: number,
  result: ComfyImageResult,
): Promise<BbiImageEntry> {
  const ctx = getContext();
  if (!ctx?.saveChat) throw new Error('SillyTavern 上下文不可用');
  const chatId = ctx.getCurrentChatId();
  if (!chatId) throw new Error('當前聊天不可用');

  const hash = promptHash(tag);
  const characterName = ctx.chat[messageId]?.name?.trim() || ctx.name2?.trim() || '未命名角色';
  const { path, genId, createdAt } = await uploadImageWithSidecar(
    characterName,
    swipeId,
    hash,
    tag,
    seed,
    result,
  );

  const entry: BbiImageEntry = {
    generationId: genId,
    path,
    prompt: tag,
    // 本次生成實際使用的種子（呼叫方生成後傳入；-1 不在支援範圍）
    seed,
    status: 'ready',
    createdAt,
    slotSeq: seq,
  };

  const saved = await mutateStore(ctx, messageId, store => appendEntry(store, swipeId, hash, entry));
  if (!saved) {
    console.warn('[虎哩繪] 圖片已上傳但 extra 寫入失敗，檔案留作孤兒', path);
    throw new Error('圖片已上傳，但聊天記錄儲存失敗');
  }
  return entry;
}

/**
 * 刪除一張圖的**檔案本體**(連同它的側寫 json),不碰任何聊天記錄。供相簿批次刪除使用。
 *
 * 與 deleteImageResult 的分工:那個是「從樓層刪一條結果」,先摘 extra 指標再刪檔案;
 * 這個是「從相簿刪一個檔案」,**沒有指標可摘**——相簿按目錄列圖,而指標散在各個聊天的
 * extra 裡,兩者之間沒有反向索引,掃全庫反查不可行(實測 chats 目錄 7 GB / 1243 個 jsonl,
 * 且 /api/chats/get 無分頁)。故這裡必然留下破指標,由樓層卡片側執行時降級兜底
 * (floor/missingImages.ts + Card.vue 的 @error)。
 *
 * 側寫刪失敗只警告:老圖本來就沒有側寫,404 屬預期常態(deleteUploadedFile 對 404 返回
 * false 不拋);真失敗了也只是多個幾 KB 的孤兒 json,不值得讓整次刪除報錯。
 *
 * 入口先 `normalizeImagePath`:呼叫方手上兩種寫法都有——相簿的 src 是逐段
 * encodeURIComponent 過的,extra/目錄列表裡的是原文。而 ST 的 /api/images/delete 與
 * /api/files/delete 都是把 body.path 直接 path.join 到根目錄、**不做 URL 解碼**,
 * 編碼路徑傳過去只會 404,還會被 deleteUserImage 當成「本就不存在」靜默吞掉——
 * 症狀就是圖沒刪掉、側寫卻真刪了。
 */
export async function deleteImageFileOnly(path: string): Promise<void> {
  const target = normalizeImagePath(path);
  await deleteUserImage(target);
  const sidecar = sidecarPathFor(target);
  if (!sidecar) return;
  try {
    await deleteUploadedFile(sidecar);
  } catch (error) {
    console.warn('[虎哩繪] 刪除側寫後設資料失敗（留作孤兒）', error);
  }
}

/**
 * 刪除一條結果：先 extra 刪指標並落盤，成功後再刪檔案（順序相反會留下
 * 指向已刪檔案的破指標；檔案刪除失敗則留作孤兒由清理兜底）。
 * 僅刪除 user/images 下的檔案（連同它的側寫 json），
 * 舊 user/files 圖片只移除記錄，保留原檔案。
 */
export async function deleteImageResult(
  messageId: number,
  swipeId: number,
  hash: string,
  genId: string,
): Promise<boolean> {
  const ctx = getContext();
  if (!ctx?.saveChat) return false;
  let pathToDelete = '';
  const removed = await mutateStore(ctx, messageId, store => {
    const bucket = store[String(swipeId)];
    const list = bucket?.[hash];
    if (!list) return store;
    const index = list.findIndex(entry => entry.generationId === genId);
    if (index < 0) return store;
    pathToDelete = list[index].path;
    const nextList = list.filter((_, i) => i !== index);
    const next: BbiImageStore = { ...store };
    next[String(swipeId)] = { ...bucket };
    if (nextList.length) {
      next[String(swipeId)][hash] = nextList;
    } else {
      delete next[String(swipeId)][hash];
    }
    return next;
  });
  if (!removed) return false;
  if (/^\/?user\/images\//.test(pathToDelete)) {
    try {
      await deleteUserImage(pathToDelete);
    } catch (error) {
      console.warn('[虎哩繪] 刪除圖片檔案失敗（留作孤兒）', error);
    }
    // 側寫跟著走。deleteUploadedFile 對 404 返回 false 不拋（老圖本就沒有側寫，屬正常）
    const sidecar = sidecarPathFor(pathToDelete);
    if (sidecar) {
      try {
        await deleteUploadedFile(sidecar);
      } catch (error) {
        console.warn('[虎哩繪] 刪除側寫後設資料失敗（留作孤兒）', error);
      }
    }
  }
  return true;
}
