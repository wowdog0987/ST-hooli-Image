import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { normalizeOrientation, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';

/**
 * 虎哩繪生圖 tag 的兩條託管正則（DESIGN-FLOOR-UI.md §4）：
 *
 * - hooli-image-tag-slot（markdownOnly）：顯示路徑把 <hooli_image>…</hooli_image> 整體
 *   替換為空錨點 <div data-hooli-slot=""></div>，提示詞永不進 DOM。
 * - hooli-image-tag-hide（promptOnly）：提示詞路徑把同一 tag 替換為空字串。
 *
 * 兩條規則 find 相同、生效路徑互斥（引擎條件 markdownOnly&&isMarkdown 與
 * promptOnly&&isPrompt 不會同時命中），可安全共存。
 */

export const IMAGE_TAG_FIND_REGEX_LITERAL = '/<hooli_image>[\\s\\S]+?<\\/hooli_image>/gi';

/** 與託管指令碼同源的執行時正則：解析 message.mes 原文裡的 tag（水合配對用）。 */
export const IMAGE_TAG_FIND_REGEX = /<hooli_image>[\s\S]+?<\/hooli_image>/gi;

/** 顯示側錨點 DOM 選擇器（錨點只用 data 屬性，class 會被 DOMPurify 加 custom- 字首）。 */
export const BBI_SLOT_SELECTOR = 'div[data-hooli-slot]';

export const IMAGE_TAG_SLOT_REGEX_ID = 'hooli-image-tag-slot';
export const IMAGE_TAG_HIDE_REGEX_ID = 'hooli-image-tag-hide';

// regex_placement：0=MD_DISPLAY(已棄用) / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND。
// 顯示路徑的 placement 隨訊息型別變化（script.js getRegexPlacement）：
// 使用者訊息→1,AI 樓層→2,而 **extra.type === 'narrator' 的樓層→3**；
// 提示詞路徑(script.js Generate)只按 is_user 二選一,只會是 1 或 2。
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;
/**
 * 旁白樓(/narrator、/sys 等 extra.type='narrator')的顯示 placement。
 *
 * 必須帶上它:`/narrator` 造出的樓是 `is_system:false` + `extra.type:'narrator'`,
 * 於是 st/context.ts 的 isAiStoryMessage **認它是劇情樓**——自動 tag 會往裡寫 tag。
 * 而顯示側 getRegexPlacement 給這種樓派的是 3,只寫 [1,2] 的話錨點正則整條不命中:
 * tag 原文不被替換,DOMPurify 剝掉不認識的 `<hooli_image>` 殼、把裡面的提示詞當正文留下,
 * 使用者直接看到一串 danbooru tag,且沒有錨點 = 沒有卡片。
 * 「tag 永不進 DOM」這條不變式在這一類樓上是破的。
 *
 * 提示詞側那條(hide)同樣帶上:它是 promptOnly,只在 isPrompt 時生效,而 ST 自己
 * 從不用 (SLASH_COMMAND, isPrompt) 這個組合,故對現有路徑是無操作;帶上它是為了
 * 「tag 永不進提示詞」在第三方也調 getRegexedString 時依然成立——replaceString 是空串,
 * 多覆蓋一個 placement 不會有副作用。兩條規則 placement 保持一致也更好推理。
 */
const PLACEMENT_SLASH_COMMAND = 3;

const DISPLAY_AND_PROMPT_PLACEMENTS = [
  PLACEMENT_USER_INPUT,
  PLACEMENT_AI_OUTPUT,
  PLACEMENT_SLASH_COMMAND,
];

export interface ManagedRegexScript extends Record<string, unknown> {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
}

/** 顯示側：生圖 tag → 空錨點（水合時 Vue 卡片渲染進錨點）。 */
export function imageTagSlotScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_SLOT_REGEX_ID,
    scriptName: '虎哩繪 · 生圖標籤佔位',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: '<div data-hooli-slot=""></div>',
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** 提示詞側：生圖 tag → 空串（提示詞路徑徹底移除，永不外洩）。 */
export function imageTagHideScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_HIDE_REGEX_ID,
    scriptName: '虎哩繪 · 隱藏生圖標籤',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: '',
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** 從訊息原文按出現順序解析全部生圖 tag；無 tag 返回空陣列。 */
export function parseImageTags(mes: string): string[] {
  return mes.match(IMAGE_TAG_FIND_REGEX) ?? [];
}

/**
 * 正文裡是否有生圖 tag 的痕跡——**含只剩半截的孤立開/閉標籤**。
 *
 * **只有這一份**:樓層按鈕判斷「要不要先彈重新生成確認」與 runner 判斷「要不要跳過
 * 已有 tag 的樓」共用它。兩側各寫一條正則的後果:按鈕那份只認開標籤,正文裡只剩一個
 * `</hooli_image>` 時按鈕以為沒 tag(不彈確認、傳 replace=false),runner 那份認開也認閉、
 * 於是以為有 tag 而靜默放棄——使用者看到的就是「按鈕點了永遠沒反應」。
 */
export function hasImageTagTrace(mes: string): boolean {
  return /<\/?hooli_image\b/i.test(mes ?? '');
}

/**
 * 剔除訊息裡的全部生圖 tag（重新生成前用）。
 * 外掛注入的 tag 獨佔一行（注入形態：行文本 + 換行 + tag），連同前行換行一起刪，
 * 恰好還原注入前原文；手寫內聯 tag 前面沒有換行，僅刪 tag 本身。
 *
 * 為什麼不能直接 `.replace(查詢正則, '')`:那條正則是非貪婪的,正文裡多出一個半截的
 * `<hooli_image>`(AI 照著上下文模仿只寫了一半、或 tag 被別的外掛截斷)時,它會從這個
 * 殘骸一路吃到下一個 `</hooli_image>`,把中間的正文連同後面那條真 tag 一起刪掉。
 * 故改為逐 token 掃:閉標籤與**最近一個未配對的開標籤**成對(整段刪),掃完仍落單的
 * 開/閉標籤只刪自己。殘骸必須清乾淨——留著它,ST 顯示側那條同樣非貪婪的錨點正則
 * 會把正文吞進錨點(破圖)。
 */
export function stripImageTags(mes: string): string {
  const source = String(mes ?? '');
  // 就地新建:模組級帶 /g 的正則例項 lastIndex 有狀態,exec 迴圈不能共用(同 replaceImageTagAt)
  const tokens = /<\/?hooli_image\b[^>]*>/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  const openStack: Array<{ start: number; end: number }> = [];
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0][1] === '/') {
      const open = openStack.pop();
      ranges.push({ start: open ? open.start : start, end });
    } else {
      openStack.push({ start, end });
    }
  }
  for (const open of openStack) ranges.push(open);
  if (!ranges.length) return source;

  ranges.sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    // `O O C C` 這種巢狀下外層區間已經把內層吃掉了,跳過
    if (range.start < cursor) continue;
    out += source.slice(cursor, range.start).replace(/(?:\r\n|\n|\r)$/, '');
    cursor = range.end;
  }
  return out + source.slice(cursor);
}

