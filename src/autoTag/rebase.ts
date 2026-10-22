/**
 * 把模型給出的插入位置從「請求開始時的正文」平移到「寫回時的正文」。
 *
 * 為什麼需要:副 API 分析要幾秒到幾十秒,期間別的外掛常改正文(翻譯、潤色、追加狀態列、
 * 重寫八股句)。舊實現在寫回前整段比對正文,一處不同就放棄——哪怕改的是與畫面毫無關係
 * 的部分,tag 也一併不注入。現在改成以「清洗後的敘事行」為錨重新定位:改動無關部分則
 * 位置分毫不動,真被改寫的句子也照樣落回它在新正文裡的對應位置,不再丟 tag。
 *
 * 對齊口徑:兩份 segment 列表(prepareTargetText 的產物,天然只含清洗後活下來的敘事行)
 * 先按文本相等求最長公共子序列作骨架,骨架之間的空隙按序號比例配對——空隙裡舊 1 條新 1 條
 * 正好是「那句話被改寫了」,精確命中而非近似;整句消失的行回落到前一個已配對錨點。
 *
 * 落點只能是當前正文的 segment,不能是裸行號:這樣 tag 絕不會掉進別的外掛剛追加的
 * 狀態列塊內部——那些塊在清洗階段就已不構成 segment。
 */

import { prepareTargetText, type TargetSegment } from '@/autoTag/clean';
import type { ImageInsertion } from '@/autoTag/protocol';

/** 超過此規模不跑 O(n*m) DP。正常樓層的敘事行數遠小於此,超了只按比例對映。 */
const LCS_CELL_LIMIT = 250_000;

/**
 * 文本相等的最長公共子序列,返回遞增的 (舊序號, 新序號) 配對。
 * 規模超限時返回空骨架,交給呼叫方整體按比例對映(退化但不出錯)。
 */
function lcsPairs(oldTexts: string[], newTexts: string[]): Array<[number, number]> {
  const n = oldTexts.length;
  const m = newTexts.length;
  if (!n || !m || n * m > LCS_CELL_LIMIT) return [];

  // dp[i][j] = oldTexts[i..] 與 newTexts[j..] 的 LCS 長度(扁平化成一維,行寬 m+1)
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldTexts[i] === newTexts[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTexts[i] === newTexts[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * 舊 segment 序號 → 新 segment 序號的對映;配不上的位置留 -1。
 * 骨架(文本原樣存在的行)先釘住,再在骨架切出的空隙裡按序號比例配對。
 */
function alignSegments(oldTexts: string[], newTexts: string[]): number[] {
  const mapped = new Array<number>(oldTexts.length).fill(-1);
  const skeleton = lcsPairs(oldTexts, newTexts);

  let prevOld = -1;
  let prevNew = -1;
  const fillGap = (oldEnd: number, newEnd: number): void => {
    const oldLen = oldEnd - prevOld - 1;
    const newLen = newEnd - prevNew - 1;
    if (oldLen <= 0 || newLen <= 0) return;
    for (let k = 0; k < oldLen; k += 1) {
      mapped[prevOld + 1 + k] = prevNew + 1 + Math.floor((k * newLen) / oldLen);
    }
  };

  for (const [i, j] of skeleton) {
    fillGap(i, j);
    mapped[i] = j;
    prevOld = i;
    prevNew = j;
  }
  fillGap(oldTexts.length, newTexts.length);
  return mapped;
}

/** 從 index 起向前找最近的已配對位置,前面沒有再往後找。全都沒有返回 -1。 */
function nearestMapped(mapped: number[], index: number): number {
  for (let i = index; i >= 0; i -= 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  for (let i = index + 1; i < mapped.length; i += 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  return -1;
}

export interface RebaseReport {
  /** 錨點句原樣存在:位置等價於沒動。 */
  anchored: number;
  /** 錨點句被改寫:按對齊結果落到它在新正文裡的對應句。 */
  remapped: number;
  /** 錨點句整句消失:順延到前一個錨點(寧可位置偏一點,也不丟 tag)。 */
  drifted: number;
}

export interface RebaseResult {
  images: ImageInsertion[];
  report: RebaseReport;
}

/**
 * 按當前正文重算每張圖的插入行。
 *
 * plannedSegments 是模型當時看到的那份 segment 列表(runner 裡 preparedTarget.segments),
 * currentText 是即將寫回的正文基底。返回的 images 已按新行號升序(同行保持原相對順序),
 * 可直接交給 injectImageTags。
 *
 * 返回 null 只在真正無從下手時:當前正文清洗後一條敘事行都不剩——此時任何落點都是瞎猜。
 * 句子被改寫、被刪、被整段追加內容都不算無從下手,一律給出落點。
 */
export function rebaseImagePositions(
  currentText: string,
  plannedSegments: TargetSegment[],
  images: ImageInsertion[],
  stripTags: string[],
): RebaseResult | null {
  const report: RebaseReport = { anchored: 0, remapped: 0, drifted: 0 };
  if (!images.length) return { images: [], report };

  const newSegments = prepareTargetText(currentText, stripTags).segments;
  if (!newSegments.length) return null;

  const oldByLine = new Map(plannedSegments.map((segment, index) => [segment.sourceLine, index]));
  const mapped = alignSegments(
    plannedSegments.map(segment => segment.text),
    newSegments.map(segment => segment.text),
  );

  const out: ImageInsertion[] = [];
  for (const image of images) {
    const oldIndex = oldByLine.get(image.sourceLine);
    // sourceLine 本就來自 plannedSegments,對不上說明呼叫方傳錯了列表
    if (oldIndex === undefined) return null;
    const direct = mapped[oldIndex];
    const target = direct >= 0 ? direct : nearestMapped(mapped, oldIndex);
    if (target < 0) return null;

    if (direct < 0) report.drifted += 1;
    else if (newSegments[target].text === plannedSegments[oldIndex].text) report.anchored += 1;
    else report.remapped += 1;
    out.push({ ...image, sourceLine: newSegments[target].sourceLine });
  }

  // 升序保證敘事順序單調;sort 穩定,落到同一行的圖片保持模型給出的原相對順序
  out.sort((left, right) => left.sourceLine - right.sourceLine);
  return { images: out, report };
}
