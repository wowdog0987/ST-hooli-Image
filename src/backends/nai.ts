import { unzipSync } from 'fflate';
import { randomUuid } from '@/randomUuid';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import {
  parseRetryAfter,
  runNaiWithRetry,
  type NaiRetryInfo,
} from '@/backends/naiRateLimit';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { clampVibeStrength, loadVibeData } from '@/backends/vibeStore';
import type {
  NaiArtistPreset,
  NaiSettings,
  NaiVibe,
  NaiVibeData,
  NaiVibeEncodings,
} from '@/state/settings';

/**
 * NovelAI 生圖後端(瀏覽器直連,協議與官方 image.novelai.net 一致)。
 * url 可指向任意相容站:官方/映象/第三方轉發,端點自動補 /ai 字首。
 *
 * 參考 st-chatu8 的實現口徑:
 * - 生圖 POST {base}/ai/generate-image,body {input, model, action:'generate', parameters}。
 * - 響應是 zip(stream: 'msgpack'),解出第一張圖。
 * - NAI3 的 vibe 直接發參考原圖;NAI4/4.5 必須先經 /ai/encode-vibe 編碼,
 *   生成時以 reference_image_multiple_cached(uuid + 編碼資料) 形式疊加。
 * - .naiv4vibe 檔案格式與官方互通(encodings 按模型 key 分組)。
 */

export class NaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * 對方 Retry-After 換算出的毫秒數(沒給則 null)。
     * 由 naiRateLimit 的重試器當退避下界用 —— 這是「該等多久」最權威的一手資訊,
     * 扔掉它就只能憑指數退避瞎猜。
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'NaiError';
  }
}

/* ============ 常量表(與 st-chatu8 / NAI 官方前端同口徑) ============ */

