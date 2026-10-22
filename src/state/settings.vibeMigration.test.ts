import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
  saveVibeFiles: vi.fn(),
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

// 只替換真正需要攔截的 saveVibeFiles(要斷言呼叫與失敗路徑),其餘匯出取真身。
// 曾經這裡手抄了 vibeFingerprint / vibeMetaFromData 的實現,於是 vibeStore 每加一個
// 匯出都會讓本檔案以「No xxx export is defined on the mock」炸掉,且抄件與真身還會悄悄漂移。
vi.mock('@/backends/vibeStore', async () => ({
  ...(await vi.importActual<typeof import('@/backends/vibeStore')>('@/backends/vibeStore')),
  saveVibeFiles: mocks.saveVibeFiles,
}));

describe('舊版 Vibe 設定遷移', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.saveVibeFiles.mockReset();
    vi.stubGlobal('toastr', {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  it('把大欄位上傳後只留下檔案路徑和小型索引', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-v1',
      name: '舊 Vibe',
      image: 'A'.repeat(1024),
      thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
      encodings: { 'v4-5full': { encoding: 'B'.repeat(512), infoExtracted: 1 } },
      strength: 0.7,
      enabled: true,
    };
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: { vibes: [legacy] },
        },
      },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockResolvedValue({
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
    });

    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(mocks.saveVibeFiles).toHaveBeenCalledOnce();
    expect(settings.nai.vibes[0]).toMatchObject({
      id: 'legacy-v1',
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
      strength: 0.7,
      enabled: true,
    });
    const persisted = mocks.context.extensionSettings.baibai_image.nai.vibes[0];
    expect(persisted).not.toHaveProperty('image');
    expect(persisted).not.toHaveProperty('thumbnail');
    expect(persisted).not.toHaveProperty('encodings');
    expect(saveSettingsDebounced).toHaveBeenCalled();
  });

  it('每條落盤後立即釋放該條大欄位', async () => {
    const vibes = [
      { id: 'legacy-1', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-2', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced: vi.fn(),
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/1.json', thumbnailPath: '' })
      .mockImplementationOnce(async () => {
        expect(vibes[0]).not.toHaveProperty('image');
        expect(vibes[1]).toHaveProperty('image');
        return { dataPath: '/user/files/2.json', thumbnailPath: '' };
      });

    const { hydrateSettings } = await import('@/state/settings');
    await hydrateSettings();

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).not.toHaveProperty('image');
  });

  it('單條儲存失敗時保留原資料且不進入正常設定回寫', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-failed',
      image: 'A'.repeat(1024),
      thumbnail: '',
      encodings: {},
    };
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes: [legacy] } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockRejectedValue(new Error('server 與 IndexedDB 都失敗'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('server 與 IndexedDB 都失敗');

    expect(mocks.context.extensionSettings.baibai_image.nai.vibes[0]).toBe(legacy);
    expect(legacy).toHaveProperty('image');
    expect(saveSettingsDebounced).not.toHaveBeenCalled();
  });

  it('部分失敗時儲存已釋放條目並保留失敗條目', async () => {
    const saveSettingsDebounced = vi.fn();
    const vibes = [
      { id: 'legacy-ok', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-failed', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/ok.json', thumbnailPath: '' })
      .mockRejectedValueOnce(new Error('第二條失敗'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('第二條失敗');

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).toHaveProperty('image');
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });
});
