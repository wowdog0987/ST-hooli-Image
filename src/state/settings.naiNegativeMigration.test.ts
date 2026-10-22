import { beforeEach, describe, expect, it, vi } from 'vitest';

import { naiDefaultUndesired } from '@/backends/nai';

/**
 * 「附加負面」併入負面提示詞一個框後的存量遷移。
 * 關鍵點:老配置裡的 negativePrompt 若不搬進 undesiredContent,升級後會靜默失效——
 * 使用者當初排除掉的內容會悄悄回到畫面裡,而 UI 上看不出任何異常。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('負面提示詞並框遷移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量附加負面折進負面提示詞,按當年順序:附加在前 + 官方詞在後', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.undesiredContent).toBe(`bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-full')}`);
    // 搬完就清空,不留一份會讓人以為還生效的影子值
    expect(settings.nai.negativePrompt).toBe('');
  });

  it('摺進去時用的是該配置自己的模型,不是預設模型', async () => {
    // 與預設模型(5-full)不同的另一個在列模型:已下線的舊模型會被白名單改寫成預設,
    // 那樣就測不出「用的是誰的模型」了。
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-curated',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.undesiredContent).toBe(
      `bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-curated')}`,
    );
  });

  it('已有 undesiredContent 時不動它(遷移只跑一次,不會重複追加)', async () => {
    const settings = await hydrateWithNai({ undesiredContent: 'mine only', negativePrompt: 'bad hands' });
    expect(settings.nai.undesiredContent).toBe('mine only');
  });

  it('已遷移過、且使用者有意清空成跟隨官方 → 保持空串,不被再折一次', async () => {
    const settings = await hydrateWithNai({ undesiredContent: '', negativePrompt: 'bad hands' });
    expect(settings.nai.undesiredContent).toBe('');
  });

  it('沒有存量附加負面 → 留空(跟隨模型官方詞)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full' });
    expect(settings.nai.undesiredContent).toBe('');
  });
});
