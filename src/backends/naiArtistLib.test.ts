import { describe, expect, it } from 'vitest';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import type { NaiArtistPreset } from '@/state/settings';

function preset(id: string, name = id, prompt = ''): NaiArtistPreset {
  return { id, name, prompt, quality: '', negative: '' };
}

describe('matchArtist', () => {
  it('空詞恆真(不過濾)', () => {
    expect(matchArtist(preset('a', '厚塗', 'artist:wlop'), '')).toBe(true);
    expect(matchArtist(preset('a', '厚塗', 'artist:wlop'), '   ')).toBe(true);
  });

  it('按名稱與畫師串內容匹配,大小寫不敏感', () => {
    const p = preset('a', '厚塗', 'artist:WLOP, artist:as109');
    expect(matchArtist(p, '厚塗')).toBe(true);
    expect(matchArtist(p, 'wlop')).toBe(true);
    expect(matchArtist(p, 'AS109')).toBe(true);
    expect(matchArtist(p, '油畫')).toBe(false);
  });
});

describe('planArtistRemoval', () => {
  const list = [preset('a'), preset('b'), preset('c'), preset('d')];

  it('當前項未被刪 → activeArtistId 不動', () => {
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'a');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.removed.map(p => p.id)).toEqual(['b', 'c']);
    expect(plan.nextActiveId).toBe('a');
  });

  it('當前項被刪 → 接位到原位置那一條', () => {
    const plan = planArtistRemoval(list, new Set(['b']), 'b');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'c', 'd']);
    expect(plan.nextActiveId).toBe('c');
  });

  it('刪的是末尾 → 退一格', () => {
    const plan = planArtistRemoval(list, new Set(['d']), 'd');
    expect(plan.nextActiveId).toBe('c');
  });

  it('刪空 → 回「不使用」', () => {
    const plan = planArtistRemoval(list, new Set(['a', 'b', 'c', 'd']), 'c');
    expect(plan.remaining).toEqual([]);
    expect(plan.nextActiveId).toBe('');
  });

  it('批次刪除含當前項 → 接位到最前一個被刪位置', () => {
    // b、c 都刪,接位取 min(原第一個被刪下標 1, 剩餘長度-1) → remaining[1] = d
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'c');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.nextActiveId).toBe('d');
  });

  it('內建 id(bi_*)不會出現在刪除集 → 當前內建條不受影響', () => {
    const plan = planArtistRemoval(list, new Set(['a']), 'bi_default');
    expect(plan.nextActiveId).toBe('bi_default');
  });
});