/**
 * tag / nl / negative 內容裡不允許出現的子標籤字面量（會汙染 hooli_image 內部解析）。
 *
 * 唯一口徑：AI 側(autoTag/protocol.ts 的 sanitizeContent)與手輸側(提示詞編輯彈窗)
 * 共用這一份。**絕不再抄第二份** —— 查詢正則 `<hooli_image>…</hooli_image>` 是非貪婪的，
 * 內容裡混進一個 `</hooli_image>` 就會讓 tag 提前截斷、後半截漏進 DOM 與提示詞，
 * 正好破掉「tag 永不進 DOM、永不進提示詞」這條不變式。
 */
export const FORBIDDEN_SUBTAG = /<\/?(?:hooli_image|tag|nl|negative|characters|size)\b/i;

/** 文本裡是否含 hooli_image 子標籤字面量（手輸校驗用；口徑同 AI 側）。 */
export function containsTagMarkup(text: string): boolean {
  return FORBIDDEN_SUBTAG.test(text);
}

export interface ImageTagContent {
  /** danbooru 短 tag 部分：顯式 <tag> 子標籤內容，或剔除子標籤後的裸文本（存量格式）。 */
  tag: string;
  /** 自然語言部分：<nl> 子標籤內容，無則空串。 */
  nl: string;
  /** 本畫面動態負面 tag：<negative> 子標籤內容，無則空串。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 畫幅方向：<size> 子標籤內容，無/不可識別則豎屏（存量 tag 即走這條，行為與改動前一致）。 */
  size: Orientation;
}

