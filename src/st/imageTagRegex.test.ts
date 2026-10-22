import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  containsTagMarkup,
  ensureImageTagRegexRegistered,
  formatPromptText,
  hasImageTagTrace,
  IMAGE_TAG_HIDE_REGEX_ID,
  IMAGE_TAG_SLOT_REGEX_ID,
  imageTagHideScript,
  imageTagSlotScript,
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  stripImageTags,
} from '@/st/imageTagRegex';

const SLOT_DIV = '<div data-hooli-slot=""></div>';

function regexFromLiteral(literal: string): RegExp {
  const match = literal.match(/^\/(.*)\/([a-z]*)$/i);
  if (!match) throw new Error('invalid regex literal');
  return new RegExp(match[1], match[2]);
}

afterEach(() => vi.unstubAllGlobals());

describe('display-side slot script (markdownOnly)', () => {
  it('replaces each complete tag block with an empty slot anchor', () => {
    const script = imageTagSlotScript();
    expect(script.markdownOnly).toBe(true);
    expect(script.promptOnly).toBe(false);
    expect(script.placement).toEqual([1, 2, 3]);
    expect(script.id).toBe(IMAGE_TAG_SLOT_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<hooli_image>1girl,\nmoonlight</hooli_image>\n正文後'.replace(regex, script.replaceString),
    ).toBe(`正文前\n${SLOT_DIV}\n正文後`);
  });

  it('handles multiple tags without swallowing text between them', () => {
    const script = imageTagSlotScript();
    const regex = regexFromLiteral(script.findRegex);
    expect(
      '<hooli_image>first</hooli_image>中間正文<hooli_image>second</hooli_image>'.replace(
        regex,
        script.replaceString,
      ),
    ).toBe(`${SLOT_DIV}中間正文${SLOT_DIV}`);
  });
});

describe('prompt-side hide script (promptOnly)', () => {
  it('removes the complete tag block from prompts', () => {
    const script = imageTagHideScript();
    expect(script.markdownOnly).toBe(false);
    expect(script.promptOnly).toBe(true);
    expect(script.placement).toEqual([1, 2, 3]);
    expect(script.id).toBe(IMAGE_TAG_HIDE_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<hooli_image>1girl,\nmoonlight</hooli_image>\n正文後'.replace(regex, script.replaceString),
    ).toBe('正文前\n\n正文後');
  });

  it('shares the same find pattern as the slot script', () => {
    expect(imageTagSlotScript().findRegex).toBe(imageTagHideScript().findRegex);
  });
});

describe('placement covers narrator floors (regression lock)', () => {
  /**
   * 為什麼這條鎖得寫清楚緣由:旁白樓(`/narrator`、`/sys`)是 `is_system:false` +
   * `extra.type:'narrator'`,st/context.ts 的 isAiStoryMessage **認它是劇情樓**、
   * 自動 tag 會往裡寫 tag;而 script.js 的 getRegexPlacement 給這種樓派的是
   * SLASH_COMMAND(3),不是 AI_OUTPUT(2)。少這個 3,錨點正則整條不命中——
   * tag 原文當正文顯示出來,還沒有錨點可掛卡片。
   *
   * 只斷言 `[1,2,3]` 的話,後人「精簡掉用不上的 placement」時看不到代價;
   * 這條測試要說的是 3 對應哪一類樓。
   */
  const PLACEMENT_BY_MESSAGE_KIND = {
    user: 1,
    ai: 2,
    narrator: 3,
  } as const;

  it('both scripts cover user, ai and narrator display placements', () => {
    for (const script of [imageTagSlotScript(), imageTagHideScript()]) {
      for (const [kind, placement] of Object.entries(PLACEMENT_BY_MESSAGE_KIND)) {
        expect(script.placement, `${script.id} 漏了 ${kind} 樓`).toContain(placement);
      }
    }
  });

  it('never covers the deprecated MD_DISPLAY placement', () => {
    // 0 已被 ST 棄用,且 regex/index.js 會把帶 0 的規則改寫成「全部 placement」,
    // 那會讓佔位規則跑到世界書(5)/思維鏈(6)上去。
    expect(imageTagSlotScript().placement).not.toContain(0);
    expect(imageTagHideScript().placement).not.toContain(0);
  });
});

