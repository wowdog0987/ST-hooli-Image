import { describe, expect, it } from 'vitest';

import {
  applyCharRefs,
  applyPositionedCharRefs,
  buildLibraryText,
  formatEntryForPrompt,
  parseConvertedTags,
  resolveCharAnchors,
} from '@/autoTag/charAnchors';
import {
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  type CharTagEntry,
} from '@/state/charTags';

function entry(name: string, fields: Partial<Record<string, string>>, source: CharTagEntry['source'] = 'ai'): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source,
    desc: '',
    history: [],
  };
}

describe('formatEntryForPrompt / buildLibraryText', () => {
  it('renders non-empty fields with labels in fixed order', () => {
    const text = formatEntryForPrompt(entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }));
    expect(text).toBe('- 小雪: 性別=1girl, 頭髮=long black hair, 眼睛=red eyes');
  });

  it('falls back to raw tag when no structured fields', () => {
    const e = entry('舊角色', {});
    e.raw = '1girl, red eyes';
    expect(formatEntryForPrompt(e)).toBe('- 舊角色: tag=1girl, red eyes');
  });

  it('builds the library block with a header', () => {
    const text = buildLibraryText([entry('小雪', { sex: '1girl' })]);
    expect(text).toContain('【角色固定外貌庫');
    expect(text).toContain('- 小雪: 性別=1girl');
  });

  it('returns empty string for no entries', () => {
    expect(buildLibraryText([])).toBe('');
  });

  it('marks locked entries and declares immutability in the header', () => {
    const text = buildLibraryText(
      [entry('小雪', { sex: '1girl' }), entry('張三', { sex: '1boy' })],
      new Set(['小雪']),
    );
    expect(text).toContain('- 小雪 [locked]: 性別=1girl');
    expect(text).toContain('- 張三: 性別=1boy');
    expect(text).toContain('[locked] are global and immutable');
    // 無鎖定名時頭部保持原樣(不帶鎖定說明)
    expect(buildLibraryText([entry('小雪', { sex: '1girl' })])).not.toContain('immutable');
  });
});

describe('applyCharRefs', () => {
  const entries = [
    entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }),
    entry('張三', { sex: '1boy' }),
  ];

  it('replaces @name placeholders with the joined tag string', () => {
    const { text, unknown } = applyCharRefs('@小雪, white dress, sitting', entries);
    expect(text).toBe('1girl, long black hair, red eyes, white dress, sitting');
    expect(unknown).toEqual([]);
  });

  it('handles multiple placeholders and mixed content', () => {
    const { text } = applyCharRefs('@張三 and @小雪, classroom', entries);
    expect(text).toBe('1boy and 1girl, long black hair, red eyes, classroom');
  });

  it('strips unknown names and tidies separators', () => {
    const { text, unknown } = applyCharRefs('@路人甲, @小雪, smile', entries);
    expect(unknown).toEqual(['路人甲']);
    expect(text).toBe('1girl, long black hair, red eyes, smile');
  });

  it('handles placeholder at both ends and collapses leftovers', () => {
    const { text } = applyCharRefs('@路人甲, @小雪', entries);
    expect(text).toBe('1girl, long black hair, red eyes');
    const { text: t2 } = applyCharRefs('@小雪, @路人甲', entries);
    expect(t2).toBe('1girl, long black hair, red eyes');
  });

  it('replaces nl placeholders with the tag string when no nl sentence exists', () => {
    const { text } = applyCharRefs('@小雪 in a white dress', entries);
    expect(text).toBe('1girl, long black hair, red eyes in a white dress');
  });

  it('prefers the nl sentence for nl replacement when present', () => {
    const e = entry('小雪', { sex: '1girl' });
    e.nl = 'a petite girl with long black hair';
    const { text } = applyCharRefs('@小雪 sits by the window', [e], 'nl');
    expect(text).toBe('a petite girl with long black hair sits by the window');
  });

  it('nl mode falls back to the tag string when no nl sentence', () => {
    const { text } = applyCharRefs('@小雪 sits by the window', entries, 'nl');
    expect(text).toBe('1girl, long black hair, red eyes sits by the window');
  });
});

describe('parseConvertedTags', () => {
  it('parses structured per-character fields', () => {
    const raw = '{"阿黛爾":{"sex":"1girl","hair":"short silver hair","eyes":""}}';
    expect(parseConvertedTags(raw)).toEqual({
      阿黛爾: { sex: '1girl', hair: 'short silver hair' },
    });
  });

  it('tolerates code fences and surrounding prose, drops empty records', () => {
    const raw = '好的:\n```json\n{"阿黛爾":{"hair":"silver"},"空":{"":"  "}}\n```';
    expect(parseConvertedTags(raw)).toEqual({ 阿黛爾: { hair: 'silver' } });
  });

  it('sanitizes values with newlines or bbi tags, rejects non-object shapes', () => {
    const raw = '{"阿黛爾":{"hair":"long\\nblack"},"壞":{"eyes":"x<hooli_image>y"},"串":{"hair":"ok"}}';
    expect(parseConvertedTags(raw)).toEqual({ 串: { hair: 'ok' }, 阿黛爾: { hair: 'long black' } });
    expect(parseConvertedTags('{"阿黛爾":"plain string"}')).toEqual({});
    expect(parseConvertedTags('no json')).toEqual({});
  });
});

describe('positioned character state', () => {
  it('renders the library without firing any request', () => {
    // 建檔已交給主請求:這層只做本地渲染,不再發外貌轉換請求
    const entries = [entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'blue eyes' })];
    const resolved = resolveCharAnchors(entries);
    expect(resolved.entries).toBe(entries);
    expect(resolved.text).toContain('- 小雪: 性別=1girl');
    expect(resolveCharAnchors([]).text).toBeNull();
  });

  it('uses the old profile before a permanent change and the new profile after it', () => {
    const base = [entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'blue eyes' })];
    const dyeHair = createCharTagSetOp('小雪', 'hair', 'long red hair', '染髮')!;
    const ops = [{ op: dyeHair, sourceLine: 2 }];

    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 0).text).toBe(
      '1girl, long black hair, blue eyes, smiling',
    );
    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 2).text).toBe(
      '1girl, long red hair, blue eyes, smiling',
    );
  });

  it('makes a same-response new profile available across the whole floor', () => {
    // 新角色的固定外貌是本樓全程成立的事實,不是「從某處開始」的變化:
    // 按位置門控會讓建檔位置之前的圖片查不到條目,@佔位符被整個剝掉 = 角色沒有外貌。
    const profile = createCharTagNewOp({
      name: '阿黛爾',
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'short silver hair', eyes: 'red eyes' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const ops = [{ op: profile, sourceLine: 2 }];
    const expected = '1girl, short silver hair, red eyes, standing';

    expect(applyPositionedCharRefs('@阿黛爾, standing', [], ops, 0)).toEqual({
      text: expected,
      unknown: [],
    });
    expect(applyPositionedCharRefs('@阿黛爾, standing', [], ops, 2).text).toBe(expected);
  });

  it('ignores AI changes targeting locked (global) names', () => {
    const base = [entry('玩家', { sex: '1boy', hair: 'short black hair' })];
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染髮')!;
    const ops = [{ op: dye, sourceLine: 0 }];
    const locked = new Set(['玩家']);
    // 鎖定:set 被丟棄,始終用庫中值
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5, 'tag', locked).text).toBe(
      '1boy, short black hair, standing',
    );
    // 不鎖定:照舊按位置生效
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5).text).toBe(
      '1boy, long red hair, standing',
    );
  });
});
