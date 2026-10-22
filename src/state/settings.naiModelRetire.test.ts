import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 4.5 以下的 NAI 模型下線(NAI_MODELS 只留 4.5/V5)後的存量處理。
 *
 * 關鍵點:白名單收窄會**改寫**使用者存著的模型 —— 畫風、Anlas 消耗與 vibe 編碼 key 全變。
 * 這是有意接受的代價(那批模型已基本無人使用),所以這裡鎖的不是「別改」,而是
 * 「只改該改的那些、且留下痕跡」:在列模型一個位元組都不許動,下線模型必須回落到
 * 預設模型並打一條 console.warn(否則「我的模型自己變了」這類反饋無據可查)。
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithModel(model: unknown) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai: { model } } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI 舊模型下線後的存量模型處理', () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    warn = vi.fn();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('console', { ...console, warn });
  });

  it.each(['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'])(
    '已下線的 %s 回落到預設模型,並留一條告警',
    async retired => {
      const settings = await hydrateWithModel(retired);
      expect(settings.nai.model).toBe('nai-diffusion-5-full');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(retired));
    },
  );

  it.each([
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
  ])('在列的 %s 原樣保留,不打擾', async kept => {
    const settings = await hydrateWithModel(kept);
    expect(settings.nai.model).toBe(kept);
    expect(warn).not.toHaveBeenCalled();
  });

  it('壓根沒存過模型的配置走預設值,不算「被下線」', async () => {
    const settings = await hydrateWithModel(undefined);
    expect(settings.nai.model).toBe('nai-diffusion-5-full');
    expect(warn).not.toHaveBeenCalled();
  });
});
