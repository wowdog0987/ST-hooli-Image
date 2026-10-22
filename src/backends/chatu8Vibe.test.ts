import { describe, expect, it } from 'vitest';

import { naiDefaultUndesired } from '@/backends/nai';
import {
  collectChatu8ArtistRefs,
  collectChatu8VibeRefs,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  planPrefixGroups,
  vibeFingerprint,
} from '@/backends/chatu8Vibe';

describe('collectChatu8VibeRefs', () => {
  it('收集預設與組內的 vibe 引用', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: {
        預設: { vibeDataId: 'cfgimg_a', strength: 0.7 },
        風格B: { vibeDataId: 'cfgimg_b', strength: 0.5 },
      },
      vibeGroups: {
        預設組: { vibes: [{ vibeDataId: 'cfgimg_c', strength: 0.6 }] },
        戰鬥組: {
          vibes: [
            { vibeDataId: 'cfgimg_d', strength: 0.4 },
            { vibeDataId: 'cfgimg_e', strength: 0.8 },
          ],
        },
      },
    });
    expect(refs.map(r => r.vibeDataId)).toEqual(['cfgimg_a', 'cfgimg_b', 'cfgimg_c', 'cfgimg_d', 'cfgimg_e']);
    expect(refs[0]).toMatchObject({ source: '預設', kind: 'preset', strength: 0.7 });
    expect(refs[2]).toMatchObject({ source: '預設組', kind: 'group', strength: 0.6 });
  });

  it('同一 vibeDataId 多處出現時按預設優先去重', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: { 我的預設: { vibeDataId: 'cfgimg_x', strength: 0.9 } },
      vibeGroups: { 組A: { vibes: [{ vibeDataId: 'cfgimg_x', strength: 0.3 }] } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'preset', source: '我的預設', strength: 0.9 });
  });

  it('容錯:非物件/缺欄位/非法強度', () => {
    expect(collectChatu8VibeRefs(null)).toEqual([]);
    expect(collectChatu8VibeRefs('junk')).toEqual([]);
    const refs = collectChatu8VibeRefs({
      vibePresets: { 壞: { vibeDataId: 123 }, 好: { vibeDataId: 'cfgimg_ok', strength: 'abc' } },
      vibeGroups: { 空組: { vibes: 'not-array' } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ vibeDataId: 'cfgimg_ok', strength: 0.6 });
  });
});

describe('detectChatu8Vibes', () => {
  it('未安裝/無設定時 found=false', () => {
    expect(detectChatu8Vibes(undefined).found).toBe(false);
    expect(detectChatu8Vibes(null).found).toBe(false);
    expect(detectChatu8Vibes('junk').found).toBe(false);
  });

  it('統計預設與組內 vibe 數(已去重)', () => {
    const info = detectChatu8Vibes({
      vibePresets: { 預設: { vibeDataId: 'a' }, 風格B: { vibeDataId: 'b' } },
      vibeGroups: { 組1: { vibes: [{ vibeDataId: 'b' }, { vibeDataId: 'c' }] } },
    });
    expect(info).toEqual({ found: true, total: 3, presets: 2, groups: 1 });
  });

  it('有設定但沒 vibe → found=true,total=0', () => {
    const info = detectChatu8Vibes({ someOtherSetting: 1 });
    expect(info).toEqual({ found: true, total: 0, presets: 0, groups: 0 });
  });
});

describe('planPrefixGroups', () => {
  const vibe = (id: string, name: string, group = '') => ({ id, name, group });

  it('把「組名 · 原名」字首還原成分組', () => {
    const plans = planPrefixGroups([
      vibe('1', '戰鬥組 · 劍光'),
      vibe('2', '戰鬥組 · 火焰'),
      vibe('3', '日常組 · 咖啡'),
    ]);
    expect(plans).toEqual([
      { id: '1', group: '戰鬥組', name: '劍光' },
      { id: '2', group: '戰鬥組', name: '火焰' },
      { id: '3', group: '日常組', name: '咖啡' },
    ]);
  });

  it('不動已分好組的條目', () => {
    expect(planPrefixGroups([vibe('1', '戰鬥組 · 劍光', '我的組')])).toEqual([]);
  });

  it('沒有字首的條目不參與', () => {
    expect(planPrefixGroups([vibe('1', '劍光'), vibe('2', '一個·沒有空格的名字')])).toEqual([]);
  });

  it('字首或餘名為空時跳過,不產出空組名', () => {
    expect(planPrefixGroups([vibe('1', ' · 劍光'), vibe('2', '戰鬥組 · ')])).toEqual([]);
  });

  it('只取第一個分隔符,餘下的分隔符留在名字裡', () => {
    expect(planPrefixGroups([vibe('1', '戰鬥組 · 劍光 · 二段')])).toEqual([
      { id: '1', group: '戰鬥組', name: '劍光 · 二段' },
    ]);
  });
});

