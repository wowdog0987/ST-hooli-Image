import { requestFloorTags } from '@/autoTag/runner';
import { ensureChatObserver, onChatMutation } from '@/floor/chatObserver';
import { isCurrentChatExcluded, settings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';

/**
 * 樓層「生成生圖 tag」按鈕注入。
 *
 * 每個劇情樓的 .extraMesButtons(ST 擴充套件按鈕區,"⋯" 展開)追加一個調色盤按鈕
 * (與擴充套件選單入口同款圖示):
 * 每按一次固定追加一張:第一次是本樓最值得畫的瞬間,之後每次是其餘裡最好的那一個;
 * 既有 tag 與圖片原樣保留。單張重寫提示詞在卡片的提示詞編輯彈窗裡,不歸這顆按鈕。
 *
 * 給誰不給誰**只由 st/context.ts 的 isAiStoryMessage 說話**,與自動流程、與 runner
 * 的兜底閘門是同一個謂詞:AI 樓給、使用者樓與 ST 真系統樓不給,而被 /hide 隱藏的普通樓
 * 照給——它仍是劇情樓,runner 也放行。舊版這裡直接讀 DOM 的 is_system 屬性,隱藏樓
 * 一律沒有按鈕(使用者報的正是這個),而屬性變更又不在 observer 的監聽範圍裡,
 * 於是「隱藏前渲染過的樓留著按鈕、隱藏後重渲染的樓沒有按鈕」同一條聊天兩種樣子。
 *
 * 按鈕是純 DOM(fa 圖示與 ST 原生擴充套件按鈕同款觀感),不進 Vue 樹。
 * ST 重渲染會重建樓層 DOM,共用的 #chat 觀察器(floor/chatObserver.ts)負責冪等對賬
 * (該有的補、該撤的撤)。
 */

const BUTTON_CLASS = 'bbi-tag-action';
// 與擴充套件選單入口同款調色盤圖示
const ICON_CLASS = 'fa-palette';

let bound = false;

function setRunning(button: HTMLElement, running: boolean): void {
  button.dataset.running = running ? '1' : '';
  button.classList.toggle(ICON_CLASS, !running);
  button.classList.toggle('fa-spinner', running);
  button.classList.toggle('fa-spin', running);
}

async function onActivate(button: HTMLElement): Promise<void> {
  if (button.dataset.running === '1') return;
  const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
  const context = getContext();
  const message = Number.isInteger(floor) ? context?.chat?.[floor] : undefined;
  // 點了必須有下文:靜默 return 在使用者那裡就是「按鈕點了沒反應」,連日誌都沒有
  if (!context || !message) {
    console.warn('[虎哩繪] 樓層按鈕找不到對應訊息', { mesid: button.closest('.mes')?.getAttribute('mesid') });
    toastr.warning('找不到這一樓的訊息，請重新整理頁面後重試', '虎哩繪');
    return;
  }
  if (!settings.enabled) {
    toastr.warning('虎哩繪已停用，請先在外掛設定裡開啟', '虎哩繪');
    return;
  }

  setRunning(button, true);
  try {
    await requestFloorTags(floor);
  } finally {
    // 執行期間 ST 可能已重渲染移除本按鈕;對脫離 DOM 的元素改 class 是安全無操作
    setRunning(button, false);
  }
}

function createButton(): HTMLDivElement {
  const button = document.createElement('div');
  // mes_button 與 .extraMesButtons 裡的 ST 原生擴充套件按鈕同類(menu_button 是通用選單按鈕,樣式不同)
  button.className = `mes_button fa-solid ${ICON_CLASS} ${BUTTON_CLASS}`;
  button.title = '生成一張生圖 tag（每按一次追加一張）';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');

  const activate = () => void onActivate(button);
  button.addEventListener('click', activate);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

/**
 * 按鈕與「誰該有按鈕」對賬(冪等、雙向):該有的補,該撤的撤。
 *
 * 雙向是必需的——只補不撤時,判據變了(排除名單裡加了這個角色、/role 把樓改成系統樓)
 * 也只有等整段重渲染才生效,期間留著的按鈕點了只會撞上 runner 的兜底閘門。
 * 正在跑的那顆不撤:它的 spinner 與 running 標記要留到本次請求收尾。
 */
function syncButtons(): void {
  const chat = getContext()?.chat;
  // 上下文還沒就緒:什麼都別做——此時「誰該有」無從判斷,照著空 chat 對賬會把按鈕全撤掉
  if (!chat) return;
  // 排除角色:該聊天整條自動 tag 鏈路停用,手動按鈕一併撤掉
  const excluded = isCurrentChatExcluded();
  for (const mesEl of document.querySelectorAll<HTMLElement>('#chat .mes')) {
    const extra = mesEl.querySelector('.extraMesButtons');
    if (!extra) continue;
    const floor = Number(mesEl.getAttribute('mesid'));
    // 判據吃 chat 裡的訊息物件,不吃 DOM 的 is_system 屬性(見檔案頭註釋)。
    // 順帶的好處:/hide 只翻屬性、不動 DOM 樹,本來就觸發不了 observer,現在也無需觸發。
    const wanted = !excluded && Number.isInteger(floor) && isAiStoryMessage(chat[floor]);
    const existing = extra.querySelector<HTMLElement>(`.${BUTTON_CLASS}`);
    if (wanted && !existing) extra.appendChild(createButton());
    else if (!wanted && existing && existing.dataset.running !== '1') existing.remove();
  }
}

/** 綁定樓層按鈕注入(冪等)。#chat 在 ST 靜態模板裡,綁定時不存在則說明環境異常,直接放棄。 */
export function bindTagActionButtons(): boolean {
  if (bound) return true;
  // 觀察器與卡片自愈共用一個(floor/chatObserver.ts):同一棵樹別觀察兩遍,
  // 開銷在瀏覽器收集 MutationRecord 那一側,不在回撥側。
  if (!ensureChatObserver()) return false;
  bound = true;
  onChatMutation(syncButtons);
  syncButtons();
  return true;
}
