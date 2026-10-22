import { describe, expect, it } from 'vitest';

import {
  applyVibes,
  buildNaiParameters,
  BUILTIN_NAI_ARTISTS,
  fullNegativePrompt,
  fullPositivePrompt,
  isBuiltinNaiArtist,
  naiArtistPrompt,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiEndpoint,
  naiRandomSeed,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiArtistPreset, NaiModel, NaiSettings, NaiVibe, NaiVibeData } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

function nai(overrides: Partial<NaiSettings> = {}): NaiSettings {
  return {
    url: 'https://image.novelai.net',
    qualityTags: '',
    negativePrompt: '',
    resolution: '832×1216',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    key: 'nai-test',
    endpoints: [{ id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'nai-test' }],
    activeEndpointId: 'nep_official',
    model: 'nai-diffusion-4-5-full',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    concurrency: 1,
    vibes: [],
    artistPresets: [],
    activeArtistId: '',
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '測試Vibe',
    dataPath: '/user/files/v1.json',
    thumbnailPath: '/user/files/v1.jpg',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: 'v4-5full:ZW5jb2Rpbmc=',
    strength: 0.6,
    enabled: true,
    group: '',
    ...overrides,
  };
}

function vibeData(overrides: Partial<NaiVibeData> = {}): NaiVibeData {
  return {
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('自動補 /ai 字首', () => {
    expect(naiEndpoint('https://image.novelai.net', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    expect(naiEndpoint('https://mirror.example.com/', 'encode-vibe')).toBe(
      'https://mirror.example.com/ai/encode-vibe',
    );
  });

  it('base 已是完整端點時原樣使用', () => {
    expect(naiEndpoint('https://x.com/proxy/ai/generate-image', 'generate-image')).toBe(
      'https://x.com/proxy/ai/generate-image',
    );
  });

  it('空地址報錯', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('支援 × / x / * 分隔', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('拒絕非 64 倍數與非法格式', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/範圍/);
  });
});

describe('提示詞拼裝', () => {
  it('使用模型官方質量詞並拼到提示詞末尾', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('1girl, sitting, location, very aesthetic, masterpiece, no text');
  });

  it('按模型切換官方質量詞', () => {
    expect(fullPositivePrompt(nai({ model: 'nai-diffusion-4-5-curated' }), '1girl')).toBe(
      '1girl, location, masterpiece, no text, -0.8::feet::, rating:general',
    );
  });

  it('負面 = 模型官方預設詞', () => {
    const neg = fullNegativePrompt(nai());
    expect(neg).toContain('worst quality');
  });

  it('負面只認 undesiredContent,不再拼 negativePrompt', () => {
    // 「附加負面」已併入一個框;存量 negativePrompt 由 normalizeNai 折進 undesiredContent
    expect(fullNegativePrompt(nai({ negativePrompt: 'bad hands', undesiredContent: 'lowres' }))).toBe('lowres');
  });

  it('覆蓋值優先於模型官方詞(正/負各一)', () => {
    expect(fullPositivePrompt(nai({ qualityTags: 'best quality' }), '1girl')).toBe('1girl, best quality');
    expect(fullNegativePrompt(nai({ undesiredContent: 'only this' }))).toBe('only this');
  });

  it('覆蓋值留空 = 跟隨模型官方詞(切模型內容跟著換)', () => {
    // 這是「空串 = 跟隨官方」這條儲存口徑的核心契約
    const asFull = fullPositivePrompt(nai({ qualityTags: '', model: 'nai-diffusion-3' }), '1girl');
    expect(asFull).toBe('1girl, best quality, amazing quality, very aesthetic, absurdres');
    expect(fullNegativePrompt(nai({ undesiredContent: '', model: 'nai-diffusion-3' }))).toContain('{bad}');
  });

  it('純空白覆蓋值等同留空', () => {
    expect(fullPositivePrompt(nai({ qualityTags: '   ' }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ undesiredContent: '  \n ' }))).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('未知模型無官方詞時回落空串,不拋', () => {
    expect(naiDefaultQualityTags('nai-diffusion-9')).toBe('');
    expect(naiDefaultUndesired('nai-diffusion-9')).toBe('');
    const odd = nai({ model: 'nai-diffusion-9' as NaiSettings['model'] });
    expect(fullPositivePrompt(odd, '1girl')).toBe('1girl');
    expect(fullNegativePrompt(odd)).toBe('');
  });
});

describe('畫師串拼裝', () => {
  const preset = (prompt: string, id = 'art_a', extra: Partial<NaiArtistPreset> = {}): NaiArtistPreset => ({
    id,
    name: 'A',
    prompt,
    quality: '',
    negative: '',
    ...extra,
  });

  it('空庫 / 未選 → 輸出與本功能上線前逐位元組一致(存量使用者零變化)', () => {
    expect(fullPositivePrompt(nai(), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('畫師串拼在最前:畫師串 → 畫面 tag → 質量詞', () => {
    const s = nai({
      artistPresets: [preset('artist:wlop, artist:krenz')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl, sitting')).toBe(
      'artist:wlop, artist:krenz, 1girl, sitting, location, very aesthetic, masterpiece, no text',
    );
  });

  it('activeArtistId 懸空 → 不使用,絕不回落第一條(那會靜默給使用者換一套畫風)', () => {
    const s = nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_gone' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('選中條目內容全空白 → 等同不使用,不留前導逗號', () => {
    // '   ' 是 truthy,filter(Boolean) 兜不住,故 naiArtistPrompt 內部必須 trim
    const s = nai({ artistPresets: [preset('   ')], activeArtistId: 'art_a' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('與自定義質量詞共存,順序仍是 畫師串 → tag → 質量詞', () => {
    const s = nai({
      qualityTags: 'best quality',
      artistPresets: [preset('artist:a')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, best quality');
  });

  it('naiArtistPrompt 三態:空庫 / 懸空 / 選中(選中時首尾空白被去掉)', () => {
    expect(naiArtistPrompt(nai())).toBe('');
    expect(naiArtistPrompt(nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_x' }))).toBe('');
    expect(
      naiArtistPrompt(nai({ artistPresets: [preset(' artist:a ')], activeArtistId: 'art_a' })),
    ).toBe('artist:a');
  });

  it('多條只取選中那一條,不串味', () => {
    const s = nai({
      artistPresets: [preset('artist:a', 'art_a'), preset('artist:b', 'art_b')],
      activeArtistId: 'art_b',
    });
    expect(naiArtistPrompt(s)).toBe('artist:b');
  });
});

describe('配方綁定正/負面詞(解析鏈:配方 → 渠道 → 官方)', () => {
  const preset = (extra: Partial<NaiArtistPreset>): NaiArtistPreset => ({
    id: 'art_a',
    name: 'A',
    prompt: 'artist:a',
    quality: '',
    negative: '',
    ...extra,
  });
  const withPreset = (extra: Partial<NaiArtistPreset>, rest: Partial<NaiSettings> = {}) =>
    nai({ artistPresets: [preset(extra)], activeArtistId: 'art_a', ...rest });

  it('配方綁定的質量詞/負面詞優先於渠道覆蓋值與官方詞', () => {
    const s = withPreset(
      { quality: 'recipe quality', negative: 'recipe negative' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, recipe quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('配方欄位留空 → 跟隨渠道覆蓋值', () => {
    const s = withPreset({}, { qualityTags: 'channel quality', undesiredContent: 'channel negative' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('配方與渠道都留空 → 模型官方詞(與本功能上線前逐位元組一致)', () => {
    const s = withPreset({});
    expect(fullPositivePrompt(s, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('只綁定其一:另一個照常回落', () => {
    const s = withPreset({ negative: 'recipe negative' }, { qualityTags: 'channel quality' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('純空白綁定值 = 未綁定,繼續向下回落', () => {
    const s = withPreset(
      { quality: '   ', negative: ' \n ' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('activeArtistId 懸空 → 配方欄位一併失效,走渠道/官方', () => {
    const s = nai({
      artistPresets: [preset({ quality: 'recipe quality', negative: 'recipe negative' })],
      activeArtistId: 'art_gone',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('切換配方 = 正/負面詞一起切換(需求的核心契約)', () => {
    const s = nai({
      artistPresets: [
        preset({ id: 'art_a', quality: 'q a', negative: 'n a' }),
        preset({ id: 'art_b', prompt: 'artist:b', quality: 'q b', negative: 'n b' }),
      ],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, q a');
    expect(fullNegativePrompt(s)).toBe('n a');
    s.activeArtistId = 'art_b';
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:b, 1girl, q b');
    expect(fullNegativePrompt(s)).toBe('n b');
    // 切到「不使用」→ 回落渠道/官方
    s.activeArtistId = '';
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });
});

describe('NAI V5 support', () => {
  it('uses official model defaults and params_version 4', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const) {
      expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
      expect(naiDefaultUndesired(model)).toContain('dithering, halftone, screentone');
      const params = buildNaiParameters(nai({ model }), { prompt: '1girl', seed: 42 });
      expect(params.params_version).toBe(4);
      expect(params.v4_prompt).toBeTruthy();
      expect(params.skip_cfg_above_sigma).toBeNull();
      expect(params.sampler).toBe('k_euler');
    }
    const fallback = buildNaiParameters(nai({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3' }), {
      prompt: '1girl',
      seed: 42,
    });
    expect(fallback.sampler).toBe('k_euler_ancestral');
  });

  it('V5 Full 預設負面只排缺陷,不再禁題材/風格/身材/畫師', () => {
    // 老版在官方基線上串過一大串社群詞,把 chibi、大胸、暗調、具體畫師名等都禁了,
    // 會跟正向詞與畫師串長期打架(原作者已宣告棄用)。這裡鎖死:通用預設不碰題材偏好。
    const neg = naiDefaultUndesired('nai-diffusion-5-full');
    // 官方基線原樣保留(V5 調參依賴它,面板也靠這段認出「未自定義」)
    expect(neg).toContain('worst quality, bad quality, jpeg artifacts');
    expect(neg).toContain('dithering, halftone, screentone');
    for (const banned of [
      'chibi',
      'large breasts',
      'huge breasts',
      'dark',
      'high contrast',
      'artist:',
      'artist collaboration',
      '4koma',
      'oekaki',
      'black face',
      'extra people',
      'honey',
      'tight pants',
      'childish',
    ]) {
      expect(neg).not.toContain(banned);
    }
  });

  it('maps Base Tag + NL and native Character Prompts into the V5 caption schema', () => {
    const settings = nai({
      model: 'nai-diffusion-5-full',
      qualityTags: 'very aesthetic',
      artistPresets: [{ id: 'artist', name: 'Artist', prompt: 'artist:test', quality: '', negative: '' }],
      activeArtistId: 'artist',
    });
    const params = buildNaiParameters(settings, {
      prompt: '2girls, classroom, sunset',
      nl: 'Two girls in a sunset classroom.',
      characters: [
        { name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left, waving.' },
        { name: 'B', tag: 'girl, silver hair, red dress', nl: '' },
      ],
      seed: 42,
    });
    const positive = params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string; centers: unknown[] }> };
      use_coords: boolean;
      use_order: boolean;
    };
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string; centers: unknown[] }> };
    };
    expect(positive.caption.base_caption).toBe(
      'artist:test, 2girls, classroom, sunset, very aesthetic. Two girls in a sunset classroom.',
    );
    expect(positive.caption.char_captions).toEqual([
      { char_caption: 'girl, black hair, white dress. On the left, waving.', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: 'girl, silver hair, red dress', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(negative.caption.char_captions).toEqual([
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(positive.use_coords).toBe(false);
    expect(positive.use_order).toBe(true);
  });

  it('uses model-specific V5 vibe encodings', () => {
    expect(vibeModelKey('nai-diffusion-5-full')).toBe('v5full');
    expect(vibeModelKey('nai-diffusion-5-curated')).toBe('v5curated');
    const settings = nai({ model: 'nai-diffusion-5-full', vibes: [vibe({ name: 'V5 vibe' })] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const data = vibeData({ encodings: { v5full: { encoding: 'djU=', infoExtracted: 1 } } });
    expect(applyVibes(params, settings, new Map([['v1', data]]))).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([
      { cache_secret_key: expect.any(String), data: 'djU=' },
    ]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  // 迴歸鎖:char_captions 所在欄位本就叫 v4_prompt,這套結構是 V4 時代的協議,V5 只是繼承。
  // 曾經按 isNai5 卡過,4.5 明明支援卻一條角色提示都發不出去(角色外貌全糊進 Base)。
  // 邊界在 4.5 而非整個 v4 系:自然語言是 4.5 引入的,原版 NAI4 只吃 tag。
  it('sends native Character Prompts on 4.5 as well as V5, but not on plain NAI 4', () => {
    const values = {
      prompt: '2girls, classroom',
      nl: 'Two girls in a classroom.',
      characters: [{ name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left.' }],
      seed: 1,
    };
    const captionsOf = (model: NaiModel) =>
      (
        buildNaiParameters(nai({ model }), values).v4_prompt as {
          caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
        }
      ).caption;

    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions.map(c => c.char_caption)]).toEqual([
        model,
        ['girl, black hair, white dress. On the left.'],
      ]);
      // nl 拼接同樣開放到 4.5:句點分隔接在 tag 串之後
      expect([model, caption.base_caption.endsWith('. Two girls in a classroom.')]).toEqual([model, true]);
    }

    // 原版 NAI4 保持單串形態:角色提示與 nl 都不發
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions]).toEqual([model, []]);
      expect([model, caption.base_caption.includes('Two girls in a classroom.')]).toEqual([model, false]);
    }
  });
});

describe('buildNaiParameters', () => {
  it('v4 繫帶 v4_prompt 結構', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
    expect(p.ucPreset).toBe(3);
    expect(p.qualityToggle).toBe(true);
  });

  it('NAI3 不帶 v4 結構,帶原圖參考陣列與 sm 開關', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('v4_prompt 的 base_caption 與 fullPositivePrompt 同源(含畫師串)', () => {
    // 頂層 input(generateNaiImage)與 parameters.v4_prompt 各拼一次的話,NAI3 讀 input、
    // NAI4/4.5 讀 v4_prompt,兩者會拿到不同提示詞且只在 NAI3 上暴露。此斷言把「同源」釘死:
    // 任何拼裝改動都必須留在 fullPositivePrompt 內部,不能在呼叫點單獨加料。
    const s = nai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '' }],
      activeArtistId: 'art_a',
    });
    const p = buildNaiParameters(s, { prompt: '1girl', seed: 1 });
    const v4 = p.v4_prompt as { caption: { base_caption: string } };
    expect(v4.caption.base_caption).toBe(fullPositivePrompt(s, '1girl'));
    expect(v4.caption.base_caption.startsWith('artist:a, 1girl')).toBe(true);
  });

  it('k_euler_ancestral 附加 brownian 修正', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('橫屏畫面取橫屏尺寸,skip_cfg_above_sigma 隨畫素量同步變化', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 與 1216×832 畫素量相同,sigma 也應相同(證明它確實按尺寸推導)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('缺 size 時按豎屏出圖(與改動前的固定預設一致)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('對應方向未填時回落內建豎屏預設', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('固定種子優先於隨機', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('關 variety 時為 null', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 用 58,其餘用 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5:編碼資料進 cached,強度並進 strength 陣列', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const skipped = applyVibes(params, nai({ vibes: [vibe()] }), new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('缺當前模型編碼的 vibe 被跳過並返回名字', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const skipped = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '舊模型Vibe', modelKeys: ['v3'] })] }),
      new Map([['v1', vibeData({ encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })]]),
    );
    expect(skipped).toEqual(['舊模型Vibe']);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('強度總和超過 1 且開歸一化時按比例壓回 1', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
      new Map([
        ['a', vibeData()],
        ['b', vibeData()],
      ]),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
  });

  it('NAI3:參考原圖進 reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const skipped = applyVibes(params, settings, new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('未啟用的 vibe 不參與', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(params, nai({ vibes: [vibe({ enabled: false })] }), new Map([['v1', vibeData()]]));
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('按模型對映官方 key', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('解析官方格式', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('缺 strength 欄位回落 0.6,不靜默變成強度 0', () => {
    // 迴歸:舊實現走 Number(v),而 Number(null) / Number('') 都是 0 ——
    // vibe 會以「強度 0」匯入,掛上了卻對畫面毫無影響,且極難排查。
    const build = (importInfo: unknown) =>
      JSON.stringify({
        identifier: 'novelai-vibe-transfer',
        version: 1,
        image: 'aW1hZ2U=',
        encodings: {
          'v4-5full': {
            k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
          },
        },
        importInfo,
      });
    expect(parseNaiv4vibe(build({ model: 'nai-diffusion-4-5-full' })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: null })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: '' })).strength).toBe(0.6);
  });

  it('拒絕非 vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/標識/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('解出 zip 內第一張圖', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('非 zip 資料包友好錯誤', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32 位無符號整數', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('內建畫師串配方(只讀、隨版本更新、不進 settings)', () => {
  it('使用者庫為空時,activeArtistId 命中內建庫', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(naiArtistPrompt(s)).toBe(BUILTIN_NAI_ARTISTS[0].prompt.trim());
    expect(fullPositivePrompt(s, '1girl')).toBe(
      `${BUILTIN_NAI_ARTISTS[0].prompt.trim()}, 1girl, location, very aesthetic, masterpiece, no text`,
    );
  });

  it('內建配方的 quality/negative 走同一回落鏈:留空 → 渠道覆蓋值', () => {
    // 內建條目當前不綁定正/負面詞;這裡鎖住「留空 = 跟隨渠道」的口徑,
    // 以後給內建條目加綁定時這條測試會提醒檢查鏈行為。
    const s = nai({
      artistPresets: [],
      activeArtistId: 'bi_default',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toContain('channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('isBuiltinNaiArtist:bi_ 字首命中,使用者條目(art_*)不命中', () => {
    expect(isBuiltinNaiArtist('bi_default')).toBe(true);
    expect(isBuiltinNaiArtist('art_abc')).toBe(false);
    expect(isBuiltinNaiArtist('')).toBe(false);
  });

  it('activeArtistId 指向不存在的內建 id(如下線後)→ 不加畫師串', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(naiArtistPrompt(s)).toBe('');
  });
});
