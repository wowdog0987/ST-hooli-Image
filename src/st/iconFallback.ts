/**
 * 字型圖示兜底:有些酒館美化主題會把頂欄/聊天框裡 .drawer-icon.fa-solid::before(或類似)
 * 的字型圖示清空(content:''、color:transparent、font-size:0),改用 background-image 按
 * **每個按鈕 id** 單獨貼自定義圖示。我們注入的按鈕不在它們名單裡,會變成一片空白。
 *
 * 這裡用更高特異性(祖先 id + 自身 id)+ !important 壓過那條通用規則,強制還原字形。
 * \f53f = fa-palette 的 Unicode(取自 ST 的 fontawesome.min.css,別憑記憶猜)。
 *
 * 各注入點共用此函式:傳入自身按鈕 id 與圖示元素的選擇器,生成一段一次性 <style>。
 */
const PALETTE = '\\f53f';
const injected = new Set<string>();

/**
 * 確保某按鈕的圖示兜底樣式已注入(按 styleId 去重,可重複呼叫)。
 * @param styleId   <style> 元素的 id(去重鍵)
 * @param selector  命中該按鈕圖示 ::before 的高特異性選擇器(不含 ::before)
 */
export function ensureIconFallback(styleId: string, selector: string): void {
  if (injected.has(styleId) || document.getElementById(styleId)) {
    injected.add(styleId);
    return;
  }
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
${selector}::before {
  content: '${PALETTE}' !important;
  width: auto !important;
  height: auto !important;
  font-size: inherit !important;
  color: inherit !important;
  background: none !important;
}
`;
  document.head.appendChild(style);
  injected.add(styleId);
}
