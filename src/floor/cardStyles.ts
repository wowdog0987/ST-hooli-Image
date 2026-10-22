import cardCss from '@/floor/card.css?raw';
import themeCss from '@/styles/theme.css?raw';

/**
 * 卡片樣式表:構造一次,經 adoptedStyleSheets 共享給每個卡片的 shadow root。
 * N 張卡片共用同一個 CSSStyleSheet 物件——零重複、零解析開銷。
 *
 * 為什麼要帶上 theme.css:令牌定義在 `.bbi-root[data-theme=…]` 選擇器下,
 * 而卡片的 shadow root 裡沒有 .bbi-root 祖先(shadow 邊界擋住了選擇器匹配,
 * 儘管自定義屬性本身可繼承)。故把 theme.css 的選擇器改寫到 :host 上,
 * 令牌就落在卡片自己的 shadow 根節點上。
 *
 * 改寫規則:`.bbi-root[data-theme='x']` → `:host([data-theme='x'])`。
 * data-theme 由 hydrate.ts 寫在 host 元素上,故用屬性選擇器形式。
 * 順帶把 `.bbi-root[data-theme='x'] .bbi-checkbox` 這類後代規則一併轉換
 * (卡片裡沒有核取方塊,留著無害;不特殊處理反而更省事)。
 */

let sheet: CSSStyleSheet | null = null;
let fallbackCss: string | null = null;

function buildCss(): string {
  const scopedTheme = themeCss
    // 帶 data-theme 的主題塊:.bbi-root[data-theme='tiger'] → :host([data-theme='tiger'])
    .replace(/\.bbi-root\[data-theme=('|")([a-z]+)\1\]/g, ':host([data-theme=$1$2$1])')
    // 裸 .bbi-root(字型/圓角/間距等公共令牌塊)→ :host
    .replace(/\.bbi-root(?![\w[-])/g, ':host');
  return `${scopedTheme}\n${cardCss}`;
}

/**
 * 取共享樣式表。支援 adoptedStyleSheets 的環境返回 CSSStyleSheet,
 * 否則返回 null,由呼叫方退回克隆 <style>(見 cardStyleTextFallback)。
 */
export function cardStyleSheet(): CSSStyleSheet | null {
  if (sheet) return sheet;
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return null;
  try {
    const created = new CSSStyleSheet();
    created.replaceSync(buildCss());
    sheet = created;
    return sheet;
  } catch {
    return null;
  }
}

/** 老瀏覽器兜底:樣式文本,由呼叫方塞進 shadow root 的 <style>。 */
export function cardStyleTextFallback(): string {
  fallbackCss ??= buildCss();
  return fallbackCss;
}
