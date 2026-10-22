import { normalizeOrientation, type Orientation } from '@/backends/size';
import type { TargetSegment } from '@/autoTag/clean';
import { FORBIDDEN_SUBTAG, serializeImageTag } from '@/st/imageTagRegex';
import {
  CHAR_TAG_FIELDS,
  type CharTagField,
  type CharTagHistoryField,
} from '@/state/charTags';

export interface ImageCharacterPrompt {
  name: string;
  tag: string;
  nl: string;
}

export interface ImageInsertion {
  /** 模型選擇的目標正文位置 ID。 */
  position: string;
  /** 位置 ID 對應的原始物理行(0-based，僅外掛內部使用)。 */
  sourceLine: number;
  /** danbooru 短 tag 部分(必填)。 */
  tag: string;
  /** 自然語言部分(可空;ComfyUI「生成自然語言」開啟時由模型一併輸出)。 */
  nl: string;
  /** 本畫面動態負面 tag(可空;僅在 ComfyUI 工作流使用 %negative_prompt% 時要求模型輸出)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 畫幅方向:模型只判橫/豎,具體畫素由使用者在後端面板配置。漏給/亂給一律降級豎屏。 */
  size: Orientation;
}

export interface ImagePlan {
  images: ImageInsertion[];
  /** AI 報告的角色庫變更(建檔/欄位更新);呼叫方負責落庫。 */
  changes: CharChange[];
}

/** AI 輸出的單條角色變更(寬鬆形狀;解析後欄位全部合法才保留)。 */
export interface CharChange {
  name: string;
  /** 'new' = 建檔;其餘為欄位名/整串/自然語言。 */
  field: CharTagHistoryField;
  value: string;
  /** 自然語言外貌句(new 建檔時可附帶)。 */
  nl?: string;
  reason: string;
  /**
   * 永久變化開始生效的位置。建檔(new)不受此約束——角色的固定外貌是本樓全程
   * 成立的事實,不是「從某處開始」的變化,這裡只作記錄與排序用。
   */
  position: string;
  /** position 對應的原始物理行(0-based,僅外掛內部使用)。 */
  sourceLine: number;
}

const HISTORY_FIELDS: ReadonlySet<string> = new Set([
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
  'new',
  'raw',
  'nl',
]);

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(cleaned);

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function parseObject(raw: string): Record<string, unknown> {
  for (const candidate of jsonObjects(raw)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 嘗試下一個候選 JSON 塊。
    }
  }
  throw new Error('AI 沒有返回可解析的 JSON 物件');
}

/** tag / nl / negative 內容裡不允許出現的子標籤字面量（口徑見 st/imageTagRegex.ts）。 */

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} 不得包含 hooli_image/tag/nl/negative/size 標籤`);
  }
  return text;
}

function sanitizeCharacters(value: unknown, imageIndex: number): ImageCharacterPrompt[] {
  if (!Array.isArray(value)) return [];
  const characters: ImageCharacterPrompt[] = [];
  for (let index = 0; index < value.length && characters.length < 32; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    try {
      const name = sanitizeContent(item.name, `characters[${index}].name`, imageIndex);
      const tag = sanitizeContent(item.tag ?? item.prompt, `characters[${index}].tag`, imageIndex);
      const nl = sanitizeContent(item.nl, `characters[${index}].nl`, imageIndex);
      if (name && tag) characters.push({ name, tag, nl });
    } catch {
      // A malformed character prompt must not discard an otherwise valid image plan.
    }
  }
  return characters;
}

/**
 * 位置歸一:模型常把標記原樣抄回(⟦P3⟧)、寫成 "P3/P4"、小寫或純數字,
 * 取其中第一個 P 編號即可,不必為格式差異整次重試。
 */
export function normalizePositionId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return `P${value}`;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const tagged = text.match(/P\s*(\d+)/i);
  if (tagged) return `P${Number(tagged[1])}`;
  return /^\d+$/.test(text) ? `P${Number(text)}` : null;
}

function sanitizePosition(value: unknown, index: number): string {
  const position = normalizePositionId(value);
  if (!position) throw new Error(`images[${index}].position 必須是目標正文中的 P編號(收到 ${JSON.stringify(value)})`);
  return position;
}

const COUNT_TAG_RE = /^(?:\d+\+?|multiple)\s*(?:boys?|girls?|others?)(?:\s+\d+\+?\s*(?:boys?|girls?|others?))*$/i;
const SEX_TAG_RE = /^(?:1|one)?\s*(boy|girl|other)$/i;

function countTag(n: number, noun: 'girl' | 'boy' | 'other'): string {
  return n === 1 ? `1${noun}` : `${n}${noun}s`;
}

/**
 * Base 的人數 tag 由角色列表推算,不採信模型寫的:模型常把人數算錯(寫出 2boys、
 * 1boy 1girl 這類),而 characters[] 裡每人的性別 tag 才是準的。
 * 有角色沒帶性別 tag 時無從推算,原樣保留模型的寫法。
 */
export function withCharacterCount(tag: string, characters: ImageCharacterPrompt[]): string {
  if (!characters.length) return tag;
  const counts = { girl: 0, boy: 0, other: 0 };
  for (const character of characters) {
    const sex = character.tag
      .split(',')
      .map(part => part.trim().match(SEX_TAG_RE)?.[1]?.toLowerCase())
      .find(Boolean) as keyof typeof counts | undefined;
    if (!sex) return tag;
    counts[sex] += 1;
  }
  const countTags = (['girl', 'boy', 'other'] as const)
    .filter(noun => counts[noun] > 0)
    .map(noun => countTag(counts[noun], noun));
  const rest = tag
    .split(',')
    .map(part => part.trim())
    .filter(part => part && !COUNT_TAG_RE.test(part));
  return [...countTags, ...rest].join(', ');
}

/**
 * 解析並嚴格校驗模型給出的“目標位置 ID + 提示詞”列表。tag 必填;nl/negative 選填。
 * size 一律容忍:歸一不出就當豎屏——為它拋錯會白白吃掉 runner 的重試次數。
 * 圖片超過上限時本地硬截斷;少於使用者明確設定的下限則拋錯,交給 runner 重試。
 * changes 全程寬容:單條壞就丟棄,絕不連累 images——角色檔案漏一條只是這個角色本輪
 * 沒錨定,為它作廢整次輸出會連圖一起沒有,那是更壞的結果。
 */
export function parseImagePlan(
  raw: string,
  segments: TargetSegment[],
  minImages: number,
  maxImages: number,
): ImagePlan {
  const parsed = parseObject(raw);
  if (!Array.isArray(parsed.images)) throw new Error('AI 返回的 JSON 缺少 images 陣列');
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] 必須是物件`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`images[${index}].position=${position} 不在目標正文可選位置中`);
    }
    // 相容模型按舊協議/習慣返回 prompt 鍵的情況
    const tag = sanitizeContent(entry.tag ?? entry.prompt, 'tag', index);
    if (!tag) throw new Error(`images[${index}].tag 不能為空`);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    const negative = sanitizeContent(entry.negative ?? entry.negative_prompt, 'negative', index);
    const characters = sanitizeCharacters(entry.characters, index);
    // 相容模型按習慣返回 orientation / aspect 鍵
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    images.push({
      position,
      sourceLine,
      tag: withCharacterCount(tag, characters),
      nl,
      negative,
      characters,
      size,
    });
  }

  const limitedImages = images.slice(0, normalizedMax);
  if (limitedImages.length < normalizedMin) {
    throw new Error(
      `AI 返回了 ${limitedImages.length} 張圖片，少於設定的最少圖片數 ${normalizedMin}`,
    );
  }

  return {
    images: limitedImages,
    changes: parseChanges(parsed.changes, positions),
  };
}

