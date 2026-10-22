import { h, render, watch, type VNode } from 'vue';

import Card from '@/floor/Card.vue';
import { clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { cardStyleSheet, cardStyleTextFallback } from '@/floor/cardStyles';
import { onChatMutation } from '@/floor/chatObserver';
import { setNaiConcurrency } from '@/floor/genQueue';
import { clearAllGen, pruneGenSlots } from '@/floor/genState';
import { clearAllTagPlans } from '@/floor/tagPlanState';
import { SlotRegistry } from '@/floor/registry';
import { checkSlotHealth, floorIdOf } from '@/floor/slotHealth';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import { BBI_SLOT_SELECTOR, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';
import { THEMES } from '@/state/ui';

/** 卡片主題:只認目前存在的主題,舊版已移除的主題名(day/night…)一律退回跟隨 ST。 */
function cardThemeOf(value: string): string {
  return THEMES.some(theme => theme.value === value) ? value : 'st';
}

/**
 * 樓層水合框架（DESIGN-FLOOR-UI.md §5.2 / §6）。
 *
 * 渲染事件觸發 → 定位樓層 .mes_text → 錨點列表（DOM 順序）與
 * parseImageTags(message.mes) 解析出的 tag 列表按序一一配對 → 每個錨點
 * 掛載一張卡片。錨點每次渲染重建，水合每次事件重建，全程冪等。
 *
 * 卡片渲進錨點自己的 **shadow root**（不是錨點本身）：樓層在 ST 的 light DOM 裡，
 * ST 全域性樣式與使用者裝的美化主題會直接改到卡片上。shadow 邊界雙向隔離，
 * 與 index.ts 主視窗同構，只是從「一個大 host」變成「每槽位一個小 host」。
 *
 * 【兩層觸發,缺一不可】
 * 1. 事件層(bindFloorHydration):ST 的渲染事件,覆蓋正常路徑,便宜且及時;
 * 2. 自愈層(bindSlotSelfHealing):MutationObserver 兜住**不發事件**的路徑。
 *
 * 第 2 層不是防禦第三方外掛,首先是防禦 ST 自己:updateMessageBlock 直接
 * `.mes_text.html(...)` 且不發任何事件,messageEditCancel/Done 用 `.empty()`,
 * 右滑生成寫 `.mes_text.html('...')`。錨點活在 .mes_text **裡面**,這些路徑一律
 * 把它連同 shadow root 一起刪掉,而事件層對此完全無感。使用者報的
 * 「圖在生成、樓層裡看不到介面」就是它——genState 是模組級的,卡片死了生成照樣跑完。
 *
 * 宿主掛在 .mes_text 外面當兄弟節點就不會被 `.html()`/`.empty()` 清掉,但本外掛的卡片必須
 * 落在 tag 的行內位置(多 tag 樓層要按位置分別成圖),搬不出去——同一條約束下
 * 當初也否掉了官方 extra.media 方案(architecture.md §6)。故自愈是位置約束下的唯一解。
 */

export const slotRegistry = new SlotRegistry();

let bound = false;
let healingBound = false;

/**
 * 可繼承的排版屬性——shadow DOM 不隔離繼承，這些會透過 host 從 ST 漏進來。
 * 與 index.ts 的 INHERITED_RESET 同一份職責（那裡是主視窗 host，這裡是每張卡片 host）；
 * 卡片要**跟隨聊天字號**故不釘 font-size，只釘會破壞佈局與配色的那些。
 */
const CARD_INHERITED_RESET: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': '400',
  'font-variant': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'line-height': '1.6',
  direction: 'ltr',
};

/**
 * 備好錨點的 shadow root:掛樣式 + 釘死繼承屬性(冪等)。
 * 錨點每次樓層渲染都是新元素,但 MESSAGE_UPDATED 等事件下也可能複用同一元素,
 * 故 attachShadow 前先查 shadowRoot——重複 attach 會拋。
 */
function ensureShadow(anchor: HTMLElement): ShadowRoot {
  const existing = anchor.shadowRoot;
  if (existing) return existing;

  const shadow = anchor.attachShadow({ mode: 'open' });
  const sheet = cardStyleSheet();
  if (sheet) {
    // 全部卡片共享同一個 CSSStyleSheet 物件:N 張卡零重複、零重複解析
    shadow.adoptedStyleSheets = [sheet];
  } else {
    // 老瀏覽器兜底:每個 shadow 一份 <style>
    const style = document.createElement('style');
    style.textContent = cardStyleTextFallback();
    shadow.appendChild(style);
  }

  for (const [prop, value] of Object.entries(CARD_INHERITED_RESET)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  return shadow;
}

/** 樓層 .mes_text 元素；樓層不在 DOM（未渲染/群聊懶渲染）時返回 null。 */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  // 顯式解除安裝：錨點容器可能已脫離 DOM（.mes_text 被 ST 整體重寫），
  // render(null, container) 對已脫離元素依然安全。
  render(null, record.container);
  slotRegistry.delete(key);
}

/** 解除安裝並清空全部記錄（切聊天 / 刪除樓層後全量重建）。 */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

/**
 * 水合單條訊息的全部槽位。
 *
 * 差分策略(替代舊版「先全卸再全掛」):同 key 且錨點元素沒變 → render 同類型元件
 * 做 props patch,元件例項與 DOM(尤其 <img>)原樣保留;錨點換了(ST 重渲染重建了
 * .mes_text)或新槽位 → 解除安裝舊記錄重掛;本樓不再需要的記錄(tag 變少 / swipe 切換 /
 * 樓層離屏 / 訊息刪除)解除安裝。
 *
 * 為什麼值得:任一槽位出圖成功都會觸發本樓重水合,舊實現把所有卡片的 <img> 重建,
 * 每張圖都重新發起請求(ST 靜態服務 max-age=0,每次都要重驗證)——樓層裡圖越多,
 * 一次出圖完成的請求風暴越大。patch 路徑下 src 不變則 DOM 不動,零請求。
 */
export function hydrateMessage(messageId: number, ctx: STContext): void {
  const chatId = ctx.getCurrentChatId();
  const message = ctx.chat[messageId];

  /** 本次水合後「應該存在」的槽位:key → {錨點, vnode}。訊息沒了就留空,下面統一解除安裝。 */
  const desired = new Map<string, { anchor: HTMLElement; vnode: VNode }>();

  if (message) {
    const tags = parseImageTags(message.mes);
    const swipeId = message.swipe_id ?? 0;
    // 槽位可能整個消失(使用者刪掉 tag / swipe 到 tag 更少的一版):那些槽位再沒有卡片
    // 來對賬,執行態記錄會永久留存,日後同 key 復現時被新卡片誤認領。按 tag 數剪掉越界的。
    pruneGenSlots(chatId ?? '-', messageId, swipeId, tags.length);

    if (tags.length > 0) {
      const mesText = findMesText(messageId);
      // 樓層不在 DOM(未渲染/群聊懶渲染):desired 留空,本樓舊記錄被解除安裝,等下次渲染事件
      if (mesText) {
        const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
        if (anchors.length !== tags.length) {
          console.warn(
            `[虎哩繪] 樓層 #${messageId} 錨點 ${anchors.length} 個 ≠ 生圖 tag ${tags.length} 個,按少者配對`,
          );
        }
        const count = Math.min(anchors.length, tags.length);
        const hashes = tags.map(tag => promptHash(tag));
        const liveHashes = new Set(hashes);

        for (let seq = 0; seq < count; seq++) {
          const key = slotRegistry.key(chatId, messageId, swipeId, seq);
          // 從 extra 恢復:當前 tag 原文重算 hash 匹配歷史 → ready(可翻頁);
          // 無匹配但有舊提示詞結果 → stale(DESIGN-FLOOR-UI.md §7.1)。
          // 提示詞在本樓唯一時只按 hash 找圖,不看 seq:追加一張插到前面時舊圖跟著原 tag 走。
          const store = readStore(message);
          const hash = hashes[seq];
          const unique = hashes.indexOf(hash) === hashes.lastIndexOf(hash);
          const history = historyEntries(store, swipeId, hash, seq, unique);
          const entry = history.length ? history[history.length - 1] : null;
          const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq, liveHashes);
          const content = parseImageTagContent(tags[seq]);
          desired.set(key, {
            anchor: anchors[seq],
            vnode: h(Card, {
              prompt: content.tag,
              nl: content.nl,
              negative: content.negative,
              characters: content.characters,
              size: content.size,
              tag: tags[seq],
              messageId,
              seq,
              swipeId,
              history,
              staleEntry,
              // key 的一部分:與 registry.key 的佔位口徑一致(chatId 缺失時用 '-')
              chatId: chatId ?? '-',
            }),
          });
        }
      }
    }
  }

  // 解除安裝本樓不在期望集合內的舊記錄(跨 swipeId)
  for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
    if (!desired.has(key)) unmountKey(key);
  }

  // 掛載或差分更新
  for (const [key, { anchor, vnode }] of desired) {
    const existing = slotRegistry.get(key);
    if (existing && existing.container.host === anchor) {
      // 同錨點:render 同類型元件 → props patch,不重掛 DOM、不重跑 onMounted。
      // autoGenerate 標記由 onMounted 消費,但它只出現在「剛寫入 tag」的錨點上
      // (寫正文必觸發 ST 重渲染、錨點必重建),走不到這條分支。
      existing.vnode = vnode;
      render(vnode, existing.container);
    } else {
      // 卡片渲進錨點的 shadow root,與 ST 樣式雙向隔離;主題跟隨設定(預設 st = 融入宿主配色)
      if (existing) unmountKey(key);
      const shadow = ensureShadow(anchor);
      anchor.setAttribute('data-theme', cardThemeOf(settings.ui.cardTheme));
      render(vnode, shadow);
      slotRegistry.set(key, { container: shadow, vnode });
    }
  }
}

