/**
 * 正文清洗工具。
 *
 * 白名單優先:訊息裡有 <content>…</content> 時只取它裡面的文字,外面的 Horae / MVU /
 * 選項按鈕 / 狀態列等外掛標籤一律不看。沒有 <content> 的訊息(別的角色卡格式)才退回
 * 下面的黑名單清洗。自定義清洗名單來自共享儲存(settings.excludes.customStripTags),
 * 輸入時已由 sanitizeTagName 消毒,這裡只負責按標籤名生成「整塊刪除」正則並執行。
 */

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;
const RE_CONTENT_SHELL = /<\/?content\b[^>]*>/gi;
/** 自閉合的自訂標籤(如狀態列外掛的 <StatusPlaceHolderImpl/>):只是佔位符,不是正文。 */
const RE_SELF_CLOSING_TAG = /<[A-Za-z][\w:-]*(?:\s[^<>]*)?\/>/g;

/**
 * 按標籤名生成「整塊刪除」正則(含標籤本身與內部內容)。tag 已由 sanitizeTagName 剔除正則元字元,
 * 拼進 RegExp 安全。邊界用前瞻 (?=[\s/>]) 而非 \b —— \b 只認 ASCII 詞字元,中文標籤(如 <雪>)
 * 在 `雪` 與 `>` 之間無詞邊界會匹配失敗;前瞻「標籤名後須緊跟空白/斜槓/右括號」對中英文都成立,
 * 且同樣防止 <snow> 誤吃 <snowball> 字首。同時刪配對塊與落單的自閉/單標籤。
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // 配對塊
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // 落單的開/閉/自閉標籤
  ];
}

/** 刪掉使用者在設定裡配置的自定義標籤(整塊:標籤 + 內部內容)。空名單則原樣返回。 */
function replaceCustomTags(s: string, tags: string[], replacement: string): string {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, replacement);
  }
  return out;
}

export function stripCustomTags(s: string, tags: string[]): string {
  return replaceCustomTags(s, tags, '');
}

/**
 * <content> 的內文範圍(不含標籤殼);訊息裡沒有 <content> 時返回 null,呼叫方退回黑名單清洗。
 * 未閉合的 <content>(回覆被截斷)取到結尾。呼叫方要先遮掉思維鏈與註釋再傳進來,
 * 免得思維鏈裡「提到」<content> 被誤認成正文起點。
 */
function contentInnerRanges(text: string): RemovalRange[] | null {
  const ranges: RemovalRange[] = [];
  const open = /<content\b[^>]*>/gi;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const start = match.index + match[0].length;
    const close = /<\/content\s*>/i.exec(text.slice(start));
    const end = close ? start + close.index : text.length;
    ranges.push({ start, end });
    open.lastIndex = close ? end + close[0].length : text.length;
  }
  return ranges.length ? ranges : null;
}

/** [0, length) 減去 keep 之後剩下的區段(即要刪除的範圍)。 */
function outsideRanges(length: number, keep: RemovalRange[]): RemovalRange[] {
  const out: RemovalRange[] = [];
  let cursor = 0;
  for (const range of mergeRanges(keep)) {
    if (range.start > cursor) out.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < length) out.push({ start: cursor, end: length });
  return out;
}

function clampToStoryBody(mes: string, tags: string[]): string {
  // 上下文樓層只用來理解場景與持續中的狀態;舊的 hooli_image 一律移除——
  // 角色外貌以角色庫為準,舊提示詞裡的外貌可能過時,每張還要多花數百 token。
  const customTags = tags.concat(['hooli_image', 'UpdateVariable', 'Analysis', 'horae', 'horaeevent']);
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, '')
    .replace(/<!--[\s\S]+?-->/g, '');
  const inner = contentInnerRanges(s);
  if (inner) s = inner.map(range => s.slice(range.start, range.end)).join('\n');
  s = s
    .replace(RE_CONTENT_SHELL, '')
    .replace(RE_SELF_CLOSING_TAG, '')
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, '');
  s = replaceCustomTags(s, customTags, '');

  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 上下文樓層清洗:只留敘事正文,生圖 tag 與外掛標籤全部移除。 */
export function cleanHistoryText(mes: string, tags: string[]): string {
  return clampToStoryBody(mes, tags);
}

