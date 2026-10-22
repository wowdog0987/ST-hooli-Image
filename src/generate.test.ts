import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateComfyImage } from '@/backends/comfyui';
import { generateNaiImage } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { activeNaiEndpoint, newNaiEndpoint, settings, type NaiModel } from '@/state/settings';

vi.mock('@/backends/nai', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/nai')>()),
  generateNaiImage: vi.fn(),
}));
vi.mock('@/backends/comfyui', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/comfyui')>()),
  generateComfyImage: vi.fn(),
}));
vi.mock('@/floor/genQueue', () => ({ acquireNaiSlot: vi.fn() }));

function fakeResult() {
  return { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireNaiSlot).mockResolvedValue(vi.fn());
  vi.mocked(generateNaiImage).mockResolvedValue(fakeResult());
  vi.mocked(generateComfyImage).mockResolvedValue(fakeResult());
});

/**
 * 把設定調成「NAI 已配齊」。地址與 key 落在**當前接入點**上——渠道級那兩個是存量欄位。
 * settings 是模組級單例,用例之間會串,故這裡把接入點庫整個復位成「只有官方一條」。
 */
function naiReady(model: NaiModel = 'nai-diffusion-4-5-full'): void {
  settings.defaultBackend = 'nai';
  settings.nai.endpoints = [
    { id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'k' },
  ];
  settings.nai.activeEndpointId = 'nep_official';
  settings.nai.model = model;
  settings.nai.seed = 0;
}

/** 把設定調成「ComfyUI 自定義工作流已配齊」。 */
function comfyReady(): void {
  settings.defaultBackend = 'comfyui';
  settings.comfyui.url = 'http://127.0.0.1:8188';
  const preset = settings.comfyui.workflows[0];
  settings.comfyui.activeWorkflowId = preset.id;
  preset.mode = 'custom';
  preset.workflow = '{"1":{}}';
}

describe('backendStatus', () => {
  it('reports each missing NAI field by name', () => {
    naiReady();
    expect(backendStatus()).toMatchObject({ configured: true, reason: '' });

    activeNaiEndpoint().key = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '當前 NAI 接入點未填寫 API Key',
    });

    activeNaiEndpoint().url = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '當前 NAI 接入點未填寫服務地址',
    });
  });

  it('keeps the endpoint name out of reason (it goes to third parties, and users name rows after URLs)', () => {
    // reason 經 getBackendStatus 原樣遞給第三方,而公開返回值裡絕不能出現地址
    naiReady();
    const named = newNaiEndpoint('https://my-secret-proxy.example');
    settings.nai.endpoints.push(named);
    settings.nai.activeEndpointId = named.id;
    expect(backendStatus().reason).not.toContain('my-secret-proxy');
  });

  it('judges readiness by the active endpoint, not the legacy channel-level url/key', () => {
    // 存量欄位留著只為回滾,出圖一律不看它 —— 否則切到沒填 key 的公益站會「看起來能點」
    naiReady();
    settings.nai.url = 'https://image.novelai.net';
    settings.nai.key = 'legacy';

    const blank = newNaiEndpoint('公益站 A');
    settings.nai.endpoints.push(blank);
    settings.nai.activeEndpointId = blank.id;
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '當前 NAI 接入點未填寫服務地址',
    });
  });

  it('sends the active endpoint down to the backend (switching outlets keeps every other param)', async () => {
    naiReady();
    settings.nai.steps = 33;
    const alt = newNaiEndpoint('公益站 A');
    alt.url = 'https://a.example';
    alt.key = 'ka';
    settings.nai.endpoints.push(alt);
    settings.nai.activeEndpointId = alt.id;

    await generateImage({ prompt: 'x', seed: 1 }, undefined, {});
    expect(vi.mocked(generateNaiImage).mock.calls[0][0]).toMatchObject({
      url: 'https://a.example',
      key: 'ka',
      steps: 33,
    });
  });

  it('answers supportsCharacters from the model alone, even before the key is filled in', () => {
    naiReady();
    activeNaiEndpoint().key = '';
    // 第三方要在出圖**前**就知道該不該傳 characters,不能等配好了才知道
    expect(backendStatus().supportsCharacters).toBe(true);
  });

  it('keeps ComfyUI at supportsCharacters=false (the pipeline never reads the field)', () => {
    comfyReady();
    expect(backendStatus()).toMatchObject({ configured: true, supportsCharacters: false });
  });

  it('flags an unconfigured ComfyUI without pretending it can draw', () => {
    comfyReady();
    settings.comfyui.workflows[0].workflow = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '當前工作流預設未填寫工作流 JSON',
    });
  });
});

