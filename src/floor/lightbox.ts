import { h, render } from 'vue';

import Lightbox from '@/floor/Lightbox.vue';

/**
 * 命令式開啟圖片燈箱(供樓層卡片呼叫)。
 *
 * 掛載位置與 components/confirm.ts 同款:外掛 host 的 shadow root——那裡有 dist/index.css
 * 與 --bbi-* 主題變數,掛 document.body 會裸奔無樣式。
 *
 * 特意**不**掛進卡片自己的 shadow root:燈箱是 fixed 全屏層,而卡片活在 .mes_text 內部,
 * 那裡的層疊上下文與 overflow 會把它裁掉。
 */

// 與 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

export interface LightboxOptions {
  src: string;
  prompt?: string;
  filename?: string;
  /** 提供了才顯示刪除按鈕;點刪除先關燈箱再回調。 */
  onDelete?: () => void;
  /** 提供了才能切到上一張 / 下一張(回調負責開啟那一張的燈箱)。 */
  onPrev?: () => void;
  onNext?: () => void;
}

/** 同一時刻只允許一個燈箱,重複呼叫先關舊的。 */
let closeCurrent: (() => void) | null = null;

export function openLightbox(options: LightboxOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);

  const close = () => {
    if (closeCurrent !== close) return; // 已被後來者替換,不重複清理
    closeCurrent = null;
    render(null, container);
    container.remove();
  };
  closeCurrent = close;

  render(
    h(Lightbox, {
      src: options.src,
      prompt: options.prompt,
      filename: options.filename,
      deletable: !!options.onDelete,
      hasPrev: !!options.onPrev,
      hasNext: !!options.onNext,
      onClose: close,
      onPrev: () => options.onPrev?.(),
      onNext: () => options.onNext?.(),
      onDelete: () => {
        close();
        options.onDelete?.();
      },
    }),
    container,
  );
}
