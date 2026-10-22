import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import Gallery from './index.vue';
import { listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { deleteImageFileOnly } from '@/floor/storage';
import { isImageMissing, resetMissingImages } from '@/floor/missingImages';
import { openLightbox } from '@/floor/lightbox';
import { confirmDialog } from '@/components/confirm';

declare const toastr: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

vi.mock('@/components/Icon.vue', () => ({ default: () => null }));
vi.mock('@/components/confirm', () => ({ confirmDialog: vi.fn() }));
vi.mock('@/floor/lightbox', () => ({ openLightbox: vi.fn() }));
vi.mock('@/floor/storage', () => ({
  readStore: vi.fn(),
  sidecarPathFor: vi.fn(),
  deleteImageFileOnly: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: [], name2: 'Alpha' }) }));
vi.mock('@/st/images', () => ({
  ARTIST_PREVIEW_FOLDER: 'artist-previews',
  listUserImageFolders: vi.fn(),
  listUserImages: vi.fn(),
  probeUserImage: vi.fn(),
}));
vi.mock('vue', async importOriginal => {
  const vue = await importOriginal<typeof import('vue')>();
  // Keep Vue's real rendering and events; CSS transitions and native input listeners need a browser.
  return { ...vue, Transition: vue.BaseTransition, vModelText: {} };
});

// Vitest's Node pipeline supplies SSR output; compile the same template for client-side node checks.
const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'));
const template = compileTemplate({
  source: descriptor.template!.content,
  filename: 'index.vue',
  id: 'gallery-test',
  compilerOptions: {
    mode: 'function',
    bindingMetadata: compileScript(descriptor, { id: 'gallery-test' }).bindings,
  },
});
if (template.errors.length) throw new Error(template.errors.join('\n'));
const ClientGallery = { ...Gallery, render: new Function('Vue', template.code)(Vue) };

interface TestNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}

function node(type: string, text = ''): TestNode {
  return { type, text, props: {}, children: [], parent: null };
}

function remove(child: TestNode): void {
  if (!child.parent) return;
  child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}

function insert(child: TestNode, parent: TestNode, anchor?: TestNode | null): void {
  remove(child);
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  child.parent = parent;
}

// A small in-memory host lets the existing Node test suite count actual Vue-rendered nodes.
const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _previous, value) => { target.props[key] = value; },
  parentNode: target => target.parent,
  nextSibling: target => {
    const siblings = target.parent?.children ?? [];
    return siblings[siblings.indexOf(target) + 1] ?? null;
  },
  insert,
  remove,
  insertStaticContent: (content, parent, anchor) => {
    const target = node('#static', content);
    insert(target, parent, anchor);
    return [target, target];
  },
});

function find(root: TestNode, selector: string): TestNode[] {
  const matches = selector.startsWith('.')
    ? String(root.props.class ?? '').split(' ').includes(selector.slice(1))
    : root.type === selector;
  return [...(matches ? [root] : []), ...root.children.flatMap(child => find(child, selector))];
}

/** \u6587\u672c\u5185\u5bb9\uff08\u542b\u5168\u90e8\u540e\u4ee3\uff09\u3002\u63d2\u503c\u4f1a\u5404\u81ea\u6210\u4e00\u4e2a #text \u8282\u70b9\uff0c\u9010\u5c42\u62fc\u8d77\u6765\u624d\u770b\u5f97\u5230\u6574\u53e5\u3002 */
function text(target: TestNode): string {
  return target.text + target.children.map(text).join('');
}

/** \u6392\u7a7a\u5fae\u4efb\u52a1 + \u4e00\u4e2a\u5b8f\u4efb\u52a1\uff1a\u7ec4\u4ef6\u91cc await \u8fc7\u7f51\u7edc\u7684\u90a3\u4e9b\u5206\u652f\u8981\u7b49\u5b83\u624d\u843d\u5230 DOM \u4e0a\u3002 */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
}

async function click(target: TestNode): Promise<void> {
  (target.props.onClick as () => void)();
  await nextTick();
}

async function change(target: TestNode): Promise<void> {
  (target.props.onChange as () => void)();
  await nextTick();
}

