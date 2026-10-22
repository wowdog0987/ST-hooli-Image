import { describe, expect, it } from 'vitest';

import { nextEditorState } from '@/floor/promptEditor';

/**
 * 「AI 重寫提示詞」落盤後,彈窗要從正文重讀這一槽的 tag 回填輸入框。
 *
 * 入口在編輯彈窗裡,而重寫是 runner 獨立寫正文的 —— 兩個寫手共用一條 tag。
 * 彈窗持有的 rawTag 是寫回 CAS 的憑據,回填時漏刷它,使用者接著點「應用」就會被
 * 「這條 tag 已被改動」擋回去,而改動它的正是自己剛觸發的這次重寫。
 */

const TAG_A = '<hooli_image><tag>1girl, classroom</tag></hooli_image>';
const TAG_B = '<hooli_image><tag>1girl, rooftop, sunset</tag></hooli_image>';
const TAG_C = '<hooli_image><tag>cat</tag></hooli_image>';

describe('nextEditorState', () => {
  it('正文裡的 tag 換了新的:rawTag 與 content 一起換', () => {
    const next = nextEditorState(`前文 ${TAG_B} 後文`, 0, TAG_A);
    // 命門:兩者必須同時更新,只更新 content 會讓後續「應用」撞上 CAS
    expect(next?.rawTag).toBe(TAG_B);
    expect(next?.content.tag).toBe('1girl, rooftop, sunset');
  });

  it('按 seq 取,不碰同樓其它槽位', () => {
    const next = nextEditorState(`${TAG_C}\n${TAG_B}`, 1, TAG_A);
    expect(next?.rawTag).toBe(TAG_B);
  });

  it('原文沒變就什麼都不動(別拿等價內容去覆蓋使用者的草稿)', () => {
    expect(nextEditorState(`前文 ${TAG_A} 後文`, 0, TAG_A)).toBeNull();
  });

  it('seq 已不存在(tag 被刪/數量變了)時不動', () => {
    expect(nextEditorState(TAG_A, 3, TAG_A)).toBeNull();
  });

  it('正文讀不到(樓層已沒了)時不動', () => {
    expect(nextEditorState(undefined, 0, TAG_A)).toBeNull();
  });
});
