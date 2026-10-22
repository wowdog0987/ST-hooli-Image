import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/state/settings';
import { buildRequestBody, extractContent, readSseContent, requestCompletion } from './client';

/** 歷史層全部 mock 掉:這裡要斷的正是「什麼時候記成功/失敗」 */
const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟隨主 API',
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  // 與真實實現同語義:吞異常返回 null
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}) }),
}));

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const channel: ApiChannel = {
  id: 'ch1',
  name: '測試渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  prefill: true,
  excludeParams: [],
  reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hi' }];
/** 帶 usage 的響應:避免觸發 token 估算分支(那需要主介面分詞器) */
const okPayload = {
  choices: [{ message: { role: 'assistant', content: '  答案文本  ' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
};

/** 造一個最小 Response,可讀出給定 SSE 文本 */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('buildRequestBody:思考強度與兩條源分支', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<typeof channel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1', false);

  it('未設思考強度 → 走 openai 源(除新增的 tool_choice 外,請求體與加功能前一致)', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      tool_choice: 'none',
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('兩條源分支都帶 tool_choice:none(給防截斷類 fetch 攔截器的放行握手)', () => {
    // Kemini 等預設指令碼攔截所有 /generate 請求,看到呼叫方自帶 tool_choice 就放行,
    // 不再注入合成工具 + 控制訊息(否則生圖 tag 會被拖慢甚至逼出重試)。
    expect(build().tool_choice).toBe('none');
    expect(build({ reasoningEffort: 'high' }).tool_choice).toBe('none');
    // 若使用者真想讓第三方改寫,可用 excludeParams 刪掉它
    expect(build({ excludeParams: ['tool_choice'] }).tool_choice).toBeUndefined();
  });

  it('設了思考強度 → 切 custom 源,並經 custom_include_body 透傳', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // 頂層不發 reasoning_effort:openai/custom 源都卡模型名白名單,
    // 模型名恰好命中時會覆蓋掉我們真正想發的值
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('custom 源必須靠 header 帶 key:proxy_password 在該源下不被讀取', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('key 含 YAML 元字元時仍能安全注入(靠 JSON.stringify 轉義)', () => {
    // 手拼 YAML 會在這類 key 上解析失敗;而 ST 的 mergeObjectWithYaml 是靜默忽略,
    // header 注入失敗 → 退回讀 ST 自己的 Custom 金鑰 → 可能把別家的 key 發到本端點。
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('空白字串視同未設(不誤切 custom 源)', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('取值不做白名單:非常規值原樣透傳', () => {
    const body = build({ reasoningEffort: '我自己的檔位' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('我自己的檔位');
  });

  it('excludeParams 在兩條分支下都照常生效', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });
});

describe('extractContent:標準響應', () => {
  it('message.content 正常提取', () => {
    const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(extractContent(data)).toBe('hello');
  });

  it('相容 choices[0].text 與頂層 content', () => {
    expect(extractContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractContent({ content: 'top-level' })).toBe('top-level');
  });

  it('content 為 content-parts 陣列時拼接各段 text', () => {
    const data = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    expect(extractContent(data)).toBe('ab');
  });

  it('content 為 null 時返回空串而非拋錯', () => {
    const data = { choices: [{ message: { role: 'assistant', content: null, refusal: null } }] };
    expect(extractContent(data)).toBe('');
  });
});

describe('extractContent:推理模型把答案塞進 reasoning', () => {
  it('content 為空時回退 reasoning', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          reasoning: '思考過程…\n\n{"images":[],"changes":[]}',
        },
      }],
    };
    expect(extractContent(data)).toContain('"images"');
  });

  it('content 為空時回退 reasoning_content(DeepSeek 標準欄位)', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: null, reasoning_content: '答案在裡' },
      }],
    };
    expect(extractContent(data)).toBe('答案在裡');
  });

  it('content 為空時回退 thinking', () => {
    const data = { choices: [{ message: { content: null, thinking: 'via thinking' } }] };
    expect(extractContent(data)).toBe('via thinking');
  });

  it('content 非空時絕不混入 reasoning', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: 'final answer', reasoning: 'chain of thought' },
      }],
    };
    expect(extractContent(data)).toBe('final answer');
  });
});

describe('readSseContent:流式', () => {
  it('拼接 delta.content', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('Hello');
  });

  it('content 全空時回退拼接 reasoning 增量', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"…{\\"images\\":[]}"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toContain('"images"');
  });

  it('content 出現後忽略 reasoning,不拼接', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"先想"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('答案!');
  });
});

describe('validate:歷史「成功」= 呼叫方驗收通過', () => {
  beforeEach(() => {
    h.beginLlm.mockClear();
    h.finishLlm.mockClear();
    h.failLlm.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okPayload)));
  });

  it('驗收通過 → 返回文本,歷史記成功', async () => {
    const seen: string[] = [];
    const text = await requestCompletion(channel, messages, {
      validate: raw => seen.push(raw),
    });
    expect(text).toBe('答案文本');
    expect(seen).toEqual(['答案文本']); // validate 拿到的是提取後的正文
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
    expect(h.failLlm).not.toHaveBeenCalled();
  });

  it('不傳 validate → 維持舊行為:拿到文本即記成功', async () => {
    await expect(requestCompletion(channel, messages)).resolves.toBe('答案文本');
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
  });

  it('驗收拋錯 → 請求按失敗丟擲,歷史記失敗而非成功', async () => {
    // 這是「HTTP 成功但協議解析不過」的場景:必須 failLlm,否則重試會在歷史裡
    // 留下兩條綠色成功記錄,看歷史的人會誤以為成功也重複呼叫。
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('協議不合法');
        },
      }),
    ).rejects.toThrow('協議不合法');
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, '協議不合法', false);
  });

  it('HTTP 失敗時 validate 根本不該被呼叫', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const validate = vi.fn();
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('500');
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });
});
