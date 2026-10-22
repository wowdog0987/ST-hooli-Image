import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeGenCount,
  beginGen,
  cancelGen,
  clearAllGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  pruneGenSlots,
  reconcileGen,
  setGenPhase,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';

const KEY = slotKey('chat1', 3, 0, 0);

describe('genState', () => {
  beforeEach(() => {
    clearAllGen();
  });

  it('slotKey 區分 chat / 樓層 / swipe / 槽位', () => {
    expect(slotKey('c', 1, 0, 0)).toBe('c|1|0|0');
    expect(slotKey('c', 1, 0, 1)).not.toBe(slotKey('c', 1, 0, 0));
    expect(slotKey('c', 1, 1, 0)).not.toBe(slotKey('c', 1, 0, 0));
    expect(slotKey('d', 1, 0, 0)).not.toBe(slotKey('c', 1, 0, 0));
  });

  it('beginGen 登記執行態並給出未取消的 signal', () => {
    const { signal } = beginGen(KEY, 'hash1');
    expect(signal.aborted).toBe(false);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', error: '', hash: 'hash1' });
  });

  it('同槽位再次 beginGen 會中止上一個任務', () => {
    const first = beginGen(KEY, 'hash1');
    const second = beginGen(KEY, 'hash1');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('每個任務拿到不同票據', () => {
    const a = beginGen(KEY, 'hash1');
    const b = beginGen(KEY, 'hash1');
    expect(a.token).not.toBe(b.token);
    expect(isCurrentGen(KEY, a.token)).toBe(false);
    expect(isCurrentGen(KEY, b.token)).toBe(true);
  });

  it('cancelGen 中止在途請求並清掉記錄', () => {
    const { signal } = beginGen(KEY, 'hash1');
    cancelGen(KEY);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('failGen 保留 error 相位與資訊(重水合後仍可見)', () => {
    const { token } = beginGen(KEY, 'hash1');
    failGen(KEY, token, '出圖失敗了');
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'error', error: '出圖失敗了' });
  });

  it('clearGen 清空記錄,卡片回落派生態', () => {
    const { token } = beginGen(KEY, 'hash1');
    clearGen(KEY, token);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('setGenPhase / setQueueAhead 就地更新展示態', () => {
    const { token } = beginGen(KEY, 'hash1', 'queued');
    expect(getGenRecord(KEY)?.phase).toBe('queued');
    setGenPhase(KEY, token, 'generating');
    setQueueAhead(KEY, token, 2);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', queueAhead: 2 });
  });

  it('reconcileGen:hash 變了才作廢在途任務', () => {
    const { signal } = beginGen(KEY, 'hash1');
    // 同 hash:不動
    expect(reconcileGen(KEY, 'hash1')).toBe(false);
    expect(signal.aborted).toBe(false);
    // hash 變了(使用者改了 tag):舊任務作廢
    expect(reconcileGen(KEY, 'hash2')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  /**
   * 迴歸:舊任務遲到的回撥不得改到新任務頭上。
   * 典型觸發——A 被 abort 後以非 AbortError 失敗(HTTP 500/429 與 abort 撞車),
   * 其 catch 若無票據校驗就會把正在跑的 B 標成 error。
   */
  describe('票據隔離(舊任務不得汙染新任務)', () => {
    it('舊任務 failGen 不影響新任務', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      failGen(KEY, a.token, 'A 的報錯');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', token: b.token });
      expect(getGenRecord(KEY)?.error).toBe('');
    });

    it('舊任務 clearGen 不會清掉新任務', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      clearGen(KEY, a.token);
      expect(getGenRecord(KEY)?.token).toBe(b.token);
    });

    it('舊任務 setQueueAhead / setGenPhase 被忽略', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h', 'queued');
      setQueueAhead(KEY, a.token, 99);
      setGenPhase(KEY, a.token, 'error');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'queued', queueAhead: null, token: b.token });
    });

    it('isCurrentGen 讓舊任務在落盤前自我放棄', () => {
      const a = beginGen(KEY, 'h');
      expect(isCurrentGen(KEY, a.token)).toBe(true);
      cancelGen(KEY);
      // 記錄已清:遲到的 A 不該再落盤
      expect(isCurrentGen(KEY, a.token)).toBe(false);
    });
  });

  it('reconcileGen 對無記錄的槽位是安全空操作', () => {
    expect(reconcileGen(KEY, 'hash1')).toBe(false);
  });

  it('clearAllGen 中止全部並清空(切聊天/刪樓)', () => {
    const a = beginGen(slotKey('c', 1, 0, 0), 'h');
    const b = beginGen(slotKey('c', 2, 0, 0), 'h');
    clearAllGen();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(activeGenCount()).toBe(0);
  });

  it('activeGenCount 只數在途,不數 error', () => {
    beginGen(slotKey('c', 1, 0, 0), 'h');
    beginGen(slotKey('c', 2, 0, 0), 'h', 'queued');
    const failed = slotKey('c', 3, 0, 0);
    const { token } = beginGen(failed, 'h');
    failGen(failed, token, 'boom');
    expect(activeGenCount()).toBe(2);
  });

  describe('pruneGenSlots', () => {
    it('刪掉越界槽位(tag 變少後消失的那些),保留仍存在的', () => {
      const kept = slotKey('c', 5, 0, 0);
      const gone = slotKey('c', 5, 0, 2);
      const { signal: keptSignal } = beginGen(kept, 'h');
      const { signal: goneSignal } = beginGen(gone, 'h');
      // 正文現在只剩 1 個 tag → seq >= 1 的都該清掉
      pruneGenSlots('c', 5, 0, 1);
      expect(getGenRecord(kept)).toBeDefined();
      expect(keptSignal.aborted).toBe(false);
      expect(getGenRecord(gone)).toBeUndefined();
      expect(goneSignal.aborted).toBe(true);
    });

    it('清掉消失槽位殘留的 error,同 key 復現時不會認領舊報錯', () => {
      const key = slotKey('c', 5, 0, 1);
      const { token } = beginGen(key, 'h');
      failGen(key, token, '上一輪的報錯');
      // tag 全被刪掉
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(key)).toBeUndefined();
    });

    it('不誤傷其它樓層 / 其它 swipe', () => {
      const otherFloor = slotKey('c', 6, 0, 3);
      const otherSwipe = slotKey('c', 5, 1, 3);
      beginGen(otherFloor, 'h');
      beginGen(otherSwipe, 'h');
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(otherFloor)).toBeDefined();
      expect(getGenRecord(otherSwipe)).toBeDefined();
    });

    it('keepCount 覆蓋全部槽位時什麼都不動(出圖成功後的常規重水合)', () => {
      const a = slotKey('c', 5, 0, 0);
      const b = slotKey('c', 5, 0, 1);
      const { signal: aSignal } = beginGen(a, 'h');
      const { signal: bSignal } = beginGen(b, 'h');
      // 關鍵迴歸:重水合不得 abort 正在生成的兄弟槽位
      pruneGenSlots('c', 5, 0, 2);
      expect(aSignal.aborted).toBe(false);
      expect(bSignal.aborted).toBe(false);
      expect(activeGenCount()).toBe(2);
    });
  });
});