export const NAI_SAMPLERS: { value: string; label: string }[] = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES: { value: string; label: string }[] = [
  { value: 'karras', label: 'Karras(推薦)' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 各模型官方質量詞，拼到正向提示詞末尾;使用者在面板改過則用其覆蓋值。 */
const QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/**
 * 各模型官方 Heavy 負面詞，作為無需使用者選擇的通用預設;使用者改過則用其覆蓋值。
 * 5-full 在官方基線後額外串一條外掛精選的通用負面層:只排畫質/解剖/水印等**缺陷**,
 * 不含題材、風格、身材、畫師偏好——那些會跟使用者的正向詞和畫師串長期打架。
 * 其餘模型維持官方基線不動。
 */
const DEFAULT_UNDESIRED_CONTENT: Record<string, string> = {
  'nai-diffusion-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, watermark, signature, username, artist name, bad anatomy, bad hands, bad feet, extra digits, fewer digits, extra fingers, fused fingers, extra limbs, missing limbs, long neck, blurry, poorly drawn, unfinished, plastic skin, waxy skin, oversaturated, washed out',
  'nai-diffusion-5-curated':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-3':
    'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  'nai-diffusion-4-full':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-4-5-curated':
    'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
};

/**
 * 某模型的官方質量詞 / 官方 Heavy 負面詞。面板拿它做「未自定義」時的顯示內容
 * 與「恢復預設」的目標,故必須匯出:否則使用者看不到實際生效的詞(改動前的老問題)。
 */
export function naiDefaultQualityTags(model: string): string {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model: string): string {
  return DEFAULT_UNDESIRED_CONTENT[model] ?? '';
}

/** variety boost 的 magic 常數(st-chatu8 同口徑):按畫素量相對參考解析度縮放。 */
const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

export function naiSupportsVibes(model: string): boolean {
  return isNai3(model) || isNai4Family(model) || isNai5(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);

export function naiSamplers(model: string): { value: string; label: string }[] {
  return isNai5(model) ? NAI_SAMPLERS.filter(sampler => NAI_V5_SAMPLERS.has(sampler.value)) : NAI_SAMPLERS;
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

/**
 * 該模型是否走「Base Prompt + 原生 Character Prompts + 自然語言」這套協議。
 *
 * 邊界是 4.5 而不是整個 v4 系:自然語言是 4.5 才引入的,原版 NAI4
 * (nai-diffusion-4-full / 4-curated-preview)只吃 tag。給它發英文 nl 句子
 * 屬於未驗證行為,故保持原樣走單串 tag 規範。
 *
 * ⚠ 不要改回 isNai5:char_captions 所在的欄位本來就叫 v4_prompt,這套結構是 V4 時代的
 * 協議,V5 只是繼承。曾經按 isNai5 卡過,導致 4.5 明明支援卻一條角色提示都發不出去。
 */
export function naiSupportsCharacterPrompts(model: string): boolean {
  return isNai45(model) || isNai5(model);
}

export function isNai4Family(model: string): boolean {
  return model.includes('nai-diffusion-4');
}

function isNai3(model: string): boolean {
  return model === 'nai-diffusion-3';
}

/** skip_cfg_above_sigma:開 variety boost 時按尺寸與模型算;關 → null。 */
export function skipCfgAboveSigma(width: number, height: number, model: string, varietyBoost: boolean): number | null {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============ 地址與基礎工具 ============ */

/**
 * 拼端點:base 去掉尾斜槓後補 /ai/<path>;base 本身已是完整端點
 * (以 /ai/<path> 或 /<path> 結尾)時原樣使用,方便第三方站給整段 URL。
 */
export function naiEndpoint(url: string, path: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('請先填寫 NAI 介面地址');
  const seg = path.replace(/^\/+/, '');
  if (base.endsWith(`/ai/${seg}`) || base.endsWith(`/${seg}`)) return base;
  return `${base}/ai/${seg}`;
}

export interface NaiSize {
  width: number;
  height: number;
}

/** 解析「832×1216 / 832x1216」;寬高須為 64 的倍數、256–2048。 */
export function parseResolution(text: string): NaiSize {
  const size = parseSize(text);
  if (!size) throw new NaiError(`解析度格式無效:${text || '(空)'};應如 832×1216`);
  const { width, height } = size;
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new NaiError(`解析度 ${width}×${height} 不是 64 的倍數,NAI 要求寬高均為 64 的倍數`);
  }
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new NaiError(`解析度 ${width}×${height} 超出 NAI 允許範圍(256–2048)`);
  }
  return { width, height };
}

/** NAI 種子是 32 位無符號整數(與 ComfyUI 的 2^53 不同,不能複用 randomSeed)。 */
export function naiRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ payload 構造(純函式,可測) ============ */

export interface NaiGenerateValues {
  /** 正向 tag(不含質量詞)。 */
  prompt: string;
  nl?: string;
  characters?: ImageCharacterPrompt[];
  /** 種子;預設隨機。 */
  seed?: number;
  /** 畫幅方向;預設豎屏(與改動前的固定預設一致)。 */
  size?: Orientation;
}

/**
 * 內建畫師串配方:只讀,**不進 settings**,改它們 = 改這裡的常量、發版即生效。
 *
 * 為什麼不做成「首次啟動播種進 settings」:寫進 settings 那一刻預設值就凍在
 * 每個使用者的裝置上(還隨 extension_settings 跨裝置同步),以後再改只能靠
 * 「與舊種子逐位元組比對」的指紋遷移,每改一次背一份舊種子。內建在程式碼裡,
 * 預設值永遠跟著版本走,已安裝使用者的 settings 一個位元組不用動。
 *
 * 口徑:
 * - id 用 bi_ 字首(使用者條目恆為 art_*),永不與使用者庫相撞;
 * - 只讀:面板不給改名/刪除,要自定義走「複製」建成使用者條目再改;
 * - quality/negative 與使用者條目同一條回落鏈,留空 = 跟隨渠道級;
 * - 新使用者預設選中第一條(見 settings.ts 的 naiDefaults);老使用者的
 *   activeArtistId 存在 settings 裡,不受這裡影響;
 * - 要下線某條內建配方,至少留一個版本再刪:正選中它的使用者會走既有
 *   「id 懸空 → 清成不使用」邏輯,畫風靜默變掉,需慎重。
 */
export const BUILTIN_NAI_ARTISTS: readonly NaiArtistPreset[] = [
  {
    id: 'bi_default',
    name: '預設畫師串',
    prompt:
      '0.8::nnmbpx::,0.8::artist:yalmyu::,0.1::smilesmile1312,::,  artist:sh_(shinh), 0.4::chen bin::,0.4::dayama::,healthyman,bacheally,',
    quality: '',
    negative: '',
  },
];

/** 該 id 是否是內建配方(面板據此只讀化;使用者條目 id 恆為 art_*,不可能撞上)。 */
export function isBuiltinNaiArtist(id: string): boolean {
  return BUILTIN_NAI_ARTISTS.some(a => a.id === id);
}

type JsonObject = Record<string, unknown>;

/**
 * 當前生效的畫風配方;未選 / 指向已刪條目 → null。
 * 查詢域 = 使用者庫 ∪ 內建庫(使用者庫優先;id 字首不同,實際不可能撞)。
 *
 * 刻意吃 nai 而不讀全域性 settings:本檔案的拼裝函式都是純函式、可單測,讀全域性會讓測試
 * 沒法用 nai() 工廠控制輸入。也刻意不 import state/settings 的 activeNaiArtist ——
 * settings.ts 已 import 本模組的 naiDefaultUndesired,反向加值依賴會成執行時環(TDZ 隱患)。
 * 這一行 find 的重複是有意為之。
 */
function naiActivePreset(nai: NaiSettings): NaiArtistPreset | null {
  if (!nai.activeArtistId) return null;
  return (
    nai.artistPresets.find(a => a.id === nai.activeArtistId) ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === nai.activeArtistId) ??
    null
  );
}

/** 當前生效的畫師串:選中條目的 prompt;未選 / 指向已刪條目 / 內容全空白 → 空串。 */
export function naiArtistPrompt(nai: NaiSettings): string {
  // 全空白的 preset 必須歸空串:'   ' 是 truthy,下游 filter(Boolean) 兜不住它
  return naiActivePreset(nai)?.prompt.trim() ?? '';
}

/**
 * 正面質量詞解析鏈:配方綁定值 → 渠道覆蓋值(qualityTags)→ 內建預設。
 * 任一級空串(或純空白)= 跟隨下一級。內建預設當前 = 模型官方詞;
 * 以後外掛要換成自己的精選預設,只改 naiDefaultQualityTags,鏈結構不變。
 */
export function naiQualityTags(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.quality.trim();
  return bound || nai.qualityTags.trim() || naiDefaultQualityTags(nai.model);
}

/** 負面提示詞解析鏈:配方綁定值 → 渠道覆蓋值(undesiredContent)→ 內建預設(模型官方負面詞)。 */
export function naiUndesiredContent(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.negative.trim();
  return bound || nai.undesiredContent.trim() || naiDefaultUndesired(nai.model);
}

/**
 * 正向完整 prompt:畫師串在最前,畫面 tag 居中,質量詞在最後。
 * - 畫師串 = 畫風配方庫當前選中條目(未選則無)。放最前是因為它決定整幅畫的畫風基調,
 *   NAI 對靠前 tag 的權重更高;
 * - 質量詞 = 配方綁定值優先,其次渠道覆蓋值(qualityTags),都留空則按模型取官方詞
 *   (見 naiQualityTags)。
 *
 * ⚠ 本函式在 buildNaiParameters(v4_prompt 的來源)與 generateNaiImage 的頂層 input
 * 欄位處各調一次,兩處必須同源。拼裝改動一律留在本函式內部——在某個呼叫點單獨加料會讓
 * NAI3(讀 input)與 NAI4/4.5(讀 v4_prompt)拿到不同的提示詞,且只在 NAI3 上暴露。
 */
export function fullPositivePrompt(nai: NaiSettings, prompt: string, nl = ''): string {
  const artist = naiArtistPrompt(nai);
  const quality = naiQualityTags(nai);
  // V5 讀得懂自然語言,Base nl(空間關係/互動/鏡頭)接在畫面 tag 之後、質量詞之前;
  // 4.5 及以下維持純 tag(V4.5 對自然語言只算部分支援,協議也不再要模型寫 nl)。
  const scene = isNai5(nai.model) ? nl.trim() : '';
  return [artist, prompt.trim(), scene, quality].filter(Boolean).join(', ');
}

function characterCaption(character: ImageCharacterPrompt): string {
  // Character Prompts identify one subject: library count tags (1girl/1boy) become girl/boy here.
  const tag = character.tag
    .split(',')
    .map(part => {
      const value = part.trim();
      if (/^\d+\s*girls?$/i.test(value)) return 'girl';
      if (/^\d+\s*boys?$/i.test(value)) return 'boy';
      return value;
    })
    .filter(Boolean)
    .join(', ');
  // 強制純 tag 模式：不拼接角色自然語言描述
  return tag;
}

/**
 * 負面完整 prompt = 配方綁定值 → 渠道覆蓋值(undesiredContent)→ 模型官方負面詞
 * (見 naiUndesiredContent)。想額外排除什麼,往任一級的值裡接即可。
 */
export function fullNegativePrompt(nai: NaiSettings): string {
  return naiUndesiredContent(nai);
}

/**
 * 構造 parameters。v4 系模型帶 v4_prompt/v4_negative_prompt 結構;NAI3 不帶。
 * vibe 不在此疊加(見 applyVibes),保持「一次生成 = build + applyVibes」兩步。
 */
export function buildNaiParameters(nai: NaiSettings, values: NaiGenerateValues): JsonObject {
  // 畫幅按方向取使用者配的那一格;沒填回落豎屏預設
  const orientation = values.size ?? 'portrait';
  const { width, height } = parseResolution(pickSize(nai, orientation) || '832×1216');
  // 顯式傳入 > 面板固定種子 > 隨機
  const seed = values.seed ?? (nai.seed > 0 ? nai.seed : naiRandomSeed());
  const prompt = fullPositivePrompt(nai, values.prompt, values.nl);
  const negative = fullNegativePrompt(nai);
  const skipCfg = skipCfgAboveSigma(width, height, nai.model, nai.varietyBoost);
  const sampler = isNai5(nai.model) && !NAI_V5_SAMPLERS.has(nai.sampler) ? 'k_euler_ancestral' : nai.sampler;

  const params: JsonObject = {
    params_version: isNai5(nai.model) ? 4 : 3,
    width,
    height,
    scale: nai.scale,
    sampler,
    steps: nai.steps,
    n_samples: 1,
    // 提示詞已由本地固定預設拼好；協議欄位保持官方前端口徑。
    ucPreset: 3,
    qualityToggle: true,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: nai.cfgRescale,
    noise_schedule: nai.noiseSchedule,
    skip_cfg_above_sigma: skipCfg,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negative,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: nai.normalizeRefStrength,
    use_coords: false,
  };

  if (isNai3(nai.model)) {
    // NAI3:vibe 直接發參考原圖;SME/SMEA 暫不開放(固定關)
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4/4.5/V5: v4 caption structure; Vibe uses a model-specific cached encoding.
    params.reference_image_multiple_cached = [];
    const charCaptions = naiSupportsCharacterPrompts(nai.model)
      ? (values.characters ?? []).map(character => ({
          char_caption: characterCaption(character),
          centers: [{ x: 0.5, y: 0.5 }],
        }))
      : [];
    params.characterPrompts = [];
    params.v4_prompt = {
      caption: { base_caption: prompt, char_captions: charCaptions },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: {
        base_caption: negative,
        char_captions: charCaptions.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })),
      },
      legacy_uc: false,
    };
  }

  if (sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  return params;
}

