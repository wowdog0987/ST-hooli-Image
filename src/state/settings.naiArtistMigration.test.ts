import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 畫師串庫的存量與髒資料處理。
 *
 * 與 ComfyUI 工作流庫**刻意相反**的三條,是本檔案的主要看點:
 * 1. 庫允許為空,`naiDefaults` 也不播種任何條目——畫師串是可選調味,
 *    憑空塞一條會讓人以為自己被套了某種畫風;
 * 2. `activeArtistId` 懸空時清成空串,**不**回落第一條。回落等於給使用者靜默換一套畫風,
 *    而下拉顯示的正是那一條(看起來就是自己設的),幾乎無法排查;
 * 3. 純加法遷移,沒有老欄位可折——老配置升級後正向提示詞輸出必須逐位元組不變。
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

describe('NAI 畫師串庫', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量配置沒有這兩個鍵 → 空庫 + 不使用,不拋(升級後出圖提示詞零變化)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('nai 鍵整個缺失 → 同樣是空庫 + 不使用', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('新格式原樣保留,當前項不被動(遷移冪等)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: '厚塗', prompt: 'artist:wlop', quality: 'masterpiece', negative: 'lowres' },
        { id: 'art_b', name: '賽璐璐', prompt: 'artist:as109', quality: '', negative: '' },
      ],
      activeArtistId: 'art_b',
    });
    expect(settings.nai.artistPresets.map(a => a.id)).toEqual(['art_a', 'art_b']);
    expect(settings.nai.artistPresets.map(a => a.name)).toEqual(['厚塗', '賽璐璐']);
    expect(settings.nai.artistPresets[0].quality).toBe('masterpiece');
    expect(settings.nai.artistPresets[0].negative).toBe('lowres');
    expect(settings.nai.activeArtistId).toBe('art_b');
  });

  it('存量條目沒有綁定的正/負面詞鍵 → 補空串(= 跟隨渠道級,升級後提示詞零變化)', async () => {
    // 綁定欄位上線前的老資料只有 id/name/prompt;補空串而非官方詞,
    // 才能保住「配方 → 渠道 → 官方」回落鏈裡老使用者原有的渠道級/官方行為。
    const settings = await hydrateWithNai({
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_a',
    });
    const preset = settings.nai.artistPresets[0];
    expect(preset.quality).toBe('');
    expect(preset.negative).toBe('');
    // 渠道級覆蓋值不受遷移影響
    expect(settings.nai.qualityTags).toBe('channel q');
    expect(settings.nai.undesiredContent).toBe('channel n');
  });

  it('綁定欄位是非字串髒資料 → 歸空串,不整條丟棄', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: 42, negative: null }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets[0].quality).toBe('');
    expect(settings.nai.artistPresets[0].negative).toBe('');
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('previewPath:合法字串保留,缺失/髒資料視為無預覽', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: 'A', prompt: '', previewPath: '/user/images/柏宝绘_画师串/art_a.jpg' },
        { id: 'art_b', name: 'B', prompt: '' },
        { id: 'art_c', name: 'C', prompt: '', previewPath: 42 },
        { id: 'art_d', name: 'D', prompt: '', previewPath: '' },
      ],
      activeArtistId: '',
    });
    const [a, b, c, d] = settings.nai.artistPresets;
    expect(a.previewPath).toBe('/user/images/柏宝绘_画师串/art_a.jpg');
    expect(b.previewPath).toBeUndefined();
    expect(c.previewPath).toBeUndefined();
    expect(d.previewPath).toBeUndefined();
  });

  it('當前項指向已刪條目 → 清成空串,**不**回落第一條', async () => {
    // 與 normalizeComfyUI 的「懸空回落 workflows[0]」刻意不同:那裡工作流是必需品,
    // 這裡回落會給使用者靜默套上一套沒選過的畫風,每張圖都變樣卻查不出原因。
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_gone',
    });
    expect(settings.nai.activeArtistId).toBe('');
    // 庫本身不受影響,條目還在
    expect(settings.nai.artistPresets).toHaveLength(1);
  });

  it('庫為空陣列但 id 非空 → id 清空,庫保持空(不補條目,與工作流庫的恆非空相反)', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'art_x' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('activeArtistId 不是字串 → 清成空串', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 42,
    });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('條目缺欄位/含髒資料 → 逐項補齊,不整條丟棄', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ name: 'no id' }, null, { id: 'art_c', prompt: 42 }],
      activeArtistId: 'art_c',
    });

    expect(settings.nai.artistPresets).toHaveLength(3);
    const [first, second, third] = settings.nai.artistPresets;
    // 缺 id 的補一個,名字保留
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    // null 條目也補齊成可用的空槽位,名字按序號給
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('畫師串 2');
    expect(second.prompt).toBe('');
    // 非字串 prompt 歸空串;有效 id 仍被 activeArtistId 認到
    expect(third.prompt).toBe('');
    expect(settings.nai.activeArtistId).toBe('art_c');
  });

  it('prompt 是空串的條目照樣保留(那是使用者面對的空槽位,不是垃圾資料)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: '待填', prompt: '' }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets).toHaveLength(1);
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('activeNaiArtist 取當前項;未選 / 懸空時返回 null', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            artistPresets: [
              { id: 'art_a', name: 'A', prompt: 'artist:a' },
              { id: 'art_b', name: 'B', prompt: 'artist:b' },
            ],
            activeArtistId: 'art_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeNaiArtist, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeNaiArtist()?.name).toBe('B');
    expect(activeNaiArtist()?.prompt).toBe('artist:b');

    // 切到「不使用」
    settings.nai.activeArtistId = '';
    expect(activeNaiArtist()).toBeNull();

    // 懸空(UI 執行中把庫改壞這種時序)也返回 null,而不是兜底成第一條
    settings.nai.activeArtistId = 'art_gone';
    expect(activeNaiArtist()).toBeNull();
  });

  it('newNaiArtist 連續呼叫 id 不重複(同一毫秒內也不撞)', async () => {
    const { newNaiArtist } = await import('@/state/settings');
    const ids = [newNaiArtist(), newNaiArtist(), newNaiArtist()].map(a => a.id);
    expect(new Set(ids).size).toBe(3);
    // art_ 字首不與 wf_ / ch_ 的 id 空間相撞
    expect(ids.every(id => id.startsWith('art_'))).toBe(true);
  });
});

describe('內建畫師串(bi_*)與新老使用者', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('全新安裝(沒有任何已存設定)→ 預設啟用內建「預設畫師串」', async () => {
    // 預設只在這條路徑生效:stored 整個不存在時,模組級預設值直接被寫進 extension_settings。
    mocks.context = {
      extensionSettings: {},
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();
    expect(settings.nai.activeArtistId).toBe('bi_default');
    expect(settings.nai.artistPresets).toEqual([]); // 使用者庫仍為空:內建條不進 settings
  });

  it('老使用者:已存的 activeArtistId 原樣保留(空串 = 不使用,不會被預設值頂掉)', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      artistPresets: [],
      activeArtistId: '',
    });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('老使用者的存量 nai 段沒有 activeArtistId 鍵 → 空串,不吃新裝預設', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('選中內建條目的配置:使用者庫為空也不算懸空,normalize 不清掉', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(settings.nai.activeArtistId).toBe('bi_default');
  });

  it('bi_ 字首但 id 不存在(內建條目下線後)→ 仍按懸空清成空串', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(settings.nai.activeArtistId).toBe('');
  });
});
