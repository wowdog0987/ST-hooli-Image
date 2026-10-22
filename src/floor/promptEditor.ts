import { h, render } from 'vue';

import PromptEditor from '@/floor/PromptEditor.vue';
import { cancelFloorTags, requestSlotTag } from '@/autoTag/runner';
import { markForAutoGenerate, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { awaitTagPlan, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';
import { slotKey } from '@/floor/genState';
import { confirmDialog } from '@/components/confirm';
import { getContext } from '@/st/context';
import {
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  type ImageTagContent,
} from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';

/**
 * 命令式開啟「編輯提示詞」彈窗(供樓層卡片呼叫)。
 *
 * 掛載位置與 components/confirm.ts、floor/lightbox.ts 同款:外掛 host 的 shadow root ——
 * 那裡有 dist/index.css 與 --bbi-* 主題變數,掛 document.body 會裸奔無樣式。
 * 特意**不**掛進卡片自己的 shadow root:彈窗是 fixed 全屏層,而卡片活在 .mes_text 內部,
 * 那裡的層疊上下文與 overflow 會把它裁掉(燈箱同理,見 lightbox.ts)。
 *
 * 【提示詞的真源是正文】
 * tag 原文存在 message.mes 裡,不在 extra、不在 store。所以「編輯提示詞」本質是一次
 * 正文寫回:序列化新 tag → 原位替換第 seq 條 → applyMessageText(身份 CAS)→
 * 重水合。新 tag 換出新 promptHash,老圖自動落進 stale 桶(卡片已有「舊提示詞」角標
 * 與提示行),故「應用」不需要任何額外落地邏輯。
 */

// 與 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

/** 樓層座標快照。彈窗活得比卡片長,這些一律開窗時取值,回撥裡絕不讀 props。 */
export interface PromptEditorAt {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  /** 開窗時的 tag 原文:寫回前用它確認 seq 還指向同一條 tag。 */
  rawTag: string;
}

export interface PromptEditorOptions {
  at: PromptEditorAt;
  /** 解析出的原始內容(彈窗的初值與「有沒有真的改」的基準)。 */
  content: ImageTagContent;
  /** 當前提示詞下已有幾張圖。 */
  historyCount: number;
  /** 後端是否已配置好。 */
  configured: boolean;
}

/** 同一時刻只允許一個編輯彈窗,重複呼叫先關舊的。 */
let closeCurrent: (() => void) | null = null;

/** 離場動畫時長,與 base.css 的 .bbi-modal-enter/leave-active(0.15s)對齊。 */
const LEAVE_MS = 160;

/** 補水合的延時,與 hydrate.ts 的 LATE_HYDRATION_DELAY 同一口徑。 */
const LATE_HYDRATION_MS = 100;

/** 寫回未成功時給使用者的說法(exhaustive:新增 ApplyMessageResult 分支時這裡會編譯報錯)。 */
function failureReason(result: Exclude<ApplyMessageResult, 'saved'>): string {
  switch (result) {
    case 'chat-changed':
      return '聊天已切換,提示詞未儲存';
    case 'floor-changed':
      return '樓層已變化,提示詞未儲存';
    case 'swipe-changed':
      return '已切換到別的 swipe,提示詞未儲存';
    case 'build-failed':
      return '正文裡的這條 tag 已被改動,請關閉彈窗後重新編輯';
    case 'unavailable':
      return 'SillyTavern 上下文不可用,提示詞未儲存';
  }
}

/**
 * 寫回正文。返回 true 表示已落盤。
 *
 * 失敗一律 toast 並返回 false,**彈窗不關** —— 使用者可能剛打了幾十個 tag,
 * 因為切了個 swipe 就把草稿吞掉是不可接受的。
 */
async function writeBack(
  at: PromptEditorAt,
  content: ImageTagContent,
  regenerate: boolean,
): Promise<boolean> {
  const context = getContext();
  if (!context) {
    toastr.error('SillyTavern 上下文不可用', '虎哩繪');
    return false;
  }
  const message = context.chat?.[at.messageId];
  if (!message) {
    toastr.error('樓層已不存在,提示詞未儲存', '虎哩繪');
    return false;
  }

  const nextTag = serializeImageTag(content);
  // 標記必須掛在寫回**之前**:寫回即觸發重水合、卡片掛載時消費標記(同 autoTag/runner.ts)。
  // force 模式無條件開跑 —— 使用者點的就是「重新生成」,即便這條提示詞以前出過圖。
  if (regenerate) {
    markForAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq, 'force');
  }

  let result: Awaited<ReturnType<typeof applyMessageText>>;
  try {
    result = await applyMessageText(
      at.messageId,
      currentText => {
        // 彈窗可能開著好幾分鐘。身份 CAS 只認聊天/樓層/swipe,**刻意不比對正文內容**
        // (那是與別的改正文外掛共存的關鍵),所以「tag 數變了 / 這條 tag 被別人改了」
        // 攔不住,只能在這裡按原文自己核對:seq 指的還是不是同一條。
        if (parseImageTags(currentText)[at.seq] !== at.rawTag) return null;
        return replaceImageTagAt(currentText, at.seq, nextTag);
      },
      at.chatId,
      at.swipeId,
      message,
    );
  } catch (error) {
    // 撤銷標記:只取回自己這一枚,不能用 clearAutoGenerateForFloor(會連累同樓兄弟槽位)
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.error(error instanceof Error ? error.message : String(error), '虎哩繪');
    return false;
  }

  if (result !== 'saved') {
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.warning(failureReason(result), '虎哩繪');
    return false;
  }

  // applyMessageText 內部會觸發 MESSAGE_EDITED / MESSAGE_UPDATED,樓層通常已自行重水合;
  // 但 ST 編輯框開著時它走 settleActiveEditor 分支(**不發 MESSAGE_UPDATED**),沒人來水合,
  // 故這裡自己補。補兩次的理由同 hydrate.ts 的 scheduleHydration:別的 ST 監聽器可能在這之後
  // 才替換 .mes_text,晚班那次若錨點沒變只是一次廉價 props patch(零重建、零重複消費標記)。
  hydrateMessage(at.messageId, context);
  setTimeout(() => {
    const later = getContext();
    if (!later || later.getCurrentChatId() !== at.chatId) return;
    hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
}

/**
 * 從正文裡重讀第 seq 條 tag,算出重寫落盤後彈窗該換成什麼(純函式,便於單測)。
 *
 * 返回 null = 什麼都別動:正文讀不到、seq 已不存在、或原文壓根沒變。不猜、不兜底——
 * 正文是提示詞的唯一真源(見檔案頭),讀不出就該保留使用者眼前的東西。
 *
 * **rawTag 與 content 必須一起換**:只換 content(回填了輸入框)不換 rawTag,使用者接著點
 * 「應用」會撞上「這條 tag 已被改動」,而改動它的正是我們自己觸發的這次重寫。
 */
export function nextEditorState(
  text: string | undefined,
  seq: number,
  currentRawTag: string,
): { rawTag: string; content: ImageTagContent } | null {
  if (typeof text !== 'string') return null;
  const nextRaw = parseImageTags(text)[seq];
  if (nextRaw === undefined || nextRaw === currentRawTag) return null;
  return { rawTag: nextRaw, content: parseImageTagContent(nextRaw) };
}

export function openPromptEditor(options: PromptEditorOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);
  let busy = false;
  /** 草稿是否已改動:由元件 emit('dirty') 推上來。 */
  let dirty = false;
  /** 已請求關閉:置上後重渲染一次讓元件播離場動畫,LEAVE_MS 後真解除安裝。 */
  let closing = false;
  /** 正在問「放棄修改?」:ConfirmDialog 自己不處理 Esc,而本彈窗的捕獲監聽還活著,
   *  不擋住的話連按 Esc 會疊出好幾個確認框。 */
  let asking = false;
  /**
   * 彈窗當前展示的內容。AI 重寫落盤後換成正文裡的新版本,元件 watch 到即回填輸入框。
   * 與 options.content 分開:那是開窗時的快照,不該被改。
   */
  let content: ImageTagContent = options.content;
  /**
   * 寫回 CAS 用的 tag 原文。**重寫落盤後必須換成新的** ——
   * 否則使用者接著點「應用」會撞上「這條 tag 已被改動」,而改動它的正是我們自己。
   */
  let rawTag = options.at.rawTag;
  /**
   * 本窗內 AI 重寫已經落過盤。彈窗不自動關,使用者回頭看到的是一份「已經存進正文」的提示詞,
   * 與他自己手打、還沒點應用的草稿長得一樣 —— 不明說一句,沒法分辨哪份已經生效。
   */
  let rewritten = false;
  /** 本槽位的執行態 key,與 genState / tagPlanState 同構。 */
  const planKey = slotKey(options.at.chatId, options.at.messageId, options.at.swipeId, options.at.seq);
  /**
   * 本窗已經關了(含被後來者頂掉)。**遲到的回撥一律不准再渲染** ——
   * 重寫跑在 tagPlanState 裡、活得比彈窗長,它的收尾回撥會在關窗之後才到。
   *
   * 這道閘門不是潔癖:容器雖已 remove,但 ModalMask 是 <Teleport> 到 modalHost 的,
   * **容器脫離文件並不等於看不見** —— 往脫檔容器裡 render 一次,彈窗會原地復活到螢幕上,
   * 而且復活的是全新例項(closing 的 watch 沒有 immediate,頂著 closing=true 掛載也不會自行隱藏),
   * 隨後 requestClose / onApply 又都在 closing 上早退 → 叉、取消、應用全部點不動,窗關不掉。
   */
  let closed = false;

  const close = () => {
    if (closeCurrent !== close) return; // 已被後來者替換,不重複清理
    closeCurrent = null;
    // 先讓元件播離場動畫(ModalMask 的 Transition 要求容器仍掛著),再真解除安裝
    closing = true;
    paint();
    setTimeout(() => {
      // 置 closed 必須在 render(null) **之前**:兩者之間若插進一次遲到的 paint,
      // 解除安裝的就是剛被它重新掛上的那個例項,等於白關。
      closed = true;
      render(null, container);
      container.remove();
    }, LEAVE_MS);
  };
  closeCurrent = close;

  /**
   * 重寫收尾後:從**當前正文**把這一槽的 tag 重新讀一份,回填輸入框。
   * 判定在 nextEditorState(純函式,有單測),這裡只負責取正文與賦值。
   * 返回 true = 確實換了新提示詞(據此給一行「已儲存」的說明)。
   */
  const refreshFromMessage = (): boolean => {
    const next = nextEditorState(
      getContext()?.chat?.[options.at.messageId]?.mes,
      options.at.seq,
      rawTag,
    );
    if (!next) return false;
    rawTag = next.rawTag;
    content = next.content;
    rewritten = true;
    return true;
  };

  /**
   * 真正發起重寫。
   *
   * 跑在 tagPlanState 裡而不是本彈窗裡:**關掉彈窗不中斷重寫**(使用者的明確要求)。
   * runner 自己會落盤並 force 出圖,所以這裡只負責收尾後把新提示詞讀回來、重繪。
   * 彈窗**不自動關**——點一下就閃退像是崩了。
   */
  const startRewrite = (): void => {
    if (busy || closing || isTagPlanning(planKey)) return;
    const task = runTagPlan(planKey, () => requestSlotTag(options.at.messageId, options.at.seq));
    paint();
    void task
      .catch(() => {
        // 失敗原因 runner 已經 toast 過了,這裡只負責把轉圈停掉
      })
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  };

  /**
   * 「AI 重寫提示詞」按鈕。
   *
   * 草稿改過就先問一句:重寫是**真落盤**的,收尾後草稿必然被新提示詞頂掉
   * (不頂掉更糟——使用者接著點「應用」會拿舊草稿把剛重寫的覆蓋回去)。手打了半天被一次
   * 點選無聲吞掉是丟資料,口徑同 requestClose;共用 asking 擋住疊出好幾個確認框。
   */
  const rewrite = (): void => {
    if (busy || asking || closing || isTagPlanning(planKey)) return;
    if (!dirty) {
      startRewrite();
      return;
    }
    asking = true;
    void confirmDialog({
      title: 'AI 重寫提示詞',
      text: '你手改的內容還沒有應用。AI 重寫完會直接儲存，並把這些改動頂掉。',
      confirmText: '重寫',
    }).then(ok => {
      asking = false;
      if (ok) startRewrite();
    });
  };

  // 重開彈窗時接上在途的重寫:請求屬於 store,關窗沒有中斷它。
  // 不重複發起,只等它收尾後照樣回填(使用者要的「續上」)。
  const rejoin = awaitTagPlan(planKey);
  if (rejoin) {
    void rejoin
      .catch(() => {})
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  }

  /** 關窗請求:草稿改過就先問一句,免得手打半天被一下 Esc 吞掉。 */
  const requestClose = () => {
    if (busy || asking || closing) return;
    if (!dirty) {
      close();
      return;
    }
    asking = true;
    void confirmDialog({
      title: '放棄修改',
      text: '提示詞的改動還沒有應用,關閉後會丟失。',
      confirmText: '放棄',
      cancelText: '繼續編輯',
      tone: 'danger',
    }).then(ok => {
      asking = false;
      if (ok) close();
    });
  };

  /**
   * 重渲染(props patch,元件例項與草稿都留著 —— 寫回失敗時使用者不丟輸入)。
   *
   * **不用 ref 拿元件例項**:命令式 render 沒有父元件,`ref` 的 owner 為 null,
   * 掛載時 Vue 因 parentComponent 護欄靜默跳過、解除安裝時無護欄直接拋
   * "Cannot read properties of null (reading 'refs')",且 ref 從未生效
   * → 拿不到例項 → 關不掉彈窗。狀態一律走 props/emit。
   */
  const paint = () => {
    // 遲到的重繪一律丟棄(見 closed 的註釋):容器已脫檔,但 ModalMask 會 Teleport 出去,
    // 渲染進去等於把關掉的彈窗又貼回螢幕,且再也關不掉。
    if (closed) return;
    render(
      h(PromptEditor, {
        content,
        historyCount: options.historyCount,
        configured: options.configured,
        busy,
        rewriting: isTagPlanning(planKey),
        rewritten,
        closing,
        onDirty: (value: boolean) => {
          dirty = value;
        },
        onRewrite: rewrite,
        onCancelRewrite: () => cancelFloorTags(options.at.messageId),
        onApply: (value: ImageTagContent, regenerate: boolean) => {
          if (busy || closing) return;
          busy = true;
          paint();
          void writeBack({ ...options.at, rawTag }, value, regenerate).then(ok => {
            busy = false;
            if (ok) close();
            else paint();
          });
        },
        onClose: requestClose,
      }),
      container,
    );
  };
  paint();
}