const prefix = '\u67cf\u5b9d\u7ed8_';
const alpha = `${prefix}Alpha`;
const beta = `${prefix}Beta`;
const expandedKey = 'bbi.ui.galleryExpanded.v1';
/** 刪除呼叫要的是歸一化 key（解碼、無前導斜槓），與元件 image.key、markImagesMissing 同一口徑；<img> 用的編碼 src 是另一回事（見 imageSrc）。 */
const keyOf = (folder: string, file: string) => `user/images/${folder}/${file}`;
let stored: Map<string, string>;
let app: ReturnType<typeof renderer.createApp> | undefined;

async function mount(): Promise<TestNode> {
  app?.unmount();
  const root = node('root');
  app = renderer.createApp(ClientGallery);
  app.provide(ssrContextKey, {});
  app.mount(root);
  await flush();
  return root;
}

beforeEach(() => {
  stored = new Map();
  resetMissingImages();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  });
  vi.stubGlobal('toastr', { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() });
  vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta]);
  vi.mocked(listUserImages).mockImplementation(async folder =>
    Array.from({ length: folder === alpha ? 53 : 5 }, (_, i) => `image-${i}.png`),
  );
  // 預設每張 1 KB:體積相關斷言用得上,其餘用例無副作用
  vi.mocked(probeUserImage).mockResolvedValue({ exists: true, size: 1024 });
  vi.mocked(deleteImageFileOnly).mockResolvedValue(undefined);
  vi.mocked(confirmDialog).mockResolvedValue(true);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('gallery on-demand rendering', () => {
  it('starts folded without image nodes, including when old collapsed preferences exist', async () => {
    stored.set('bbi.ui.galleryCollapsed.v1', JSON.stringify([beta]));
    const root = await mount();
    expect(find(root, '.gal-fold-trigger').map(head => head.props['aria-expanded'])).toEqual([false, false]);
    expect(find(root, 'img')).toHaveLength(0);
    // 摺疊容器本身常駐(高度過渡要有 0fr 起點),但沒展開過的組不渲染任何內容
    expect(find(root, '.gal-fold-wrap')).toHaveLength(2);
    expect(find(root, '.gal-fold-body')).toHaveLength(0);
  });

  it('adds at most 24 images per click, handles the remainder and keeps folded groups loaded', async () => {
    const root = await mount();
    const [alphaHead, betaHead] = find(root, '.gal-fold-trigger');
    await click(alphaHead);
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, 'img').every(image => image.props.loading === 'lazy')).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
    expect(find(root, '.gal-more')[0].children.some(child => child.text.includes('5'))).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(53);
    expect(find(root, '.gal-more')).toHaveLength(0);

    // 收起只把高度歸零,<img> 必須留在 DOM 裡:重掛一次就是一張圖一個網路往返
    // (/user/images 不帶 maxAge,Firefox 更是 no-store),公網連 ST 時會白屏一拍。
    await click(alphaHead);
    expect(find(root, '.gal-fold-wrap')[0].props.class).toContain('is-collapsed');
    expect(find(root, 'img')).toHaveLength(53);
    await click(alphaHead);
    expect(find(root, '.gal-fold-wrap')[0].props.class).not.toContain('is-collapsed');
    expect(find(root, 'img')).toHaveLength(53);
    await click(betaHead);
    expect(find(root, 'img')).toHaveLength(58);
    expect(find(root, '.gal-more')).toHaveLength(0);
  });

  it('remembers manual expansion but resets batch sizes on remount and folds new groups', async () => {
    let root = await mount();
    await click(find(root, '.gal-fold-trigger')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(JSON.parse(stored.get(expandedKey)!)).toEqual([alpha]);

    vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta, `${prefix}Gamma`]);
    root = await mount();
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, '.gal-fold-trigger').map(head => head.props['aria-expanded'])).toEqual([true, false, false]);
    await click(find(root, '.gal-fold-trigger')[0]);
    expect(JSON.parse(stored.get(expandedKey)!)).toEqual([]);
    root = await mount();
    expect(find(root, 'img')).toHaveLength(0);
  });

  it.each(['invalid json', '{}', 'null', '[123, null]'])(
    'falls back to folded groups for unusable preferences: %s',
    async raw => {
      stored.set(expandedKey, raw);
      expect(find(await mount(), 'img')).toHaveLength(0);
    },
  );

  it('still toggles and loads batches when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage disabled'); },
      setItem: () => { throw new Error('Storage disabled'); },
    });
    const root = await mount();
    expect(find(root, 'img')).toHaveLength(0);
    await click(find(root, '.gal-fold-trigger')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
  });

  it('does not open groups just because they match a search', async () => {
    const root = await mount();
    (find(root, 'input')[0].props['onUpdate:modelValue'] as (query: string) => void)('Beta');
    await nextTick();
    expect(find(root, '.gal-fold-trigger')).toHaveLength(1);
    expect(find(root, 'img')).toHaveLength(0);
    await click(find(root, '.gal-fold-trigger')[0]);
    expect(find(root, 'img')).toHaveLength(5);
  });
});

