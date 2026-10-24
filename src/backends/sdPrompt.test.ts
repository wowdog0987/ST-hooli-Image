import { describe, expect, it } from 'vitest';

import { toSdPrompt, toSdTag } from '@/backends/sdPrompt';

describe('NovelAI 寫法 → SD 寫法', () => {
  it('數字權重(含單冒號手誤)轉成 (tag:w)', () => {
    expect(toSdTag('1.4::short hair::')).toBe('(short hair:1.4)');
    expect(toSdTag('1.4:wispy see-through bangs')).toBe('(wispy see-through bangs:1.4)');
    expect(toSdTag('0.8::freckles')).toBe('(freckles:0.8)');
  });

  it('花括號/方括號依層數換算', () => {
    expect(toSdTag('{smile}')).toBe('(smile:1.05)');
    expect(toSdTag('{{smile}}')).toBe('(smile:1.1)');
    expect(toSdTag('[hat]')).toBe('(hat:0.95)');
  });

  it('負權重略過;已是 SD 寫法的不動', () => {
    expect(toSdTag('-1::hat::')).toBe('');
    expect(toSdTag('(blush:1.2)')).toBe('(blush:1.2)');
  });

  it('tag 內的普通圓括號跳脫,已跳脫的不重複', () => {
    expect(toSdTag('hatsune miku (vocaloid)')).toBe('hatsune miku \\(vocaloid\\)');
    expect(toSdTag('hatsune miku \\(vocaloid\\)')).toBe('hatsune miku \\(vocaloid\\)');
  });

  it('整串轉換,一般 tag 原樣', () => {
    expect(toSdPrompt('1girl, 1.4::short hair::, -1::hat::, red dress on silver hair girl')).toBe(
      '1girl, (short hair:1.4), red dress on silver hair girl',
    );
  });
});