/** vibe 模型 key:encodings 分組的鍵(與官方 .naiv4vibe 一致)。 */
export function vibeModelKey(model: string): string {
  if (model.includes('nai-diffusion-5-curated')) return 'v5curated';
  if (model.includes('nai-diffusion-5-full')) return 'v5full';
  if (model.includes('4-5-curated')) return 'v4-5curated';
  if (model.includes('4-5-full')) return 'v4-5full';
  if (model.includes('4-curated')) return 'v4curated';
  if (model.includes('4-full')) return 'v4full';
  if (model.includes('diffusion-3')) return 'v3';
  return 'v4-5full';
}

/**
 * 把啟用的 vibe 疊加進 parameters。
 * - NAI3:參考原圖進 reference_image_multiple(配資訊提取度 1 + 強度);
 * - NAI4/4.5:編碼資料進 reference_image_multiple_cached(隨機 cache key),強度並進
 *   reference_strength_multiple;強度總和超過 1 且開啟歸一化時按比例壓回 1。
 * 返回被跳過的 vibe 名(缺當前模型編碼/缺原圖),呼叫方據以提示。
 */
export function applyVibes(
  params: JsonObject,
  nai: NaiSettings,
  dataById: ReadonlyMap<string, NaiVibeData>,
): string[] {
  const active = nai.vibes.filter(v => v.enabled);
  if (!active.length) return [];
  if (!naiSupportsVibes(nai.model)) return active.map(vibe => vibe.name);
  const skipped: string[] = [];
  const strengths = params.reference_strength_multiple as number[];

  if (isNai3(nai.model)) {
    const images = params.reference_image_multiple as string[];
    const infos = params.reference_information_extracted_multiple as number[];
    for (const vibe of active) {
      const data = dataById.get(vibe.id);
      if (!data?.image) {
        skipped.push(vibe.name);
        continue;
      }
      images.push(data.image);
      infos.push(1);
      strengths.push(vibe.strength);
    }
    return skipped;
  }

  const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
  const modelKey = vibeModelKey(nai.model);
  const picked: number[] = [];
  for (const vibe of active) {
    const enc = dataById.get(vibe.id)?.encodings[modelKey];
    if (!enc?.encoding) {
      skipped.push(vibe.name);
      continue;
    }
    cached.push({ cache_secret_key: randomUuid(), data: enc.encoding });
    picked.push(vibe.strength);
  }
  // 歸一化:總強度 > 1 時按比例壓回 1(st-chatu8 同口徑;4.5 開歸一化時官方端也會自動處理)
  const total = picked.reduce((s, x) => s + x, 0);
  const scale = nai.normalizeRefStrength && total > 1 ? 1 / total : 1;
  for (const s of picked) strengths.push(s * scale);
  return skipped;
}

