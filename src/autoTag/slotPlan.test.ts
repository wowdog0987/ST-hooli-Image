import { describe, expect, it } from 'vitest';

import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import { serializeImageTag } from '@/st/imageTagRegex';

function tag(text: string, nl = ''): string {
  return serializeImageTag({ tag: text, nl, negative: '', characters: [], size: 'portrait' });
}

describe('buildSlotTaskNote', () => {
  it('說明只重寫第 N 張、畫面不變,並要求恰好 1 張', () => {
    const source = [
      `正文`,
      tag('1girl, classroom'),
      tag('1boy, rooftop', 'A boy on the roof.'),
      tag('cat, windowsill'),
    ].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('【本次只重寫第 2 張的提示詞】');
    expect(note).toContain('不要另選畫面');
    expect(note).toContain('images 陣列必須恰好返回 1 項');
  });

  /**
   * 這條是本功能的命門:寫回側按 seq 原位替換、根本不看模型返回的 position,
   * 所以「換不換畫面」完全由這段措辭決定。舊版寫的是「另選一個與它們明顯不同的
   * 瞬間」,導致按鈕寫著「重寫提示詞」、模型收到的卻是「換個畫面」。
   *
   * 注意只能鎖**祈使**口徑:「不要另選畫面」是禁令,含「另選」二字卻正是我們要的,
   * 所以不能簡單斷言不含「另選」。
   */
  it('絕不能出現讓模型另選畫面的祈使措辭', () => {
    const note = buildSlotTaskNote([tag('1girl, classroom'), tag('1boy, rooftop')].join('\n'), 0);
    expect(note).not.toContain('請為這一張另選');
    expect(note).not.toContain('明顯不同的瞬間');
    expect(note).not.toContain('重選');
    // 禁令必須在場
    expect(note).toContain('不要另選畫面');
  });

  it('把目標槽位當前的提示詞原樣喂回去當錨點(不截斷)', () => {
    const long = `1girl, ${'detail, '.repeat(60)}classroom`;
    const note = buildSlotTaskNote([tag(long), tag('cat')].join('\n'), 0);
    expect(note).toContain('這一張當前的提示詞');
    // 錨點是要模型逐字對照的,必須全文帶上——被截斷就等於讓它猜畫面
    expect(note).toContain(long);
  });

  it('列出其餘畫面時跳過目標槽位,並說明不要搶它們的畫面', () => {
    const source = [tag('1girl, classroom'), tag('1boy, rooftop'), tag('cat, windowsill')].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('第 1 張：1girl, classroom');
    expect(note).not.toContain('第 2 張：');
    expect(note).toContain('第 3 張：cat, windowsill');
    expect(note).toContain('不要把它們的畫面搶過來');
  });

  it('單張樓只有說明,沒有其餘畫面清單', () => {
    const note = buildSlotTaskNote(tag('1girl, sunset'), 0);
    expect(note).toContain('【本次只重寫第 1 張的提示詞】');
    expect(note).not.toContain('本樓其餘畫面');
    // 單張樓照樣要給錨點
    expect(note).toContain('1girl, sunset');
  });

  it('正文裡沒有 tag 時不拋錯,也不編造錨點(邊界容忍)', () => {
    const note = buildSlotTaskNote('純正文', 0);
    expect(note).toContain('【本次只重寫第 1 張的提示詞】');
    expect(note).not.toContain('本樓其餘畫面');
    expect(note).not.toContain('這一張當前的提示詞');
  });

  it('其餘畫面摘要壓成單行並截斷,避免把整段提示詞灌進備註', () => {
    const long = 'x'.repeat(400);
    const source = [tag('aaa'), tag(long)].join('\n');
    // 目標是第 1 張,所以第 2 張走的是「其餘畫面」摘要口徑 → 要截斷
    const note = buildSlotTaskNote(source, 0);
    expect(note).toContain('第 2 張：');
    expect(note).not.toContain(long);
    expect(note).toContain('…');
    // tag / nl 兩段之間不得帶換行漏進清單(parseImageTagContent 會把 nl 內部換行折成空格,
    // 這裡鎖的是段與段之間的分隔符也被壓成單行)
    const withNl = buildSlotTaskNote(
      [tag('aaa'), tag('1girl', 'A girl.\nSecond line.')].join('\n'),
      0,
    );
    expect(withNl).toContain('第 2 張：1girl / A girl. Second line.');
  });
});
