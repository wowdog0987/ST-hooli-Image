import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 思維鏈由三後端共用一份拆成 comfy / nai / naiV5 三份。
 *
 * 存量使用者的自定義 thinking 一律是照 ComfyUI 形態寫的(單串 tag + 鄰接綁定),
 * 只遷進同形態的 comfyThinking 與 naiThinking;naiV5Thinking 必須留空回落新預設——
 * 把 ComfyUI 口徑灌進 V5 等於把「思維鏈要求它做規範明令禁止的事」這個 bug 固化下來。
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

describe('思維鏈按後端拆分的設定遷移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('舊的單份 thinking 遷進 comfy 與 nai,V5 留空', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { thinking: '我改過的清單' },
    });
    expect(autoTag.prompts.comfyThinking).toBe('我改過的清單');
    expect(autoTag.prompts.naiThinking).toBe('我改過的清單');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('新裝三份都為空(回落各自內建預設)', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.prompts.comfyThinking).toBe('');
    expect(autoTag.prompts.naiThinking).toBe('');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('已按新欄位存過的值不被舊 thinking 覆蓋', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: {
        thinking: '舊的',
        comfyThinking: '新的 comfy',
        naiThinking: '新的 nai',
        naiV5Thinking: '新的 V5',
      },
    });
    expect(autoTag.prompts.comfyThinking).toBe('新的 comfy');
    expect(autoTag.prompts.naiThinking).toBe('新的 nai');
    expect(autoTag.prompts.naiV5Thinking).toBe('新的 V5');
  });

  it('拆分不動同批次的其餘提示詞欄位', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { jailbreak: '破限', comfySpec: '我的規範', thinking: '我的清單' },
    });
    expect(autoTag.prompts.jailbreak).toBe('破限');
    expect(autoTag.prompts.comfySpec).toBe('我的規範');
    expect(autoTag.prompts.naiSpec).toBe('');
    expect(autoTag.prompts.naiV5Spec).toBe('');
    expect(autoTag.prompts.prefill).toBe('');
  });
});