/* ============ 網路請求 ============ */

async function naiHttpError(resp: Response, label: string): Promise<NaiError> {
  const text = (await resp.text().catch(() => '')).trim();
  let detail = text;
  try {
    const json = JSON.parse(text);
    if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* 非 JSON 錯誤體直接用原文 */
  }
  // Retry-After 一併帶上:重試器拿它當退避下界(見 NaiError.retryAfterMs)
  const retryAfterMs = parseRetryAfter(resp.headers?.get('Retry-After'));
  switch (resp.status) {
    case 400:
      return new NaiError(`${label}:請求校驗失敗:${detail.slice(0, 300)}`, resp.status, retryAfterMs);
    case 401:
      return new NaiError(`${label}:API Key 錯誤或無效`, resp.status, retryAfterMs);
    case 402:
      return new NaiError(`${label}:需要有效訂閱(402)`, resp.status, retryAfterMs);
    case 429:
      return new NaiError(
        `${label}:請求過於頻繁(429),已自動退避重試;仍失敗請調低「同時出圖數」或稍後再試`,
        resp.status,
        retryAfterMs,
      );
    default:
      return new NaiError(`${label} (${resp.status}):${detail.slice(0, 300)}`, resp.status, retryAfterMs);
  }
}

/** 測試連線:優先 /user/subscription 驗 key;第三方站無此介面(404)時只驗證地址可達。 */
export async function testNaiConnection(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!nai.key.trim()) throw new NaiError('請先填寫 API Key');
  const resp = await fetch(naiEndpoint(nai.url, 'user/subscription'), {
    headers: { Authorization: `Bearer ${nai.key.trim()}` },
    signal,
  });
  if (resp.status === 404) {
    return { message: '地址可達,但無訂閱介面(第三方站);請以實際生圖驗證' };
  }
  if (!resp.ok) throw await naiHttpError(resp, '連線 NAI 失敗');
  const data = (await resp.json().catch(() => null)) as {
    tier?: number;
    active?: boolean;
    subscription?: { tier?: number; active?: boolean; expiresAt?: number };
  } | null;
  const tier = data?.subscription?.tier ?? data?.tier;
  const active = data?.subscription?.active ?? data?.active;
  const tierName = ['Free', 'Tablet', 'Scroll', 'Opus'][Number(tier)] ?? `Tier ${tier}`;
  return {
    message: `連線正常:${tierName}${active === false ? '(訂閱未啟用)' : ''}`,
  };
}

