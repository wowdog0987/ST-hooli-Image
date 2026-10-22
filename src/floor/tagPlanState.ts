import { reactive } from 'vue';

/**
 * 「AI 重寫提示詞」的請求執行態(模組級 store)。
 *
 * 與 genState 同樣的理由必須放元件外:卡片生命週期由水合決定,任一兄弟槽位出圖都會
 * 觸發整樓重水合、把卡片連同元件內 ref 一起銷燬;重寫請求還在途,重建後的卡片要能
 * 認領回「AI 重寫提示詞…」並給出取消入口。
 *
 * 【為什麼還要存住 promise】
 * 入口在提示詞編輯彈窗裡(floor/promptEditor.ts),而**關掉彈窗不能中斷重寫**——
 * 請求屬於這個 store,不屬於彈窗。使用者中途關窗、稍後重開時,彈窗要能 await 回同一個
 * 在途請求、等它收尾後把新提示詞讀回輸入框(「續上」),而不是只看到一個轉圈。
 * 故這裡存的是 {票據, promise} 而非單純的布林。
 *
 * 與 genState 分開存放,不合並:genState 管的是出圖請求(queued/generating/error + hash
 * 對賬),這裡管的是 LLM 提示詞請求。兩者各有併發/取消語義(取消出圖不該誤殺重寫,
 * 反之亦然),混在一起只會讓狀態機互相汙染。key 與 genState / registry / autoGenerate
 * 保持同構:chatId|messageId|swipeId|seq。
 *
 * 「取消」不在這裡做:中止靠 autoTag/runner.ts 的 cancelFloorTags(每樓一把請求鎖),
 * 本 store 只負責展示態與收尾認領。
 */

interface TagPlanRecord {
  /** 票據:用於識別「遲到的收尾」——舊任務收尾時不得清掉同 key 的新任務。 */
  token: number;
  /** 在途請求。重開的彈窗 await 它即可接上本次重寫的收尾。 */
  promise: Promise<void>;
}

const planning = reactive(new Map<string, TagPlanRecord>());

let nextToken = 1;

export function isTagPlanning(key: string): boolean {
  return planning.has(key);
}

/**
 * 跑一次重寫並全程登記執行態。同 key 重複開始以新票據為準(舊任務的收尾不得清掉新任務)。
 *
 * 返回的 promise 與登記的是同一個:呼叫方可以 await,也可以直接丟掉不管——
 * 請求的生命週期歸本 store,不歸呼叫方(關掉彈窗不中斷重寫靠的就是這一點)。
 */
export function runTagPlan(key: string, run: () => Promise<void>): Promise<void> {
  const token = nextToken++;
  // run() 先跑起來再登記:.finally 的回撥是微任務,一定晚於下面這行同步的 set
  const promise = run().finally(() => {
    if (planning.get(key)?.token === token) planning.delete(key);
  });
  planning.set(key, { token, promise });
  return promise;
}

/** 取回在途重寫的 promise(無在途則 null)。供重開的彈窗「續上」。 */
export function awaitTagPlan(key: string): Promise<void> | null {
  return planning.get(key)?.promise ?? null;
}

/** 清空全部(切聊天 / 刪樓後的全量重建;在途請求由 runner 的 cancelAll 中止)。 */
export function clearAllTagPlans(): void {
  planning.clear();
}
