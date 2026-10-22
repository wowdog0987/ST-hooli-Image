import { naiDefaultUndesired, parseNaiv4vibe } from '@/backends/nai';
import {
  clampVibeStrength,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import { getContext } from '@/st/context';
import { newNaiArtist, type NaiArtistPreset, type NaiVibe } from '@/state/settings';

/**
 * 智繪姬(st-chatu8)vibe 相容匯入(只讀,絕不寫智繪姬的任何資料)。
 *
 * chatu8 的 vibe 儲存模型:
 * - extension_settings['st-chatu8'] 裡:
 *   - vibePresets: { [預設名]: { vibeDataId, strength, model, ... } }(Vibe 生成器預設)
 *   - vibeGroups: { [組名]: { vibes: [{ vibeDataId, strength }] } }(NAI4/4.5 vibe 組)
 *   - configImageStorage: { [id]: { path } } —— 存到酒館伺服器時的路徑對映
 * - vibe 資料本體是 .naiv4vibe 格式的 JSON 字串,兩處可能:
 *   a) 酒館伺服器檔案(configImageStorage[id].path 可直接 fetch);
 *   b) IndexedDB「chatu8_config_images」庫的 config_images 表(記錄 {id, data})。
 * 格式與我們的一致(同為官方 novelai-vibe-transfer),解析直接複用 parseNaiv4vibe。
 */

/** 智繪姬在 extension_settings 裡的名稱空間鍵。 */
export const CHATU8_SETTINGS_KEY = 'st-chatu8';
const CHATU8_DB_NAME = 'chatu8_config_images';
const CHATU8_STORE_NAME = 'config_images';
const FETCH_TIMEOUT_MS = 20_000;

export { vibeFingerprint } from '@/backends/vibeStore';

export interface Chatu8VibeRef {
  vibeDataId: string;
  strength: number;
  /** 來源名:預設名或組名(用於命名匯入條目)。 */
  source: string;
  kind: 'preset' | 'group';
}

export interface Chatu8ArtistRef {
  /** Source preset name in st-chatu8. */
  source: string;
  /** 前置固定正向(fixedPrompt)→ 目標畫師串位(正向最前,與智繪姬拼裝位置一致)。 */
  prompt: string;
  /** 後置固定正向(fixedPrompt_end)→ 目標正面質量詞位(正向最後,與智繪姬拼裝位置一致)。 */
  quality: string;
  /** 固定負向(negativePrompt);匯入時會在前面拼上當前模型官方基線(智繪姬同口徑:官方 UCP + 使用者負向)。 */
  negative: string;
  /** Whether this is the currently selected NovelAI prompt preset in st-chatu8. */
  active: boolean;
}

/** Collect every shared st-chatu8 prompt preset; the source does not track per-backend ownership. */
export function collectChatu8ArtistRefs(chatu8: unknown): Chatu8ArtistRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  if (!root.yushe || typeof root.yushe !== 'object') return [];
  const activeName = typeof root.yusheid_novelai === 'string' ? root.yusheid_novelai : '';
  const refs: Chatu8ArtistRef[] = [];
  for (const [source, value] of Object.entries(root.yushe)) {
    if (!value || typeof value !== 'object') continue;
    const preset = value as Record<string, unknown>;
    refs.push({
      source,
      prompt: typeof preset.fixedPrompt === 'string' ? preset.fixedPrompt.trim() : '',
      quality: typeof preset.fixedPrompt_end === 'string' ? preset.fixedPrompt_end.trim() : '',
      negative: typeof preset.negativePrompt === 'string' ? preset.negativePrompt.trim() : '',
      active: source === activeName,
    });
  }
  return refs;
}

export interface Chatu8ArtistDetectInfo {
  found: boolean;
  total: number;
}

export function detectChatu8Artists(chatu8: unknown): Chatu8ArtistDetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0 };
  return { found: true, total: collectChatu8ArtistRefs(chatu8).length };
}

