import { openPanel } from '@/state/ui';
import { ensureIconFallback } from '@/st/iconFallback';

const BTN_ID = 'bbi-topbar-button';
const STYLE_ID = 'bbi-topbar-style';

function ensureStyle(): void {
  // 美化主題可能清空頂欄圖示字形,用高特異性選擇器強制還原(見 iconFallback)
  ensureIconFallback(STYLE_ID, `#top-settings-holder #${BTN_ID} .drawer-icon.fa-solid`);
}

/**
 * 往 ST 頂欄(#top-settings-holder)注入一個快速開啟虎哩繪的 drawer 按鈕,
 * 位置在「使用者設定管理」(#persona-management-button)左邊。
 *
 * 注入的按鈕**不進 shadow DOM**——直接用 ST 的 .drawer / .drawer-icon 類名,
 * 跟隨酒館主題美化。點選只負責開啟虎哩繪視窗,不展開任何抽屜(故無 .drawer-toggle,
 * 避免 ST 的 doNavbarIconClick 把它當抽屜來開合)。
 *
 * 受設定開關控制:開 → 確保已注入;關 → 移除。輪詢等頂欄出現(頂欄懶載入)。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'drawer';
  btn.innerHTML = `
    <div class="drawer-toggle">
      <div class="drawer-icon fa-solid fa-palette fa-fw closedIcon" title="虎哩繪"></div>
    </div>
  `;
  // 僅開啟視窗,不走 ST 的抽屜開合邏輯(故未掛 .drawer-toggle 的 doNavbarIconClick)
  btn.querySelector('.drawer-toggle')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openPanel();
  });
  return btn;
}

/** 真正執行插入:成功或已存在返回 true,頂欄未就緒返回 false(由輪詢重試)。 */
function tryInject(): boolean {
  const holder = document.getElementById('top-settings-holder');
  if (!holder) return false;
  if (document.getElementById(BTN_ID)) return true;

  ensureStyle();
  const btn = buildButton();
  // 插到「使用者設定管理」左邊;它若還沒渲染則退而掛到頂欄末尾。
  const persona = document.getElementById('persona-management-button');
  if (persona) persona.before(btn);
  else holder.appendChild(btn);
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
}

/** 按開關同步頂欄按鈕的有無。開關變化時呼叫即可(冪等)。 */
export function syncTopBarButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    removeButton();
    return;
  }
  if (tryInject()) return;
  // 頂欄懶載入:輪詢等它出現。頂欄是 index.html 靜態結構,通常首次即命中、timer 不啟動;
  // 萬一始終不出現,封頂 ~20s(40 次)後放棄,絕不常駐空轉(同 index.ts 的 bindMemoryWhenReady 範式)。
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 500);
}
