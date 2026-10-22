import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

import {
  confirmImageMissing,
  isImageMissing,
  markImageMissing,
  markImagesMissing,
  normalizeImagePath,
  resetMissingImages,
} from '@/floor/missingImages';
import { probeUserImage } from '@/st/images';

vi.mock('@/st/images', () => ({ probeUserImage: vi.fn() }));

beforeEach(() => {
  resetMissingImages();
  vi.mocked(probeUserImage).mockReset();
});

describe('normalizeImagePath', () => {
  it('解碼並去掉前導斜槓,讓 extra 與相簿兩側的寫法能相等', () => {
    // extra 裡是服務端原樣返回的未編碼路徑,相簿那邊是逐段 encodeURIComponent 的
    const fromExtra = '/user/images/柏宝绘_爱丽丝/bbi_a_0_b-g1.png';
    const fromGallery = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/bbi_a_0_b-g1.png';
    expect(normalizeImagePath(fromExtra)).toBe(normalizeImagePath(fromGallery));
  });

  it('半截百分號編碼不拋錯,按原文比', () => {
    expect(normalizeImagePath('/user/images/100%/a.png')).toBe('user/images/100%/a.png');
  });
});

describe('missingImages', () => {
  it('標記後按歸一化口徑命中,編碼與否都認', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png')).toBe(true);
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/a.png')).toBe(true);
  });

  it('未標記的圖不算缺失', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/b.png')).toBe(false);
  });

  it('批次標記', () => {
    markImagesMissing(['/user/images/f/a.png', '/user/images/f/b.png']);
    expect(isImageMissing('/user/images/f/a.png')).toBe(true);
    expect(isImageMissing('/user/images/f/b.png')).toBe(true);
  });

  it('空路徑既不寫入也不命中', () => {
    markImageMissing('');
    expect(isImageMissing('')).toBe(false);
  });
});

describe('confirmImageMissing', () => {
  const path = '/user/images/柏宝绘_爱丽丝/a.png';

  it('服務端明確 404 才落冊', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('探不清(網路錯誤/500)絕不落冊', async () => {
    // <img> 的 error 分不清「檔案沒了」和「網斷了」。把掉線記成刪除,
    // 使用者網一抖就滿屏「檔案已刪除」,且重新整理前好不了。
    vi.mocked(probeUserImage).mockResolvedValue(null);
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('檔案還在則不落冊', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: true, size: 1024 });
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('同一張圖只探一次:已在冊的直接返回,併發的後來者不重複發請求', async () => {
    let settle!: (probe: { exists: false }) => void;
    vi.mocked(probeUserImage).mockReturnValue(new Promise(resolve => { settle = resolve; }));
    // 重水合會重掛 <img>,error 會再來一遍
    const first = confirmImageMissing(path);
    expect(await confirmImageMissing(path)).toBe(false); // 在途,不再發第二個 HEAD
    settle({ exists: false });
    expect(await first).toBe(true);
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);

    expect(await confirmImageMissing(path)).toBe(true); // 已在冊,直接命中
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);
  });

  it('只認 user/images 下的圖:老圖與外來路徑一律不探', async () => {
    // user/files 裡的老圖本外掛不刪,沒有「被相簿刪掉」這條路徑
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing('/user/files/old.png')).toBe(false);
    expect(await confirmImageMissing('https://example.com/a.png')).toBe(false);
    expect(await confirmImageMissing('')).toBe(false);
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
  });

  it('編碼過的路徑也認得出是 user/images,並與未編碼寫法同鍵', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    const encoded = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png';
    expect(await confirmImageMissing(encoded)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('探測丟擲時釋放在途標記,下次還能重試', async () => {
    vi.mocked(probeUserImage).mockRejectedValueOnce(new Error('boom'));
    await expect(confirmImageMissing(path)).rejects.toThrow('boom');
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
  });
});

describe('響應式', () => {
  // 卡片的 liveHistory/liveStale/filesGone 全是 computed(isImageMissing(...))。
  // 本冊若退化成普通 Set,標記後卡片不會重算——相簿刪完圖,已開啟的樓層照舊顯示破圖,
  // 要等下一次水合才好。這條鎖的是「標記能推動 computed」,不是 Set 的語義。
  it('標記後 computed 立刻重算', () => {
    const a = '/user/images/f/a.png';
    const gone = computed(() => isImageMissing(a));
    expect(gone.value).toBe(false);
    markImageMissing(a);
    expect(gone.value).toBe(true);
  });

  it('只驚動被標記的那張,不連坐同目錄的其它圖', () => {
    const b = '/user/images/f/b.png';
    const gone = computed(() => isImageMissing(b));
    expect(gone.value).toBe(false);
    markImageMissing('/user/images/f/a.png');
    expect(gone.value).toBe(false);
  });
});
