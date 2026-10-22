import { describe, expect, it } from 'vitest';

import { appendEntry, historyEntries, latestStaleEntry, type BbiImageEntry } from '@/floor/storage';

function img(generationId: string, slotSeq: number, createdAt: number): BbiImageEntry {
  return { generationId, path: `/user/images/${generationId}.png`, prompt: '', seed: null, status: 'ready', createdAt, slotSeq };
}

describe('追加一張插到既有 tag 前面時,圖片跟著提示詞走', () => {
  // 舊 tag(hash A)原本是第 1 張(seq 0)並已出圖;新 tag(hash B)插到它前面,A 變成 seq 1
  const store = appendEntry({}, 0, 'A', img('old-image', 0, 1));
  const live = new Set(['B', 'A']);

  it('舊 tag 在新位置(seq 1)仍找得到自己的圖', () => {
    expect(historyEntries(store, 0, 'A', 1, true).map(e => e.generationId)).toEqual(['old-image']);
  });

  it('新 tag(seq 0)不會借用舊 tag 的圖當成自己的舊圖', () => {
    expect(latestStaleEntry(store, 0, 'B', 0, live)).toBeNull();
  });

  it('單張重寫(舊提示詞已不在本樓)仍會先顯示舊圖', () => {
    expect(latestStaleEntry(store, 0, 'A-rewritten', 0, new Set(['A-rewritten']))?.generationId).toBe('old-image');
  });

  it('同一樓兩條相同提示詞時仍按 seq 區分', () => {
    const twin = appendEntry(store, 0, 'A', img('second-slot', 1, 2));
    expect(historyEntries(twin, 0, 'A', 0).map(e => e.generationId)).toEqual(['old-image']);
    expect(historyEntries(twin, 0, 'A', 1).map(e => e.generationId)).toEqual(['second-slot']);
  });
});