/** 一條預設的去向(與 collectChatu8ArtistRefs 順序一一對應,預覽徽標與落盤共用)。 */
export interface Chatu8ArtistPlan {
  source: string;
  /** 前置固定正向(預覽用)。 */
  prompt: string;
  /** 後置固定正向(預覽用)。 */
  quality: string;
  /** 固定負向原文(預覽用;落盤值在 preset 裡,前面已拼上官方基線)。 */
  negative: string;
  active: boolean;
  /** import = 新建條目;overwrite = 同名覆蓋現有條目;skip = 內容完全相同,跳過。 */
  state: 'import' | 'overwrite' | 'skip';
  /** 目標條目 id:overwrite/skip 指向現有條目;import 指向新建條目。 */
  targetId: string;
  /** import/overwrite 時攜帶最終落庫值(overwrite 時 id = 現有條目 id)。 */
  preset?: NaiArtistPreset;
}

export interface Chatu8ArtistImportResult {
  found: boolean;
  imported: number;
  overwritten: number;
  duplicates: number;
  plans: Chatu8ArtistPlan[];
  /** Matching target id for the source's active NovelAI preset; the caller decides whether to select it. */
  activeArtistId: string;
}

/**
 * 把智繪姬的全部提示詞預設搬進畫師串庫(純函式,絕不寫智繪姬)。
 *
 * 對映(與智繪姬生成時的拼裝位置一一對應):
 * - fixedPrompt(前置固定正向)→ 目標 prompt(畫師串位,正向最前);
 * - fixedPrompt_end(後置固定正向)→ 目標 quality(正面質量詞位,正向最後);
 * - negativePrompt(固定負向)→ 目標 negative。智繪姬的口徑是「官方 UCP + 使用者負向」,
 *   故使用者負向非空時把當前模型官方基線烤在它前面(基線在匯入時即定,隨後不隨模型切換);
 *   使用者負向為空則留空走回落鏈,基線仍跟隨模型,與智繪姬空負向時只用 UCP 同效。
 *
 * 同名即視為同一配方:內容不同 → 覆蓋更新(舊版遷移把正向整體塞進畫師串的條目,
 * 重新匯入即被修好),完全相同 → 跳過。冪等,隨時可再來。
 */
export function importArtistsFromChatu8(
  existing: readonly NaiArtistPreset[],
  chatu8: unknown = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY],
  model: string,
): Chatu8ArtistImportResult {
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, overwritten: 0, duplicates: 0, plans: [], activeArtistId: '' };
  }

  // 同名覆蓋按「首個同名條目」處理(庫允許重名、以 id 為鍵;其餘同名條目不動)。
  const byName = new Map<string, NaiArtistPreset>();
  for (const preset of existing) {
    const name = preset.name.trim();
    if (name && !byName.has(name)) byName.set(name, preset);
  }

  const bakeNegative = (ref: Chatu8ArtistRef): string =>
    ref.negative ? [naiDefaultUndesired(model), ref.negative].filter(Boolean).join(', ') : '';

  const buildPreset = (ref: Chatu8ArtistRef, negative: string): NaiArtistPreset => {
    const preset = newNaiArtist(ref.source);
    preset.prompt = ref.prompt;
    preset.quality = ref.quality;
    preset.negative = negative;
    return preset;
  };

  const result: Chatu8ArtistImportResult = {
    found: true,
    imported: 0,
    overwritten: 0,
    duplicates: 0,
    plans: [],
    activeArtistId: '',
  };

  for (const ref of collectChatu8ArtistRefs(chatu8)) {
    const negative = bakeNegative(ref);
    const sameContent = (p: NaiArtistPreset) =>
      p.prompt.trim() === ref.prompt && p.quality.trim() === ref.quality && p.negative.trim() === negative;

    const existingPreset = byName.get(ref.source.trim());
    if (existingPreset) {
      if (sameContent(existingPreset)) {
        result.duplicates++;
        result.plans.push({ ...ref, negative, state: 'skip', targetId: existingPreset.id });
      } else {
        const preset = buildPreset(ref, negative);
        preset.id = existingPreset.id;
        result.overwritten++;
        result.plans.push({ ...ref, negative, state: 'overwrite', targetId: existingPreset.id, preset });
      }
      if (ref.active) result.activeArtistId = existingPreset.id;
      continue;
    }

    const preset = buildPreset(ref, negative);
    result.imported++;
    result.plans.push({ ...ref, negative, state: 'import', targetId: preset.id, preset });
    if (ref.active) result.activeArtistId = preset.id;
  }
  return result;
}

