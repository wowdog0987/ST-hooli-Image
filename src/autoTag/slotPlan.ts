import type { TargetSegment } from '@/autoTag/clean';
import { formatPromptText, parseImageTagContent, parseImageTags, stripImageTags } from '@/st/imageTagRegex';

/** 單條已佔用畫面摘要的截斷長度:清單只是給模型「別撞車」用的,不是讓它照抄的提示詞。 */
const MAX_SUMMARY = 160;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 某一槽位的展示口徑摘要(壓成單行);越界或無內容時返回空串。 */
function summarize(tags: string[], index: number, maxSummary: number): string {
  const raw = tags[index];
  if (raw === undefined) return '';
  const summary = formatPromptText(parseImageTagContent(raw)).replace(/\s*\n+\s*/g, ' / ').trim();
  return summary ? truncate(summary, maxSummary) : '';
}

/**
 * 單槽重寫(autoTag/runner.ts 的 requestSlotTag)的任務備註。
 *
 * 語義是**重寫提示詞**,不是換畫面:這一張畫的還是原來那個瞬間,只是提示詞重寫一遍
 * (寫得更準、更細、修掉與正文不符的地方)。寫回側本就釘死原位——runner 的 slot 分支
 * 直接 replaceImageTagAt(seq),模型返回的 position 壓根不參與寫回——所以這裡的措辭
 * 是**唯一**決定它換不換畫面的東西。舊版寫的是「另選一個與它們明顯不同的瞬間」,
 * 於是按鈕寫著「重寫提示詞」、模型收到的卻是「換一個畫面」,兩頭對不上。
 *
 * 為此要把該槽位**當前的提示詞原樣喂回去**當錨點:不給它,模型只能從整樓正文裡猜
 * 「這一張畫的是哪個瞬間」,猜偏了就又變成換畫面。其餘槽位仍然報上去,但用途變了——
 * 不是「別選中它們」,而是「別把本該屬於它們的畫面搶過來」。
 *
 * 槽位順序只取一份資料:parseImageTags(與正文、卡片、水合同一口徑)。
 * 摘要用展示口徑 formatPromptText 壓成單行並截斷:給模型的是「已有什麼」的索引,
 * 不是要它逐字對照的原文。目標槽位是唯一的例外,它要的就是逐字對照。
 *
 * 純函式、無宿主依賴:runner 在發請求前拼好傳進 buildAutoTagMessages 的 taskNote。
 */
export function buildSlotTaskNote(rawSource: string, seq: number, maxSummary = MAX_SUMMARY): string {
  const tags = parseImageTags(rawSource ?? '');
  const occupied: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    if (index === seq) continue;
    const summary = summarize(tags, index, maxSummary);
    occupied.push(`- 第 ${index + 1} 張：${summary || '（無提示詞）'}`);
  }

  // 目標槽位的當前提示詞:錨點,不截斷——要模型照著同一個畫面重寫,就得給它全文。
  const current = tags[seq] === undefined
    ? ''
    : formatPromptText(parseImageTagContent(tags[seq])).trim();

  const lines = [
    `【本次只重寫第 ${seq + 1} 張的提示詞】`,
    '這一張畫的仍然是它原本的那個瞬間：**不要另選畫面、不要換構圖主體、不要挪到正文別處**。',
    '你的任務是把這同一個畫面的提示詞重寫一遍——依據正文把它寫得更準確、更具體，補上漏掉的關鍵資訊，修掉與正文不符或含糊的部分。',
    'images 陣列必須恰好返回 1 項。',
  ];
  if (current) {
    lines.push('', '這一張當前的提示詞（要重寫的就是它，畫面以它為準）：', current);
  }
  if (occupied.length) {
    lines.push('', '本樓其餘畫面（它們各自的提示詞已經確定，不要把它們的畫面搶過來，也不要改動它們）：', ...occupied);
  }
  return lines.join('\n');
}

/**
 * 正文裡每條既有 tag 落在哪個目標段落(P 編號);找不到對應段落時為空串。
 *
 * tag 由 injectImageTags 插在敘事行之後、獨佔一行,stripImageTags 會連同它前面的換行一起刪掉,
 * 所以「tag 之前的原文」剝掉 tag 後數換行,就是它所跟隨的那一行在剝離後正文裡的行號。
 */
export function existingImagePositions(rawSource: string, segments: TargetSegment[]): string[] {
  const source = rawSource ?? '';
  const out: string[] = [];
  for (const match of source.matchAll(/<hooli_image>[\s\S]+?<\/hooli_image>/gi)) {
    const before = stripImageTags(source.slice(0, match.index ?? 0));
    const newlines = before.match(/\r\n|\n|\r/g)?.length ?? 0;
    const line = /(?:\r\n|\n|\r)$/.test(before) ? newlines - 1 : newlines;
    let position = '';
    for (const segment of segments) {
      if (segment.sourceLine > line) break;
      position = segment.id;
    }
    out.push(position);
  }
  return out;
}

/**
 * 樓層按鈕「追加一張」(autoTag/runner.ts 的 append 模式)的任務備註:本樓已有的畫面原樣保留,
 * 模型另選一個不同的瞬間,只返回這一張新圖。
 */
export function buildAppendTaskNote(
  rawSource: string,
  segments: TargetSegment[],
  maxSummary = MAX_SUMMARY,
): string {
  const tags = parseImageTags(rawSource ?? '');
  const positions = existingImagePositions(rawSource, segments);
  const existing = tags.map((_, index) => {
    const at = positions[index] ? ` ⟦${positions[index]}⟧` : '';
    return `- 第 ${index + 1} 張${at}：${summarize(tags, index, maxSummary) || '（無提示詞）'}`;
  });
  if (!tags.length) {
    return [
      '【本次為本樓選出第 1 張畫面】',
      '請選出全文最值得畫的那一個瞬間。images 恰好返回 1 項。',
    ].join('\n');
  }
  return [
    `【本次在本樓追加第 ${tags.length + 1} 張畫面】`,
    '本樓已經畫過下列畫面,它們保持原樣:',
    ...existing,
    '',
    '請在其餘的瞬間裡選出最值得畫的那一個(與上面每一張都是不同的時刻或不同的動作),只畫這一個瞬間。images 恰好返回 1 項。',
  ].join('\n');
}

/** 寫回前後的 tag 清單比對出新增的那幾條的 seq(按多重集合扣除,同內容的舊 tag 不會被誤認)。 */
export function addedTagSeqs(before: string[], after: string[]): number[] {
  const remaining = new Map<string, number>();
  for (const tag of before) remaining.set(tag, (remaining.get(tag) ?? 0) + 1);
  const added: number[] = [];
  after.forEach((tag, seq) => {
    const left = remaining.get(tag) ?? 0;
    if (left > 0) remaining.set(tag, left - 1);
    else added.push(seq);
  });
  return added;
}