describe('parseImageTags', () => {
  it('returns tags in document order, preserving raw text', () => {
    expect(parseImageTags('a<hooli_image>one</hooli_image>b<hooli_image>two,\nlines</hooli_image>c')).toEqual([
      '<hooli_image>one</hooli_image>',
      '<hooli_image>two,\nlines</hooli_image>',
    ]);
  });

  it('returns an empty array when there are no tags', () => {
    expect(parseImageTags('沒有生圖標籤的正文')).toEqual([]);
  });
});

describe('hasImageTagTrace', () => {
  it('sees complete tags', () => {
    expect(hasImageTagTrace('場景\n<hooli_image>1girl</hooli_image>')).toBe(true);
  });

  it('sees a lone closing tag — the case that used to make the button a no-op', () => {
    // 按鈕層曾用 /<hooli_image\b/(只認開標籤)→ 判定「沒 tag」不彈確認、傳 replace=false;
    // runner 層認開也認閉 → 判定「有 tag」靜默放棄。兩側同源後這種樓照樣能重新生成。
    expect(hasImageTagTrace('模型學著上下文寫了半截 </hooli_image>')).toBe(true);
  });

  it('sees a lone opening tag and is case-insensitive', () => {
    expect(hasImageTagTrace('<BBI_Image>')).toBe(true);
  });

  it('is false for tag-free text and for a lookalike prefix', () => {
    expect(hasImageTagTrace('普通正文')).toBe(false);
    expect(hasImageTagTrace('<hooli_images>')).toBe(false);
  });
});

