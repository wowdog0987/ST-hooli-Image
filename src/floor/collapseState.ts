import { reactive } from 'vue';

/**
 * 樓層卡片「摺疊態」的模組級 store。
 *
 * 為什麼必須放在元件外:與 genState.ts 同理——卡片的生命週期由水合決定,swipe、
 * 編輯訊息、ST 重渲染樓層都會換錨點、解除安裝重掛元件,摺疊態若放元件 ref 裡,
 * 使用者摺好的圖會自己彈開。key 與 genState/registry 同構(chatId|messageId|swipeId|seq),
 * 卡片重建後按 key 認領回自己的摺疊態。
 *
 * 為什麼不寫 message.extra:摺疊是「臨時遮蔽」性質的 UI 態,不是資料;寫 extra 意味著
 * 每次摺疊/展開都 saveChat() 落盤一次,代價與語義都不合適。會話內記住即可,
 * 重新整理後回落到設定項「樓層圖片預設摺疊」(settings.ui.autoCollapseImages)。
 *
 * 不主動清理:一個槽位只佔一個布林值,舊聊天/已刪槽位的殘留可忽略;
 * 且切聊天再切回來時摺疊態還在,反而是使用者期望的行為。
 */

/** 顯式設定過摺疊態的槽位;沒設過的槽位回落到「預設摺疊」設定項。 */
const collapsed = reactive(new Map<string, boolean>());

/** 當前摺疊態:手動設定優先,否則用預設值(設定項「樓層圖片預設摺疊」)。 */
export function isCollapsed(key: string, defaultCollapsed: boolean): boolean {
  return collapsed.get(key) ?? defaultCollapsed;
}

/** 手動設定摺疊/展開(覆蓋預設值,會話內有效)。 */
export function setCollapsed(key: string, value: boolean): void {
  collapsed.set(key, value);
}
