import { getContext } from '@/st/context';
import { reactive } from 'vue';
import {
  findCharTag,
  normalizeCharTagStore,
  recomputeCharTags,
  removeCharTag,
  setGlobalCharTagSource,
  upsertCharTag,
  type CharTagEntry,
} from '@/state/charTags';

/**
 * 全域性角色固定外貌庫 —— 跨所有聊天生效的「只讀模板」。
 *
 * 定位:玩家角色等「哪個聊天都用同一張臉」的角色,建檔一次、處處生效。
 * 硬約束:**AI 永遠不能寫它**(charTags.applyCharTagOps 按鎖定名丟棄 changes),
 * 只有使用者手動增刪改、或把本聊天角色「提升為全域性」會寫。tag 有問題使用者自己改。
 *
 * 儲存:extensionSettings[GLOBAL_KEY](→ 伺服器 settings.json,跨裝置同步),
 * 帶 revision + 廣播事件,協議與 settings.ts 的共享渠道/排除名單同構。
 * 條目結構複用 CharTagEntry,但**不記 history**(跨聊天沒有樓層概念,也沒有可回滾的 AI 變更)。
 *
 * 依賴方向:本模組 → charTags(normalize/CRUD/重算);charTags → 本模組只經
 * setGlobalCharTagSource 注入的只讀 getter,不成模組環。
 */

const GLOBAL_KEY = 'baibai_image_char_global';
const GLOBAL_EVENT = 'st-baibai-image:char-global-changed';
const SCHEMA_VERSION = 1;

interface GlobalCharTagStore {
  schemaVersion: number;
  revision: number;
  entries: CharTagEntry[];
}

export const globalCharTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
let fingerprint = '';
let revision = 0;
let listenerBound = false;

function fingerprintOf(entries: CharTagEntry[]): string {
  return JSON.stringify(entries);
}

/** 全域性條目一律不帶 history(沒有可回滾的自動變更,手動編輯也不留痕,保持簡單)。 */
function normalizeGlobalEntries(raw: unknown): CharTagEntry[] {
  return normalizeCharTagStore(raw).map(entry => ({ ...entry, history: [] }));
}

function readStore(raw: unknown): GlobalCharTagStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<GlobalCharTagStore>;
  if (!Array.isArray(store.entries)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    entries: normalizeGlobalEntries({ version: 3, entries: store.entries }),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: GlobalCharTagStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(globalCharTagLib.entries)) as CharTagEntry[],
  };
  ctx.extensionSettings[GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: GlobalCharTagStore): void {
  const next = fingerprintOf(store.entries);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  globalCharTagLib.entries = store.entries;
  fingerprint = next;
  // 派生庫(合併種子 + 鎖定名)隨全域性庫變化即時重新整理
  recomputeCharTags();
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(GLOBAL_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/**
 * 啟動初始化:注入條目來源(必須在 bindCharTagSync 之前,首次重算就要帶上全域性庫),
 * 再從 extensionSettings 領養已有資料並掛上廣播監聽。
 */
export function initGlobalCharTags(): void {
  setGlobalCharTagSource(() => globalCharTagLib.entries);
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[GLOBAL_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
}

export function findGlobalCharTag(name: string): CharTagEntry | undefined {
  const clean = name.trim();
  return globalCharTagLib.entries.find(entry => entry.name === clean);
}

/** 新增/覆蓋全域性條目(僅使用者手動路徑呼叫;oldName 用於改名)。 */
export function upsertGlobalCharTag(entry: CharTagEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  const [normalized] = normalizeGlobalEntries({ version: 3, entries: [{ ...entry, name }] });
  if (!normalized) return false;
  if (oldName && oldName !== name) {
    const oldIndex = globalCharTagLib.entries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) globalCharTagLib.entries.splice(oldIndex, 1);
  }
  const index = globalCharTagLib.entries.findIndex(candidate => candidate.name === name);
  if (index >= 0) globalCharTagLib.entries[index] = normalized;
  else globalCharTagLib.entries.push(normalized);
  persist();
  recomputeCharTags();
  return true;
}

export function removeGlobalCharTag(name: string): boolean {
  const clean = name.trim();
  const index = globalCharTagLib.entries.findIndex(entry => entry.name === clean);
  if (index < 0) return false;
  globalCharTagLib.entries.splice(index, 1);
  persist();
  recomputeCharTags();
  return true;
}

/**
 * 把本聊天角色的**當前生效值**(含本聊天 AI 已改出的結果)快照進全域性庫,
 * 並刪除本聊天副本、清掉該角色在本聊天的樓層 ops —— 之後由全域性庫接管,
 * 任何聊天(包括本聊天)都以全域性值為準,AI 的 changes 對該名字一律無效。
 */
export function promoteCharTagToGlobal(name: string): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (!upsertGlobalCharTag({ ...current, fields: { ...current.fields }, history: [] })) return false;
  removeCharTag(name);
  return true;
}

/**
 * 反向出口:把全域性條目複製成本聊天副本。之後本聊天以副本為準(覆蓋全域性),
 * 該名字移出鎖定集,AI 在本聊天可照常對它變更;其他聊天不受影響。
 */
export function copyGlobalCharTagToChat(name: string): boolean {
  const global = findGlobalCharTag(name);
  if (!global) return false;
  return upsertCharTag(
    { ...global, fields: { ...global.fields }, history: [] },
    undefined,
    { recordChanges: false },
  );
}
