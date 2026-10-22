import { getContext, type STContext, type STMessage } from '@/st/context';

function findMessage(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function activeEditorText(floor: number): string | null {
  return findMessage(floor)?.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value ?? null;
}

function currentSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function setMessageText(message: STMessage, text: string): void {
  message.mes = text;
  const swipeId = currentSwipeId(message);
  if (swipeId === null || !message.swipes || swipeId < 0 || swipeId >= message.swipes.length) return;
  message.swipes[swipeId] = text;
}

function settleActiveEditor(floor: number, text: string): boolean {
  const message = findMessage(floor);
  const editor = message?.querySelector<HTMLTextAreaElement>('#curEditTextarea');
  if (!message || !editor) return false;

  editor.value = text;
  message.querySelector<HTMLElement>('.mes_edit_cancel')?.click();
  return true;
}

async function emitMessageEvent(context: STContext, event: string | undefined, floor: number): Promise<void> {
  if (event && context.eventSource.emit) await context.eventSource.emit(event, floor);
}

async function refreshRenderedMessage(context: STContext, message: STMessage, floor: number): Promise<void> {
  if (!findMessage(floor)) return;
  if (typeof context.updateMessageBlock === 'function') {
    try {
      await context.updateMessageBlock(floor, message);
      return;
    } catch {
      // 區域性重新整理失敗時再退回整段聊天過載。
    }
  }
  await context.reloadCurrentChat?.();
}

export type ApplyMessageResult =
  | 'saved'
  | 'chat-changed'
  | 'floor-changed'
  | 'swipe-changed'
  | 'build-failed'
  | 'unavailable';

export interface MessageExtraUpdate {
  key: string;
  /** undefined = 刪除該鍵。 */
  value: unknown;
}

/**
 * 判斷槽位裡的訊息還是不是請求開始時那一條。
 *
 * 不用物件引用比對:別的外掛改正文時常整體替換訊息物件(chat[i] = {...chat[i], mes})，
 * 引用比對會把這種「同一條訊息、只是換了個殼」誤判成樓層變化,連帶整次分析作廢。
 * send_date 在訊息建立時定死、編輯不變,配 name 足以認人;刪樓導致索引平移時
 * send_date 必然不同,該攔的照樣攔住。舊訊息沒有 send_date 時退回引用比對。
 */
function isSameMessage(message: STMessage, expected: STMessage): boolean {
  if (message === expected) return true;
  if (!expected.send_date) return false;
  return message.send_date === expected.send_date && message.name === expected.name;
}

/**
 * 以 compare-and-swap 方式修改訊息正文和一個 extra 鍵。
 *
 * 身份檢查(聊天 / 訊息 / swipe)一致才落盤;正文內容本身**不**參與比對——正文由
 * buildNext 基於「落盤那一刻的真實正文」現算,別的外掛在分析期間做的修改因此得以保留，
 * 而不是被請求開始時的舊快照覆蓋。buildNext 返回 null 表示它認為這次不該寫。
 * 儲存失敗時同時回滾正文與 extra，避免留下半寫狀態。
 */
export async function applyMessageText(
  floor: number,
  buildNext: (currentText: string) => string | null,
  expectedChatId: string,
  expectedSwipeId: number | null,
  expectedMessage?: STMessage,
  extraUpdate?: MessageExtraUpdate,
): Promise<ApplyMessageResult> {
  const context = getContext();
  if (!context?.saveChat) return 'unavailable';
  if (context.getCurrentChatId?.() !== expectedChatId) return 'chat-changed';

  const message = context.chat?.[floor];
  if (!message) return 'unavailable';
  if (expectedMessage && !isSameMessage(message, expectedMessage)) return 'floor-changed';
  if (currentSwipeId(message) !== expectedSwipeId) return 'swipe-changed';

  // 編輯框開著時它才是正文的活口徑(使用者改了還沒確認),落盤基底以它為準
  const nextText = buildNext(activeEditorText(floor) ?? message.mes);
  if (nextText === null) return 'build-failed';

  const previousText = message.mes;
  const previousExtra = message.extra;
  const swipeId = currentSwipeId(message);
  const previousSwipeText = swipeId !== null ? message.swipes?.[swipeId] : undefined;
  setMessageText(message, nextText);
  if (extraUpdate) {
    const nextExtra = { ...(message.extra ?? {}) };
    if (extraUpdate.value === undefined) delete nextExtra[extraUpdate.key];
    else nextExtra[extraUpdate.key] = extraUpdate.value;
    message.extra = nextExtra;
  }

  try {
    await context.saveChat();
  } catch (error) {
    message.mes = previousText;
    message.extra = previousExtra;
    if (swipeId !== null && message.swipes && swipeId >= 0 && swipeId < message.swipes.length) {
      message.swipes[swipeId] = previousSwipeText ?? previousText;
    }
    throw error;
  }

  await emitMessageEvent(context, context.eventTypes.MESSAGE_EDITED, floor).catch(error => {
    console.warn('[虎哩繪] tag 已儲存，但 MESSAGE_EDITED 事件傳送失敗', error);
  });
  if (!settleActiveEditor(floor, message.mes)) {
    await refreshRenderedMessage(context, message, floor).catch(error => {
      console.warn('[虎哩繪] tag 已儲存，但樓層重新整理失敗', error);
    });
    await emitMessageEvent(context, context.eventTypes.MESSAGE_UPDATED, floor).catch(error => {
      console.warn('[虎哩繪] tag 已儲存，但 MESSAGE_UPDATED 事件傳送失敗', error);
    });
  }
  return 'saved';
}
