import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ generateRaw: vi.fn() }));

vi.mock('@/st/context', () => ({ getContext: () => ctx }));
vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟隨主 API',
  beginLlm: () => null,
  finishLlm: () => undefined,
  failLlm: () => undefined,
  patchLlmTokens: () => undefined,
  safeHistory: () => null,
}));

const messages = [
  { role: 'system' as const, content: 'rules' },
  { role: 'user' as const, content: 'story' },
  { role: 'assistant' as const, content: '<thinking>' },
];

/** 降級階梯記在模組狀態裡,每個用例重新載入模組從第一階開始。 */
async function freshClient() {
  vi.resetModules();
  return import('./client');
}

describe('跟隨主 API 被拒時的降級重試', () => {
  beforeEach(() => ctx.generateRaw.mockReset());

  it('第一次就成功時照原樣送(預填充 + 65535),不重試', async () => {
    ctx.generateRaw.mockResolvedValueOnce('ok');
    const { requestViaMainApi } = await freshClient();
    await expect(requestViaMainApi(messages)).resolves.toBe('ok');
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    const [call] = ctx.generateRaw.mock.calls[0];
    expect(call.responseLength).toBe(65535);
    expect(call.prompt.at(-1).role).toBe('assistant');
  });

  it('Bad Request → 拿掉預填充、上限 16384 重試;成功後後續請求直接用該階', async () => {
    ctx.generateRaw.mockRejectedValueOnce(new Error('Bad Request')).mockResolvedValue('ok');
    const { requestViaMainApi } = await freshClient();
    await expect(requestViaMainApi(messages)).resolves.toBe('ok');
    const retry = ctx.generateRaw.mock.calls[1][0];
    expect(retry.responseLength).toBe(16384);
    expect(retry.prompt.at(-1).role).toBe('user');

    await requestViaMainApi(messages);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(3);
    expect(ctx.generateRaw.mock.calls[2][0].responseLength).toBe(16384);
  });

  it('連續被拒時最後交給 ST 自己的回覆長度(null)', async () => {
    ctx.generateRaw
      .mockRejectedValueOnce(new Error('Bad Request'))
      .mockRejectedValueOnce(new Error('max_tokens is too large'))
      .mockResolvedValueOnce('ok');
    const { requestViaMainApi } = await freshClient();
    await expect(requestViaMainApi(messages)).resolves.toBe('ok');
    expect(ctx.generateRaw.mock.calls[2][0].responseLength).toBeNull();
  });

  it('不是「被拒收」的錯誤不降級,直接拋出', async () => {
    ctx.generateRaw.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { requestViaMainApi } = await freshClient();
    await expect(requestViaMainApi(messages)).rejects.toThrow('Failed to fetch');
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
  });
});
