import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { STBaiBaiImageApi } from '@/public/types';
import { charTagLib, emptyCharFields, type CharTagEntry } from '@/state/charTags';

vi.mock('@/st/context', () => ({ getContext: () => ({ getCurrentChatId: () => 'chat-a' }) }));

// 本外掛跑在瀏覽器裡,ready/changed 是**真事件**;測試環境是 node,沒有 window。
// 拿 EventTarget 當替身:addEventListener/dispatchEvent 語義與瀏覽器一致,
// 足以鎖住「第三方能不能收到通知」這件事。必須在 import register 之前建好。
vi.stubGlobal('window', new EventTarget());

const { PUBLIC_CHANGED_EVENT, PUBLIC_READY_EVENT, registerPublicInterface } =
  await import('@/public/register');

function api(): STBaiBaiImageApi {
  return (globalThis as { STBaiBaiImage?: STBaiBaiImageApi }).STBaiBaiImage!;
}

function entry(name: string): CharTagEntry {
  return { name, fields: emptyCharFields(), raw: '', nl: '', source: 'ai', desc: '', history: [] };
}

/** 等 queueMicrotask 與 Vue watch 的 flush 都跑完。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  charTagLib.entries = [];
});

describe('registerPublicInterface', () => {
  it('publishes on globalThis and announces readiness (the two ways to find it)', async () => {
    const ready = vi.fn();
    // 比虎哩繪先載入的第三方只能靠事件——只給 globalThis 會逼它自己寫輪詢
    window.addEventListener(PUBLIC_READY_EVENT, ready);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    registerPublicInterface();
    await settle();

    expect(api()).toBeDefined();
    expect(ready).toHaveBeenCalledTimes(1);
    const detail = (ready.mock.calls[0][0] as CustomEvent).detail as Record<string, unknown>;
    expect(detail).toMatchObject({ type: 'ready', apiVersion: 1, chatId: 'chat-a' });
    expect(detail.capabilities).toMatchObject({ generate: true, characterLibrary: true });
  });

  it('is idempotent: a second call does not re-announce or replace the object', () => {
    const ready = vi.fn();
    window.addEventListener(PUBLIC_READY_EVENT, ready);
    const first = api();
    registerPublicInterface();
    expect(api()).toBe(first);
    expect(ready).not.toHaveBeenCalled();
  });

  it('freezes the api so one plugin cannot rewrite what the next one gets', () => {
    const target = api() as unknown as Record<string, unknown>;
    expect(() => { target.generate = () => {}; }).toThrow();
    expect(typeof api().generate).toBe('function');
  });

  it('hands out a fresh capabilities copy each read', () => {
    (api().capabilities as unknown as Record<string, unknown>).generate = false;
    expect(api().capabilities.generate).toBe(true);
  });

  it('notifies subscribers when the character library changes, and stops on unsubscribe', async () => {
    const seen: unknown[] = [];
    const off = api().subscribe(notice => seen.push(notice));

    charTagLib.entries = [entry('阿黛爾')];
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'changed', apiVersion: 1 });

    off();
    charTagLib.entries = [entry('別的')];
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('coalesces a burst of library recomputes into one notice', async () => {
    const seen: unknown[] = [];
    const off = api().subscribe(notice => seen.push(notice));
    // 切聊天/刪樓/滑動會連著觸發好幾次重算;不攢的話第三方一秒收十幾條一樣的通知,
    // 每條都可能引它做一次全量重新整理
    charTagLib.entries = [entry('a')];
    charTagLib.entries = [entry('b')];
    charTagLib.entries = [entry('c')];
    await settle();
    expect(seen).toHaveLength(1);
    off();
  });

  it('gives each subscriber its own copy so one cannot corrupt the next', async () => {
    const second: Array<Record<string, unknown>> = [];
    const offA = api().subscribe(notice => {
      const mutable = notice as unknown as Record<string, unknown>;
      mutable.type = '被改了';
      (mutable.capabilities as Record<string, unknown>).generate = false;
    });
    const offB = api().subscribe(notice => second.push(notice as unknown as Record<string, unknown>));

    charTagLib.entries = [entry('x')];
    await settle();

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'changed' });
    expect((second[0].capabilities as { generate: boolean }).generate).toBe(true);
    offA();
    offB();
  });

  it('survives a subscriber that throws, and still fires the DOM event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changed = vi.fn();
    window.addEventListener(PUBLIC_CHANGED_EVENT, changed);
    const good = vi.fn();
    const offA = api().subscribe(() => { throw new Error('第三方崩了'); });
    const offB = api().subscribe(good);

    charTagLib.entries = [entry('y')];
    await settle();

    // 一個第三方寫崩了,不能連累其餘訂閱者與事件監聽者
    expect(good).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('rejects a non-function subscriber loudly instead of silently doing nothing', () => {
    expect(() => api().subscribe(null as never)).toThrow(TypeError);
  });
});
