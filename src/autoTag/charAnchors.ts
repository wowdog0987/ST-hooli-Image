import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  CHAR_TAG_FIELD_LABELS,
  CHAR_TAG_FIELDS,
  applyCharTagOps,
  type CharTagAutoOp,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import { getTagGenChannel } from '@/state/settings';

/**
 * 角色固定外貌庫的「錨定」側。
 *
 * 生成 tag 前把庫文本(全部條目)拼進請求:AI 看得到每個角色當前的欄位值,才能判斷
 * 需不需要改;畫面 tag 裡它照抄庫中欄位值,不使用佔位符。
 *
 * 為什麼不用 @角色名 佔位符(v0.1.2 起撤回):原設計讓 AI 只寫 @小雪、由外掛替換成
 * 完整欄位串,本意是杜絕複述漂移。實測有三個結構性問題:
 * - 同一角色被引用多次時逐次展開,一張圖裡出現三份完整外貌 + 三個 1boy,
 *   模型據此畫出多個重疊軀幹(正向權重乘三,負面詞壓不住)。
 * - 規範裡「40 個 tag 以內」的預算無法執行:AI 數 @小雪 是 1 個,實際展開成 6 個。
 * - 庫髒資料被無條件放大:動作/場景詞誤入 outfit 欄位時,每次展開都帶上它。
 * 庫文本本就在同一上下文裡、欄位值明明白白列著,照抄可見文本比憑記憶複述可靠,
 * 原設計高估了漂移風險。故改回「庫只作參考,AI 自己寫全」。
 *
 * applyCharRefs 系函式保留:模型偶發寫出 @名字 時仍會被替換掉,不至於把字面量
 * 送進生圖。即從主路徑降級為兜底。
 *
 * 建檔由主請求在同一次輸出裡完成(changes 的 field="new"):Horae的中文外貌本來就
 * 隨角色參考塊發給了主請求,它還額外有世界書、角色卡與目標正文佐證,比獨立的轉換
 * 請求判斷得更準。建檔與用檔同屬一次推理,後續 tag 才能圍繞剛確立的外貌協調。
 *
 * 主流程順序:先落 changes(本樓發生的變化當樓生效) → 再兜底替換殘留的 @佔位符。
 */

/** 把庫條目渲染成給 AI 看的一行(欄位式明細 + 佔位符提示);鎖定條目帶 [locked] 標記。 */
export function formatEntryForPrompt(entry: CharTagEntry, locked = false): string {
  const parts: string[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const v = entry.fields[f]?.trim();
    if (v) parts.push(`${CHAR_TAG_FIELD_LABELS[f]}=${v}`);
  }
  if (!parts.length && entry.raw.trim()) parts.push(`tag=${entry.raw.trim()}`);
  if (entry.nl.trim()) parts.push(`nl=${entry.nl.trim()}`);
  return `- ${entry.name}${locked ? ' [locked]' : ''}: ${parts.join(', ') || '(未記錄欄位)'}`;
}

/**
 * 庫文本:發給 AI 的角色庫部分。AI 依據它決定 changes,並在 tag/nl 中照抄對應欄位;
 * 名單與欄位值都由外掛生成,AI 只讀。鎖定名(全域性庫)帶 [locked] 標記並在頭部宣告不可變。
 */
export function buildLibraryText(
  entries: CharTagEntry[],
  lockedNames?: ReadonlySet<string>,
  presentNames?: ReadonlySet<string>,
): string {
  if (!entries.length) return '';
  // 給了在場名單時:只有在場角色帶完整欄位,其餘只報名字(讓模型知道已建檔、別重建)
  const shown = presentNames ? entries.filter(entry => presentNames.has(entry.name)) : entries;
  const absent = presentNames ? entries.filter(entry => !presentNames.has(entry.name)) : [];
  const lines = shown.map(entry => formatEntryForPrompt(entry, lockedNames?.has(entry.name) ?? false));
  if (absent.length) {
    lines.push(`- 已建檔(本次未判定在場;若入畫照常使用這個名字,不要重新建檔):${absent.map(entry => entry.name).join('、')}`);
  }
  const lockedNote = lockedNames?.size
    ? '; entries marked [locked] are global and immutable: never report changes for them, always copy their fields as-is'
    : '';
  return `【角色固定外貌庫】[system-maintained; copy fields verbatim into character prompts${lockedNote}]\n${lines.join('\n')}`;
}