/**
 * 解析 tag 原文（含 <hooli_image> 殼）的內部內容。一條容忍式規則覆蓋三種形態：
 * - <hooli_image>xxxx</hooli_image>                    裸文本 = tag（存量相容）
 * - <hooli_image>xxxx<nl>yyyy</nl></hooli_image>       裸文本 = tag，<nl> = nl
 * - <hooli_image><tag>x</tag><negative>y</negative></hooli_image> 顯式子標籤（手寫容忍）
 * 裸文本與顯式 <tag> 同時存在時按「裸文本在前」以 ", " 合併進 tag 部分，不丟內容。
 * <size>/<nl>/<negative> 必須先剝掉，不能漏進正向提示詞。
 */
export function parseImageTagContent(raw: string): ImageTagContent {
  // 內容統一折疊成單行:手寫 tag 可能跨行,而提示詞裡換行沒有意義
  const oneLine = (text: string) => text.trim().replace(/[\r\n]+/g, ' ');
  const inner = raw.replace(/^<hooli_image[^>]*>/i, '').replace(/<\/hooli_image>$/i, '');
  const nlMatch = inner.match(/<nl>([\s\S]*?)<\/nl>/i);
  const nl = nlMatch ? oneLine(nlMatch[1]) : '';
  const negativeMatch = inner.match(/<negative>([\s\S]*?)<\/negative>/i);
  const negative = negativeMatch ? oneLine(negativeMatch[1]) : '';
  const charactersMatch = inner.match(/<characters>([\s\S]*?)<\/characters>/i);
  let characters: ImageCharacterPrompt[] = [];
  if (charactersMatch) {
    try {
      const parsed = JSON.parse(charactersMatch[1]);
      if (Array.isArray(parsed)) {
        characters = parsed.slice(0, 32).flatMap(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const rawItem = item as Record<string, unknown>;
          const name = oneLine(typeof rawItem.name === 'string' ? rawItem.name : '');
          const tag = oneLine(typeof rawItem.tag === 'string' ? rawItem.tag : '');
          const nl = oneLine(typeof rawItem.nl === 'string' ? rawItem.nl : '');
          return name && tag ? [{ name, tag, nl }] : [];
        });
      }
    } catch {
      // Invalid character JSON must not break the otherwise valid Base prompt.
    }
  }
  const sizeMatch = inner.match(/<size>([\s\S]*?)<\/size>/i);
  const size = normalizeOrientation(sizeMatch ? oneLine(sizeMatch[1]) : '');
  const withoutSubTags = inner
    .replace(/<nl>[\s\S]*?<\/nl>/gi, '')
    .replace(/<negative>[\s\S]*?<\/negative>/gi, '')
    .replace(/<characters>[\s\S]*?<\/characters>/gi, '')
    .replace(/<size>[\s\S]*?<\/size>/gi, '');
  const explicit = [...withoutSubTags.matchAll(/<tag>([\s\S]*?)<\/tag>/gi)]
    .map(match => oneLine(match[1]))
    .filter(Boolean);
  const bare = oneLine(withoutSubTags.replace(/<tag>[\s\S]*?<\/tag>/gi, ''));
  const tag = [...(bare ? [bare] : []), ...explicit].join(', ');
  return { tag, nl, negative, characters, size };
}

