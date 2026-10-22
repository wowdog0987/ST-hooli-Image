import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NAI_MIN_INTERVAL_MS,
  noteNaiRateLimited,
  setNaiMinInterval,
} from '@/backends/naiRateLimit';
import { acquireNaiSlot, naiSlotBusy, resetNaiGate, setNaiConcurrency } from '@/floor/genQueue';

describe('NAI 併發閘門', () => {
  beforeEach(() => {
    resetNaiGate();
    // 本組只驗併發,把節奏關掉;節奏另有一組(見下)。
    setNaiMinInterval(0);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  it('預設上限 1:第二個請求要等第一個 release', async () => {
    const release1 = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);

    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    // 還沒 release,第二個不該拿到槽
    await Promise.resolve();
    expect(granted).toBe(false);

    release1();
    const release2 = await pending;
    expect(granted).toBe(true);
    release2();
    expect(naiSlotBusy()).toBe(false);
  });

  it('上限內的請求立刻通過', async () => {
    setNaiConcurrency(2);
    const a = await acquireNaiSlot();
    const b = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
    b();
    expect(naiSlotBusy()).toBe(false);
  });

  it('調大上限立刻放行等待中的任務', async () => {
    const first = await acquireNaiSlot();
    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    setNaiConcurrency(3);
    const second = await pending;
    expect(granted).toBe(true);
    first();
    second();
  });

  it('已取消的 signal 直接拋錯,不佔槽位', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireNaiSlot(controller.signal)).rejects.toThrow();
    expect(naiSlotBusy()).toBe(false);
  });

  it('排隊期間被取消:拋錯並從佇列摘除,不會之後再佔槽', async () => {
    const release1 = await acquireNaiSlot();
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    // 尚在排隊時取消
    controller.abort();
    await expect(pending).rejects.toThrow();

    // 釋放第一個後,被取消的那個不該悄悄佔用槽位
    release1();
    expect(naiSlotBusy()).toBe(false);
    const release2 = await acquireNaiSlot();
    release2();
  });

  it('release 冪等:重複呼叫不會把計數減穿', async () => {
    const release = await acquireNaiSlot();
    release();
    release();
    release();
    expect(naiSlotBusy()).toBe(false);
    // 計數沒被減成負數 → 仍只允許 1 個併發
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });

  it('併發上限至少為 1(非法值兜底)', async () => {
    setNaiConcurrency(0);
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });
});

describe('NAI 全域性節奏(閘門側)', () => {
  /** 用小間隔跑真即時鍾:比假時鐘更能驗到「持槽等待」的真實次序。 */
  const INTERVAL = 40;

  beforeEach(() => {
    resetNaiGate();
    setNaiMinInterval(INTERVAL);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    resetNaiGate();
  });

  it('第一個請求不等待', async () => {
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeLessThan(INTERVAL);
    release();
  });

  it('相鄰兩個請求之間至少隔一個最小間隔', async () => {
    const first = await acquireNaiSlot();
    first();
    const started = Date.now();
    const second = await acquireNaiSlot();
    // 時鐘精度留 5ms 餘量
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    second();
  });

  it('節奏等待持槽進行:上限 2 時第二個也得排在第一個之後,不會同時放行', async () => {
    setNaiConcurrency(2);
    const started = Date.now();
    const [a, b] = await Promise.all([acquireNaiSlot(), acquireNaiSlot()]);
    // 兩個都在上限內,但第二個仍要等完間隔——否則「併發 2」等於「同時發 2 個」
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    a();
    b();
  });

  it('429 冷卻會攔住新任務取槽', async () => {
    noteNaiRateLimited(120);
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
    release();
  });

  it('節奏等待期間被取消:拋錯且把槽還回去(不洩漏)', async () => {
    noteNaiRateLimited(5000);
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    // 此刻已持槽、正在等冷卻
    expect(naiSlotBusy()).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // 槽已歸還:否則併發永久少一格
    expect(naiSlotBusy()).toBe(false);
  });
});
