import { h, render } from 'vue';

import ConfirmDialog from '@/components/ConfirmDialog.vue';

export interface ConfirmOptions {
  title: string;
  /** 正文(純文本) */
  text: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'danger';
}

// 與 index.ts 的 HOST_ID 保持一致:外掛宿主元素,其 shadow root 裡有 dist/index.css
// 與 --bbi-* 主題變數;彈窗必須掛進去才有樣式(掛 document.body 會裸奔)。
const HOST_ID = 'bbi-app-host';

/**
 * 命令式確認彈窗:供聊天側(樓層按鈕等模板外環境)使用,替代瀏覽器原生 confirm。
 * 掛載進外掛 host 的 shadow root;外掛視窗開著時 ConfirmDialog 內部 Teleport 到
 * modalHost(浮於視窗之上),關著時 Teleport 停用、原地渲染,兩種狀態都可用。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) {
    // 取不到 host 等於彈不出窗,返回 false 會被呼叫方當成「使用者取消了」而靜默放棄 ——
    // 至少留一行日誌,否則表現是「點了沒反應」且無從排查。
    console.warn('[虎哩繪] 外掛 host 不在,確認彈窗無法撥出', { hostId: HOST_ID, title: options.title });
    return Promise.resolve(false);
  }

  const container = document.createElement('div');
  root.appendChild(container);
  return new Promise(resolve => {
    const settle = (result: boolean) => {
      render(null, container);
      container.remove();
      resolve(result);
    };
    render(
      h(
        ConfirmDialog,
        {
          open: true,
          title: options.title,
          confirmText: options.confirmText,
          cancelText: options.cancelText,
          tone: options.tone,
          // 聊天側撥出時可能壓在外掛視窗/其它彈窗之上
          topLayer: true,
          onConfirm: () => settle(true),
          onCancel: () => settle(false),
        },
        { default: () => options.text },
      ),
      container,
    );
  });
}