/** Hydrate currently displayed messages without tearing down cards that still have the same anchors. */
function hydrateVisible(ctx: STContext): void {
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/** Full rebuild for chat changes or message deletion. */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  hydrateVisible(ctx);
}

const LATE_HYDRATION_DELAY = 100;

/**
 * 自愈:體檢已掛載的槽位,把死掉的重掛;被宿主整段藏掉的只留痕(見 warnHiddenByHost)。
 *
 * 便宜是硬要求——它掛在 rAF 節流的 `#chat` observer 上,流式渲染期間每幀都可能跑。
 * 成本上限是 O(已掛載卡片數)(實測量級 <20),每張只做 `isConnected` 屬性讀 +
 * 一次 `closest()`;**只有真發現異常**才碰 DOM。絕不在這裡調 hydrateVisible:
 * 那會對每條訊息跑 parseImageTags + readStore + promptHash,那才是真卡頓。
 *
 * 重掛按樓去重:一樓多卡時,`.mes_text` 被整體換掉意味著該樓所有槽位一起死,
 * 逐個 hydrateMessage 會把同一樓重水合 N 次。
 *
 * 不必擔心自激迴圈:hydrateMessage 寫 DOM 會再喚醒一次本回調,但那一輪體檢裡
 * 這些槽位已是 ok(錨點在文件內),不再產生寫操作,迴圈到此為止。而 observer 只訂閱
 * childList、不訂閱 attributes,寫 data-theme/內聯樣式壓根不會喚醒它。
 */
