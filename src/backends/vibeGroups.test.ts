import { describe, expect, it } from 'vitest';

import { groupKey, groupVibes, isGroupActive, matchVibe, UNGROUPED } from '@/backends/vibeGroups';
import type { NaiVibe } from '@/state/settings';

function vibe(id: string, group = '', enabled = false, name = id): NaiVibe {
  return {
    id,
    name,
    dataPath: `/user/files/${id}.json`,
    thumbnailPath: '',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: `fp-${id}`,
    strength: 0.6,
    enabled,
    group,
  };
}

describe('groupKey', () => {
  it('真實組名加字首裝箱,空名為未分組哨兵', () => {
    expect(groupKey('戰鬥組')).toBe('g:戰鬥組');
    expect(groupKey('')).toBe(UNGROUPED);
    expect(groupKey('   ')).toBe(UNGROUPED);
  });

  it('使用者把組命名成哨兵字面量也不會撞車', () => {
    expect(groupKey('ungrouped')).not.toBe(UNGROUPED);
    expect(groupKey('new')).toBe('g:new');
  });
});

describe('matchVibe', () => {
  it('空查詢全部命中', () => {
    expect(matchVibe(vibe('a'), '')).toBe(true);
    expect(matchVibe(vibe('a'), '   ')).toBe(true);
  });

  it('名字或組名子串命中,大小寫不敏感', () => {
    const v = { name: 'Sunset Girl', group: '風景組' };
    expect(matchVibe(v, 'sunset')).toBe(true);
    expect(matchVibe(v, 'GIRL')).toBe(true);
    expect(matchVibe(v, '風景')).toBe(true);
    expect(matchVibe(v, '戰鬥')).toBe(false);
  });
});

describe('groupVibes', () => {
  it('按組歸攏,未分組永遠墊底', () => {
    const groups = groupVibes([
      vibe('1'),
      vibe('2', '戰鬥組'),
      vibe('3'),
      vibe('4', '日常組'),
      vibe('5', '戰鬥組'),
    ]);
    expect(groups.map(g => g.label)).toEqual(['戰鬥組', '日常組', '未分組']);
    expect(groups[0].all.map(v => v.id)).toEqual(['2', '5']);
    expect(groups[2].all.map(v => v.id)).toEqual(['1', '3']);
  });

  it('有名字的組按庫中首次出現順序排', () => {
    const groups = groupVibes([vibe('1', 'Z組'), vibe('2', 'A組')]);
    expect(groups.map(g => g.label)).toEqual(['Z組', 'A組']);
  });

  it('搜尋只收窄 items,all 始終是全量成員', () => {
    const groups = groupVibes(
      [vibe('1', '戰鬥組', false, '劍光'), vibe('2', '戰鬥組', false, '火焰'), vibe('3', '日常組', false, '咖啡')],
      '劍',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(v => v.id)).toEqual(['1']);
    // 關鍵:同組被搜尋藏起來的「火焰」仍在 all 裡,批次動作才不會把它誤關
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('搜尋沒命中的組不出現', () => {
    const groups = groupVibes([vibe('1', '戰鬥組', false, '劍光'), vibe('2', '日常組', false, '咖啡')], '咖啡');
    expect(groups.map(g => g.label)).toEqual(['日常組']);
  });

  it('按組名搜尋能帶出整組', () => {
    const groups = groupVibes([vibe('1', '戰鬥組', false, '劍光'), vibe('2', '戰鬥組', false, '火焰')], '戰鬥');
    expect(groups[0].items).toHaveLength(2);
  });

  it('組名首尾空格歸一到同一組', () => {
    const groups = groupVibes([vibe('1', '戰鬥組'), vibe('2', ' 戰鬥組 ')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('空庫返回空陣列', () => {
    expect(groupVibes([])).toEqual([]);
  });
});

describe('isGroupActive', () => {
  it('啟用集合恰好等於本組全部成員時才算生效', () => {
    const vibes = [vibe('1', '戰鬥組', true), vibe('2', '戰鬥組', true), vibe('3', '日常組', false)];
    const [battle, daily] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(true);
    expect(isGroupActive(daily, vibes)).toBe(false);
  });

  it('組外多開一條即不再生效(不會顯示騙人的生效中)', () => {
    const vibes = [vibe('1', '戰鬥組', true), vibe('2', '日常組', true)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('組內漏開一條也不算生效', () => {
    const vibes = [vibe('1', '戰鬥組', true), vibe('2', '戰鬥組', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('搜尋期間的判定仍按全量成員算', () => {
    const vibes = [vibe('1', '戰鬥組', true, '劍光'), vibe('2', '戰鬥組', false, '火焰')];
    // 搜尋只剩「劍光」,但「火焰」未啟用 → 整組不算生效
    const [battle] = groupVibes(vibes, '劍');
    expect(battle.items).toHaveLength(1);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('全部未啟用時不算生效', () => {
    const vibes = [vibe('1', '戰鬥組', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });
});
