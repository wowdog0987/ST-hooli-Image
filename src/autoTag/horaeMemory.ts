/**
 * Horae 角色狀態讀取:直接讀聊天訊息上的 horae_meta(Horae 每一樓解析 <horae> 後存的結果),
 * 不經任何橋接介面,裝標準版 Horae 即可。
 *
 * 只取畫圖用得到的角色資料:主角與在場角色的著裝、情緒,以及身份、關係;
 * 外貌只給角色庫還沒建檔的角色(供模型建檔)——已建檔的以角色庫為準。
 * 物品、待辦、劇情軌跡、好感度一律不讀。
 *
 * 合併口徑對齊 Horae 的 getLatestState:著裝與情緒以最新一筆為準,NPC 逐欄位合併
 * (性別等受保護欄位只在未設定時填入),在場名單取最近一次非空的,使用者在 Horae 裡
 * 刪掉的 NPC 一併排除。
 */
import type { STMessage } from '@/st/context';

/** 參考塊中涉及的單個角色(結構化),供角色管理頁「從Horae生成」與錨定匹配。 */
export interface HoraeRole {
  /** 角色名:NPC 為 Horae 記錄的名字;主角為呼叫方給的名字(一般是使用者名稱)。 */
  name: string;
  /** Horae 記錄的外貌原文;未記錄為空串。 */
  desc: string;
  isProtagonist: boolean;
}

export interface HoraeMemoryContext {
  /** 角色參考文本塊,可直接拼進提示詞。 */
  text: string;
  /** 本次參考塊涉及的角色(與 text 同一批過濾口徑)。 */
  roles: HoraeRole[];
}

interface HoraeNpc {
  appearance?: unknown;
  relationship?: unknown;
  gender?: unknown;
  age?: unknown;
  job?: unknown;
}

interface HoraeMeta {
  _skipHorae?: unknown;
  _deletedNpcs?: unknown;
  scene?: { characters_present?: unknown };
  costumes?: Record<string, unknown>;
  mood?: Record<string, unknown>;
  npcs?: Record<string, HoraeNpc>;
}

interface RoleState {
  npcs: Record<string, Record<string, string>>;
  costumes: Record<string, string>;
  mood: Record<string, string>;
  present: string[];
}

const UPDATABLE = ['appearance', 'relationship', 'age', 'job'] as const;
const PROTECTED = ['gender'] as const;

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function metaOf(message: STMessage | undefined): HoraeMeta | null {
  const meta = (message as { horae_meta?: HoraeMeta } | undefined)?.horae_meta;
  return meta && !meta._skipHorae ? meta : null;
}

/** 截至 floor(含)的角色狀態;沒有任何 Horae 記錄時返回 null。 */
function roleStateAt(chat: STMessage[], floor: number): RoleState | null {
  const state: RoleState = { npcs: {}, costumes: {}, mood: {}, present: [] };
  let seen = false;
  for (let index = 0; index <= floor && index < chat.length; index += 1) {
    const meta = metaOf(chat[index]);
    if (!meta) continue;
    seen = true;
    const present = meta.scene?.characters_present;
    if (Array.isArray(present) && present.length) state.present = present.map(oneLine).filter(Boolean);
    for (const [name, value] of Object.entries(meta.costumes ?? {})) state.costumes[name] = oneLine(value);
    for (const [name, value] of Object.entries(meta.mood ?? {})) state.mood[name] = oneLine(value);
    for (const [name, npc] of Object.entries(meta.npcs ?? {})) {
      const target = (state.npcs[name] ??= {});
      for (const field of UPDATABLE) {
        if (npc[field] !== undefined) target[field] = oneLine(npc[field]);
      }
      for (const field of PROTECTED) {
        if (npc[field] !== undefined && !target[field]) target[field] = oneLine(npc[field]);
      }
    }
  }
  if (!seen) return null;
  const deleted = ((chat[0] as { horae_meta?: HoraeMeta } | undefined)?.horae_meta?._deletedNpcs ?? []) as unknown[];
  for (const raw of Array.isArray(deleted) ? deleted : []) {
    const name = oneLine(raw);
    delete state.npcs[name];
    delete state.costumes[name];
    delete state.mood[name];
    state.present = state.present.filter(entry => entry !== name);
  }
  return state;
}