/** 從 chatu8 設定裡收集全部 vibe 引用(預設 + 組),按 vibeDataId 去重(預設優先,命名更好看)。 */
export function collectChatu8VibeRefs(chatu8: unknown): Chatu8VibeRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  const refs: Chatu8VibeRef[] = [];
  const seen = new Set<string>();
  const push = (vibeDataId: unknown, strength: unknown, source: string, kind: Chatu8VibeRef['kind']) => {
    if (typeof vibeDataId !== 'string' || !vibeDataId || seen.has(vibeDataId)) return;
    seen.add(vibeDataId);
    refs.push({ vibeDataId, strength: clampVibeStrength(strength), source, kind });
  };

  const presets = root.vibePresets;
  if (presets && typeof presets === 'object') {
    for (const [name, preset] of Object.entries(presets)) {
      const p = preset as Record<string, unknown> | null;
      if (p && typeof p === 'object') push(p.vibeDataId, p.strength, name, 'preset');
    }
  }
  const groups = root.vibeGroups;
  if (groups && typeof groups === 'object') {
    for (const [groupName, group] of Object.entries(groups)) {
      const g = group as { vibes?: unknown } | null;
      if (!g || !Array.isArray(g.vibes)) continue;
      for (const vibe of g.vibes) {
        const v = vibe as Record<string, unknown> | null;
        if (v && typeof v === 'object') push(v.vibeDataId, v.strength, groupName, 'group');
      }
    }
  }
  return refs;
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return '';
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  return header.includes(';base64') ? base64ToUtf8(data) : decodeURIComponent(data);
}

/** 與 chatu8 getConfigText 的伺服器分支同口徑:fetch 路徑後按 data:/JSON/base64 嘗試解碼。 */
async function fetchServerText(path: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(path, { signal: controller.signal });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (text.startsWith('data:')) return decodeDataUrlText(text);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;
    try {
      return base64ToUtf8(trimmed);
    } catch {
      return text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 讀 chatu8 的 IndexedDB(不帶版本號開啟,避免觸發 upgrade;只讀單條記錄)。
 * data 可能是字串(text)或 ArrayBuffer(圖片,不會是 vibe 文本,忽略)。
 */
let chatu8DbPromise: Promise<IDBDatabase | null> | null = null;

function openChatu8Db(): Promise<IDBDatabase | null> {
  if (chatu8DbPromise) return chatu8DbPromise;
  chatu8DbPromise = new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(CHATU8_DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHATU8_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
  });
  return chatu8DbPromise;
}

async function readChatu8Store(id: string): Promise<string | null> {
  const db = await openChatu8Db();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const get = db.transaction([CHATU8_STORE_NAME], 'readonly').objectStore(CHATU8_STORE_NAME).get(id);
      get.onsuccess = () => {
        const data = (get.result as { data?: unknown } | undefined)?.data;
        if (typeof data === 'string') resolve(data);
        else resolve(null);
      };
      get.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface Chatu8DetectInfo {
  /** 是否檢測到智繪姬設定。 */
  found: boolean;
  /** vibe 引用總數(預設+組內,已按 id 去重)。 */
  total: number;
  presets: number;
  groups: number;
}

/** 智繪姬 vibe 檢測:只讀 settings 裡的引用列表(同步、廉價),供遷移面板即時展示。 */
export function detectChatu8Vibes(chatu8: unknown): Chatu8DetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0, presets: 0, groups: 0 };
  const refs = collectChatu8VibeRefs(chatu8);
  return {
    found: true,
    total: refs.length,
    presets: refs.filter(r => r.kind === 'preset').length,
    groups: refs.filter(r => r.kind === 'group').length,
  };
}

/** 舊版遷移把組名拼進了顯示名,分隔符是「 · 」。 */
const LEGACY_GROUP_SEPARATOR = ' · ';

export interface PrefixGroupPlan {
  id: string;
  /** 從名字字首識別出的組名。 */
  group: string;
  /** 去掉字首後的顯示名。 */
  name: string;
}