describe('stripImageTags', () => {
  it('removes plugin-injected tags together with their line break, restoring the original text', () => {
    expect(stripImageTags('第一行\n<hooli_image>1girl</hooli_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('removes multiple tags after the same line and tags with nl/size sub-tags', () => {
    expect(
      stripImageTags(
        '場景\n<hooli_image>1girl<nl>A girl.</nl><size>portrait</size></hooli_image>\n<hooli_image>2boy<size>landscape</size></hooli_image>\n結尾',
      ),
    ).toBe('場景\n結尾');
  });

  it('removes inline hand-written tags without touching surrounding text', () => {
    expect(stripImageTags('前文 <hooli_image>x</hooli_image> 後文')).toBe('前文  後文');
  });

  it('leaves tag-free text untouched and preserves CRLF', () => {
    expect(stripImageTags('沒有\r\n標籤')).toBe('沒有\r\n標籤');
  });

  it('also clears half-written orphan tags left after the pairs are gone', () => {
    // 留一個孤立的 <hooli_image> 會讓非貪婪查詢正則從它吃到下一個 </hooli_image>,
    // 把中間的正文連同後面那條真 tag 一起吞掉 —— 殘骸只刪自己,真 tag 整段刪。
    expect(stripImageTags('第一行\n<hooli_image>\n第二行\n<hooli_image>1girl</hooli_image>\n第三行')).toBe(
      '第一行\n第二行\n第三行',
    );
    expect(stripImageTags('半截 </hooli_image> 殘骸')).toBe('半截  殘骸');
    expect(stripImageTags('第一行\n</hooli_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('clears an empty tag pair (the old pair regex required non-empty content and left it behind)', () => {
    expect(stripImageTags('第一行\n<hooli_image></hooli_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('deletes the whole outer span when opening tags nest', () => {
    expect(stripImageTags('前\n<hooli_image>a<hooli_image>b</hooli_image></hooli_image>\n後')).toBe('前\n後');
  });
});

describe('parseImageTagContent', () => {
  it('treats bare content as the tag part (legacy format)', () => {
    expect(parseImageTagContent('<hooli_image>1girl, moonlight</hooli_image>')).toEqual({
      tag: '1girl, moonlight',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('splits bare tag text and a <nl> sub-tag (plugin standard form)', () => {
    expect(parseImageTagContent('<hooli_image>1girl<nl>A girl.</nl></hooli_image>')).toEqual({
      tag: '1girl',
      nl: 'A girl.',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('accepts explicit <tag> and <nl> sub-tags in any order', () => {
    expect(
      parseImageTagContent('<hooli_image><nl>A girl.\nShe smiles.</nl><tag>1girl</tag></hooli_image>'),
    ).toEqual({ tag: '1girl', nl: 'A girl. She smiles.', negative: '', characters: [], size: 'portrait' });
  });

  it('merges bare text with explicit <tag> content instead of dropping it', () => {
    expect(parseImageTagContent('<hooli_image>bare_tags<tag>explicit_tags</tag></hooli_image>')).toEqual({
      tag: 'bare_tags, explicit_tags',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('strips <size> out of the tag part instead of leaking it into the prompt', () => {
    // 漏剝的話 landscape 這個詞會直接混進正向提示詞
    expect(parseImageTagContent('<hooli_image>2girls, wide shot<size>landscape</size></hooli_image>')).toEqual(
      { tag: '2girls, wide shot', nl: '', negative: '', characters: [], size: 'landscape' },
    );
  });

  it('handles all three sub-tags together (full plugin form)', () => {
    expect(
      parseImageTagContent('<hooli_image>2girls<nl>Two girls.</nl><size>landscape</size></hooli_image>'),
    ).toEqual({ tag: '2girls', nl: 'Two girls.', negative: '', characters: [], size: 'landscape' });
  });

  it('extracts <negative> without leaking it into the positive tag', () => {
    expect(
      parseImageTagContent(
        '<hooli_image>1girl<negative>extra people,\nduplicate</negative><size>portrait</size></hooli_image>',
      ),
    ).toEqual({
      tag: '1girl',
      nl: '',
      negative: 'extra people, duplicate',
      characters: [],
      size: 'portrait',
    });
  });


  it('parses V5 character prompts without leaking JSON into Base tag', () => {
    const raw = '<hooli_image>2girls, classroom<characters>[{"name":"A","tag":"girl, black hair","nl":"left"}]</characters><size>landscape</size></hooli_image>';
    expect(parseImageTagContent(raw)).toEqual({
      tag: '2girls, classroom',
      nl: '',
      negative: '',
      characters: [{ name: 'A', tag: 'girl, black hair', nl: 'left' }],
      size: 'landscape',
    });
  });

  it('ignores malformed character JSON while preserving the Base prompt', () => {
    expect(parseImageTagContent('<hooli_image>1girl<characters>{bad}</characters></hooli_image>')).toEqual({
      tag: '1girl',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('falls back to portrait for legacy tags without <size>', () => {
    // 存量正文裡的 tag 沒有 size,必須維持改動前的豎屏行為
    expect(parseImageTagContent('<hooli_image>1girl</hooli_image>').size).toBe('portrait');
    expect(parseImageTagContent('<hooli_image>1girl<size>亂寫</size></hooli_image>').size).toBe('portrait');
  });
});

describe('serializeImageTag', () => {
  it('writes every sub-tag when all fields are present', () => {
    expect(
      serializeImageTag({
        tag: '2girls, classroom',
        nl: 'Two girls talking.',
        negative: 'extra people',
        characters: [{ name: 'A', tag: 'girl, black hair', nl: 'left' }],
        size: 'landscape',
      }),
    ).toBe(
      '<hooli_image>2girls, classroom<nl>Two girls talking.</nl><negative>extra people</negative>' +
        '<characters>[{"name":"A","tag":"girl, black hair","nl":"left"}]</characters>' +
        '<size>landscape</size></hooli_image>',
    );
  });

  it('omits empty nl/negative/characters instead of writing empty sub-tags', () => {
    expect(
      serializeImageTag({ tag: '1girl', nl: '', negative: '', characters: [], size: 'portrait' }),
    ).toBe('<hooli_image>1girl<size>portrait</size></hooli_image>');
  });

  it('always writes <size> — generation is deferred, so orientation must persist in the text', () => {
    expect(
      serializeImageTag({ tag: '1girl', nl: '', negative: '', characters: [], size: 'landscape' }),
    ).toContain('<size>landscape</size>');
  });

  it('round-trips through parseImageTagContent byte-for-byte in canonical form', () => {
    // 這條鎖死「開啟彈窗、什麼都不改、儲存」不會換 promptHash 桶 —— 一換,老圖全變 stale。
    const canonical = [
      '<hooli_image>1girl<size>portrait</size></hooli_image>',
      '<hooli_image>2girls<nl>Two girls.</nl><size>landscape</size></hooli_image>',
      '<hooli_image>1girl<negative>extra people</negative><size>portrait</size></hooli_image>',
      '<hooli_image>2girls<characters>[{"name":"A","tag":"girl","nl":""}]</characters><size>landscape</size></hooli_image>',
    ];
    for (const raw of canonical) {
      expect(serializeImageTag(parseImageTagContent(raw))).toBe(raw);
    }
  });

  it('produces a form that parses back to the same fields', () => {
    const content = {
      tag: '1girl, smile',
      nl: 'A girl smiling.',
      negative: 'duplicate',
      characters: [{ name: '小雪', tag: 'girl, white hair', nl: 'right side' }],
      size: 'portrait' as const,
    };
    expect(parseImageTagContent(serializeImageTag(content))).toEqual(content);
  });
});

describe('formatPromptText', () => {
  it('joins the parts with blank lines in card order', () => {
    expect(
      formatPromptText({
        tag: '1girl, moonlight',
        nl: 'She stands on the roof.',
        negative: 'lowres',
        characters: [{ name: '顧晚', tag: 'black hair', nl: 'looking away' }],
      }),
    ).toBe(
      '1girl, moonlight\n\nShe stands on the roof.\n\n角色: 顧晚\nblack hair\nlooking away\n\nNegative: lowres',
    );
  });

  it('drops empty parts instead of leaving blank gaps', () => {
    expect(formatPromptText({ tag: '1girl', nl: '', negative: '', characters: [] })).toBe('1girl');
    expect(formatPromptText({ tag: '', nl: '', negative: '', characters: [] })).toBe('');
  });

  it('renders what parseImageTagContent produces (gallery reads tags this way)', () => {
    // 相簿拿到的只有 tag 原文,要靠這條鏈路還原成與卡片一致的展示
    const raw = serializeImageTag({
      tag: '1girl',
      nl: 'night',
      negative: 'blurry',
      characters: [{ name: '顧晚', tag: 'black hair', nl: '' }],
      size: 'portrait',
    });
    expect(formatPromptText(parseImageTagContent(raw))).toBe(
      '1girl\n\nnight\n\n角色: 顧晚\nblack hair\n\nNegative: blurry',
    );
  });
});

describe('replaceImageTagAt', () => {
  const text = '一\n<hooli_image>first</hooli_image>\n二\n<hooli_image>second</hooli_image>\n三\n<hooli_image>third</hooli_image>\n四';
  const next = '<hooli_image>edited<size>portrait</size></hooli_image>';

  it('replaces the first tag and leaves everything else byte-identical', () => {
    expect(replaceImageTagAt(text, 0, next)).toBe(
      `一\n${next}\n二\n<hooli_image>second</hooli_image>\n三\n<hooli_image>third</hooli_image>\n四`,
    );
  });

  it('replaces a middle tag without touching its neighbours', () => {
    expect(replaceImageTagAt(text, 1, next)).toBe(
      `一\n<hooli_image>first</hooli_image>\n二\n${next}\n三\n<hooli_image>third</hooli_image>\n四`,
    );
  });

  it('replaces the last tag', () => {
    expect(replaceImageTagAt(text, 2, next)).toBe(
      `一\n<hooli_image>first</hooli_image>\n二\n<hooli_image>second</hooli_image>\n三\n${next}\n四`,
    );
  });

  it('returns null when seq is out of range or invalid', () => {
    expect(replaceImageTagAt(text, 3, next)).toBe(null);
    expect(replaceImageTagAt(text, -1, next)).toBe(null);
    expect(replaceImageTagAt(text, 1.5, next)).toBe(null);
    expect(replaceImageTagAt('沒有標籤的正文', 0, next)).toBe(null);
  });

  it('is not affected by a shared regex lastIndex across repeated calls', () => {
    // 模組級 IMAGE_TAG_FIND_REGEX 帶 /g 有狀態,故本函式就地新建正則;連調三次結果須一致
    expect(replaceImageTagAt(text, 0, next)).toBe(replaceImageTagAt(text, 0, next));
    expect(replaceImageTagAt(text, 2, next)).toBe(replaceImageTagAt(text, 2, next));
  });

  it('handles multi-line and inline tags on the same line', () => {
    expect(
      replaceImageTagAt('前 <hooli_image>a,\nb</hooli_image> 中 <hooli_image>c</hooli_image> 後', 1, next),
    ).toBe(`前 <hooli_image>a,\nb</hooli_image> 中 ${next} 後`);
  });
});

describe('containsTagMarkup', () => {
  it('catches sub-tag literals that would truncate the tag block', () => {
    // 查詢正則是非貪婪的:內容裡混進 </hooli_image> 會讓 tag 提前截斷,後半截漏進 DOM 與提示詞
    expect(containsTagMarkup('1girl</hooli_image>後半截')).toBe(true);
    expect(containsTagMarkup('1girl<hooli_image>')).toBe(true);
    expect(containsTagMarkup('a<nl>b')).toBe(true);
    expect(containsTagMarkup('a</nl>')).toBe(true);
    expect(containsTagMarkup('a<negative>b')).toBe(true);
    expect(containsTagMarkup('a<characters>b')).toBe(true);
    expect(containsTagMarkup('a<size>b')).toBe(true);
    expect(containsTagMarkup('a<tag>b')).toBe(true);
  });

  it('leaves ordinary prompt text alone', () => {
    expect(containsTagMarkup('1girl, long black hair, (smile:1.2), <lora:foo:0.8>')).toBe(false);
    expect(containsTagMarkup('')).toBe(false);
    expect(containsTagMarkup('a < b, 2 > 1')).toBe(false);
  });
});

describe('managed bbi image-tag regex registration', () => {  it('registers both scripts once by fixed id and updates old managed rules', () => {
    const saveSettingsDebounced = vi.fn();
    const unrelated = { id: 'user-rule', scriptName: '使用者規則' };
    const legacy = {
      id: IMAGE_TAG_HIDE_REGEX_ID,
      scriptName: '虎哩繪 · 隱藏生圖標籤',
      findRegex: '/old/g',
      markdownOnly: true,
      promptOnly: true,
      placement: [0, 1, 2],
      customField: 'preserved',
    };
    const extensionSettings: Record<string, unknown> = { regex: [unrelated, legacy] };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({ extensionSettings, saveSettingsDebounced }),
      },
    });

    expect(ensureImageTagRegexRegistered()).toBe(true);
    expect(ensureImageTagRegexRegistered()).toBe(true);
    const list = extensionSettings.regex as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(unrelated);

    // 舊單條 hide 規則被原位升級為 promptOnly 版本（不再雙開），使用者欄位保留
    const hide = list.find(s => s.id === IMAGE_TAG_HIDE_REGEX_ID);
    expect(hide).toMatchObject({
      scriptName: '虎哩繪 · 隱藏生圖標籤',
      markdownOnly: false,
      promptOnly: true,
      placement: [1, 2, 3],
      customField: 'preserved',
    });

    // 新增 slot 規則且只出現一次
    const slots = list.filter(s => s.id === IMAGE_TAG_SLOT_REGEX_ID);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      scriptName: '虎哩繪 · 生圖標籤佔位',
      markdownOnly: true,
      promptOnly: false,
      placement: [1, 2, 3],
      replaceString: SLOT_DIV,
    });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
  });
});