/**
 * 解析變化生效位置。建檔(new)缺位置不是錯——它本就全樓生效;
 * 解析不出時回落到首個位置,只用於排序。
 */
function parsePosition(
  value: unknown,
  positions: Map<string, number>,
): { position: string; sourceLine: number } | null {
  const position = normalizePositionId(value);
  if (!position) return null;
  const sourceLine = positions.get(position);
  if (sourceLine === undefined) return null;
  return { position, sourceLine };
}

function firstPosition(positions: Map<string, number>): { position: string; sourceLine: number } {
  for (const [position, sourceLine] of positions) return { position, sourceLine };
  return { position: '', sourceLine: 0 };
}

/** 建檔欄位:hair 與 eyes 是二次元身份錨點,缺任一條則該條建檔不可用(呼叫方丟棄)。 */
function parseNewFields(raw: Record<string, unknown>): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  if (!fields.hair || !fields.eyes) return null;
  return JSON.stringify(fields);
}

function parseChanges(raw: unknown, positions: Map<string, number>): CharChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CharChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const fieldRaw = typeof o.field === 'string' ? o.field.trim() : '';
    if (!name || !HISTORY_FIELDS.has(fieldRaw)) continue;
    const field = fieldRaw as CharTagHistoryField;
    const parsedPosition = parsePosition(o.position ?? o.at, positions);
    // 建檔全樓生效,位置只作記錄,缺失就回落首位;永久變化必須知道從哪生效,位置壞 = 丟棄
    if (!parsedPosition && field !== 'new') continue;
    const { position, sourceLine } = parsedPosition ?? firstPosition(positions);
    let value = typeof o.value === 'string' ? o.value.trim() : '';
    const fields =
      o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
        ? (o.fields as Record<string, unknown>)
        : null;
    if (field === 'new') {
      const parsedFields = fields ? parseNewFields(fields) : null;
      if (!parsedFields) continue;
      value = parsedFields;
    }
    const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!value && !nl) continue;
    out.push({ name, field, value, nl: nl || undefined, reason, position, sourceLine });
  }
  return out;
}

/** 保持原文及原換行符不變，只在模型選擇的位置 ID 對應原始碼行之後插入 tag。 */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    if (!Number.isInteger(image.sourceLine) || image.sourceLine < 0 || image.sourceLine >= lines.length) {
      throw new Error(`位置 ${image.position} 對應的原始物理行已失效`);
    }
    const line = image.sourceLine;
    const list = byLine.get(line) ?? [];
    list.push(image);
    byLine.set(line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // 序列化口徑見 st/imageTagRegex.ts 的 serializeImageTag（與手動編輯彈窗共用同一份，
    // 兩處漂移會讓「解析出的欄位」與「落進正文的原文」對不上，而 promptHash 吃的是原文）。
    for (const image of inserted) {
      output += `${insertedEol}${serializeImageTag(image)}`;
    }
    output += line.eol;
  }
  return output;
}
