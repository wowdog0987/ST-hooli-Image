import { describe, expect, it } from 'vitest';

import { checkSlotHealth, floorIdOf, HOST_HIDE_CLASS } from '@/floor/slotHealth';

/**
 * 倉裡沒裝 jsdom(vitest 跑在 node),故用鴨子型別的假節點。
 * checkSlotHealth / floorIdOf 刻意只碰極小的 DOM 表面(isConnected / closest /
 * classList.contains / getAttribute),正是為了能這樣鎖住判據。
 */
function fakeHost(options: {
  connected?: boolean;
  /** closest(selector) 的返回值表;缺的選擇器返回 null。 */
  ancestors?: Record<string, unknown>;
}): Element {
  const { connected = true, ancestors = {} } = options;
  return {
    isConnected: connected,
    closest: (selector: string) => ancestors[selector] ?? null,
  } as unknown as Element;
}

function fakeMesText(classes: string[]): unknown {
  return { classList: { contains: (name: string) => classes.includes(name) } };
}

function fakeMes(mesid: string | null): unknown {
  return { getAttribute: (name: string) => (name === 'mesid' ? mesid : null) };
}

describe('checkSlotHealth', () => {
  it('reports ok for a connected anchor under a visible .mes_text', () => {
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('ok');
  });

  it('reports detached when the anchor left the document', () => {
    // ST 的 updateMessageBlock / messageEditCancel 整體重寫 .mes_text 的結果
    const host = fakeHost({ connected: false, ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports detached for a missing host', () => {
    expect(checkSlotHealth(null)).toBe('detached');
    expect(checkSlotHealth(undefined)).toBe('detached');
  });

  it('reports hidden-by-host when the ancestor .mes_text carries the hide class', () => {
    // ST 給「有 media 且 inline_image===false」的樓掛 inline_media,style.css 裡是 display:none
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) } });
    expect(checkSlotHealth(host)).toBe('hidden-by-host');
  });

  /**
   * 順序鎖:脫離文件的元素 closest() 仍會沿著**已斷開的子樹**往上走,而那份被 ST
   * 換下來的 .mes_text 完全可能帶著 inline_media。若先判 hidden 再判 detached,
   * 這種樓會被誤診成「只是被藏了」——於是不重掛、只去改一個不在文件裡的節點,
   * 卡片永遠回不來。detached 必須優先。
   */
  it('prefers detached over hidden when both look true', () => {
    const host = fakeHost({
      connected: false,
      ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) },
    });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports ok when the anchor is connected but has no .mes_text ancestor', () => {
    // 別把「結構不認識」當成異常去反覆重掛:不知道怎麼救的情況下什麼都別做
    expect(checkSlotHealth(fakeHost({}))).toBe('ok');
  });
});

describe('floorIdOf', () => {
  it('reads the floor number from the enclosing .mes', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('7') } }))).toBe(7);
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('0') } }))).toBe(0);
  });

  it('returns null when there is no enclosing .mes', () => {
    // 該樓整個不在文件裡(切聊天/懶渲染解除安裝):交給渲染事件,不在自愈裡瞎猜
    expect(floorIdOf(fakeHost({}))).toBeNull();
    expect(floorIdOf(null)).toBeNull();
  });

  it('returns null for a missing or non-numeric mesid', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes(null) } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('') } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('abc') } }))).toBeNull();
    // 負數不是合法樓層號,別拿它去索引 chat
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('-1') } }))).toBeNull();
  });
});
