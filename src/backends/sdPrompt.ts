/**
 * NovelAI 提示詞寫法 → ComfyUI(SD 系模型)寫法。
 *
 * 角色庫與題詞規則以 NovelAI 為主,同一份 tag 送 ComfyUI 前在這裡換成 SD 認得的形式:
 * - 數字權重 `1.4::short hair::`(含手誤的單冒號 `1.4:short hair`)→ `(short hair:1.4)`;
 * - 花括號/方括號 `{tag}` / `[tag]`(NAI 每層 ×1.05 / ÷1.05)→ `(tag:1.05)` / `(tag:0.95)`;
 * - 負權重(NAI 用來「移除」某物)SD 沒有對應寫法,直接略過;
 * - tag 裡的普通圓括號(`character name (series)`)SD 會當成加權,要跳脫成 `\(` `\)`;
 * - 已經是 SD 權重寫法 `(tag:1.2)` 或已跳脫的,原樣保留。
 */

const NAI_NUMERIC = /^(-?\d+(?:\.\d+)?)::(.+?)(?:::)?$/;
const NAI_NUMERIC_SINGLE = /^(-?\d+(?:\.\d+)?):(?!:)\s*(.+)$/;
const SD_WEIGHT = /^\(.+:\s*-?\d+(?:\.\d+)?\)$/;

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 跳脫還沒跳脫的圓括號。 */
function escapeParens(text: string): string {
  return text.replace(/(?<!\\)([()])/g, '\\$1');
}

function weighted(body: string, weight: number): string {
  return `(${escapeParens(body.trim())}:${round(weight)})`;
}

export function toSdTag(part: string): string {
  const tag = part.trim();
  if (!tag || SD_WEIGHT.test(tag)) return tag;

  const numeric = tag.match(NAI_NUMERIC) ?? tag.match(NAI_NUMERIC_SINGLE);
  if (numeric) {
    const weight = Number(numeric[1]);
    return weight > 0 ? weighted(numeric[2], weight) : '';
  }

  const braces = tag.match(/^(\{+)([^{}]+)(\}+)$/);
  if (braces && braces[1].length === braces[3].length) return weighted(braces[2], 1.05 ** braces[1].length);
  const brackets = tag.match(/^(\[+)([^[\]]+)(\]+)$/);
  if (brackets && brackets[1].length === brackets[3].length) return weighted(brackets[2], 1 / 1.05 ** brackets[1].length);

  return escapeParens(tag);
}

function convertPrompt(text: string, convert: (part: string) => string): string {
  return String(text ?? '')
    .split('\n')
    .map(line => line.split(',').map(convert).filter(Boolean).join(', '))
    .join('\n');
}

/** 整串逗號分隔的提示詞逐個 tag 轉換;換行保留。 */
export function toSdPrompt(text: string): string {
  return convertPrompt(text, toSdTag);
}

/**
 * 給 Flux / Anima 這類非 CLIP 編碼器:權重語法對它們幾乎無效,還會留下怪符號,
 * 一律拿掉只留 tag 本身;負權重(移除某物)照樣略過。
 */
export function toPlainTag(part: string): string {
  const tag = part.trim();
  if (!tag) return '';
  const sd = tag.match(/^\((.+):\s*(-?\d+(?:\.\d+)?)\)$/);
  if (sd) return Number(sd[2]) > 0 ? sd[1].trim() : '';
  const numeric = tag.match(NAI_NUMERIC) ?? tag.match(NAI_NUMERIC_SINGLE);
  if (numeric) return Number(numeric[1]) > 0 ? numeric[2].trim() : '';
  const braces = tag.match(/^(\{+|\[+)([^{}[\]]+)(\}+|\]+)$/);
  if (braces && braces[1].length === braces[3].length) return braces[2].trim();
  return tag.replace(/\\([()])/g, '$1');
}

export function toPlainPrompt(text: string): string {
  return convertPrompt(text, toPlainTag);
}
