import type { NaiVibe } from '@/state/settings';

/**
 * Vibe 分組的純邏輯(歸攏、搜尋、啟用集合判定),與 NaiPanel 的渲染分開放。
 *
 * 分組是「一起啟用/一起摺疊」的標籤而非獨立狀態:出圖仍只看每條的 enabled
 * (backends/nai.ts 的 filter(v => v.enabled)),組的批次動作本質是對成員
 * enabled 的批次賦值,不引入第二套真相。
 *
 * 組名是使用者任意輸入,不能直接當 key/哨兵用(會和「未分組」「新建分組」撞名),
 * 故一律加 `g:` 字首裝箱:帶字首的必是真實組,裸值 UNGROUPED/NEW_GROUP 必是哨兵。
 */

export const GROUP_PREFIX = 'g:';
export const UNGROUPED = 'ungrouped';
export const NEW_GROUP = 'new';

/** 組名 → 裝箱 key(空名即「未分組」哨兵)。 */
export function groupKey(name: string): string {
  return name.trim() ? `${GROUP_PREFIX}${name.trim()}` : UNGROUPED;
}

export interface VibeGroup {
  /** 裝箱後的 key,用於 v-for key 與摺疊集合。 */
  key: string;
  /** 展示名。 */
  label: string;
  /** 真實組名(未分組為空串),批次改組時用。 */
  name: string;
  /** 搜尋命中的成員,只用於渲染。 */
  items: NaiVibe[];
  /**
   * 組的全部成員(不受搜尋影響)。批次動作與計數一律用它:
   * 「只開這組」若只作用於搜尋命中的子集,會把同組被搜尋藏起來的條目一併關掉——
   * 使用者看不見的東西被悄悄改掉是最難查的一類 bug,故渲染與語義分開兩個列表。
   */
  all: NaiVibe[];
}

/** 搜尋命中:名字或組名子串匹配(與設定頁排除列表同口徑,大小寫不敏感)。 */
export function matchVibe(vibe: Pick<NaiVibe, 'name' | 'group'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return vibe.name.toLowerCase().includes(q) || vibe.group.toLowerCase().includes(q);
}

/**
 * 按組歸攏。順序:有名字的組按庫中首次出現的先後排,「未分組」永遠墊底
 * ——它不是一個組,只是還沒歸類的收容區,排前面會顯得像預設組。
 *
 * 搜尋沒命中任何成員的組不會出現;命中的組則帶上全量成員(all)。
 */
export function groupVibes(vibes: readonly NaiVibe[], query = ''): VibeGroup[] {
  const map = new Map<string, VibeGroup>();
  for (const vibe of vibes) {
    if (!matchVibe(vibe, query)) continue;
    const name = vibe.group.trim();
    const key = groupKey(name);
    let group = map.get(key);
    if (!group) {
      group = { key, label: name || '未分組', name, items: [], all: [] };
      map.set(key, group);
    }
    group.items.push(vibe);
  }
  // 全量成員單獨收一遍:只補進已出現的組,搜尋沒命中的組不憑空出現
  for (const vibe of vibes) {
    map.get(groupKey(vibe.group))?.all.push(vibe);
  }
  const groups = [...map.values()];
  return [...groups.filter(g => g.name), ...groups.filter(g => !g.name)];
}

/**
 * 「生效中」不落盤、是算出來的:當前啟用集合恰好等於本組全部成員時才成立。
 * 故使用者手動多勾一條之後它會自己消失,不會出現「顯示生效中但實際不是」的騙人狀態。
 * 空組不算生效(否則庫裡全空時每個空組都顯示生效中)。
 */
export function isGroupActive(group: VibeGroup, vibes: readonly NaiVibe[]): boolean {
  if (!group.all.length) return false;
  const ids = new Set(group.all.map(v => v.id));
  return vibes.every(v => v.enabled === ids.has(v.id));
}