// 體積統計暫時停用:作者不滿意「逐張 HEAD 讀 Content-Length」的方案(見 index.vue 的 load())。
// 以下用例原樣保留,恢復 measureSizes 呼叫時去掉 .skip 即可。
describe.skip('gallery size readout', () => {
  it('sums measured bytes per group and in total, sizing every image including unrendered ones', async () => {
    const root = await mount();
    // 58 張全都量過(懶載入只是渲染策略,體積統計必須覆蓋整組,否則角標隨下拉往上跳)
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(58);
    expect(find(root, '.gal-size').map(text)).toEqual(['53 KB', '5.0 KB']);
    expect(text(find(root, '.gal-count')[0])).toContain('58 KB');
    // 量全了就不帶「≥」,也不再顯示「還在量」的加號
    expect(find(root, '.gal-size').some(span => text(span).includes('≥'))).toBe(false);
    expect(find(root, '.gal-measuring')).toHaveLength(0);
  });

  it('marks partial sums with ≥ and never counts an unmeasurable file as zero', async () => {
    // 探不到大小的那些(HEAD 失敗 / 缺 Content-Length)一律不計入,而不是當 0 位元組累加:
    // 謊報 0 會讓「量不到」看起來像「量到了,就是空的」。
    vi.mocked(probeUserImage).mockImplementation(async src =>
      src.includes(encodeURIComponent(alpha))
        ? (src.endsWith('image-0.png') ? { exists: true, size: 2048 } : null)
        : { exists: true, size: null },
    );
    const root = await mount();
    // Alpha 只量出一張 → 帶 ≥;Beta 一張都沒量出來 → 整個角標不顯示(而非 0 B)
    expect(find(root, '.gal-size').map(text)).toEqual(['≥ 2.0 KB']);
    expect(text(find(root, '.gal-count')[0])).toContain('2.0 KB');
  });

  it('skips already-measured images when reloading', async () => {
    const root = await mount();
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(58);
    vi.mocked(listUserImages).mockImplementation(async folder =>
      Array.from({ length: folder === alpha ? 54 : 5 }, (_, i) => `image-${i}.png`),
    );
    await click(find(root, '.gal-icon-btn')[0]);
    await flush();
    // 只有新增的那一張要量
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(59);
    expect(find(root, '.gal-size').map(text)).toEqual(['54 KB', '5.0 KB']);
  });
});

describe('gallery size readout disabled', () => {
  it('issues no HEAD probes and renders no size UI', async () => {
    const root = await mount();
    // 進頁零體積探測;重新整理也不該冒出來——請求數隨相簿線性增長正是暫時停用它的原因
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
    await click(find(root, '.gal-icon-btn')[0]);
    await flush();
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
    // 分組角標、總計體積、測量中的「+」一律不出現
    expect(find(root, '.gal-size')).toHaveLength(0);
    expect(find(root, '.gal-measuring')).toHaveLength(0);
    expect(text(find(root, '.gal-count')[0])).not.toContain('KB');
  });
});