export function healSlots(): void {
  let floorsToRehydrate: Set<number> | null = null;

  for (const record of slotRegistry.all()) {
    const host = record.container.host;
    const health = checkSlotHealth(host);
    if (health === 'ok') continue;

    if (health === 'hidden-by-host') {
      // 錨點還在、shadow root 也在,重掛多少次都沒用:是祖先 .mes_text 整段被
      // ST 的 inline_media 規則藏了(本樓有 extra.media 且 inline_image === false,
      // 原生出圖/打標擴充套件會寫這個組合)。**刻意不去強改它**,只留痕,見 warnHiddenByHost。
      warnHiddenByHost(host);
      continue;
    }

    const floor = floorIdOf(host);
    // 找不到樓層號:該樓整個不在文件裡(切聊天/懶渲染解除安裝),等渲染事件即可。
    // 記錄留著不動——hydrateMessage 會在樓層回來時按 desired 集合正常對賬。
    if (floor === null) continue;
    (floorsToRehydrate ??= new Set()).add(floor);
  }

  if (!floorsToRehydrate) return;
  const ctx = getContext();
  if (!ctx) return;
  for (const floor of floorsToRehydrate) hydrateMessage(floor, ctx);
}

/** 已提示過的樓層(同一樓別每幀刷一行日誌)。 */
const hiddenWarned = new Set<number>();