/** 舊介面相容:runner 之外仍有呼叫方依賴錨定文本形態。 */
export function buildAnchorText(entries: CharTagEntry[], lockedNames?: ReadonlySet<string>): string {
  return buildLibraryText(entries, lockedNames);
}

/* ============ 中文外貌 → 結構化欄位 的批次轉換 ============ */

const CONVERT_SPEC = `你是外貌 tag 轉換器。把給出的角色中文外貌描述拆成固定欄位的 danbooru 短 tag:英文小寫、逗號分隔、多詞用空格連線(不要用下劃線)。

欄位與示例:
- sex(性別):1girl / 1boy / androgynous 等
- hair(頭髮):long black hair / short silver hair 等
- eyes(眼睛):red eyes / blue eyes 等
- skin(膚色):tan / dark skin 等(沒提就留空;白皙是預設膚色,不需要記錄)
- body(體型):petite / tall / slim / small breasts 等
- extra(標誌特徵):heterochromia / scar on cheek / pointy ears 等(沒提就留空)

規則:
1. 只收畫得出來、而且永久不變的外貌:髮、眼、膚色、體型、天生或永久的標誌(疤、痣、尖耳、刺青)。
   這些不屬於固定外貌,留給每張圖按當下劇情寫:服裝、飾品、表情、情緒、動作、場景,以及暫時狀態(疲倦、黑眼圈、受傷、臉紅、流汗、淚痕)。
   這些畫不出來,直接略過:身高體重等數字、年齡數字、性格與氣質(charismatic、idol aesthetic、cool 之類)。
   同一特徵只寫一個最貼切的 tag(例如 narrow eyes 與 sharp eyes 擇一)。
2. hair 與 eyes 是二次元角色身份錨點：描述裡只要出現髮色、髮型/長度或瞳色線索就必須寫入對應欄位，不得遺漏或塞進 extra；hair 儘量同時保留顏色和長度/髮型，eyes 保留顏色。
3. 描述裡沒提的細節不要腦補,對應欄位留空字串。
4. 只返回一個 JSON 物件:{"角色名":{"sex":"...","hair":"...","eyes":"...","skin":"...","body":"...","extra":"..."}},鍵與輸入的角色名完全一致;不要 Markdown 程式碼塊、不要解釋。`;

/** 欄位值清洗:換行壓成空格、剝 hooli_image 系子標籤字面量(防止汙染注入格式)。 */
function sanitizeTagValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:hooli_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

/** 從模型回覆中解析 {角色名: {欄位: tag}}(寬容:帶程式碼塊/前後雜質也能解)。 */
export function parseConvertedTags(raw: string): Record<string, Partial<Record<CharTagField, string>>> {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const candidates: string[] = [cleaned.trim()];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const out: Record<string, Partial<Record<CharTagField, string>>> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          const name = key.trim();
          if (!name || !v || typeof v !== 'object' || Array.isArray(v)) continue;
          const fields: Partial<Record<CharTagField, string>> = {};
          for (const f of CHAR_TAG_FIELDS) {
            const tag = sanitizeTagValue((v as Record<string, unknown>)[f]);
            if (tag) fields[f] = tag;
          }
          if (Object.keys(fields).length) out[name] = fields;
        }
        return out;
      }
    } catch {
      // 試下一個候選
    }
  }
  return {};
}

export interface ConvertedChar {
  name: string;
  desc: string;
  fields: Partial<Record<CharTagField, string>>;
}

/**
 * 批次把中文外貌轉成結構化欄位。一次請求轉換所有待辦角色。
 * 渠道與自動 tag 主流程同口徑:指派渠道優先,未指派跟隨主 API。
 * 返回成功轉換的條目;整體失敗(請求異常)向上拋,呼叫方 catch 後降級。
 *
 * 只服務角色管理頁的「按Horae最新外貌生成」按鈕 —— 那是使用者主動點的一次性動作。
 * 自動 tag 主流程不再調它:建檔由主請求在同一次輸出裡完成(見檔案頭)。
 */
