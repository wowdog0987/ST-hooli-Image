import type { NaiArtistPreset } from '@/state/settings';

/**
 * 畫師串庫的管理態純邏輯(搜尋匹配 / 刪除接位規劃)。
 * 與互動解耦,便於單測;NaiArtistManager.vue 只做互動與落盤。
 */

/**
 * 搜尋匹配:名稱 + 畫師串內容,大小寫不敏感的子串匹配;空詞恆真(= 不過濾)。
 * 綁定的正/負面詞不參與——使用者記畫風靠的是名字和那串 artist tag,
 * 匹配面鋪得越廣,「明明搜到了」與「這怎麼也命中」的意外都越多。
 */
export function matchArtist(
  preset: Pick<NaiArtistPreset, 'name' | 'prompt'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return preset.name.toLowerCase().includes(q) || preset.prompt.toLowerCase().includes(q);
}

export interface ArtistRemovalPlan {
  /** 刪除後的庫(保持原順序)。 */
  remaining: NaiArtistPreset[];
  /** 實際被刪的條目(呼叫方據此清理預覽圖檔案)。 */
  removed: NaiArtistPreset[];
  /**
   * 刪除後的 activeArtistId:當前項沒被動 → 不動;
   * 當前項被刪 → 接位到原位置那一條(已是末尾則退一格),刪空 → ''(= 不使用)。
   * 與 NaiPanel 單條刪除的接位口徑一致,刻意**不**回落 [0](靜默換畫風查不出原因)。
   */
  nextActiveId: string;
}

/**
 * 規劃一次刪除(單條與批次共用)。removedIds 之外的條目不碰;
 * activeId 不在刪除集裡就原樣保留(內建 bi_* 永不在刪除集——管理器不給內建條勾選框)。
 */
export function planArtistRemoval(
  list: readonly NaiArtistPreset[],
  removedIds: ReadonlySet<string>,
  activeId: string,
): ArtistRemovalPlan {
  const removed = list.filter(a => removedIds.has(a.id));
  const remaining = list.filter(a => !removedIds.has(a.id));
  let nextActiveId = activeId;
  if (removedIds.has(activeId)) {
    const index = list.findIndex(a => removedIds.has(a.id));
    nextActiveId = remaining[Math.min(index, remaining.length - 1)]?.id ?? '';
  }
  return { remaining, removed, nextActiveId };
}