describe('decideSeed', () => {
  it('prefers an explicit seed over everything else', () => {
    naiReady();
    settings.nai.seed = 999;
    expect(decideSeed('nai', 12345)).toBe(12345);
    expect(decideSeed('nai', 12345.7)).toBe(12345);
  });

  it('uses the NAI panel seed only when it is a positive number', () => {
    naiReady();
    settings.nai.seed = 777;
    expect(decideSeed('nai')).toBe(777);
    settings.nai.seed = 0;
    expect(decideSeed('nai')).not.toBe(0);
  });

  it.each([0, -1, NaN, undefined])('ignores %s as an override and still returns a usable seed', value => {
    naiReady();
    settings.nai.seed = 0;
    const seed = decideSeed('nai', value as number | undefined);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });
});

describe('generateImage', () => {
  it('holds a NAI gate slot and always releases it — even when the request throws', async () => {
    naiReady();
    const release = vi.fn();
    vi.mocked(acquireNaiSlot).mockResolvedValue(release);

    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    vi.mocked(generateNaiImage).mockRejectedValueOnce(new Error('429'));
    await expect(generateImage({ prompt: '1girl', seed: 1 })).rejects.toThrow('429');
    // 漏一次 release 就永久少一格併發,漏滿就再也發不出請求
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('leaves ComfyUI out of the gate (its queue lives on the server)', async () => {
    comfyReady();
    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).not.toHaveBeenCalled();
  });

  it('passes characters through untouched — nai.ts owns the model predicate', async () => {
    naiReady();
    const characters = [{ name: '阿黛爾', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 5, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toEqual({
      prompt: 'x', nl: '', characters, seed: 5, size: 'landscape',
    });
  });

  it('says charactersApplied=false when the model cannot take them', async () => {
    naiReady('nai-diffusion-3');
    const characters = [{ name: 'a', tag: 'b', nl: '' }];
    const applied = await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(applied.charactersApplied).toBe(false);

    naiReady();
    expect((await generateImage({ prompt: 'x', characters, seed: 1 })).charactersApplied).toBe(true);
    // 沒傳角色時不該報「用上了」
    expect((await generateImage({ prompt: 'x', seed: 1 })).charactersApplied).toBe(false);
  });

  it('refuses to fire a doomed request when the backend is not configured', async () => {
    naiReady();
    activeNaiEndpoint().key = '';
    await expect(generateImage({ prompt: 'x', seed: 1 })).rejects.toThrow('未填寫 API Key');
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
  });

  it('clears the retry banner once the image is in hand', async () => {
    naiReady();
    const onRetry = vi.fn();
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onRetry });
    // 落盤還要一會兒,這段時間不該繼續顯示「稍後重試」
    expect(onRetry).toHaveBeenLastCalledWith(null);
  });

  it('only fires onStart after the slot is in hand (that is the queued→generating moment)', async () => {
    naiReady();
    const order: string[] = [];
    vi.mocked(acquireNaiSlot).mockImplementation(async () => {
      order.push('slot');
      return () => {};
    });
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onStart: () => order.push('start') });
    expect(order).toEqual(['slot', 'start']);
  });

  it('sends the dynamic negative to ComfyUI (NAI takes its negative from settings)', async () => {
    comfyReady();
    await generateImage({ prompt: 'x', negative: 'bad hands', seed: 9 }, undefined, {});
    expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({
      negative_prompt: 'bad hands',
      seed: 9,
      size: 'portrait',
    });
  });
});