function fmtProtagonist(state: RoleState, name: string, withAppearance: boolean): string {
  const npc = state.npcs[name] ?? {};
  const fields: Array<[string, string]> = [
    ['性別', npc.gender ?? ''],
    ['年齡', npc.age ?? ''],
    ['身份', npc.job ?? ''],
    ['外貌', withAppearance ? (npc.appearance ?? '') : ''],
    ['著裝', state.costumes[name] ?? ''],
    ['狀態', state.mood[name] ?? ''],
  ];
  return fields.filter(([, value]) => value).map(([label, value]) => `${label}:${value}`).join('；');
}

function fmtNpc(state: RoleState, name: string, withAppearance: boolean): string {
  const npc = state.npcs[name] ?? {};
  const bracket = [npc.gender, npc.age, npc.job].filter(Boolean).join('·');
  let line = bracket ? `${name}(${bracket})` : name;
  if (npc.relationship) line += ` —— 與主角:${npc.relationship}`;
  const tail: string[] = [];
  if (withAppearance && npc.appearance) tail.push(`外貌:${npc.appearance}`);
  if (state.costumes[name]) tail.push(`著裝:${state.costumes[name]}`);
  if (state.mood[name]) tail.push(`狀態:${state.mood[name]}`);
  return tail.length ? `${line} 〔${tail.join(';')}〕` : line;
}

/** 某角色在 Horae 裡記錄的外貌(不論是否在場);角色管理頁「從Horae生成」用。 */
export function readHoraeAppearance(chat: STMessage[], name: string): string {
  return roleStateAt(chat, chat.length - 1)?.npcs[name]?.appearance ?? '';
}

/**
 * 讀取 Horae 角色狀態並組成角色參考文本。
 * @param floor 目標樓(含本樓的 Horae 記錄)
 * @param bodyText 目標樓正文(不在場名單上、但正文寫到名字的角色也算參與本樓)
 * @param protagonistName 主角名(一般傳使用者名稱;Horae 以同名的 NPC/著裝記錄當主角資料)
 * @param libraryNames 角色庫已建檔的角色名:這些角色只送著裝與狀態,不送外貌
 * 沒有 Horae 記錄或沒有任何角色資訊時返回 null(呼叫方改為只送正文)。
 */
export function readHoraeMemory(
  chat: STMessage[],
  floor: number,
  bodyText: string,
  protagonistName = '主角',
  libraryNames: ReadonlySet<string> = new Set(),
): HoraeMemoryContext | null {
  const state = roleStateAt(chat, floor);
  if (!state) return null;

  const lines: string[] = [];
  const roles: HoraeRole[] = [];
  const protagonist = fmtProtagonist(state, protagonistName, !libraryNames.has(protagonistName));
  if (protagonist) {
    lines.push(`主角:${protagonist}`);
    roles.push({ name: protagonistName, desc: state.npcs[protagonistName]?.appearance ?? '', isProtagonist: true });
  }

  // 在場角色常駐;其餘有 NPC 檔或著裝記錄的角色,正文寫到名字才算參與本樓
  const present = new Set(state.present);
  const candidates = new Set([...Object.keys(state.npcs), ...Object.keys(state.costumes)]);
  const npcLines: string[] = [];
  for (const name of candidates) {
    if (!name || name === protagonistName) continue;
    if (!present.has(name) && !bodyText.includes(name)) continue;
    npcLines.push(`- ${fmtNpc(state, name, !libraryNames.has(name))}`);
    roles.push({ name, desc: state.npcs[name]?.appearance ?? '', isProtagonist: false });
  }
  if (npcLines.length) lines.push(`重要角色:\n${npcLines.join('\n')}`);

  if (!lines.length) return null;
  return { text: `【角色參考(Horae同步的最新狀態,只讀參考)】\n${lines.join('\n')}`, roles };
}