interface RemovalRange {
  start: number;
  end: number;
}

interface SourceLineRange {
  index: number;
  start: number;
  end: number;
}

export interface TargetSegment {
  /** 發給模型的短位置 ID。 */
  id: string;
  /** 對應原始正文的物理行號(0-based，僅外掛內部使用)。 */
  sourceLine: number;
  /** 刪除噪聲後的該行敘事文本。 */
  text: string;
}

export interface PreparedTargetText {
  /** 帶段尾位置 ID 的目標正文。 */
  promptText: string;
  /** 位置 ID 到原始物理行的穩定對映。 */
  segments: TargetSegment[];
}

function rangesForRegex(source: string, pattern: RegExp): RemovalRange[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  return [...source.matchAll(regex)]
    .filter(match => match.index !== undefined && match[0].length > 0)
    .map(match => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function mergeRanges(ranges: RemovalRange[]): RemovalRange[] {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RemovalRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function maskedSource(source: string, ranges: RemovalRange[]): string {
  if (!ranges.length) return source;
  const chars = source.split('');
  for (const range of mergeRanges(ranges)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function sourceLineRanges(source: string): SourceLineRange[] {
  const lines: SourceLineRange[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let index = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ index, start, end: match.index });
    start = match.index + match[0].length;
    index += 1;
  }
  lines.push({ index, start, end: source.length });
  return lines;
}

function retainedLineText(source: string, line: SourceLineRange, ranges: RemovalRange[]): string {
  const pieces: string[] = [];
  let cursor = line.start;
  for (const range of ranges) {
    if (range.end <= line.start) continue;
    if (range.start >= line.end) break;
    if (range.start > cursor) pieces.push(source.slice(cursor, Math.min(range.start, line.end)));
    cursor = Math.max(cursor, range.end);
    if (cursor >= line.end) break;
  }
  if (cursor < line.end) pieces.push(source.slice(cursor, line.end));
  return pieces.join(' ').replace(/[ \t]+/g, ' ').trim();
}

function targetRemovalRanges(source: string, tags: string[]): RemovalRange[] {
  const hidden = [
    ...rangesForRegex(source, RE_THINK_BLOCK),
    ...rangesForRegex(source, /<!--[\s\S]+?-->/g),
  ];
  const noise: RemovalRange[] = [
    ...hidden,
    ...rangesForRegex(source, /<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi),
  ];
  // 白名單:有 <content> 時,它外面的一切都不是正文
  const inner = contentInnerRanges(maskedSource(source, hidden));
  if (inner) noise.push(...outsideRanges(source.length, inner));
  // <content> 包的是正文本體:只刪標籤殼本身,內文保留
  noise.push(...rangesForRegex(source, RE_CONTENT_SHELL));
  noise.push(...rangesForRegex(source, RE_SELF_CLOSING_TAG));
  for (const tag of [...tags, 'UpdateVariable', 'Analysis', 'horae', 'horaeevent']) {
    if (!tag) continue;
    for (const regex of blockStripRegexes(tag)) noise.push(...rangesForRegex(source, regex));
  }
  return mergeRanges(noise);
}

/**
 * 目標正文刪除同款噪聲，並只給保留下來的非空物理行追加段尾位置 ID。
 * 每個 ID 直接儲存原始 sourceLine，不再要求模型複製原文，也不依賴清洗後文本反查。
 */
export function prepareTargetText(mes: string, tags: string[]): PreparedTargetText {
  const source = String(mes ?? '');
  const ranges = targetRemovalRanges(source, tags);
  const segments = sourceLineRanges(source)
    .map(line => ({ sourceLine: line.index, text: retainedLineText(source, line, ranges) }))
    .filter(segment => !!segment.text)
    .map((segment, index) => ({ id: `P${index + 1}`, ...segment }));
  return {
    promptText: segments.map(segment => `${segment.text} ⟦${segment.id}⟧`).join('\n\n'),
    segments,
  };
}

/** 不帶位置標記的目標清洗結果，供除錯/測試檢視。 */
export function cleanTargetText(mes: string, tags: string[]): string {
  return prepareTargetText(mes, tags).segments.map(segment => segment.text).join('\n\n');
}
