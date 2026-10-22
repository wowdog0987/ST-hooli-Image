import type { VNode } from 'vue';

/**
 * 樓層卡片掛載記錄表（DESIGN-FLOOR-UI.md §6.2）。
 *
 * key = (chatId, mesid, swipeId, seq)：
 * - mesid 定位樓層，seq 定位樓層內第 N 個錨點（DOM 順序 = tag 序號）。
 * - swipeId 進 key，滑動切換時各 swipe 的記錄互不汙染。
 * - 重水合時同錨點的槽位直接 patch（hydrate.ts 差分策略）；錨點更換或槽位消失
 *   時必須 render(null, container) 顯式解除安裝舊 vnode，再掛新樹。
 */
export interface SlotRecord {
  /**
   * vnode 的渲染容器：錨點 div 的 shadow root（hydrate.ts 給每個錨點 attachShadow，
   * 讓卡片與 ST 全域性樣式雙向隔離）。render(null, container) 解除安裝。
   */
  container: ShadowRoot;
  vnode: VNode;
}

export class SlotRegistry {
  private records = new Map<string, SlotRecord>();

  key(chatId: string | undefined, mesid: number, swipeId: number | undefined, seq: number): string {
    return `${chatId ?? '-'}|${mesid}|${swipeId ?? '-'}|${seq}`;
  }

  /** 某訊息的全部槽位 key（跨 swipeId）。重水合該訊息前用它清理舊記錄。 */
  keysByMessage(chatId: string | undefined, mesid: number): string[] {
    const prefix = `${chatId ?? '-'}|${mesid}|`;
    return [...this.records.keys()].filter(key => key.startsWith(prefix));
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  get(key: string): SlotRecord | undefined {
    return this.records.get(key);
  }

  set(key: string, record: SlotRecord): void {
    this.records.set(key, record);
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  /** 全部記錄（解除安裝時遍歷用）。 */
  all(): SlotRecord[] {
    return [...this.records.values()];
  }

  /** 全部 key（解除安裝時遍歷用）。 */
  keys(): string[] {
    return [...this.records.keys()];
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
