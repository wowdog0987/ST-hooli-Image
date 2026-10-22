/**
 * `#chat` 子樹變更的**唯一** MutationObserver。
 *
 * 為什麼要共用一個:樓層按鈕對賬與卡片自愈盯的是同一棵樹、同樣的 childList+subtree。
 * 各自 new 一個 observer,瀏覽器就要把同一批 MutationRecord 收集兩遍、派發兩遍;
 * 而真正的開銷在收集側,不在回撥側。合成一個之後,新增一個訂閱者的邊際成本
 * 只是回撥裡多跑一個函式——這也是「加自愈會不會常駐卡頓」的答案:不會,因為
 * 這筆觀察成本從樓層按鈕上線那天起就已經在付了。
 *
 * 節流用 rAF:流式渲染期間 Mutation 極密(每個 token 一次),同一幀內的連續變更
 * 合併成一次回撥。訂閱者的回撥必須是「便宜的對賬」——只讀屬性、只在真有差異時
 * 才動 DOM,別在裡面做全量重建。
 */

type ChatMutationListener = () => void;

const listeners = new Set<ChatMutationListener>();

let observer: MutationObserver | null = null;
let scheduled = false;

function flush(): void {
  scheduled = false;
  for (const listener of listeners) {
    // 一個訂閱者拋異常不能連坐其它訂閱者(尤其別讓它把自愈整條鏈路帶走)
    try {
      listener();
    } catch (error) {
      console.error('[虎哩繪] #chat 變更回撥異常', error);
    }
  }
}

/**
 * 綁定觀察器(冪等)。`#chat` 在 ST 靜態模板裡,取不到說明宿主環境異常,直接放棄。
 * 返回 false 時呼叫方**不該**自行退化成輪詢:那比 observer 貴得多。
 */
export function ensureChatObserver(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;

  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  // 只要 childList+subtree:屬性變更(/hide 翻 is_system、我們自己給錨點寫 data-theme
  // 與內聯樣式)一律不進來。後者尤其關鍵——觀察 attributes 會讓自愈寫屬性的動作
  // 反過來喚醒自己,變成自激迴圈。
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}

/** 訂閱 `#chat` 變更(自動確保觀察器已綁定)。返回退訂函式。 */
export function onChatMutation(listener: ChatMutationListener): () => void {
  listeners.add(listener);
  ensureChatObserver();
  return () => listeners.delete(listener);
}
