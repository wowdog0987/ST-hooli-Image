import { describe, expect, it } from 'vitest';

import { normalizePositionId, parseImagePlan, withCharacterCount } from '@/autoTag/protocol';

const char = (tag: string) => ({ name: 'x', tag, nl: '' });

describe('normalizePositionId', () => {
  it('接受模型常見的各種寫法', () => {
    expect(normalizePositionId('P3')).toBe('P3');
    expect(normalizePositionId('⟦P3⟧')).toBe('P3');
    expect(normalizePositionId('p12')).toBe('P12');
    expect(normalizePositionId('P3/P4')).toBe('P3');
    expect(normalizePositionId(5)).toBe('P5');
    expect(normalizePositionId('7')).toBe('P7');
  });

  it('沒有編號 → null', () => {
    expect(normalizePositionId('')).toBeNull();
    expect(normalizePositionId('end')).toBeNull();
    expect(normalizePositionId(undefined)).toBeNull();
  });
});

describe('withCharacterCount', () => {
  it('用角色列表的性別重算 Base 人數,丟掉模型寫錯的人數 tag', () => {
    expect(
      withCharacterCount('2boys, 1girl, 1boy 1girl, dim lighting, rococo interior', [
        char('1boy, dark blue hair'),
        char('1girl, long burgundy hair'),
      ]),
    ).toBe('1girl, 1boy, dim lighting, rococo interior');
  });

  it('同性多人合併成複數', () => {
    expect(withCharacterCount('2girls, park', [char('1girl, a'), char('girl, b')])).toBe('2girls, park');
  });

  it('有角色缺性別 tag → 原樣保留', () => {
    expect(withCharacterCount('2boys, park', [char('1boy'), char('red hair')])).toBe('2boys, park');
  });

  it('沒有角色列表(ComfyUI 單串)→ 原樣保留', () => {
    expect(withCharacterCount('1girl, park', [])).toBe('1girl, park');
  });
});

describe('parseImagePlan 位置與人數歸一', () => {
  it('⟦P2⟧ 寫法可解析,Base 人數按角色重算', () => {
    const raw = JSON.stringify({
      images: [
        {
          position: '⟦P2⟧',
          tag: '2boys, 1girl, room',
          characters: [
            { name: 'A', tag: '1boy, x' },
            { name: 'B', tag: '1girl, y' },
          ],
        },
      ],
      changes: [],
    });
    const plan = parseImagePlan(raw, [
      { id: 'P1', sourceLine: 0, text: 'a' },
      { id: 'P2', sourceLine: 2, text: 'b' },
    ], 1, 1);
    expect(plan.images[0].position).toBe('P2');
    expect(plan.images[0].tag).toBe('1girl, 1boy, room');
  });
});
