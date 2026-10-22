import { describe, expect, it } from 'vitest';

import { isCollapsed, setCollapsed } from '@/floor/collapseState';

describe('collapseState', () => {
  it('未手動設定的槽位回落到預設值', () => {
    expect(isCollapsed('c|1|0|0', false)).toBe(false);
    expect(isCollapsed('c|1|0|0', true)).toBe(true);
  });

  it('手動設定後覆蓋預設值', () => {
    setCollapsed('c|2|0|1', true);
    expect(isCollapsed('c|2|0|1', false)).toBe(true);

    setCollapsed('c|3|0|0', false);
    expect(isCollapsed('c|3|0|0', true)).toBe(false);
  });

  it('不同槽位互不影響', () => {
    setCollapsed('c|4|0|0', true);
    expect(isCollapsed('c|4|0|1', false)).toBe(false);
    // swipeId 是 key 的一部分:切 swipe 是另一個槽位
    expect(isCollapsed('c|4|1|0', false)).toBe(false);
  });
});
