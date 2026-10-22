import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 接入點庫(地址 + 金鑰)的存量摺疊與髒資料處理。
 *
 * 起因是「公益站換著用」:同一套出圖引數,要在多個出口之間切。故只有 url/key 隨條目走,
 * 模型/取樣器/尺寸/vibe/畫師串一概留在渠道級 —— 換站不該逼人重配一遍引數。
 *
 * 與畫師串庫**相反**的兩條口徑(與工作流庫同側),是本檔案的主要看點:
 * 1. 庫恆非空,且恆含內建官方那條:地址是必需品,空了直接出不了圖;
 * 2. activeEndpointId 懸空回落 endpoints[0],**不**清空。畫師串回落等於靜默換畫風
 *    (每張圖都變樣卻查不出),接入點回落只是換個出口、出錯會當場報連線失敗,代價不對等。
 *
 * 另有一條只屬於這裡:官方條的 url 由 normalize 強制糾回,手改 settings.json 也拗不過。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

const OFFICIAL = 'https://image.novelai.net';

describe('NAI 接入點庫 · 存量摺疊', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('nai 鍵整個缺失 → 只有官方那一條,且被選中', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('存量用官方地址 → key 折進官方那條,**不**多出一條重複項', async () => {
    const settings = await hydrateWithNai({ url: OFFICIAL, key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('存量地址留空 → 同樣折進官方那條(空地址不值得單開一行)', async () => {
    const settings = await hydrateWithNai({ url: '', key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
  });

  it('存量地址帶尾斜槓的官方 → 視作官方,仍折成一條', async () => {
    const settings = await hydrateWithNai({ url: `${OFFICIAL}/`, key: 'k' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('存量用第三方站 → 收成第一條並保持選中,官方條**追加在後**', async () => {
    // 順序是刻意的:官方排前面會把使用者正在用的出口擠到第二行,看起來像被換掉了。
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://nai.example.org', OFFICIAL]);
    expect(settings.nai.endpoints[0].key).toBe('sk-x');
    expect(settings.nai.activeEndpointId).toBe(settings.nai.endpoints[0].id);
    expect(settings.nai.endpoints[1].id).toBe('nep_official');
  });

  it('遷移後舊欄位原樣留著(回滾用,不參與出圖)', async () => {
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.key).toBe('sk-x');
    expect(settings.nai.url).toBe('https://nai.example.org');
  });

  it('遷移冪等:已是新格式就原樣保留,當前項不被動', async () => {
    const first = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
      ],
      activeEndpointId: 'nep_a',
    });
    expect(first.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    expect(first.nai.endpoints[0].name).toBe('公益站 A');
    expect(first.nai.endpoints[0].key).toBe('ka');
    expect(first.nai.activeEndpointId).toBe('nep_a');
  });
});

describe('NAI 接入點庫 · 恆非空與官方條不變式', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('官方條被手工刪掉 → 自動補回(庫裡永遠有一個能用的出口)', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    expect(settings.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    // 補回來不搶選中:使用者當前用的還是 A
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('官方條的 url 被手改 → 強制糾回官方地址', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_official', name: '假官方', url: 'https://evil.example', key: 'k' }],
      activeEndpointId: 'nep_official',
    });
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    // 名字也歸回內建名(官方條不可改名,髒資料同樣糾正);key 是使用者自己的,保留
    expect(settings.nai.endpoints[0].name).toBe('NovelAI 官方');
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('endpoints 是空陣列 → 按「沒有新格式」走存量摺疊,而不是留空庫', async () => {
    const settings = await hydrateWithNai({ endpoints: [], url: 'https://a.example', key: 'ka' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://a.example', OFFICIAL]);
  });

  it('activeEndpointId 懸空 → 回落第一條,**不**清成空串', async () => {
    const settings = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_b', name: 'B', url: 'https://b.example', key: 'kb' },
      ],
      activeEndpointId: 'nep_gone',
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
    expect(settings.nai.endpoints).toHaveLength(3); // A、B、補回的官方
  });

  it('activeEndpointId 不是字串 → 同樣回落第一條', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 42,
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('條目缺欄位/含髒資料 → 逐項補齊,不整條丟棄', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ name: 'no id' }, null, { id: 'nep_c', url: 42, key: null }],
      activeEndpointId: 'nep_c',
    });
    const [first, second, third] = settings.nai.endpoints;
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('接入點 2');
    expect(second.url).toBe('');
    // 非字串歸空串;有效 id 仍被 activeEndpointId 認到
    expect(third.url).toBe('');
    expect(third.key).toBe('');
    expect(settings.nai.activeEndpointId).toBe('nep_c');
  });

  it('newNaiEndpoint 連續呼叫 id 不重複,字首 nep_ 不與 art_/wf_/ch_ 撞', async () => {
    const { newNaiEndpoint } = await import('@/state/settings');
    const ids = [newNaiEndpoint(), newNaiEndpoint(), newNaiEndpoint()].map(e => e.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id.startsWith('nep_'))).toBe(true);
  });
});

describe('effectiveNai:出圖只認當前接入點', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('url/key 取當前條,其餘出圖引數一律沿用渠道級(換站不用重配)', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            url: 'https://legacy.example',
            key: 'legacy-key',
            model: 'nai-diffusion-4-5-full',
            steps: 33,
            endpoints: [
              { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
              { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
            ],
            activeEndpointId: 'nep_a',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, effectiveNai, settings } = await import('@/state/settings');
    await hydrateSettings();

    const conn = effectiveNai();
    expect(conn.url).toBe('https://a.example');
    expect(conn.key).toBe('ka');
    // 渠道級引數原樣帶過來,不因換站而變
    expect(conn.model).toBe('nai-diffusion-4-5-full');
    expect(conn.steps).toBe(33);

    // 切回官方:同一套引數,換個出口
    settings.nai.activeEndpointId = 'nep_official';
    expect(effectiveNai().url).toBe(OFFICIAL);
    expect(effectiveNai().key).toBe('ko');
    expect(effectiveNai().steps).toBe(33);
  });

  it('執行中把 activeEndpointId 改壞 → activeNaiEndpoint 回落第一條,不返回 undefined', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    const { activeNaiEndpoint } = await import('@/state/settings');
    settings.nai.activeEndpointId = 'nep_gone';
    expect(activeNaiEndpoint().id).toBe('nep_a');
  });
});