/**
 * 為「已經遷移過」的庫補分組:舊版把組名拼成了「組名 · 原名」,這裡把字首還原成 group。
 *
 * 只動 group 為空的條目(不覆蓋使用者已手工分好的組),且字首與餘名都非空才算。
 * 純函式、只返回需要改動的條目,呼叫方決定是否落盤——使用者點按鈕前要能看到「將整理 N 個」。
 */
export function planPrefixGroups(
  vibes: readonly Pick<NaiVibe, 'id' | 'name' | 'group'>[],
): PrefixGroupPlan[] {
  const plans: PrefixGroupPlan[] = [];
  for (const vibe of vibes) {
    if (vibe.group.trim()) continue;
    const at = vibe.name.indexOf(LEGACY_GROUP_SEPARATOR);
    if (at <= 0) continue;
    const group = vibe.name.slice(0, at).trim();
    const name = vibe.name.slice(at + LEGACY_GROUP_SEPARATOR.length).trim();
    if (!group || !name) continue;
    plans.push({ id: vibe.id, group, name });
  }
  return plans;
}

export interface Chatu8ImportResult {
  /** 是否檢測到 chatu8 設定。 */
  found: boolean;
  imported: number;
  /** 內容與本庫已有(或本次已匯入)重複而跳過。 */
  duplicates: number;
  /** 引用存在但資料取不到/解析失敗。 */
  failed: number;
  /** 待入庫的新條目(呼叫方 push 進 settings.nai.vibes)。 */
  vibes: NaiVibe[];
}

let importSeq = 0;

export interface Chatu8ImportOptions {
  onProgress?: (current: number, total: number) => void;
}

/**
 * 從 st-chatu8 匯入全部 vibe。existing 傳當前庫(內容去重用)。
 * 單個失敗不阻塞整體;結果為 null 表示未檢測到 chatu8。
 */
export async function importVibesFromChatu8(
  existing: NaiVibe[],
  options: Chatu8ImportOptions = {},
): Promise<Chatu8ImportResult> {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, duplicates: 0, failed: 0, vibes: [] };
  }
  const refs = collectChatu8VibeRefs(chatu8);
  const serverMap =
    (chatu8 as Record<string, unknown>).configImageStorage &&
    typeof (chatu8 as Record<string, unknown>).configImageStorage === 'object'
      ? ((chatu8 as Record<string, unknown>).configImageStorage as Record<string, { path?: unknown }>)
      : {};

  const fingerprints = new Set(existing.map(v => v.fingerprint).filter(Boolean));
  const result: Chatu8ImportResult = { found: true, imported: 0, duplicates: 0, failed: 0, vibes: [] };

  for (const [index, ref] of refs.entries()) {
    options.onProgress?.(index + 1, refs.length);
    // 伺服器優先(chatu8 同口徑),取不到再試 IndexedDB
    const path = serverMap[ref.vibeDataId]?.path;
    let text = typeof path === 'string' && path ? await fetchServerText(path) : null;
    if (!text) text = await readChatu8Store(ref.vibeDataId);
    if (!text) {
      result.failed++;
      continue;
    }
    // IndexedDB 裡可能存的是 dataURL 字串,先剝殼
    if (text.startsWith('data:')) text = decodeDataUrlText(text);
    try {
      const parsed = parseNaiv4vibe(text);
      const fingerprint = vibeFingerprint(parsed.encodings);
      if (fingerprints.has(fingerprint)) {
        result.duplicates++;
        continue;
      }
      const id = `vibe_${Date.now()}_${++importSeq}`;
      const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
      const paths = await saveVibeFiles(data, null, id);
      fingerprints.add(fingerprint);
      result.vibes.push(
        vibeMetaFromData(
          id,
          // 預設用預設名(使用者起的);組內條目無名,用 vibe 檔案原名(組名已進 group 欄位,
          // 不再拼進顯示名——那會變成「組名 · 組名 · xxx」的重複)
          ref.kind === 'preset' ? ref.source : parsed.name,
          paths.dataPath,
          paths.thumbnailPath,
          data,
          ref.strength,
          false,
          // 智繪姬的組結構原樣保留;預設不屬於任何組
          ref.kind === 'group' ? ref.source : '',
        ),
      );
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
