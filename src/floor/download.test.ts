import { describe, expect, it } from 'vitest';

import { imageDownloadFileName } from '@/floor/download';

describe('imageDownloadFileName', () => {
  it('keeps Chinese characters in the downloaded filename', () => {
    expect(imageDownloadFileName('/user/files/bbi____.png', '柏寶', 'g123')).toBe(
      'bbi_柏寶_g123.png',
    );
  });

  it('replaces only characters forbidden in filenames', () => {
    expect(imageDownloadFileName('/user/files/image.jpg?x=1', '柏寶/測試:卡', 'g123')).toBe(
      'bbi_柏寶_測試_卡_g123.jpg',
    );
  });
});
