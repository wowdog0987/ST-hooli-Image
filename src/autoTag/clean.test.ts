import { describe, expect, it } from 'vitest';

import {
  cleanHistoryText,
  cleanTargetText,
  prepareTargetText,
  stripCustomTags,
} from '@/autoTag/clean';

describe('stripCustomTags', () => {
  it('配對塊整刪(含內部內容)', () => {
    expect(stripCustomTags('前文\n<snow>狀態列內容</snow>\n後文', ['snow'])).toBe('前文\n\n後文');
  });

  it('落單開/閉/自閉標籤:只刪標籤本身', () => {
    expect(stripCustomTags('<snow>內容無閉合', ['snow'])).toBe('內容無閉合');
    expect(stripCustomTags('內容</snow>', ['snow'])).toBe('內容');
    expect(stripCustomTags('內容<snow/>', ['snow'])).toBe('內容');
  });

  it('中文標籤名同樣生效(前瞻而非詞邊界)', () => {
    expect(stripCustomTags('<雪>飄雪特效</雪>正文', ['雪'])).toBe('正文');
  });

  it('邊界前瞻:不誤吃同名字首標籤(<snow> 不吃 <snowball>)', () => {
    expect(stripCustomTags('<snowball>保留</snowball>', ['snow'])).toBe('<snowball>保留</snowball>');
  });

  it('帶屬性的開標籤也整塊刪除', () => {
    expect(stripCustomTags('前<snow class="bar">內容</snow>後', ['snow'])).toBe('前後');
  });

  it('大小寫不敏感', () => {
    expect(stripCustomTags('<SNOW>內容</SNOW>', ['snow'])).toBe('');
  });

  it('空名單 / 無匹配標籤:原樣返回', () => {
    const s = '<think>思維鏈</think>正文';
    expect(stripCustomTags(s, [])).toBe(s);
    expect(stripCustomTags(s, ['snow'])).toBe(s);
  });

  it('多個標籤依次整刪', () => {
    expect(stripCustomTags('<a>1</a>x<b>2</b>y', ['a', 'b'])).toBe('xy');
  });
});

describe('prompt body cleaning', () => {
  const source = `<think>不可見思維</think>
第一段正文
<snow>自定義狀態</snow>
<hooli_image>1girl, silver hair<size>portrait</size></hooli_image>
第二段正文
<horae>
location:客廳
</horae>`;

  it('cleans historical floors and drops old image tags (appearance comes from the library)', () => {
    expect(cleanHistoryText(source, ['snow'])).toBe('第一段正文\n\n第二段正文');
  });

  it('removes target noise without changing retained prose', () => {
    expect(cleanTargetText(source, ['snow'])).toBe(
      `第一段正文

<hooli_image>1girl, silver hair<size>portrait</size></hooli_image>

第二段正文`,
    );
  });

  it('builds stable position IDs mapped to original physical lines', () => {
    expect(prepareTargetText(source, ['snow'])).toEqual({
      promptText: `第一段正文 ⟦P1⟧

<hooli_image>1girl, silver hair<size>portrait</size></hooli_image> ⟦P2⟧

第二段正文 ⟦P3⟧`,
      segments: [
        { id: 'P1', sourceLine: 1, text: '第一段正文' },
        {
          id: 'P2',
          sourceLine: 3,
          text: '<hooli_image>1girl, silver hair<size>portrait</size></hooli_image>',
        },
        { id: 'P3', sourceLine: 4, text: '第二段正文' },
      ],
    });
  });

  it('keeps inline prose on one mapped source line after removing a block', () => {
    expect(prepareTargetText('前文<snow>隱藏</snow>後文', ['snow'])).toEqual({
      promptText: '前文 後文 ⟦P1⟧',
      segments: [{ id: 'P1', sourceLine: 0, text: '前文 後文' }],
    });
  });

  it('keeps source offsets stable when emoji appear before removed blocks', () => {
    expect(prepareTargetText('😀<snow>狀態</snow>\n<horaeevent>event:一般|x</horaeevent>\n正文', ['snow'])).toEqual({
      promptText: '😀 ⟦P1⟧\n\n正文 ⟦P2⟧',
      segments: [
        { id: 'P1', sourceLine: 0, text: '😀' },
        { id: 'P2', sourceLine: 2, text: '正文' },
      ],
    });
  });
});

describe('<content> 正文殼', () => {
  const mes = '<content>\n賽洛斯推門而入。\n艾洛抬起頭。\n</content>\n<horae>\nlocation:皇宮·休息室\n</horae>';

  it('目標正文保留 <content> 內文,只拆標籤殼', () => {
    const prepared = prepareTargetText(mes, []);
    expect(prepared.promptText).toBe('賽洛斯推門而入。 ⟦P1⟧\n\n艾洛抬起頭。 ⟦P2⟧');
  });

  it('上下文正文同樣保留 <content> 內文', () => {
    const text = cleanHistoryText(mes, []);
    expect(text).toContain('賽洛斯推門而入。');
    expect(text).not.toContain('<content>');
    expect(text).not.toContain('location:');
  });
});

describe('自閉合佔位標籤', () => {
  it('<StatusPlaceHolderImpl/> 不成為可選段落,也不進上下文', () => {
    const mes = '<content>\n她抬起頭。\n</content>\n<StatusPlaceHolderImpl/>';
    expect(prepareTargetText(mes, []).promptText).toBe('她抬起頭。 ⟦P1⟧');
    expect(cleanHistoryText(mes, [])).not.toContain('StatusPlaceHolderImpl');
  });
});

describe('<content> 白名單', () => {
  const mes = [
    '<thinking>先想想,正文會放在 <content> 裡</thinking>',
    '<content>',
    '兩人躺在草地上聊天。',
    '<hooli_image>1girl<size>portrait</size></hooli_image>',
    '他忽然低頭吻了她。',
    '</content>',
    '<UpdateVariable>_.set("x", 1);</UpdateVariable>',
    '<choice>選項 A</choice>',
    '<horae>',
    'location:草地',
    '</horae>',
    '<StatusPlaceHolderImpl/>',
  ].join('\n');

  it('上下文只留 <content> 內的敘事,外掛標籤與舊生圖 tag 全部不見', () => {
    expect(cleanHistoryText(mes, [])).toBe('兩人躺在草地上聊天。\n\n他忽然低頭吻了她。');
  });

  it('目標正文同樣只從 <content> 內取段落;思維鏈裡提到的 <content> 不會被當成起點', () => {
    const plain = mes.replace(/<hooli_image>[\s\S]*?<\/hooli_image>\n/, '');
    expect(prepareTargetText(plain, []).promptText).toBe('兩人躺在草地上聊天。 ⟦P1⟧\n\n他忽然低頭吻了她。 ⟦P2⟧');
  });

  it('沒有 <content> 的訊息退回原本的清洗方式', () => {
    expect(prepareTargetText('第一行。\n<choice>選項</choice>\n第二行。', ['choice']).promptText).toBe(
      '第一行。 ⟦P1⟧\n\n第二行。 ⟦P2⟧',
    );
  });

  it('未閉合的 <content> 取到結尾', () => {
    expect(prepareTargetText('前言\n<content>\n被截斷的正文。', []).promptText).toBe('被截斷的正文。 ⟦P1⟧');
  });
});