/**
 * 「卡片被宿主整段隱藏」只留痕,不強改。
 *
 * 為什麼不順手釘一條 `display:block !important` 把它拉回來:那條 `display:none`
 * 是 ST 有意為之——`extra.inline_image === false` 的語義正是「這一樓只看圖、不看正文」,
 * 由使用者或別的擴充套件設定。強行解除會把人家特意藏起來的正文一併翻出來,對**現在沒毛病**
 * 的人是可見的倒退;而且行內樣式一旦釘上就撤不掉了(ST 之後按 extra 重算 class,
 * 卻管不到我們寫的 style),正是那種「改不了又一直在生效」的暗格。
 *
 * 卡片必須落在 tag 的行內位置(多 tag 樓層按位置分別成圖),搬不出 .mes_text——
 * 同一條約束當初也否掉了官方 extra.media 方案。故這一類只能如實報告:
 * 日誌給出樓層號與原因,便於使用者反饋時一句話定位,不假裝修好了。
 */
function warnHiddenByHost(host: Element): void {
  const floor = floorIdOf(host);
  const id = floor ?? -1;
  if (hiddenWarned.has(id)) return;
  hiddenWarned.add(id);
  console.warn(
    `[虎哩繪] 樓層 #${floor ?? '?'} 的卡片已掛載但不可見:該樓 .mes_text 被 ST 的 ` +
      'inline_media 規則整段隱藏(本樓有附件圖且 extra.inline_image 為 false)。' +
      '這是宿主的有意行為,外掛不強行解除;如需看到卡片,請讓該樓恢復顯示正文。',
  );
}

/** 綁定自愈(冪等)。返回 false = `#chat` 不在文件裡,宿主環境異常。 */
export function bindSlotSelfHealing(): boolean {
  if (healingBound) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;
  healingBound = true;
  onChatMutation(healSlots);
  return true;
}

/**
 * Other ST listeners may still replace .mes_text after an event. Hydrate at the end of the
 * event loop, then check once more; an unchanged anchor only receives a cheap Vue props patch.
 */
function scheduleHydration(
  task: (ctx: STContext) => void,
  lateTask: (ctx: STContext) => void = task,
): void {
  const chatId = getContext()?.getCurrentChatId();
  const run = () => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    task(current);
  };
  setTimeout(run, 0);
  setTimeout(() => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    lateTask(current);
  }, LATE_HYDRATION_DELAY);
}

/**
 * Bind message rendering plus the two recovery events used by ST for generation finalization
 * and loading older history.
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    scheduleHydration(current => hydrateMessage(id, current));
  };
  const onVisibleReload = () => scheduleHydration(hydrateVisible);
  const onGenerationEnded = (messageCount: unknown) => {
    const id = Number(messageCount) - 1;
    if (Number.isInteger(id) && id >= 0) scheduleHydration(current => hydrateMessage(id, current));
    else onVisibleReload();
  };
  const onFullReload = () => {
    clearAutoGenerateFlags();
    // A deleted/switched chat no longer owns in-flight generation work.
    clearAllGen();
    // 提示詞規劃同理:舊聊天的在途規劃由 runner 的 cancelAll 中止,這裡只清展示態
    clearAllTagPlans();
    // 樓層號在新聊天裡指向別的樓,已提示過的記錄一併作廢,否則新聊天裡同號樓永久靜默
    hiddenWarned.clear();
    scheduleHydration(hydrateAll, hydrateVisible);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
  if (eventTypes.MORE_MESSAGES_LOADED) {
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, onVisibleReload);
  }
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  scheduleHydration(hydrateAll, hydrateVisible);

  // 自愈層:兜住 ST 與第三方那些「重寫 .mes_text 但不發事件」的路徑(見檔案頭註釋)
  bindSlotSelfHealing();

  // 卡片主題改了 → 就地改各卡片 host 的 data-theme(不必重水合,令牌是 CSS 變數,自動生效)
  watch(
    () => settings.ui.cardTheme,
    theme => {
      for (const record of slotRegistry.all()) {
        const host = record.container.host;
        if (host instanceof HTMLElement) host.setAttribute('data-theme', cardThemeOf(theme));
      }
    },
  );
  // NAI 併發上限 → 閘門(ComfyUI 不限併發,靠服務端佇列)
  watch(
    () => settings.nai.concurrency,
    value => setNaiConcurrency(value),
    { immediate: true },
  );
  return true;
}