export async function generateCharTags(
  chars: Array<{ name: string; desc: string }>,
  signal?: AbortSignal,
): Promise<ConvertedChar[]> {
  if (!chars.length) return [];
  const messages: ChatMsg[] = [
    { role: 'system', content: CONVERT_SPEC },
    {
      role: 'user',
      content: chars.map(c => `- ${c.name}: ${c.desc}`).join('\n'),
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: '角色外貌轉換' })
    : await requestViaMainApi(messages, { signal, source: '角色外貌轉換' });
  const parsed = parseConvertedTags(raw);
  const out: ConvertedChar[] = [];
  for (const c of chars) {
    const fields = parsed[c.name];
    if (fields) out.push({ name: c.name, desc: c.desc, fields });
  }
  return out;
}

/* ============ 主流程入口 ============ */

/**
 * 生成前的庫準備:把當前庫渲染成請求裡的庫文本。
 *
 * 純函式、無請求 —— 建檔已交給主請求(見檔案頭)。保留這層是因為呼叫方還需要
 * 「庫文本 + 庫條目」這對組合,且 @佔位符替換要以同一份 entries 為基線。
 * 空庫返回 text=null,呼叫方據此不啟用 @佔位符。
 */
export interface ResolvedCharAnchors {
  text: string | null;
  entries: CharTagEntry[];
}

export function resolveCharAnchors(
  entriesBefore: CharTagEntry[],
  lockedNames?: ReadonlySet<string>,
  presentNames?: ReadonlySet<string>,
): ResolvedCharAnchors {
  const text = buildLibraryText(entriesBefore, lockedNames, presentNames);
  return { text: text || null, entries: entriesBefore };
}

/* ============ @佔位符 替換 ============ */

/** @名 佔位符;名字允許中文/字母/數字/點/下劃線/間隔號(常見角色名形態)。 */
const REF_PATTERN = /@([\p{L}\p{N}_.·]+)/gu;

function joinEntryTag(entry: CharTagEntry): string {
  // 與 state/charTags.buildEntryTag 同構;重複這一小段以避開迴圈依賴
  if (entry.raw.trim() && CHAR_TAG_FIELDS.every(f => !(entry.fields[f] ?? '').trim())) {
    return entry.raw.trim();
  }
  return CHAR_TAG_FIELDS.map(f => (entry.fields[f] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** 壓縮替換後殘留的分隔符垃圾:連續逗號、行首行尾逗號。 */
function tidySeparators(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/,\s+/g, ', ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim();
}

/**
 * AI 輸出文本裡的 @佔位符 處理:庫裡有的 → 替換成最新 tag 串(nl 模式優先條目的自然語言句);
 * 沒有的 → 剝掉(連帶尾隨分隔符)。返回處理後的文本與未知名字列表(呼叫方可用於告警)。
 */
export function applyCharRefs(
  text: string,
  entries: CharTagEntry[],
  mode: 'tag' | 'nl' = 'tag',
): { text: string; unknown: string[] } {
  const byName = new Map(entries.map(e => [e.name, e]));
  const unknown: string[] = [];
  const seen = new Set<string>();
  const replaced = text.replace(REF_PATTERN, (_full, name: string) => {
    const entry = byName.get(name);
    if (entry) {
      if (mode === 'nl' && entry.nl.trim()) return entry.nl.trim();
      return joinEntryTag(entry);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unknown.push(name);
    }
    return '';
  });
  return { text: tidySeparators(replaced), unknown };
}

export interface PositionedCharOp {
  op: CharTagAutoOp;
  sourceLine: number;
}

/**
 * 按圖片位置解析 @佔位符。
 *
 * 建檔(new)全樓生效:新角色的固定外貌是本樓**全程成立的事實**,不是「從某處開始」的
 * 變化——同一樓裡位置更靠前的圖片也可能有這個角色在場。若按位置門控,那些圖片的
 * @佔位符會查不到條目而被整個剝掉,角色變成沒有外貌。
 * 永久變化(set)才按位置門控:染髮之前的圖片必須用舊檔案。
 */
export function applyPositionedCharRefs(
  text: string,
  entries: CharTagEntry[],
  ops: PositionedCharOp[],
  sourceLine: number,
  mode: 'tag' | 'nl' = 'tag',
  locked?: ReadonlySet<string>,
): { text: string; unknown: string[] } {
  const activeOps = ops
    .filter(item => item.op.kind === 'new' || item.sourceLine <= sourceLine)
    .map(item => item.op);
  return applyCharRefs(text, applyCharTagOps(entries, activeOps, -1, locked), mode);
}
