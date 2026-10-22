import { describe, expect, it } from 'vitest';

import { mapLimit } from '@/pool';

/** 受控 promise:讓測試自己決定每個任務何時完成。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapLimit', () => {
  it('返回順序與輸入一致,而非完成順序', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapLimit([0, 1, 2], 3, async i => {
      await gates[i].promise;
      return `r${i}`;
    });
    // 倒著放行:若按完成順序收集,結果會是 r2,r1,r0
    gates[2].resolve();
    gates[1].resolve();
    gates[0].resolve();
    expect(await run).toEqual(['r0', 'r1', 'r2']);
  });

  it('同時在跑的任務數不超過 limit', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const run = mapLimit(gates, 2, async gate => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return 1;
    });
    // 先讓前兩個起跑,再逐個放行,始終不該超過 2
    await Promise.resolve();
    gates.forEach(gate => gate.resolve());
    await run;
    expect(peak).toBe(2);
  });

  it('慢任務不拖住整片:worker 各自取下一個未領的下標', async () => {
    const slow = deferred<void>();
    const order: number[] = [];
    const run = mapLimit([0, 1, 2, 3], 2, async i => {
      // 0 號一直卡著,1 號之後的都該由另一個 worker 順次做完
      if (i === 0) await slow.promise;
      order.push(i);
      return i;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([1, 2, 3]);
    slow.resolve();
    expect(await run).toEqual([0, 1, 2, 3]);
  });

  it('空輸入直接返回空陣列,不起 worker', async () => {
    let calls = 0;
    expect(
      await mapLimit([], 4, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it.each([0, -3, NaN])('非法 limit 回落到序列而不是死鎖: %s', async limit => {
    expect(await mapLimit([1, 2, 3], limit, async n => n * 2)).toEqual([2, 4, 6]);
  });

  it('limit 大於條數時不會多起 worker', async () => {
    expect(await mapLimit([1, 2], 99, async n => n)).toEqual([1, 2]);
  });
});
