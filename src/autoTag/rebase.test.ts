import { describe, expect, it } from 'vitest';

import { prepareTargetText } from '@/autoTag/clean';
import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import { rebaseImagePositions } from '@/autoTag/rebase';

function image(sourceLine: number, tag: string): ImageInsertion {
  return {
    position: `P${sourceLine}`,
    sourceLine,
    tag,
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
  };
}

/** 按 runner 的口徑:模型看到的 segment 列表來自請求開始時的正文。 */
function plan(text: string, stripTags: string[] = []) {
  return prepareTargetText(text, stripTags).segments;
}

/** 落點斷言看的是「tag 貼在哪一句之後」,比行號更接近使用者能觀察到的結果。 */
function lineAfterTag(text: string, tag: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex(line => line.includes(`<hooli_image>${tag}`));
  return index > 0 ? lines[index - 1] : '';
}

describe('rebaseImagePositions', () => {
  it('正文沒變:位置分毫不動', () => {
    const text = '第一句\n第二句\n第三句';
    const segments = plan(text);
    const result = rebaseImagePositions(text, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(result?.report).toEqual({ anchored: 1, remapped: 0, drifted: 0 });
  });

  it('別的外掛在末尾追加內容:骨架全命中,位置不動', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `${before}\n<statusbar>好感度 +1</statusbar>\n追加的旁註`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    expect(result?.report.anchored).toBe(2);
  });

  it('別的外掛在開頭插入內容:位置整體平移,仍貼在原來那句之後', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `插進來的新首句\n${before}`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(2);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第二句');
    expect(result?.report.anchored).toBe(1);
  });

  it('八股句被改寫:tag 跟著落到改寫後的那一句之後(核心場景)', () => {
    const before = '第一句\n【狀態】好感度:低\n第三句';
    const after = '第一句\n【狀態】好感度:中等偏上\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('【狀態】好感度:中等偏上');
    expect(result?.report).toEqual({ anchored: 0, remapped: 1, drifted: 0 });
  });

  it('全文被潤色(每句都改了措辭):逐句對位,一張都不丟', () => {
    const before = '她走進房間\n窗外下著雨\n他抬起頭';
    const after = '她緩步走進了房間\n窗外正下著細雨\n他慢慢抬起頭';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('她緩步走進了房間');
    expect(lineAfterTag(injected, 'b')).toBe('他慢慢抬起頭');
    expect(result?.report.remapped).toBe(2);
  });

  it('錨點句整句被刪:順延到前一段,不丟 tag', () => {
    const before = '第一句\n第二句\n第三句';
    const after = '第一句\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(0);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第一句');
    expect(result?.report.drifted).toBe(1);
  });

  it('多張圖保持敘事順序單調', () => {
    const before = '一\n二\n三\n四';
    const after = '一\n二改了\n三\n四';
    const segments = plan(before);
    const result = rebaseImagePositions(
      after,
      segments,
      [image(3, 'd'), image(0, 'a'), image(1, 'b')],
      [],
    );
    const lines = result!.images.map(i => i.sourceLine);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
    expect(lines).toEqual([0, 1, 3]);
  });

  it('落點只取清洗後的敘事行:tag 不會掉進追加的狀態列塊裡', () => {
    const before = '第一句\n第二句';
    const after = '第一句\n<snow>\n塊內第一行\n塊內第二行\n</snow>\n第二句';
    const segments = plan(before, ['snow']);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], ['snow']);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('第二句');
    // 塊內部不得被劈開
    expect(injected).toContain('<snow>\n塊內第一行\n塊內第二行\n</snow>');
  });

  it('正文被清空/只剩噪聲:返回 null 交呼叫方放棄', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('', segments, [image(0, 'a')], [])).toBeNull();
    expect(rebaseImagePositions('<snow>只剩狀態列</snow>', segments, [image(0, 'a')], ['snow']))
      .toBeNull();
  });

  it('沒有圖片時直接返回空結果(不碰正文)', () => {
    const result = rebaseImagePositions('隨便', plan('隨便'), [], []);
    expect(result).toEqual({ images: [], report: { anchored: 0, remapped: 0, drifted: 0 } });
  });

  it('sourceLine 不屬於給定 segment 列表:視為呼叫方錯誤,返回 null', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('第一句\n第二句', segments, [image(99, 'a')], [])).toBeNull();
  });

  it('重複句子不會全部塌到同一行', () => {
    const before = '同一句\n中間\n同一句';
    const after = '同一句\n中間改了\n同一句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
  });
});
