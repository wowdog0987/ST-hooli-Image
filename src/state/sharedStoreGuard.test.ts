import { describe, expect, it } from 'vitest';

/**
 * 共享儲存「空種子」事故迴歸測試:
 * 舊版繪在沒有任何排除資料時也會用空名單建立共享儲存(occupying baibai_exclude_settings),
 * 書啟動後領養空 store → 雙方互相同步成空,使用者配置全滅。
 * 現在的契約:沒有使用者資料的一方絕不建倉;有資料的一方遇到「空種子 store」時自愈回寫。
 *
 * 本檔案只測純邏輯工具(excludesHasUserData 同構實現),settings.ts 的 hydrate 鏈
 * 依賴 ST getContext,不便在 node 環境完整例項化。
 */

interface ExcludesLike {
  excludedChars: string[];
  customStripTags: string[];
}

function excludesHasUserData(ex: ExcludesLike): boolean {
  return ex.excludedChars.length > 0 || ex.customStripTags.length > 0;
}

describe('排除名單共享儲存空種子守衛', () => {
  it('全空名單(使用者剛裝外掛 / 舊版寫入的空種子)= 無使用者資料', () => {
    expect(excludesHasUserData({ excludedChars: [], customStripTags: [] })).toBe(false);
  });

  it('有排除角色 = 有使用者資料', () => {
    expect(excludesHasUserData({ excludedChars: ['小雪'], customStripTags: [] })).toBe(true);
  });

  it('有自定義清洗標籤 = 有使用者資料', () => {
    expect(excludesHasUserData({ excludedChars: [], customStripTags: ['snow'] })).toBe(true);
  });
});
