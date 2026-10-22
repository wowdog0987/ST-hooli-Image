import { describe, expect, it } from 'vitest';

import { buildAutoTagMessages } from '@/autoTag/prompt';
import {
  activeComfyPreset,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * 提示詞集:全部留空(= 回落內建預設),只把本用例關心的那幾項覆蓋掉。
 * 收在一處是因為 AutoTagPrompts 每加一個鍵,散落的字面量會同時 typecheck 失敗。
 */
function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    prefill: '',
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一層' },
      { name: 'Char', is_user: false, is_system: false, mes: '目標第一行\n\n目標第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('auto tag prompt', () => {
  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ jailbreak: '附加規則' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加規則');
    expect(messages.some(m => m.role === 'system' && m.content.includes('你是嚴謹的劇情畫面規劃與生圖提示詞編寫員'))).toBe(true);
    expect(messages.some(m => m.content.includes('除一個 <thinking> 塊和一個 JSON 物件外'))).toBe(true);
    expect(messages.some(m => m.content.includes('最終結果必須包含且只能包含一個可解析的 JSON 物件'))).toBe(true);
    expect(messages.some(m => m.content.includes('images 數量必須在 0～3 之間'))).toBe(true);
    expect(messages.some(m => m.content.includes('沒有值得繪製的可見瞬間時可以返回空陣列'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含質量詞'))).toBe(true);
    expect(messages.some(m => m.content.includes('先完成角色建檔與變化檢查'))).toBe(true);
    expect(messages.some(m => m.content.includes('同一事件的相鄰動作'))).toBe(true);
    expect(messages.some(m => m.content.includes('兩人同框不等於必須橫屏'))).toBe(true);
    expect(messages.some(m => m.content.includes('"field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('"hair":"long black hair","eyes":"blue eyes"'))).toBe(true);
    expect(messages.some(m => m.content.includes('首次出場就必須建檔'))).toBe(true);
    expect(messages.some(m => m.content.includes('角色卡、世界書、Horae或持續劇情'))).toBe(true);
    expect(messages.some(m => m.content.includes('hair 與 eyes 必填'))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes('後續不得重新隨機'))).toBe(true);
    // 建檔不受入選與否影響,也不受位置門控 —— 這兩條是修復的核心,措辭必須在協議裡
    expect(messages.some(m => m.content.includes('不論他是否入選本次圖片'))).toBe(true);
    expect(messages.some(m => m.content.includes('建檔在本樓全程有效'))).toBe(true);
    // 已撤銷的 characters 審計:不得迴流到協議裡
    expect(messages.some(m => m.content.includes('characters'))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 2];
    expect(user.role).toBe('user');
    expect(user.content).toContain('【角色固定外貌庫】[system-maintained; currently empty]');
    expect(user.content).toContain('當前為空，沒有任何角色已建檔');
    expect(user.content).not.toContain('上一層');
    expect(user.content).toContain('目標第一行 ⟦P1⟧\n\n目標第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('turns a positive minimum into a strict image-count range', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 2,
      maxImages: 4,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('images 數量必須在 2～4 之間'))).toBe(true);
    expect(messages.some(m => m.content.includes('下限 2 是使用者明確要求'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得返回少於 2 張或空陣列'))).toBe(true);
  });

  it('uses the prepared target snapshot without recomputing position IDs', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      null,
      {
        promptText: '請求開始時的正文快照 ⟦P9⟧',
        segments: [{ id: 'P9', sourceLine: 7, text: '請求開始時的正文快照' }],
      },
    );
    const user = messages[messages.length - 2];

    expect(user.content).toContain('請求開始時的正文快照 ⟦P9⟧');
    expect(user.content).not.toContain('目標第一行 ⟦P1⟧');
  });

  it('counts context by AI floors, keeps interleaved user floors, and drops prior image tags', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早使用者樓' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隱藏思維</think>
<content>
上一個 AI 樓
<snow>狀態列</snow>
<hooli_image>1girl, long silver hair, red eyes<size>portrait</size></hooli_image>
</content>
尾部狀態`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中間使用者樓' },
      { name: 'Char', is_user: false, is_system: false, mes: '當前目標樓' },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };

    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 2];
    expect(user.content).not.toContain('更早使用者樓');
    expect(user.content).toContain('上一個 AI 樓');
    expect(user.content).not.toContain('hooli_image');
    expect(user.content).toContain('中間使用者樓');
    expect(user.content).not.toContain('隱藏思維');
    expect(user.content).not.toContain('狀態列');
    expect(user.content).not.toContain('尾部狀態');
    expect(user.content).not.toContain('上下文樓層');
    expect(user.content).toContain('當前目標樓 ⟦P1⟧');
    expect(user.content).not.toContain('上一個 AI 樓 ⟦P');
  });

  it('attaches the built-in thinking checklist and <thinking> prefill by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes('輸出前思考清單'));
    expect(thinkingMsg?.role).toBe('system');

    // 兩層結構:A~E 是整樓一次的全域性判斷,第二層是逐圖槽位塊。
    // 結構骨架比逐字文案更值得釘——散裝 bullet 正是模型把每圖壓成一句話的原因。
    expect(thinkingMsg?.content).toContain('第一層｜全域性判斷（整樓各做一次）');
    expect(thinkingMsg?.content).toContain('第二層｜逐張圖槽位塊');
    expect(thinkingMsg?.content).toContain('不得合併、不得跨圖共用一份');
    expect(thinkingMsg?.content).toContain('第三層｜落筆前自查');
    for (const slot of ['人物：', '核心動作：', '景別：', '場景：', '環境光：', 'size：']) {
      expect(thinkingMsg?.content).toContain(slot);
    }
    expect(thinkingMsg?.content).toContain('<角色名>｜表情｜視線｜本鏡頭可見服裝｜臨時狀態｜個人動作');
    expect(thinkingMsg?.content).toContain('確實不適用的槽位寫 "-"');
    expect(thinkingMsg?.content).toContain('核心動作、景別、表情、視線、場景、環境光、size 七項永遠不得為 "-"');
    // 表情/視線此前全庫沒有槽位,是「木臉」的根因;兩個後端規範也要各帶一份。
    expect(thinkingMsg?.content).toContain('兩項都不得留空，面無表情也要主動填 expressionless');
    expect(thinkingMsg?.content).toContain('表情與視線填後端規範給出的標準 danbooru 詞');
    expect(thinkingMsg?.content).toContain('沒有漏掉表情、視線或環境光');
    // 只開一個 thinking 塊:prefill 已經是 <thinking>,模型再開一個會破壞 protocol.ts 的成對剝離。
    expect(thinkingMsg?.content).toContain('不得開啟第二個 <thinking> 塊');

    // 以下是重寫前就必須守住的既有約束,逐條確認沒有在重構中丟失。
    expect(thinkingMsg?.content).toContain('不得把臨時狀態恢復成角色預設值');
    expect(thinkingMsg?.content).toContain('即使 images 為空也不能跳過這一步');
    expect(thinkingMsg?.content).toContain('視覺明確度、劇情重要度、動作完整度');
    expect(thinkingMsg?.content).toContain('下限大於 0 時從較次但仍可見的候選中補足');
    expect(thinkingMsg?.content).toContain('一次快門完整拍下');
    // size 判定口徑瘦身後只留在後端規範一份(thinking 與協議都不再複述),
    // 但整套訊息裡必須仍有且有這一份,否則模型無從判斷橫豎。
    expect(messages.some(m => m.content.includes('雙人近距離構圖可寫 portrait'))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('雙人近距離可 portrait');
    expect(thinkingMsg?.content).toContain('只跳過沒有視覺變化的對話');
    expect(thinkingMsg?.content).toContain('首次出場就建檔');
    expect(thinkingMsg?.content).toContain('不論他是否入選本次圖片');
    expect(thinkingMsg?.content).toContain('建檔在本樓全程有效');
    // 建檔的 hair 必須帶長度/髮型:只寫顏色的舊措辭會讓模型以 black hair 過關。
    expect(thinkingMsg?.content).toContain('hair 必須同時帶髮色和長度/髮型');
    expect(thinkingMsg?.content).not.toContain('hair 與 eyes 都不得留空');
    // 白皙膚色詞禁令(ComfyUI 預設膚色已夠白,疊 pale skin 會白得失真):
    // 規範給禁令,思維鏈第三層給落筆前的檢查位;tan/dark skin 是豁免項。
    expect(messages.some(m => m.content.includes('白皙詞一律禁止'))).toBe(true);
    expect(thinkingMsg?.content).toContain('白皙膚色詞混進任何一張圖');
    expect(thinkingMsg?.content).toContain('tan、dark skin 不在此列');
    // 建檔欄位的詳細寫法瘦身後只留在任務協議一份,thinking 不再複述。
    expect(messages.some(m => m.content.includes('建檔寫法：{"name":"角色名","field":"new"'))).toBe(true);
    // 新舊檔案的 position 語義、時代判斷的發揮邊界:瘦身後各自只留一份權威副本
    // (分別在任務協議與後端規範),thinking 不再複述,但整套訊息裡必須仍在。
    expect(messages.some(m => m.content.includes('該位置之前的圖片使用舊檔案'))).toBe(true);
    expect(messages.some(m => m.content.includes('證據較少時可以合理補全時代風格'))).toBe(true);
    expect(thinkingMsg?.content).toContain('不得退回中性服裝或預設現代都市');
    expect(thinkingMsg?.content).toContain('把未知的場景事實具體化');
    // 泥地/地形禁令原本 3 份(規範 + 槽位 + 自查),瘦身後規範留完整版、
    // thinking 只留一句「沒依據就別寫」。outdoors/forest 的具體口徑歸規範。
    expect(messages.some(m => m.content.includes('只確定“森林”時寫 forest 即可'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得為了豐富畫面自行新增泥地、土路'))).toBe(true);
    expect(thinkingMsg?.content).toContain('沒依據就別寫');
    expect(thinkingMsg?.content).toContain('沒依據就刪除');
    expect(thinkingMsg?.content).toContain('只有名字實際列在【角色固定外貌庫】區塊中的才算已建檔');
    expect(thinkingMsg?.content).toContain('按正文 P 位置維護每個角色的臨時服裝');
    expect(thinkingMsg?.content).toContain('視覺指紋');
    expect(thinkingMsg?.content).toContain('版型/剪裁 + 主色 + 關鍵部件');
    expect(thinkingMsg?.content).toContain('褲襪含顏色與透明度');
    expect(thinkingMsg?.content).toContain('模型會自行重新設計的孤立詞');
    // 槽位側同樣要擋住籠統詞,否則 C 段定了 navy school blazer、槽位裡仍退回 school uniform。
    expect(thinkingMsg?.content).toContain('槽位裡不許退回 school uniform、dress、pantyhose 這種籠統孤立詞');
    expect(thinkingMsg?.content).toContain('多人畫面每人的服裝各寫各的');
    // 自查項要點名服裝,上一版只提「表情視線」,模型自查時就只核對了表情視線。
    expect(thinkingMsg?.content).toContain('沒有誰的衣服只寫在槽位裡卻沒進 tag');
    // 配角只寫「彎腰換鞋」不寫表情詞 → tag 裡他沒有表情。角色行必須逐人寫全英文詞。
    expect(thinkingMsg?.content).toContain('配角也要寫全');
    expect(thinkingMsg?.content).toContain('這一行沒有表情詞');
    expect(thinkingMsg?.content).toContain('每個在場角色都各有一個綁定到自己的表情詞和視線詞');
    // 超限重選必須發生在 E 段,不能等到第三層「讓位」——那幾塊槽位是白寫的。
    expect(thinkingMsg?.content).toContain('寫出 P 列表之前先數一遍');
    expect(thinkingMsg?.content).toContain('這一層只核對、不改決定');
    expect(messages.some(m => m.content.includes('navy school blazer, white collared shirt, red ribbon'))).toBe(true);
    expect(thinkingMsg?.content).toContain('鏡頭外不可見的部件可以省略，但省略不等於脫掉');
    expect(thinkingMsg?.content).toContain('沒有散落的無主特徵');
    expect(messages.some(m => m.content.includes('每個在場正式角色必須二選一'))).toBe(true);
    expect(messages.some(m => m.content.includes('禁止把兩人的外貌特徵散放成無法歸屬的一串公共 tag'))).toBe(true);
    expect(thinkingMsg?.content).toContain('定一套具體、自洽的時代/文明/視覺體系並全樓沿用');
    expect(messages.some(m => m.content.includes('必須先判斷，並主動具體化'))).toBe(true);
    expect(messages.some(m => m.content.includes('具體不等於編造'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得為了豐富畫面自行新增泥地、土路'))).toBe(true);
    expect(messages.some(m => m.content.includes('允許為了完成畫面作合理猜測'))).toBe(false);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('<thinking>');
  });

  it('uses custom thinking/prefill when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ comfyThinking: '自定義清單', prefill: 'custom>' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('自定義清單'))).toBe(true);
    expect(messages.some(m => m.content.includes('輸出前思考清單'))).toBe(false);
    expect(messages[messages.length - 1].content).toBe('custom>');
  });

  // 思維鏈按後端各存一份。改 ComfyUI 那份不能影響 NAI——共用一份正是 V5 被要求填
  // 「景別/環境光/鄰接綁定」這類它的規範從未教過的欄位的根因。
  it('picks the thinking checklist per backend and never crosses them over', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({
        comfyThinking: 'COMFY-CHECKLIST',
        naiThinking: 'NAI-CHECKLIST',
        naiV5Thinking: 'NAIV5-CHECKLIST',
      }),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      const cases = [
        { backend: 'comfyui', model: oldModel, want: 'COMFY-CHECKLIST' },
        // 單串分支的代表換成原版 NAI4:4.5 起走 Character Prompts 分支(自然語言是 4.5 引入的)
        // ⚠ NAI4 已從 NAI_MODELS 撤下(設定頁選不到了),但 prompt.ts 的單串分支與
        // naiSpec/naiThinking 兩個鍵都還在,故這條繼續按字串鎖住分支歸屬。
        { backend: 'nai', model: 'nai-diffusion-4-full', want: 'NAI-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-4-5-full', want: 'NAIV5-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-5-full', want: 'NAIV5-CHECKLIST' },
      ] as const;
      const all = ['COMFY-CHECKLIST', 'NAI-CHECKLIST', 'NAIV5-CHECKLIST'];
      for (const { backend, model, want } of cases) {
        settings.defaultBackend = backend;
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const text = messages.map(m => m.content).join('\n');
        for (const marker of all) {
          expect([backend, model, marker, text.includes(marker)]).toEqual([
            backend,
            model,
            marker,
            marker === want,
          ]);
        }
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 身份 tag 與 NSFW 的思維鏈落點:0.1.16 的舊清單本來有(身份 tag 定詞+自查 / NAI 專屬
  // NSFW 條款+自查),三層重寫時三份全丟——規則只在 spec 裡、思考迴路沒有檢查位,
  // 漏寫機率回升。這條釘死三份各自的落點口徑,且 NSFW 不帶年齡限定。
  it('keeps fandom identity and NSFW checkpoints inside each backend thinking', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      // ComfyUI:身份 tag 定詞 + 括號轉義提醒 + negative 條件自查(只有 Comfy 工作流會有
      // negative 鍵);Comfy spec 無 NSFW 條款,思維鏈也不加。
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('判定為同人時同一行定出最終身份 tag 詞');
      expect(text).toContain(
        '每個同人角色的 tag 串裡都有 B 段定下的 character name \\(copyright name\\) 身份 tag',
      );
      expect(text).toContain('若本圖協議含 negative 鍵');
      expect(text).not.toContain('若本圖是顯式 NSFW 場景');
      // spec 的轉義指導必須原樣到達模型:模板字串裡 \( 會被烹飪成 (,
      // 0.1.16 起這條實際發給模型的就是未轉義括號,一直是壞的。
      expect(text).toContain('實際提示詞形態為 character name \\(copyright name\\)');
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(text).not.toContain('形態為 character name (copyright name)');
      // 白皙膚色詞禁令只給 ComfyUI:本地模型預設膚色已夠白,再疊 pale skin 會白得失真。
      expect(text).toContain('白皙詞一律禁止');
      expect(text).toContain('白皙膚色詞混進任何一張圖');

      // NAI 4 系:身份 tag 不轉義 + 顯式 NSFW 解剖落點(從有變無的迴歸,此處補回)。
      // 負面詞由後端按模型固定附加,AI 不寫 negative——不該有 negative 條件自查。
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('判定為同人時同一行定出最終身份 tag 詞');
      expect(text).toContain('不轉義圓括號');
      expect(text).toContain('若正文明確為顯式 NSFW 場景');
      expect(text).toContain('若本圖是顯式 NSFW 場景');
      expect(text).not.toContain('若本圖協議含 negative 鍵');
      expect(text).not.toContain('成年人');
      // NAI 側使用者沒有白痘問題,不引入這條禁令。
      expect(text).not.toContain('白皙膚色詞');
      expect(text).not.toContain('白皙詞一律禁止');

      // NAI V5:身份 tag 落點是 characters[].tag 首位;NSFW 按 Base/角色塊分工;
      // contentRule 明令禁止 negative tags,不該有 negative 條件自查。
      settings.nai.model = 'nai-diffusion-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('身份 tag 必須寫進檔案');
      expect(text).toContain('每個同人角色的身份 tag 都逐字照抄自檔案 fandom 欄位');
      expect(text).toContain('若正文明確為顯式 NSFW 場景');
      expect(text).toContain('若本圖是顯式 NSFW 場景');
      expect(text).not.toContain('若本圖協議含 negative 鍵');
      expect(text).not.toContain('成年人');
      expect(text).not.toContain('白皙膚色詞');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // NAI V5 用 Base + characters[] 隔離每個人,其規範第 8 條明令禁止 ComfyUI 的鄰接綁定。
  // 舊版三後端共用一份思維鏈時,V5 被要求做規範禁止的事——這條釘死不再回流。
  it('gives NAI V5 a Base/character slot block with no adjacency-binding wording', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // 鄰接綁定的每種措辭都不得出現在 V5 路徑上。
      for (const banned of [
        '落 tag 時各自綁定',
        'on silver hair girl',
        'on green hair girl',
        '沒主人的籠統孤立詞',
        '人物：<人數 tag',
        '區分性稱謂鄰接綁定',
      ]) {
        expect([banned, text.includes(banned)]).toEqual([banned, false]);
      }

      // 取而代之的是 Base 塊 + 每角色塊。
      expect(text).toContain('■ P<編號>｜Base');
      expect(text).toContain('■ P<編號>｜<角色名或正文指稱>');
      // 角色塊按取景框、不按檔案:塊名允許正文指稱,固定外貌槽給【一次性】留了合法填法。
      // 舊口徑「照抄庫中/剛建檔的欄位」是唯一來源,無名角色在這個槽位上無路可走——
      // 於是模型寧可放棄畫面(見「無名角色入畫」問題文件),這條釘死不再回流。
      expect(text).toContain('【一次性】角色用正文的指稱原詞作塊名');
      expect(text).toContain('【一次性】按世界觀一次性補全');
      expect(text).toContain('不要用鄰接綁定');
      expect(text).toContain('Base 塊與角色塊的分工是硬邊界');
      expect(text).toContain('落 JSON 時進他自己的 characters[].tag');
      // 單人畫面沒有多人互動:核心互動槽寫 "-",唯一角色的動作進他角色塊的個人動作——
      // 舊口徑讓單人接觸點寫進 Base 槽,與「個人動作只進角色塊」的分工規則直接打架。
      expect(text).toContain('單人畫面本槽寫 "-"');
      expect(text).not.toContain('單人畫面寫該角色與場景/道具的接觸點');
      // 第三層逐槽點名核對:實跑裡模型把環境光丟了、自查卻聲稱「覆蓋了全部槽位」。
      // 點名清單必須含多人畫面的核心互動——只在單人畫面才允許 "-" 跳過。
      expect(text).toContain('逐槽核對過');
      expect(text).toContain('環境光不許漏');
      expect(text).toContain('多人畫面的核心互動');
      // 服裝視覺指紋與協議形態無關,三份思維鏈都要保住。
      expect(text).toContain('槽位裡不許退回 school uniform、dress、pantyhose 這種籠統孤立詞');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 建檔資格 ≠ 入畫資格。實跑裡模型把「一次性無名路人不建檔」讀成「無名者不能入畫」,
  // 於是放棄了全文最強的戲劇瞬間(核心互動的另一方是個無名對手),轉而挑了個能把他
  // 裁出鏡頭的景別。根因是造名單的謂詞寫錯了:第一層 B 只清點「有名有姓」,那人從未
  // 上冊,下游規則根本看不見他。三處必須同時成立,缺一處他就會在某一環被判死刑。
  it('lets unprofiled characters enter the frame on the NAI V5 path', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // ① 第一層 B 清點「誰在場」而不是「誰有檔案」,並逐人標出三類身份。
      expect(text).toContain('逐個列出實際在場的**全部**角色');
      expect(text).toContain('清點的是「誰在場」，不是「誰有檔案」');
      expect(text).toContain('【一次性】');
      expect(text).not.toContain('逐個列出實際在場且有名有姓的角色');

      // ② 二選一 → 三選一。只改名單不改自查,那人會以合法身份上冊、卻在最後一關被
      // 自己判死刑(「每個在場正式角色必須二選一」他兩條都佔不上)。
      expect(text).toContain('每個在場角色都能三選一');
      expect(text).not.toContain('每個在場正式角色都能二選一');

      // 缺檔不能否決核心互動;排除無關在場者仍是合法取景。
      expect(text).toContain('建檔資格與入畫資格是兩回事');
      expect(text).toContain('不得僅因缺檔案放棄畫面、改選瞬間或裁掉他');

      // 個體/人群只決定入畫後的落位,不決定是否值得入畫。
      expect(text).toContain('拿不準是個體還是一團時按一團處理');
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');

      // 編人名是有毒的:name 會隨 <characters> 落進正文,而 cleanHistoryText 保留
      // hooli_image,下一樓原樣讀回——一個假人名與真檔案無法區分,會被誤建檔。
      expect(text).toContain('絕不為他編造人名');
      expect(text).toContain('Never invent a personal name for them');

      // Name consistency 原本是普世律,模型把「沒有真名」讀成「沒有合法名」。
      // 它的全部目的是保護逐字匹配,而一次性角色不參與任何匹配,故必須限定作用域。
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');

      // 人數按取景框算;缺檔不能成為裁掉核心互動參與者的理由。
      expect(text).toContain('number of people visible inside this frame');
      expect(text).toContain('a missing profile is never a reason to reject a moment or crop that participant out');

      // C 段連坐:名單放寬後,不排除【一次性】會讓模型給一次性對手維護服裝時間線——
      // 白燒 token,更糟的是強化「他是正經角色」的暗示,反過來誘發建檔。
      expect(text).toContain('【一次性】角色不在本段佔行');

      // 示例本身曾是反面教材:Base 寫 2girls 卻只給一條 Character Prompt,
      // 正好演示了「另一個人沒有落位」。示例必須演示要求的行為。
      expect(text).toContain('三年級隊長');
      expect(text).not.toContain('"tag":"2girls, classroom, sunset, medium shot"');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 只驗證規則裝配;實際取景是否突出主要角色仍需用劇情實跑。
  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    'prioritizes principal characters without requiring every present person in frame (%s)',
    async model => {
      const options: AutoTagSettings = {
        enabled: true,
        contextMessages: 2,
        minImages: 0,
        maxImages: 2,
        retryCount: 1,
        autoGenerate: true,
        prompts: prompts(),
      };
      const oldBackend = settings.defaultBackend;
      const oldModel = settings.nai.model;
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const contract = messages.find(m => m.content.startsWith('你是嚴謹的劇情畫面規劃'))!.content;
        const thinking = messages.find(m => m.content.startsWith('【輸出前思考清單】'))!.content;
        const spec = messages.find(m => m.content.startsWith('[NovelAI'))!.content;
        const selection = thinking.split('E. 選段\n')[1].split('第二層｜')[0];

        expect(contract).toContain('優先表現正文中玩家主角和主要角色的表情、狀態、行動及關係');
        expect(contract).toContain('主要角色單獨出鏡同樣成立');
        expect(contract).toContain('不得把不在場者加入畫面');
        expect(contract).toContain('主要角色依據設定與劇情判斷，不等同於所有已建檔角色');
        expect(contract).toContain('僅僅在場不構成入畫理由');
        expect(contract).toContain('Anonymous crowds visible in the frame remain in Base');
        expect(selection).toContain('優先選擇突出玩家主角或主要角色的畫面');
        expect(selection).toContain('不以有無檔案或是否有名字給候選加減分');
        expect(selection).toContain('先確定本圖要突出的主體與核心互動，再決定誰入鏡');
        expect(selection).toContain('若人群本身承載核心互動則保留');
        expect(thinking).toContain('清點名單不是入畫名單');
        expect(thinking).toContain('每個本圖可見的個體角色各寫一塊');
        expect(thinking).toContain('入畫時才在他自己的角色塊裡補外貌');
        expect(thinking).toContain('沒有為了減人數破壞核心互動，也沒有把無關在場者補進畫面');
        expect(thinking).not.toContain('每個在場角色各');
        expect(thinking).not.toContain('入畫資格只看正文是否寫他在場');
        expect(spec).toContain('Only include them when the chosen frame needs the crowd');
        expect(spec).toContain('Other people or crowds may remain off-screen');
        expect(spec).toContain('Keep an unnamed participant when needed to show the core interaction');
        expect(spec).not.toContain('an extra body in Base costs a little rendering polish');
      } finally {
        settings.defaultBackend = oldBackend;
        settings.nai.model = oldModel;
      }
    },
  );

  // 思維鏈要求填景別/環境光/size,V5 規範裡原本沒有任何判據——模型只能瞎猜。
  it('teaches NAI V5 the visual-completion doctrine its slots depend on', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('Write exactly one shot distance');
      expect(text).toContain('must contain this image');
      expect(text).toContain('Keep body tags consistent with the shot distance');
      // 表情詞表與另兩份對齊:思維鏈是白名單制(規範沒列的一律不許用),
      // 少列一個詞等於停用一個詞。
      expect(text).toContain('smile, grin, laughing, blush');
      expect(text).toContain('crying, tears, angry');
      expect(text).toContain('worried, scared, smug');
      expect(text).toContain('open mouth, clenched teeth');
      // d46ae82 的地形修復此前從未覆蓋 V5 路徑。
      expect(text).toContain('never add muddy ground, dirt path, wetland, puddles');
      expect(text).toContain('Orientation (the size key)');
      expect(text).toContain('When unsure, write portrait');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 原版 NAI4 的 char_captions 恆為空(nai.ts),協議形態與 ComfyUI 一樣是單條 tag 串,
  // 一樣需要鄰接綁定——但 NAI 規範裡此前一條多人規則、一個示例都沒有。
  // (4.5 起走 Character Prompts 分支,歸屬另一份規範,不適用鄰接綁定。)
  it('gives NAI 4 the multi-character binding rules and a worked example', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('多人畫面（兩人及以上）額外規則');
      expect(text).toContain('white dress on green hair girl');
      expect(text).toContain('petite on silver hair girl');
      expect(text).toContain('black hair girl smiling, silver hair girl looking at another');
      expect(text).toContain('dark trousers on black hair boy');
      // 示例是規則的靠山:只有條文沒有示例時模型照抄不到寫法。
      expect(text).toContain('多人 tag 示例');
      // NAI 不吃 ComfyUI 的權重括號轉義,那條不該跟著複製過來。
      expect(text).not.toContain('ComfyUI 會把未轉義圓括號當作權重語法');
      // 排序統一到「構圖緊跟人數」口徑:與 Comfy 一致,也與多人規則原文一致;
      // 舊的「鏡頭構圖放末尾」排序表和示例曾與此自相矛盾。
      expect(text).toContain('人數/主體 → 鏡頭構圖 → 外貌');
      expect(text).not.toContain('場景 → 光線氛圍 → 鏡頭構圖');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // 視線詞表筆誤:eyes closed 是 closed eyes 的別名,同 tag 兩種詞序不該並列。
      expect(text).not.toContain('eyes closed');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  it('has the library dictate copied field values instead of @ placeholders', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const library = '【角色固定外貌庫(系統維護)】\n小雪: 1girl, long silver hair';
    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, library);

    // 示例改用實際外貌串;@佔位符已撤回(見 charAnchors.ts 檔案頭)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系統會替換成庫中最新 tag'))).toBe(false);
    // 照抄庫中欄位 + 一張圖只寫一遍,是本次回退的兩條核心措辭
    expect(messages.some(m => m.content.includes('照抄庫中/剛建檔的欄位值'))).toBe(true);
    expect(messages.some(m => m.content.includes('只寫一遍'))).toBe(true);
    expect(messages[messages.length - 2].content).toContain(library);
    expect(messages[messages.length - 2].content).not.toContain('currently empty');
  });

  it('forbids poses and scenes from entering the appearance profile', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    // 檔案會在之後每張圖被照抄,姿勢/場景混進欄位會讓角色永遠保持那個姿勢
    expect(messages.some(m => m.content.includes('lying on carpet'))).toBe(true);
    expect(messages.some(m => m.content.includes('長期不變的身體特徵'))).toBe(true);
  });

  it('keeps first-appearance profiling enabled when BaiBai Book memory exists', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      {
        text: '【角色參考】已有其他角色',
        roles: [],
      },
    );

    expect(messages.some(message => message.content.includes('首次出場就必須'))).toBe(true);
    expect(messages.some(message => message.content.includes('Horae本次未提供'))).toBe(false);
  });

  it('uses the dedicated NAI V5 Base and Character Prompt contract', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('one Base Prompt plus zero or more native Character Prompts'))).toBe(true);
      expect(messages.some(message => message.content.includes('"characters":['))).toBe(true);
      expect(messages.some(message => message.content.includes('source# / target# / mutual#'))).toBe(true);
      expect(messages.some(message => message.content.includes('Character tag uses girl/boy without a numeric count'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base 的全域性性對 tag 與 nl 同樣成立:實跑裡模型把單角色的制服/體型寫進 Base nl,
      // 與角色 nl 重複——舊文本只把禁令寫在 tag 層面。
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // 建檔 nl 只寫固定外貌:臨時服裝進了永久檔案的 nl,會跟著之後每樓走。
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 表情/視線此前在三個後端規範裡都沒有位置,思維鏈槽位填了也會在轉 tag 時丟掉。
  it('reserves an expression/gaze slot in the tag ordering of both tag-based backends', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      for (const backend of ['comfyui', 'nai'] as const) {
        settings.defaultBackend = backend;
        if (backend === 'nai') settings.nai.model = 'nai-diffusion-4-full';
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const spec = messages.find(m => m.content.includes('從重要到次要排列'));
        expect(spec?.content).toContain('動作姿態 → 表情視線 → 場景');
        expect(spec?.content).toContain('表情與視線每張圖都要寫，不得省略');
        expect(spec?.content).toContain('判斷為面無表情時也要顯式寫 expressionless');
        // 首輪實跑漏出 gentle smile / shy expression / neutral curious expression
        // 這類非 danbooru 片語:槽位填對了,轉 tag 時原樣直譯。規範裡要給限定詞表。
        expect(spec?.content).toContain('必須使用模型認識的標準 danbooru 詞，不得自創描述性片語');
        expect(spec?.content).toContain('gentle smile 寫 smile，shy expression 寫 blush');
        expect(spec?.content).toContain('puffy cheeks');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 同一輪實跑裡 P11 兩人各自的 looking at another 被合併成一個裸 tag,
  // petite / black pantyhose 也脫離了 on green hair girl 綁定。
  it('binds per-character expression, gaze and body type in multi-character ComfyUI tags', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'comfyui';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const spec = messages.find(m => m.content.includes('多人畫面（兩人及以上）額外規則'));
      expect(spec?.content).toContain('表情與視線同樣是**每人各一份、必須綁定**的特徵');
      expect(spec?.content).toContain('另一人變成預設木臉');
      expect(spec?.content).toContain('兩人表情或視線恰好相同時也各寫一份帶稱謂的');
      expect(spec?.content).toContain('體型詞（petite、tall、muscular 等）不是錨點，必須綁定到具體角色');
      // 規則沒有示例撐腰就是空話:實跑裡模型照著示例串抄結構,petite/loli 仍然裸寫。
      expect(spec?.content).toContain('petite on silver hair girl');
      // 髮色瞳色是綁定錨點,裸列才對——不能被上一條誤傷成 black hair on black hair girl。
      expect(spec?.content).toContain('髮色、瞳色本身是用來指認角色的錨點，照常裸列即可');
      // 瘦身時刪掉「不許退回籠統詞」當輪就復發:tag 裡裸寫 school uniform +
      // black opaque pantyhose,男孩的 white shirt/dark pants 乾脆沒進 tag。
      expect(spec?.content).toContain('同類不同款的服裝尤其要綁定，不能靠一個統稱糊過去');
      expect(spec?.content).toContain('dark pleated skirt on green hair girl');
      expect(spec?.content).toContain('white shirt on black hair boy');
      expect(spec?.content).toContain('會讓模型把裙子套到男生身上');
      // 示例串要真的示範綁定寫法,否則模型照著舊示例抄裸 tag。
      expect(spec?.content).toContain('black hair girl smile, black hair girl looking at viewer');
      expect(spec?.content).toContain('silver hair girl blush, silver hair girl looking away');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  // 槽位本身也要擋住中文描述,否則先漏進槽位再漏進 tag。
  it('makes the per-image slot block demand canonical danbooru expression words', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);
    const thinkingMsg = messages.find(m => m.content.includes('輸出前思考清單'));
    expect(thinkingMsg?.content).toContain('不寫中文感受也不自創片語（想寫「溫柔地笑」就填 smile）');
    expect(thinkingMsg?.content).toContain('多人畫面每人各填一份');
    expect(thinkingMsg?.content).toContain('另一人變成預設木臉');
    // 連著兩輪實跑都沒照抄 ■ 格式,但七個槽位一項沒漏——防漏的目的已達成,
    // 形狀不是目的。故意不釘「■ 單獨成行」這類形態斷言,只釘槽位齊全。
    expect(thinkingMsg?.content).toContain('七個槽位一個都不能少');
    // 搖擺的可執行判據:抽象的「別反覆權衡」模型每次都覺得自己沒在權衡。
    expect(thinkingMsg?.content).toContain('同一個欄位在整個 <thinking> 裡只准出現一次取值');
    // 不寫推演過程的約束保留,但不設字數硬上限——上限會逼著模型為多圖多人場景壓縮建檔判斷。
    expect(thinkingMsg?.content).not.toContain('800 字');
    expect(thinkingMsg?.content).toContain('帶問號的自問');
    expect(thinkingMsg?.content).toContain('並列候選');
    // 第三層曾自稱「落成 tag」,與「不要預寫 tag 串」直接打架,實跑裡 tag 被寫了四遍。
    expect(thinkingMsg?.content).toContain('第三層｜落筆前自查');
    // 上一版只禁「完整 tag/nl 串」,模型鑽空子改成在 thinking 裡預寫整個 JSON 物件
    // (末尾一句 "JSON:" 加一份完整答案),白燒約 800 token。措辭要覆蓋 JSON 本身。
    expect(thinkingMsg?.content).toContain('不寫完整 tag 串、不寫完整 nl 句、更不要寫出 JSON 物件');
    expect(thinkingMsg?.content).toContain('答案只在 </thinking> 之後出現一次');
    expect(thinkingMsg?.content).not.toContain('第三層｜落成 tag 並自查');
    expect(thinkingMsg?.content).not.toContain('逐條轉成 tag/nl');
  });

  it('requests per-image negative tags only when the ComfyUI workflow uses %negative_prompt%', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    // 工作流改由「當前預設」承載(見 settings.ts 工作流庫);預設值恆有一條,直接改它
    const preset = activeComfyPreset();
    const oldWorkflow = preset.workflow;
    try {
      settings.defaultBackend = 'comfyui';
      preset.workflow = JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: '%prompt%', negative: '%negative_prompt%' },
        },
      });
      const messages = await buildAutoTagMessages(context(), 1, options, null);

      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);
      expect(messages.some(message => message.content.includes('禁止輸出通用質量、畫質、審美或技術性負面詞'))).toBe(true);
      expect(messages.some(message => message.content.includes('worst quality、low quality、blurry'))).toBe(true);
      expect(messages.some(message => message.content.includes('工作流裡已有的通用質量負面詞'))).toBe(false);
      expect(messages.some(message => message.content.includes('不得使用 @角色佔位符'))).toBe(true);
      // 實跑裡模型給下雨的正文配了 "negative":"rain, umbrella",反而抵消了 tag 的 wet asphalt。
      expect(messages.some(message => message.content.includes('negative 裡絕不能出現正文已明確成立的事實'))).toBe(true);
      expect(messages.some(message => message.content.includes('正文寫了在下雨'))).toBe(true);
      // 復發一次:nl 自己寫了 drizzle,negative 仍填 rain。禁令必須覆蓋「否定自己剛寫的內容」。
      expect(messages.some(message => message.content.includes('也不能否定你自己剛寫進本圖 tag/nl 的任何東西'))).toBe(true);
      expect(messages.some(message => message.content.includes('寫完 negative 逐詞回看本圖的 tag 與 nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('空的 negative 永遠比抵消正文的 negative 安全'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
    }
  });

  it('簡易模式的動態負面詞門檻由模板決定:checkpoint/anima 請求,flux 不請求', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const oldMode = preset.mode;
    const oldTemplate = preset.simple.template;
    try {
      settings.defaultBackend = 'comfyui';
      preset.mode = 'simple';
      preset.simple.template = 'checkpoint';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);

      preset.simple.template = 'flux';
      const fluxMessages = await buildAutoTagMessages(context(), 1, options, null);
      expect(fluxMessages.some(message => message.content.includes('"negative":"extra people'))).toBe(false);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.mode = oldMode;
      preset.simple.template = oldTemplate;
    }
  });
});
