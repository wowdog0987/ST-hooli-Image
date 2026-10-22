import { describe, expect, it } from 'vitest';

import { prepareTargetText } from '@/autoTag/clean';
import { addedTagSeqs, buildAppendTaskNote, existingImagePositions } from '@/autoTag/slotPlan';
import { stripImageTags } from '@/st/imageTagRegex';

const tagA = '<hooli_image>1girl, kitchen<size>portrait</size></hooli_image>';
const tagB = '<hooli_image>1boy, sofa<size>portrait</size></hooli_image>';
const raw = ['第一行。', '第二行。', tagA, '第三行。', '第四行。', tagB, '第五行。'].join('\n');

describe('existingImagePositions', () => {
  it('每條既有 tag 對應到它跟隨的那一段的 P 編號', () => {
    const segments = prepareTargetText(stripImageTags(raw), []).segments;
    expect(segments.map(segment => segment.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(existingImagePositions(raw, segments)).toEqual(['P2', 'P4']);
  });

  it('CRLF 正文同樣正確', () => {
    const crlf = raw.replace(/\n/g, '\r\n');
    const segments = prepareTargetText(stripImageTags(crlf), []).segments;
    expect(existingImagePositions(crlf, segments)).toEqual(['P2', 'P4']);
  });
});

describe('buildAppendTaskNote', () => {
  it('列出已畫過的畫面(含位置),要求另選一個不同的瞬間、恰好 1 張', () => {
    const segments = prepareTargetText(stripImageTags(raw), []).segments;
    const note = buildAppendTaskNote(raw, segments);
    expect(note).toContain('追加第 3 張畫面');
    expect(note).toContain('第 1 張 ⟦P2⟧：1girl, kitchen');
    expect(note).toContain('第 2 張 ⟦P4⟧：1boy, sofa');
    expect(note).toContain('images 恰好返回 1 項');
  });
});

describe('addedTagSeqs', () => {
  it('找出插入在中間的新 tag', () => {
    expect(addedTagSeqs([tagA, tagB], [tagA, 'new', tagB])).toEqual([1]);
  });

  it('與舊 tag 內容相同的新 tag 也只認多出來的那一條', () => {
    expect(addedTagSeqs([tagA], [tagA, tagA])).toEqual([1]);
  });
});
