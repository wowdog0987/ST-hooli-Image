import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ComfyUI 單套工作流 → 工作流庫的存量遷移。
 *
 * 兩個關鍵點:
 * 1. 老配置的 workflow / naturalLanguage / 橫豎尺寸不搬進第一條預設的話,升級後
 *    使用者配好的工作流會憑空消失(面板變空白、出圖直接失敗)。
 * 2. workflows 恆非空是全域性不變式:面板與出圖門檻都直接取 workflows[0] 兜底,
 *    庫為空會一路 undefined 炸開。髒資料也必須被兜住。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithComfy(comfyui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: comfyui === undefined ? {} : { comfyui } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('ComfyUI 工作流庫遷移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老單套配置折成一條預設,JSON/開關/橫豎尺寸原樣搬入併成為當前項', async () => {
    const settings = await hydrateWithComfy({
      url: 'http://127.0.0.1:8188',
      workflow: '{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}',
      naturalLanguage: true,
      portraitSize: '1024×1536',
      landscapeSize: '1536×1024',
    });

    expect(settings.comfyui.workflows).toHaveLength(1);
    const [preset] = settings.comfyui.workflows;
    expect(preset.name).toBe('我的工作流');
    // 老使用者貼過 JSON:遷移後照舊是自定義工作流,不被新預設的簡易引數蓋掉
    expect(preset.mode).toBe('custom');
    expect(preset.workflow).toBe('{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}');
    expect(preset.naturalLanguage).toBe(true);
    expect(preset.portraitSize).toBe('1024×1536');
    expect(preset.landscapeSize).toBe('1536×1024');
    // 當前項指向它,否則升級後面板顯示空白
    expect(settings.comfyui.activeWorkflowId).toBe(preset.id);
    // url 仍是渠道級,不下沉進預設
    expect(settings.comfyui.url).toBe('http://127.0.0.1:8188');
  });

  it('從未配過(comfyui 鍵缺失)→ 也給一條空預設,不拋錯', async () => {
    const settings = await hydrateWithComfy(undefined);
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
    // 新安裝從簡易引數起步:打開就是選模型的畫面,不用面對空白的工作流 JSON
    expect(settings.comfyui.workflows[0].mode).toBe('simple');
  });

  it('老配置 workflow 是空串 → 仍建這一條(那正是使用者面對的空槽位,不是垃圾資料)', async () => {
    const settings = await hydrateWithComfy({ workflow: '', naturalLanguage: false });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
  });

  it('新格式資料原樣保留,不會被再折一次(遷移冪等)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [
        { id: 'wf_a', name: 'Illustrious', workflow: '{"1":{}}', naturalLanguage: false, portraitSize: '832×1216', landscapeSize: '1216×832' },
        { id: 'wf_b', name: 'Flux', workflow: '{"2":{}}', naturalLanguage: true, portraitSize: '1024×1024', landscapeSize: '1024×1024' },
      ],
      activeWorkflowId: 'wf_b',
    });

    expect(settings.comfyui.workflows.map(w => w.id)).toEqual(['wf_a', 'wf_b']);
    expect(settings.comfyui.workflows.map(w => w.name)).toEqual(['Illustrious', 'Flux']);
    expect(settings.comfyui.activeWorkflowId).toBe('wf_b');
  });

  it('當前項指向已刪條目 → 回落第一條(懸空 id 會讓面板空白、出圖取不到工作流)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ id: 'wf_a', name: 'A', workflow: '{"1":{}}' }],
      activeWorkflowId: 'wf_gone',
    });
    expect(settings.comfyui.activeWorkflowId).toBe('wf_a');
  });

  it('workflows 是空陣列 → 補一條,保住恆非空不變式', async () => {
    const settings = await hydrateWithComfy({ workflows: [], activeWorkflowId: '' });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
  });

  it('條目缺欄位/含髒資料 → 逐項補齊,不變式仍成立', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ name: 'no id' }, null, { id: 'wf_c', workflow: 42, portraitSize: '   ' }],
      activeWorkflowId: 'wf_c',
    });

    expect(settings.comfyui.workflows).toHaveLength(3);
    const [first, second, third] = settings.comfyui.workflows;
    // 缺 id 的補一個,缺名字的給預設名
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('我的工作流');
    // 非字串的 workflow 歸空串;空白尺寸回預設值(不能留空,否則 %width% 拿不到值)
    expect(third.workflow).toBe('');
    expect(third.portraitSize).toBe('832×1216');
    expect(settings.comfyui.activeWorkflowId).toBe('wf_c');
  });

  it('activeComfyPreset / effectiveComfyConn 取的是當前項', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          comfyui: {
            url: 'http://example:8188',
            workflows: [
              { id: 'wf_a', name: 'A', workflow: '{"1":{}}', portraitSize: '832×1216', landscapeSize: '1216×832' },
              { id: 'wf_b', name: 'B', workflow: '{"2":{}}', portraitSize: '1024×1024', landscapeSize: '1024×1024' },
            ],
            activeWorkflowId: 'wf_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeComfyPreset, effectiveComfyConn } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeComfyPreset().name).toBe('B');
    const { simpleDefaults } = await import('@/backends/comfyTemplates');
    expect(effectiveComfyConn()).toEqual({
      url: 'http://example:8188',
      workflow: '{"2":{}}',
      // 存量預設沒有 mode/simple 欄位 → custom + 簡易模式預設值
      mode: 'custom',
      simple: simpleDefaults(),
      portraitSize: '1024×1024',
      landscapeSize: '1024×1024',
    });
  });
});
