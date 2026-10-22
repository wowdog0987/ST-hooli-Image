import { describe, expect, it } from 'vitest';

import { formatBytes } from '@/bytes';

describe('formatBytes', () => {
  it('按 1024 進位制換算到合適的單位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(311300)).toBe('304 KB');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('不足 10 留一位小數,10 以上抹掉', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(9.94 * 1024)).toBe('9.9 KB');
    // 越過 10 就不再給小數:角標裡那位只是噪聲
    expect(formatBytes(10.4 * 1024)).toBe('10 KB');
  });

  it('位元組本身不給小數', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('封頂在 TB,不會溢位單位表', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });

  it('非有限值與負數返回空串,不偽裝成 0 B', () => {
    // 「還沒算出來」必須和「算出來是空的」區分開,故不給兜底值
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(Infinity)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});
