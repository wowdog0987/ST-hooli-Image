const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const guardedRoots = new WeakSet<ShadowRoot>();

function pathContainsEditable(event: KeyboardEvent): boolean {
  return event.composedPath().some(node =>
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    (node instanceof HTMLElement && node.isContentEditable),
  );
}

/**
 * 防止 Shadow DOM 內編輯控制元件的方向鍵繼續冒泡到 ST 全域性快捷鍵。
 * 只截斷傳播,不 preventDefault,故游標移動、選項切換和數字增減仍由控制元件正常處理。
 */
export function guardEditableArrowKeys(root: ShadowRoot): void {
  if (guardedRoots.has(root)) return;
  guardedRoots.add(root);
  root.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent) || !ARROW_KEYS.has(event.key)) return;
    // ST 本身會忽略帶修飾鍵的方向鍵;繼續放行可避免影響其它全域性組合快捷鍵。
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (pathContainsEditable(event)) event.stopPropagation();
  });
}
