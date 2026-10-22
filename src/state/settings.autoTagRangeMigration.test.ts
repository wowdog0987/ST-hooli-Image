import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 單樓圖片數量由單一 maxImages 升級為 minImages～maxImages。
 * 存量使用者不能因為升級被突然強制每樓出圖，因此缺少 minImages 必須遷移為 0；
 * 髒範圍也要在 hydrate 時歸一，避擴音示詞與解析器收到 min > max。
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithAutoTag(autoTag: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: autoTag === undefined ? {} : { autoTag } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings.autoTag;
}

describe('自動 tag 圖片數量範圍遷移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('舊配置只有 maxImages 時補 minImages=0,保留允許無圖的行為', async () => {
    const autoTag = await hydrateWithAutoTag({ maxImages: 5 });
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(5);
  });

  it('新裝預設範圍為 0～2', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(2);
  });

  it('把下限夾進 0～上限,並保證上限至少為 1', async () => {
    const tooHigh = await hydrateWithAutoTag({ minImages: 9, maxImages: 3 });
    expect(tooHigh.minImages).toBe(3);
    expect(tooHigh.maxImages).toBe(3);

    vi.resetModules();
    const negative = await hydrateWithAutoTag({ minImages: -4, maxImages: 0 });
    expect(negative.minImages).toBe(0);
    expect(negative.maxImages).toBe(1);
  });
});
