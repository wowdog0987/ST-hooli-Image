/**
 * 畫幅方向(橫屏/豎屏)與尺寸解析的共享工具。
 *
 * 分工:模型只決定「橫還是豎」,具體畫素由使用者在各後端面板裡配一對(豎屏尺寸/橫屏尺寸)——
 * 不同 checkpoint 適應的解析度不同,寫死一個比例會讓一半場景吃虧。
 *
 * 本模組刻意不 import settings:出圖後端與協議層都要用它,
 * 依賴具體 Settings 型別會繞出迴圈引用。按方向取尺寸的入參用結構化約束表達。
 */

export type Orientation = 'portrait' | 'landscape';

export interface ImageSize {
  width: number;
  height: number;
}

/** 只作精確匹配的橫屏縮寫(太短,做子串匹配會誤傷 landscape 之外的詞)。 */
const LANDSCAPE_CODES = new Set(['l', 'h', 'w']);

/** 出現即判橫屏的關鍵詞(子串匹配,覆蓋「橫屏構圖」「landscape shot」這類短語)。 */
const LANDSCAPE_WORDS = ['landscape', 'horizontal', 'widescreen', 'wide', '橫', '寬屏'];

/**
 * 容忍式歸一:認不出來一律 'portrait'。
 *
 * 豎屏是外掛原本的固定預設(832×1216),降級到它 = 維持現狀,
 * 因此模型漏給/給亂值時不該拋錯——parseImagePlan 拋錯會白白消耗 runner 的重試次數。
 * 也認「16:9 / 1216x832」這類比例寫法:寬 > 高即橫屏。
 */
export function normalizeOrientation(value: unknown): Orientation {
  if (typeof value !== 'string') return 'portrait';
  const text = value.trim().toLowerCase();
  if (!text) return 'portrait';
  if (LANDSCAPE_CODES.has(text)) return 'landscape';

  // 比例/尺寸寫法:16:9、1216x832、1216×832 → 比較寬高
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*[:：×xX*]\s*(\d+(?:\.\d+)?)/);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      return a > b ? 'landscape' : 'portrait';
    }
  }

  return LANDSCAPE_WORDS.some(word => text.includes(word)) ? 'landscape' : 'portrait';
}

/**
 * 寬鬆尺寸解析:「1216×832 / 1216x832 / 1216*832」→ {width, height}。
 * 只做通用下限校驗(整數、64–4096);後端各自的額外限制(如 NAI 要求 64 的倍數、
 * 上限 2048)由呼叫方在此之上再加,錯誤資訊也由呼叫方給,便於貼合後端語境。
 * 解析不出返回 null,由呼叫方決定是報錯還是降級。
 */
export function parseSize(text: string): ImageSize | null {
  const match = (text ?? '').match(/(\d{2,4})\s*[×xX*]\s*(\d{2,4})/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 64 || height < 64 || width > 4096 || height > 4096) return null;
  return { width, height };
}

/** 一對畫幅尺寸配置(各出圖後端各持一份)。 */
export interface SizePair {
  /** 豎屏尺寸,如 832×1216。 */
  portraitSize: string;
  /** 橫屏尺寸,如 1216×832。 */
  landscapeSize: string;
}

/** 按方向取使用者配置的尺寸串(未填時返回空串,由呼叫方決定回落)。 */
export function pickSize(pair: SizePair, orientation: Orientation): string {
  const text = orientation === 'landscape' ? pair.landscapeSize : pair.portraitSize;
  return (text ?? '').trim();
}
