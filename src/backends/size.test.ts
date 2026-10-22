import { describe, expect, it } from 'vitest';

import { normalizeOrientation, parseSize, pickSize } from '@/backends/size';

describe('normalizeOrientation', () => {
  it('認標準值與大小寫/空白變體', () => {
    expect(normalizeOrientation('portrait')).toBe('portrait');
    expect(normalizeOrientation('landscape')).toBe('landscape');
    expect(normalizeOrientation('  LANDSCAPE  ')).toBe('landscape');
  });

  it('認常見同義寫法與中文', () => {
    expect(normalizeOrientation('horizontal')).toBe('landscape');
    expect(normalizeOrientation('wide')).toBe('landscape');
    expect(normalizeOrientation('橫屏')).toBe('landscape');
    expect(normalizeOrientation('landscape shot')).toBe('landscape');
    expect(normalizeOrientation('l')).toBe('landscape');
    expect(normalizeOrientation('vertical')).toBe('portrait');
  });

  it('認比例/尺寸寫法,按寬高關係判定', () => {
    expect(normalizeOrientation('16:9')).toBe('landscape');
    expect(normalizeOrientation('9:16')).toBe('portrait');
    expect(normalizeOrientation('1216x832')).toBe('landscape');
    expect(normalizeOrientation('832×1216')).toBe('portrait');
    expect(normalizeOrientation('1:1')).toBe('portrait');
  });

  it('缺失或無法識別一律降級為豎屏(維持改動前的固定預設)', () => {
    expect(normalizeOrientation(undefined)).toBe('portrait');
    expect(normalizeOrientation(null)).toBe('portrait');
    expect(normalizeOrientation('')).toBe('portrait');
    expect(normalizeOrientation('   ')).toBe('portrait');
    expect(normalizeOrientation(42)).toBe('portrait');
    expect(normalizeOrientation({ size: 'landscape' })).toBe('portrait');
    expect(normalizeOrientation('隨便寫點什麼')).toBe('portrait');
  });
});

describe('parseSize', () => {
  it('解析各種分隔符', () => {
    expect(parseSize('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseSize('1216x832')).toEqual({ width: 1216, height: 832 });
    expect(parseSize('1024 * 1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('解析不出或超範圍返回 null,由呼叫方決定報錯還是降級', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('豎版')).toBeNull();
    expect(parseSize('8000×8000')).toBeNull();
    expect(parseSize('32×32')).toBeNull();
  });

  it('不強制 64 的倍數(那是 NAI 專屬限制,由 parseResolution 另外把關)', () => {
    expect(parseSize('830×1216')).toEqual({ width: 830, height: 1216 });
  });
});

describe('pickSize', () => {
  const pair = { portraitSize: '832×1216', landscapeSize: '1216×832' };

  it('按方向取對應那一格', () => {
    expect(pickSize(pair, 'portrait')).toBe('832×1216');
    expect(pickSize(pair, 'landscape')).toBe('1216×832');
  });

  it('未填返回空串,交由呼叫方回落', () => {
    expect(pickSize({ portraitSize: '  ', landscapeSize: '' }, 'portrait')).toBe('');
    expect(pickSize({ portraitSize: '', landscapeSize: '' }, 'landscape')).toBe('');
  });
});
