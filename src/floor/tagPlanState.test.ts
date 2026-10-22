import { beforeEach, describe, expect, it } from 'vitest';

import { awaitTagPlan, clearAllTagPlans, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';

const KEY = 'c|1|0|0';

/** 手動控制收尾時機的 deferred(不用計時器,避免測試靠睡眠) */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('tagPlanState', () => {
  beforeEach(() => {
    clearAllTagPlans();
  });

  it('跑起來即處於重寫中,收尾後清除', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    expect(isTagPlanning(KEY)).toBe(true);
    gate.resolve();
    await task;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('舊任務的收尾不得清掉新任務的記錄', async () => {
    const first = deferred();
    const second = deferred();
    const firstTask = runTagPlan(KEY, () => first.promise);
    const secondTask = runTagPlan(KEY, () => second.promise);
    first.resolve();
    await firstTask;
    // 先開的那個收尾了,但 key 上現在是後開的那個,展示態必須還亮著
    expect(isTagPlanning(KEY)).toBe(true);
    second.resolve();
    await secondTask;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  /**
   * 彈窗「續上」的命門:關掉彈窗不中斷重寫,重開時要能 await 回同一個在途請求。
   * 若這裡返回的不是同一個 promise,重開的彈窗就只會乾轉圈、等不到收尾。
   */
  it('awaitTagPlan 取回的是同一個在途 promise', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    const rejoined = awaitTagPlan(KEY);
    expect(rejoined).toBe(task);
    gate.resolve();
    await task;
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  it('無在途任務時 awaitTagPlan 返回 null', () => {
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  /** 請求失敗也必須摘掉執行態,否則那一槽會永遠卡在「重寫中」再也點不動。 */
  it('run 拋錯時照樣清除執行態,並把錯誤拋給呼叫方', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    gate.reject(new Error('boom'));
    await expect(task).rejects.toThrow('boom');
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('clearAllTagPlans 清空全部槽位', () => {
    runTagPlan(KEY, () => deferred().promise);
    runTagPlan('c|2|0|0', () => deferred().promise);
    clearAllTagPlans();
    expect(isTagPlanning(KEY)).toBe(false);
    expect(isTagPlanning('c|2|0|0')).toBe(false);
  });
});
