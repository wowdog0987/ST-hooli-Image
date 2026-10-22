import { utf8ToBase64 } from '@/base64';
import { deleteUploadedFile, uploadBase64File } from '@/floor/upload';
import type { NaiVibe, NaiVibeData, NaiVibeEncodings } from '@/state/settings';
import { randomUuid } from '@/randomUuid';

const FETCH_TIMEOUT_MS = 20_000;
const LOCAL_DB_NAME = 'baibai_image_vibes';
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = 'vibes';
const LOCAL_PATH_PREFIX = 'idb:';

let localDbPromise: Promise<IDBDatabase> | null = null;

function openLocalDb(): Promise<IDBDatabase> {
  if (localDbPromise) return localDbPromise;
  localDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('開啟 Vibe 本地儲存失敗'));
    request.onblocked = () => reject(new Error('Vibe 本地儲存被其他頁面佔用'));
  });
  return localDbPromise;
}

async function writeLocalData(key: string, data: NaiVibeData): Promise<string> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).put(data, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('寫入 Vibe 本地儲存失敗'));
  });
  return `${LOCAL_PATH_PREFIX}${key}`;
}

async function readLocalData(path: string): Promise<NaiVibeData> {
  const db = await openLocalDb();
  const key = path.slice(LOCAL_PATH_PREFIX.length);
  return new Promise((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readonly').objectStore(LOCAL_STORE_NAME).get(key);
    request.onsuccess = () => {
      const data = request.result as NaiVibeData | undefined;
      if (data) resolve(data);
      else reject(new Error('Vibe 本地資料不存在'));
    };
    request.onerror = () => reject(request.error ?? new Error('讀取 Vibe 本地儲存失敗'));
  });
}

async function deleteLocalData(path: string): Promise<void> {
  const db = await openLocalDb();
  const key = path.slice(LOCAL_PATH_PREFIX.length);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('刪除 Vibe 本地資料失敗'));
  });
}

function safeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function storageFileName(path?: string, key = ''): string {
  const current = path?.split('/').pop();
  return current || `bbi-vibe-${safeFileKey(key) || randomUuid()}.json`;
}

function thumbnailFileName(dataUrl: string, path?: string, key = ''): string {
  const current = path?.split('/').pop();
  if (current) return current;
  const format = dataUrl.match(/^data:image\/([^;,]+)/i)?.[1]?.toLowerCase();
  const extension = format === 'jpeg' ? 'jpg' : format || 'jpg';
  return `bbi-vibe-thumb-${safeFileKey(key) || randomUuid()}.${extension}`;
}

function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export const DEFAULT_VIBE_STRENGTH = 0.6;

/**
 * Vibe 強度的唯一口徑:夾到 0–1,認不出數就回落預設值。
 *
 * 曾經有四份各自為政的實現(設定反序列化 / .naiv4vibe 解析 / 智繪姬匯入 / 面板輸入),
 * 其中三份寫作 `Number(v)`,而 `Number(null)` 與 `Number('')` 都是 0 ——
 * 「欄位缺失」於是被靜默判成「強度 0」,vibe 掛上了卻對畫面毫無影響,極難排查。
 * 這裡只認真正的數字和能解析出數字的字串(面板 <input> 給的是字串),
 * 其餘(null / '' / 空白串 / 布林 / 物件)一律回落預設值。
 */
export function clampVibeStrength(raw: unknown, def = DEFAULT_VIBE_STRENGTH): number {
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : def;
}

export function vibeFingerprint(encodings: NaiVibeEncodings): string {
  return Object.keys(encodings)
    .sort()
    .map(key => `${key}:${encodings[key].encoding.slice(0, 64)}`)
    .join('|');
}

export function vibeMetaFromData(
  id: string,
  name: string,
  dataPath: string,
  thumbnailPath: string,
  data: NaiVibeData,
  strength: number,
  enabled: boolean,
  group = '',
): NaiVibe {
  return {
    id,
    name,
    dataPath,
    thumbnailPath,
    modelKeys: Object.keys(data.encodings),
    hasImage: !!data.image,
    fingerprint: vibeFingerprint(data.encodings),
    strength,
    enabled,
    group,
  };
}

export async function saveVibeData(data: NaiVibeData, currentPath = '', key = ''): Promise<string> {
  const json = JSON.stringify(data);
  return uploadBase64File(storageFileName(currentPath, key), utf8ToBase64(json));
}

export async function saveVibeFiles(
  data: NaiVibeData,
  current: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'> | null = null,
  key = '',
): Promise<{ dataPath: string; thumbnailPath: string }> {
  const localKey = current?.dataPath.startsWith(LOCAL_PATH_PREFIX)
    ? current.dataPath.slice(LOCAL_PATH_PREFIX.length)
    : safeFileKey(key) || randomUuid();
  if (current?.dataPath.startsWith(LOCAL_PATH_PREFIX)) {
    return { dataPath: await writeLocalData(localKey, data), thumbnailPath: current.thumbnailPath };
  }
  try {
    return await saveServerVibeFiles(data, current, localKey);
  } catch (error) {
    if (current) throw error;
    console.warn('[虎哩繪] Vibe 寫入 ST 檔案儲存失敗，回退瀏覽器 IndexedDB:', error);
    return { dataPath: await writeLocalData(localKey, data), thumbnailPath: '' };
  }
}

async function saveServerVibeFiles(
  data: NaiVibeData,
  current: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'> | null,
  key: string,
): Promise<{ dataPath: string; thumbnailPath: string }> {
  const dataPath = await saveVibeData(data, current?.dataPath, key);
  if (current?.thumbnailPath) return { dataPath, thumbnailPath: current.thumbnailPath };
  if (!data.thumbnail) return { dataPath, thumbnailPath: current?.thumbnailPath ?? '' };
  try {
    const thumbnailPath = await uploadBase64File(
      thumbnailFileName(data.thumbnail, current?.thumbnailPath, key),
      dataUrlBase64(data.thumbnail),
    );
    return { dataPath, thumbnailPath };
  } catch (error) {
    if (!current?.dataPath) await deleteUploadedFile(dataPath).catch(() => {});
    throw error;
  }
}

export async function loadVibeData(vibe: Pick<NaiVibe, 'dataPath' | 'name'>): Promise<NaiVibeData> {
  if (!vibe.dataPath) throw new Error(`Vibe「${vibe.name}」缺少資料檔案`);
  if (vibe.dataPath.startsWith(LOCAL_PATH_PREFIX)) return readLocalData(vibe.dataPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(vibe.dataPath, { signal: controller.signal });
    if (!response.ok) throw new Error(`讀取 Vibe「${vibe.name}」失敗 (${response.status})`);
    const data = (await response.json()) as Partial<NaiVibeData>;
    if (!data || typeof data !== 'object' || !data.encodings || typeof data.encodings !== 'object') {
      throw new Error(`Vibe「${vibe.name}」資料格式無效`);
    }
    return {
      image: typeof data.image === 'string' ? data.image : '',
      thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : '',
      encodings: data.encodings as NaiVibeEncodings,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteVibeData(vibe: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'>): Promise<void> {
  let firstError: unknown = null;
  for (const path of [vibe.dataPath, vibe.thumbnailPath]) {
    if (!path) continue;
    try {
      if (path.startsWith(LOCAL_PATH_PREFIX)) await deleteLocalData(path);
      else await deleteUploadedFile(path);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
