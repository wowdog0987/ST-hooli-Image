import { describe, expect, it } from 'vitest';

import { renameLegacyImageTags } from '@/st/legacyImageTag';

describe('renameLegacyImageTags', () => {
  it('把舊 tag 的開閉標籤改名,內容原樣保留', () => {
    const legacy = '正文\n<bbi_image>1girl<nl>a girl</nl><characters>[]</characters><size>portrait</size></bbi_image>\n後文';
    expect(renameLegacyImageTags(legacy)).toBe(
      '正文\n<hooli_image>1girl<nl>a girl</nl><characters>[]</characters><size>portrait</size></hooli_image>\n後文',
    );
  });

  it('沒有舊 tag 時不變', () => {
    const text = '<hooli_image>x</hooli_image>';
    expect(renameLegacyImageTags(text)).toBe(text);
  });
});