describe('gallery multi-select delete', () => {
  /** 進入選擇態並展開 Alpha。 */
  async function selectMode(): Promise<TestNode> {
    const root = await mount();
    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-fold-trigger')[0]);
    return root;
  }

  it('keeps thumbnails opening the lightbox until selection mode is on', async () => {
    const root = await mount();
    await click(find(root, '.gal-fold-trigger')[0]);
    expect(find(root, '.gal-check')).toHaveLength(0);
    await click(find(root, '.gal-thumb')[0]);
    await flush();
    expect(vi.mocked(openLightbox)).toHaveBeenCalledTimes(1);

    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-thumb')[0]);
    await flush();
    // 選擇態下點圖只勾選,不再放大
    expect(vi.mocked(openLightbox)).toHaveBeenCalledTimes(1);
    expect(find(root, '.gal-thumb')[0].props.class).toContain('is-selected');
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
  });

  it('deletes the picked images and their sidecars, then drops them in place', async () => {
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-thumb')[2]);
    // 先把 Alpha 翻到第二批:刪除後不能把使用者翻出來的批次重置回 24 張
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);

    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();

    expect(vi.mocked(confirmDialog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteImageFileOnly).mock.calls.map(call => call[0])).toEqual([
      keyOf(alpha, 'image-0.png'),
      keyOf(alpha, 'image-2.png'),
    ]);
    // 就地摘除:53 → 51,且沒有重新拉目錄(重新 load 會把展開態和批次全重置)
    expect(vi.mocked(listUserImages)).toHaveBeenCalledTimes(2);
    expect(find(root, '.gal-badge').map(text)).toEqual(['51', '5']);
    // 已顯示張數(48)不變,後面的圖往前補位——刪兩張不該讓使用者重新往下翻
    expect(find(root, 'img')).toHaveLength(48);
    expect(text(find(root, '.gal-count')[0])).toContain('56 張');
    // 體積顯示已暫時停用(見 load()):刪除後就地渲染的列表裡也不該出現任何體積角標
    expect(find(root, '.gal-size')).toHaveLength(0);
    // 樓層卡片據此立刻降級,不必等它自己 404
    expect(isImageMissing(`user/images/${alpha}/image-0.png`)).toBe(true);
    expect(isImageMissing(`user/images/${alpha}/image-1.png`)).toBe(false);
    // 選中項清空後自動退出選擇態
    expect(find(root, '.gal-actionbar')).toHaveLength(0);
  });

  it('selects the whole group from the header checkbox, not just the rendered batch', async () => {
    const root = await selectMode();
    expect(find(root, 'img')).toHaveLength(24);
    await change(find(root, '.gal-group-check')[0].children[0]);
    // 懶載入只渲染了 24 張,但「全選這個角色」指的是這個角色的全部 53 張
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('53');

    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();
    expect(vi.mocked(deleteImageFileOnly)).toHaveBeenCalledTimes(53);
    // 刪空的分組整組消失
    expect(find(root, '.gal-fold-trigger')).toHaveLength(1);
    expect(text(find(root, '.gal-count')[0])).toContain('1 位角色');
  });

  it('keeps the files when the confirmation is declined', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();
    expect(vi.mocked(deleteImageFileOnly)).not.toHaveBeenCalled();
    // 取消不該順手把選中項清掉:使用者多半是想再核對一遍
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
    expect(find(root, '.gal-badge').map(text)).toEqual(['53', '5']);
  });

  it('keeps failed deletions selected and reports them instead of pretending they went', async () => {
    vi.mocked(deleteImageFileOnly).mockImplementation(async path => {
      if (path.endsWith('image-1.png')) throw new Error('EBUSY');
    });
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-thumb')[1]);
    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();

    // 成功的摘掉、失敗的留在列表裡且仍勾著,使用者可以直接重試
    expect(find(root, '.gal-badge').map(text)).toEqual(['52', '5']);
    expect(isImageMissing(`user/images/${alpha}/image-0.png`)).toBe(true);
    expect(isImageMissing(`user/images/${alpha}/image-1.png`)).toBe(false);
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
    expect(toastr.error).toHaveBeenCalled();
    expect(toastr.success).not.toHaveBeenCalled();
  });

  it('drops the selection when leaving selection mode', async () => {
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-select-toggle')[0]);
    // 留著上次的選中項,下次進來會對著一批不記得為何選中的圖按刪除
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('0');
    expect(find(root, '.gal-thumb')[0].props.class).not.toContain('is-selected');
  });

  it('puts the action bar right below the toolbar, not after the (possibly very long) list', async () => {
    // 撥出它的「選擇」鈕在工具條裡。操作條若擺在列表末尾,角色多時按下去螢幕上什麼都不動,
    // 像沒生效;吸頂則一按就看見。這條鎖的是順序——CSS 的 sticky 單測看不見,但 DOM 順序看得見。
    const root = await mount();
    await click(find(root, '.gal-select-toggle')[0]);
    const page = find(root, '.bbi-page')[0];
    const order = page.children.map(child => String(child.props.class ?? ''));
    expect(order.findIndex(cls => cls.includes('gal-actionbar')))
      .toBeLessThan(order.findIndex(cls => cls.includes('gal-groups')));
  });

  it('uses the shared .bbi-checkbox so themes restyling it (pastel redraws the tick) apply here too', async () => {
    const root = await selectMode();
    const box = find(root, '.gal-group-check')[0].children[0];
    expect(String(box.props.class ?? '')).toContain('bbi-checkbox');
  });
});
