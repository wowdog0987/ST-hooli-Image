import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 全域性角色庫(state/globalCharTags.ts)整合測試。
 * 以假 window.SillyTavern.getContext 喂一個記憶體 extensionSettings/chatMetadata,
 * 驗證:CRUD 落盤、歷史剝離、合併進派生庫、鎖定名攔截 AI ops、提升/複製兩條遷移路徑。
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
}

let ctx: FakeCtx;
// 每次 resetModules 後動態重進,保證模組級狀態(fingerprint/baseEntries)乾淨
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');

function makeEntry(name: string, fields: Record<string, string>) {
  return {
    name,
    fields: { ...charTags.emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  };
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    saveChat: vi.fn(() => Promise.resolve()),
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  charTags = await import('@/state/charTags');
  globalTags = await import('@/state/globalCharTags');
  globalTags.initGlobalCharTags();
  charTags.hydrateCharTags();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('global char tag store', () => {
  it('upsert 落盤 extensionSettings 且剝離 history,併合並進派生庫', () => {
    const ok = globalTags.upsertGlobalCharTag({
      ...makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }),
      history: [{ field: 'hair', from: 'a', to: 'b', reason: 'x', floor: 1, at: 1 }],
    });
    expect(ok).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].history).toEqual([]);
    // 派生庫(本聊天為空時)直接含全域性條目
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['玩家']);
    const stored = ctx.extensionSettings['baibai_image_char_global'] as {
      schemaVersion: number;
      entries: Array<{ name: string; history: unknown[] }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.entries[0].name).toBe('玩家');
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('同名為覆蓋更新;oldName 改名;remove 刪除', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', eyes: 'red eyes' }));
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].fields.eyes).toBe('red eyes');

    globalTags.upsertGlobalCharTag(makeEntry('冒險者', { sex: '1boy' }), '玩家');
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['冒險者']);

    expect(globalTags.removeGlobalCharTag('冒險者')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
    expect(globalTags.removeGlobalCharTag('不存在')).toBe(false);
  });

  it('拒絕空條目(無欄位也無整串)', () => {
    expect(globalTags.upsertGlobalCharTag(makeEntry('空', {}))).toBe(false);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
  });

  it('init 時領養 extensionSettings 裡已有的全域性庫', async () => {
    ctx.extensionSettings['baibai_image_char_global'] = {
      schemaVersion: 1,
      revision: 3,
      entries: [makeEntry('老玩家', { sex: '1girl' })],
    };
    vi.resetModules();
    charTags = await import('@/state/charTags');
    globalTags = await import('@/state/globalCharTags');
    globalTags.initGlobalCharTags();
    charTags.hydrateCharTags();
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
  });
});

describe('鎖定與合併語義', () => {
  it('全域性獨有角色被鎖定:本聊天 AI 樓層 ops 對它無效', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染髮')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short black hair');
    expect([...charTags.lockedCharTagNames()]).toEqual(['玩家']);
  });

  it('本聊天手動建同名條目 = 覆蓋全域性並解鎖,AI 可照常變更', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    charTags.upsertCharTag(makeEntry('玩家', { sex: '1boy', hair: 'long white hair' }));
    // 解鎖
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    // 本聊天值優先
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long white hair');
    // AI 變更生效
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染髮')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long red hair');
    // 全域性庫本身不被汙染
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short black hair');
  });
});

describe('提升為全域性 / 複製到本聊天', () => {
  it('提升:快照當前生效值(含 AI 變更)進全域性,清本聊天副本與樓層 ops', () => {
    charTags.upsertCharTag(makeEntry('小雪', { sex: '1girl', hair: 'long black hair' }));
    const dye = charTags.createCharTagSetOp('小雪', 'hair', 'short red hair', '剪髮染髮')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.findCharTag('小雪')?.fields.hair).toBe('short red hair');

    expect(globalTags.promoteCharTagToGlobal('小雪')).toBe(true);
    // 全域性拿到的是當前生效值
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short red hair');
    // 本聊天基線副本已刪、樓層 ops 已清
    expect(charTags.charTagBaseNames.has('小雪')).toBe(false);
    const floorExtra = (ctx.chat[0] as { extra?: Record<string, unknown> }).extra;
    expect(floorExtra?.[charTags.BBI_CHAR_EXTRA_KEY]).toBeUndefined();
    // 此後該名字被鎖定
    expect([...charTags.lockedCharTagNames()]).toEqual(['小雪']);
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short red hair');
  });

  it('複製到本聊天:全域性保留,本聊天副本接管且解鎖', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    expect(globalTags.copyGlobalCharTagToChat('玩家')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.findCharTag('玩家')?.fields.sex).toBe('1boy');
  });
});