/**
 * 序列化成 tag 原文（含 <hooli_image> 殼）—— parseImageTagContent 的反向操作。
 *
 * **格式的讀與寫只有這一份**：注入(autoTag/protocol.ts 的 injectImageTags)與手動編輯
 * (floor/promptEditor.ts)共用，兩處漂移會讓「解析得到的欄位」與「落進正文的原文」對不上，
 * 而 promptHash 吃的正是原文 —— 漂移直接表現為「什麼都沒改卻全變 stale」。
 *
 * 標準形態：tag 部分保持裸文本（與存量格式一致），nl/negative/characters 空則整段不寫。
 * size **恆寫出**：生成是延後的(點卡片才出圖)，方向必須隨 tag 持久化在正文裡。
 */
export function serializeImageTag(content: ImageTagContent): string {
  const nl = content.nl ? `<nl>${content.nl}</nl>` : '';
  const negative = content.negative ? `<negative>${content.negative}</negative>` : '';
  const characters = content.characters.length
    ? `<characters>${JSON.stringify(content.characters)}</characters>`
    : '';
  return `<hooli_image>${content.tag}${nl}${negative}${characters}<size>${content.size}</size></hooli_image>`;
}

/**
 * 提示詞全文的**唯一展示口徑**：樓層卡片（複製 / 燈箱 / 展開區）與相簿共用。
 *
 * 與 serializeImageTag 的分工:那個產出機器讀的正文原文（會被 promptHash 吃），
 * 這個產出人讀的純文本（段間空行、角色分段）。兩者都不許各自照抄第二份——
 * 相簿要顯示的必須與卡片上一字不差，否則同一張圖在兩處看到兩種樣子。
 *
 * size 刻意不出現:它是畫幅方向，不是提示詞內容，卡片上也從來不顯示。
 */
export function formatPromptText(
  content: Pick<ImageTagContent, 'tag' | 'nl' | 'negative' | 'characters'>,
): string {
  return [
    content.tag,
    content.nl,
    ...content.characters.map(character =>
      [`角色: ${character.name}`, character.tag, character.nl].filter(Boolean).join('\n'),
    ),
    content.negative ? `Negative: ${content.negative}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 原位替換正文裡第 seq 條 tag（0-based），其餘正文與其它 tag 一字不動。
 * seq 越界返回 null（呼叫方據此放棄寫回）。
 *
 * 為什麼不用模組級的 IMAGE_TAG_FIND_REGEX：那是個帶 /g 的共享例項，lastIndex 有狀態。
 * 現有呼叫方走的都是 .match()/.replace()（會重置 lastIndex）故相安無事，
 * 這裡用 replace 回撥按序計數，仍就地新建正則，不給後來者留下踩踏的餘地。
 */
export function replaceImageTagAt(mes: string, seq: number, nextTag: string): string | null {
  if (!Number.isInteger(seq) || seq < 0) return null;
  let index = 0;
  let replaced = false;
  const output = mes.replace(/<hooli_image>[\s\S]+?<\/hooli_image>/gi, match => {
    if (index++ !== seq) return match;
    replaced = true;
    return nextTag;
  });
  return replaced ? output : null;
}

const MANAGED_SCRIPTS: Array<() => ManagedRegexScript> = [
  imageTagSlotScript,
  imageTagHideScript,
];

/**
 * 向 ST 全域性正則列表註冊虎哩繪託管規則。
 * 固定 id 保證冪等：舊版本或使用者改動過的同 id 規則會被更新，其它正則原樣保留，
 * 不重複新增。舊版單條 hooli-image-tag-hide（markdownOnly+promptOnly 雙開）會被
 * 新 hide 定義原位覆蓋，並新增 slot 規則，存量使用者無縫遷移。
 */
export function ensureImageTagRegexRegistered(): boolean {
  const context = getContext();
  const extensionSettings = context?.extensionSettings;
  if (!extensionSettings) return false;
  if (!Array.isArray(extensionSettings.regex)) extensionSettings.regex = [];

  const list = extensionSettings.regex as Array<Record<string, unknown>>;
  for (const make of MANAGED_SCRIPTS) {
    const script = make();
    const index = list.findIndex(item => item?.id === script.id);
    if (index >= 0) list[index] = { ...list[index], ...script };
    else list.push(script);
  }
  context.saveSettingsDebounced?.();
  return true;
}