describe('vibeFingerprint', () => {
  it('同內容同指紋,與 key 順序無關', () => {
    const a = vibeFingerprint({
      v3: { encoding: 'AAA', infoExtracted: 1 },
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
    });
    const b = vibeFingerprint({
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
      v3: { encoding: 'AAA', infoExtracted: 1 },
    });
    expect(a).toBe(b);
  });

  it('不同編碼不同指紋', () => {
    const a = vibeFingerprint({ v3: { encoding: 'AAA', infoExtracted: 1 } });
    const b = vibeFingerprint({ v3: { encoding: 'CCC', infoExtracted: 1 } });
    expect(a).not.toBe(b);
  });
});

describe('st-chatu8 artist migration', () => {
  const MODEL = 'nai-diffusion-4-5-full';
  const source = {
    yushe: {
      Default: { fixedPrompt: '', fixedPrompt_end: '', negativePrompt: '' },
      Painter: { fixedPrompt: 'artist:a', fixedPrompt_end: 'style:b', negativePrompt: 'bad hands' },
      SharedSDPreset: { fixedPrompt: 'score_9', fixedPrompt_end: '' },
      Broken: null,
    },
    yusheid_novelai: 'Painter',
  };

  it('collects each preset with its three fields split by position', () => {
    expect(collectChatu8ArtistRefs(source)).toEqual([
      { source: 'Default', prompt: '', quality: '', negative: '', active: false },
      { source: 'Painter', prompt: 'artist:a', quality: 'style:b', negative: 'bad hands', active: true },
      { source: 'SharedSDPreset', prompt: 'score_9', quality: '', negative: '', active: false },
    ]);
  });

  it('detects source settings independently from preset count', () => {
    expect(detectChatu8Artists(undefined)).toEqual({ found: false, total: 0 });
    expect(detectChatu8Artists({ yushe: {} })).toEqual({ found: true, total: 0 });
    expect(detectChatu8Artists(source)).toEqual({ found: true, total: 3 });
  });

  it('imports presets with position-preserving mapping and baked negative baseline', () => {
    const result = importArtistsFromChatu8([], source, MODEL);
    expect(result.found).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.overwritten).toBe(0);
    expect(result.duplicates).toBe(0);
    const byName = new Map(result.plans.map(p => [p.source, p]));
    const painter = byName.get('Painter')!;
    expect(painter.state).toBe('import');
    expect(painter.preset).toMatchObject({
      name: 'Painter',
      prompt: 'artist:a',
      quality: 'style:b',
      negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
    });
    // 負向為空 → 不烤基線,留空走回落鏈(基線跟隨模型)
    expect(byName.get('SharedSDPreset')!.preset!.negative).toBe('');
    expect(byName.get('Default')!.preset!.prompt).toBe('');
    expect(result.activeArtistId).toBe(painter.targetId);
    expect(result.plans.every(p => p.targetId.startsWith('art_'))).toBe(true);
  });

  it('overwrites same-name entries with different content, keeping their id and the active mapping', () => {
    // 舊版遷移的條目:正向整體塞在畫師串裡,負向為空 → 重新匯入應原地修復
    const existing = [
      { id: 'art_old', name: 'Painter', prompt: 'artist:a, style:b', quality: '', negative: '' },
    ];
    const result = importArtistsFromChatu8(existing, source, MODEL);
    expect(result.imported).toBe(2);
    expect(result.overwritten).toBe(1);
    expect(result.duplicates).toBe(0);
    const plan = result.plans.find(p => p.source === 'Painter')!;
    expect(plan.state).toBe('overwrite');
    expect(plan.targetId).toBe('art_old');
    expect(plan.preset).toMatchObject({
      id: 'art_old',
      prompt: 'artist:a',
      quality: 'style:b',
      negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
    });
    expect(result.activeArtistId).toBe('art_old');
  });

  it('skips same-name entries with identical content (idempotent re-import)', () => {
    const existing = [
      {
        id: 'art_x',
        name: 'Painter',
        prompt: 'artist:a',
        quality: 'style:b',
        negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
      },
    ];
    const result = importArtistsFromChatu8(existing, source, MODEL);
    expect(result.imported).toBe(2);
    expect(result.overwritten).toBe(0);
    expect(result.duplicates).toBe(1);
    const plan = result.plans.find(p => p.source === 'Painter')!;
    expect(plan.state).toBe('skip');
    expect(plan.targetId).toBe('art_x');
    expect(result.activeArtistId).toBe('art_x');
  });

  it('does not collapse different names with identical prompt content', () => {
    const result = importArtistsFromChatu8(
      [],
      { yushe: { A: { fixedPrompt: 'artist:a' }, B: { fixedPrompt: 'artist:a' } } },
      MODEL,
    );
    expect(result.imported).toBe(2);
  });

  it('imports every valid preset, including all-empty ones', () => {
    const result = importArtistsFromChatu8([], source, MODEL);
    expect(result.plans.map(p => p.source)).toEqual(['Default', 'Painter', 'SharedSDPreset']);
  });
});
