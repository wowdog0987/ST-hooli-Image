/**
 * 複製到剪貼簿 —— 全專案統一入口。
 *
 * 手機常用區域網 HTTP 地址訪問 ST，此時非同步 Clipboard API 不可用；回退到隱藏
 * textarea + execCommand，和 ST 自身的複製工具保持同一相容策略。
 */
function legacyCopy(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);

  try {
    textArea.focus({ preventScroll: true });
    textArea.select();
    textArea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}

export async function copyText(text: string, okMessage = '已複製'): Promise<boolean> {
  if (!text) return false;

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!legacyCopy(text)) throw new Error('Clipboard copy failed');
      }
    } else if (!legacyCopy(text)) {
      throw new Error('Clipboard copy failed');
    }

    toastr.success(okMessage, '虎哩繪');
    return true;
  } catch {
    toastr.error('複製失敗，請手動選擇文本', '虎哩繪');
    return false;
  }
}