/** 解 NAI 返回的 zip,取第一張圖轉 base64。 */
export function unzipNaiImage(buffer: ArrayBuffer): { base64: string; filename: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new NaiError('響應不是有效的 zip 包(第三方站可能返回了其他格式)');
  }
  const name = Object.keys(files).find(n => /\.(png|jpe?g|webp)$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new NaiError('zip 包內沒有圖片檔案');
  return { base64: uint8ToBase64(files[name]), filename: name };
}

/**
 * 生圖。返回與 ComfyImageResult 同構的結果(dataURL 形式),樓層卡片/落盤層可直接複用。
 *
 * 429/5xx/網路級失敗會自動退避重試(backends/naiRateLimit.ts);配置類錯誤
 * (key 錯、訂閱過期、引數非法)立刻丟擲,不做無謂重試。onRetry 用於把退避過程
 * 報給卡片顯示 —— 否則使用者看著「生成中…」一動不動幾十秒,只會以為卡死了再點一次。
 */
export async function generateNaiImage(
  nai: NaiSettings,
  values: NaiGenerateValues,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<ComfyImageResult> {
  if (!nai.key.trim()) throw new NaiError('請先填寫 NAI API Key');
  if (!values.prompt.trim()) throw new NaiError('正向提示詞不能為空');

  const params = buildNaiParameters(nai, values);
  const activeVibes = naiSupportsVibes(nai.model) ? nai.vibes.filter(vibe => vibe.enabled) : [];
  const loaded = new Map<string, NaiVibeData>();
  for (const vibe of activeVibes) {
    try {
      const data = await loadVibeData(vibe);
      loaded.set(
        vibe.id,
        isNai3(nai.model)
          ? data
          : {
              image: '',
              thumbnail: '',
              encodings: data.encodings,
            },
      );
    } catch (error) {
      console.warn(`[虎哩繪] 讀取 vibe「${vibe.name}」失敗:`, error);
    }
  }
  const skipped = applyVibes(params, nai, loaded);
  if (skipped.length) {
    const reason = naiSupportsVibes(nai.model) ? '缺當前模型編碼' : '當前模型不支援 Vibe Transfer';
    console.warn(`[虎哩繪] 以下 vibe 因${reason}被跳過:`, skipped);
    toastr.warning(`vibe「${skipped.join('、')}」${reason},已跳過`, '虎哩繪');
  }

  const body = {
    input: fullPositivePrompt(nai, values.prompt, values.nl),
    model: nai.model,
    action: 'generate',
    parameters: params,
    use_new_shared_trial: true,
  };
  // 只把「發請求 + 解包」包進重試:上面拼引數、讀 vibe 資料的活是一次性的,
  // 重跑它們既白費功夫,也會把 vibe 缺編碼的 toastr 警告重複彈出來。
  return runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'generate-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'NAI 生圖失敗');

      const { base64, filename } = unzipNaiImage(await resp.arrayBuffer());
      const format = filename.split('.').pop()?.toLowerCase() || 'png';
      return {
        url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${base64}`,
        filename: `nai-${Date.now()}.${format}`,
        format,
        revoke() {},
      };
    },
    { signal, onRetry: opts.onRetry },
  );
}

/* ============ vibe 編碼與 .naiv4vibe 互通 ============ */

/** 官方 .naiv4vibe 裡 encoding 的固定內層 key(與 st-chatu8 同)。 */
export const VIBE_ENCODING_KEY = 'b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f';

/**
 * 調 /ai/encode-vibe 把參考圖編碼成 vibe 資料(base64)。
 * NAI4/4.5 的 vibe 必須經此編碼;NAI3 不需要(直接發原圖)。
 *
 * 與生圖同樣帶退避重試:這也是一次真實的 NAI 請求,吃 429 時不該只是彈個紅條了事。
 * (併發槽由呼叫方取,見 pages/backend/panels/NaiPanel.vue —— 與卡片同一條紀律。)
 */
export async function encodeVibeImage(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  imageBase64: string,
  model: string,
  infoExtracted = 1,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<string> {
  if (!nai.key.trim()) throw new NaiError('請先填寫 NAI API Key');
  return runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'encode-vibe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify({ image: imageBase64, information_extracted: infoExtracted, model }),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'vibe 編碼失敗');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length < 100) {
        throw new NaiError(`vibe 編碼資料異常(僅 ${bytes.length} 位元組),介面可能返回了錯誤響應`);
      }
      return uint8ToBase64(bytes);
    },
    { signal, onRetry: opts.onRetry },
  );
}

export interface ImportedVibe {
  name: string;
  image: string;
  thumbnail: string;
  encodings: NaiVibeEncodings;
  strength: number;
}

/** 解析 .naiv4vibe 檔案文本(JSON)為 vibe 條目(不含 id,由呼叫方補)。 */
export function parseNaiv4vibe(text: string): ImportedVibe {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NaiError('不是有效的 .naiv4vibe 檔案(JSON 解析失敗)');
  }
  if (json?.identifier !== 'novelai-vibe-transfer') {
    throw new NaiError('不是 NovelAI vibe 檔案(缺少 novelai-vibe-transfer 標識)');
  }
  const encodings: NaiVibeEncodings = {};
  for (const [modelKey, group] of Object.entries(json.encodings ?? {})) {
    const first = Object.values(group as Record<string, any>)[0];
    if (typeof first?.encoding === 'string' && first.encoding) {
      encodings[modelKey] = {
        encoding: first.encoding,
        infoExtracted:
          typeof first.params?.information_extracted === 'number'
            ? first.params.information_extracted
            : 1,
      };
    }
  }
  if (!Object.keys(encodings).length) throw new NaiError('vibe 檔案裡沒有可用的編碼資料');
  return {
    name: typeof json.name === 'string' && json.name ? json.name : '匯入的 Vibe',
    image: typeof json.image === 'string' ? json.image : '',
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : '',
    encodings,
    strength: clampVibeStrength(json.importInfo?.strength),
  };
}

/** 匯出為官方相容的 .naiv4vibe JSON(全部已編碼模型一併帶上)。 */
export async function buildNaiv4vibe(vibe: NaiVibe, data: NaiVibeData): Promise<string> {
  const encodings: Record<string, unknown> = {};
  for (const [modelKey, enc] of Object.entries(data.encodings)) {
    encodings[modelKey] = {
      [VIBE_ENCODING_KEY]: {
        encoding: enc.encoding,
        params: { information_extracted: enc.infoExtracted },
      },
    };
  }
  const id = data.image ? await sha256Hex(data.image) : randomUuid();
  return JSON.stringify({
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: data.image,
    id,
    encodings,
    name: vibe.name,
    thumbnail: data.thumbnail,
    createdAt: Date.now(),
    importInfo: {
      model: Object.keys(data.encodings)[0] ?? '',
      information_extracted: 1,
      strength: vibe.strength,
    },
  });
}
