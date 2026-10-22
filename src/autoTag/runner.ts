import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readHoraeMemory } from '@/autoTag/horaeMemory';
import {
  applyPositionedCharRefs,
  resolveCharAnchors,
  type PositionedCharOp,
} from '@/autoTag/charAnchors';
import { prepareTargetText } from '@/autoTag/clean';
import { beginGeneration, clearGeneration, consumeGeneration } from '@/autoTag/generationGate';
import { buildAutoTagMessages, recentFloors } from '@/autoTag/prompt';
import { rebaseImagePositions, type RebaseReport } from '@/autoTag/rebase';
import { readFloorPresent } from '@/autoTag/sceneMemory';
import { addedTagSeqs, buildAppendTaskNote, buildSlotTaskNote } from '@/autoTag/slotPlan';
import {
  BBI_CHAR_EXTRA_KEY,
  CHAR_TAG_FIELDS,
  charTagsBeforeFloor,
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  lockedCharTagNames,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
  type CharTagAutoOp,
  type CharTagField,
} from '@/state/charTags';
import { injectImageTags, parseImagePlan, type ImagePlan } from '@/autoTag/protocol';
import {
  clearAutoGenerateForFloor,
  consumeAutoGenerate,
  markForAutoGenerate,
} from '@/floor/autoGenerate';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { getContext, isAiStoryMessage, type STMessage } from '@/st/context';
import {
  hasImageTagTrace,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  stripImageTags,
} from '@/st/imageTagRegex';
import { getTagGenChannel, isCurrentChatExcluded, settings } from '@/state/settings';

const processed = new Set<string>();
const running = new Map<string, AbortController>();
let bound = false;
const scheduled = new Set<ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_PREFIX = '[BBI][AutoTagDebug]';

function diagnostic(event: string, payload: unknown = null): void {
  const seen = new WeakSet<object>();
  let detail: string;
  try {
    const json = JSON.stringify(payload, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    detail = json ?? String(payload);
  } catch (error) {
    detail = JSON.stringify({ stringifyError: error instanceof Error ? error.message : String(error) });
  }
  console.info(`${DIAGNOSTIC_PREFIX} ${event} ${detail}`);
}

/**
 * 放棄本次執行並交代原因:診斷日誌照舊記全量,**手動路徑必須同時給 toast**。
 *
 * 手動點選是顯式意圖,靜默 return 在使用者那裡就等於「按鈕點了沒反應」——查不出、
 * 也沒法反饋。自動路徑保持安靜(每層樓都彈一次沒人受得了),它的去向看診斷日誌。
 */
function abort(
  floor: number,
  reason: string,
  manual: boolean | undefined,
  hint: string,
  payload: Record<string, unknown> = {},
): void {
  diagnostic('runForFloor:skip', { floor, reason, ...payload });
  if (manual) toastr.warning(hint, '虎哩繪');
}

function activeSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function textHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

interface RunOptions {
  /** 手動觸發(樓層按鈕):繞過 autoTag.enabled 與 processed 去重;空結果也給出反饋。 */
  manual?: boolean;
  /**
   * 追加一張(樓層按鈕):既有 tag 與圖片原樣保留,模型另選一個不同的瞬間,
   * 只產出這一張並插到它的位置。分析基底剔除舊 tag,任務備註列出已畫過的畫面(沒有就是第一張)。
   */
  append?: boolean;
  /**
   * 單槽位提示詞重寫(卡片「AI 重寫提示詞」):只替換該 seq 的 tag,其餘 tag 與圖片一字不動。
   * **畫面不變**——寫回按 seq 原位替換,模型返回的 position 壓根不參與寫回,措辭口徑見
   * slotPlan.buildSlotTaskNote。分析基底同樣剔除全部舊 tag,但強制輸出恰好 1 張,
   * 且忽略本次 AI 的 changes(首次全量分析已為整樓建過檔)。
   */
  slot?: { seq: number };
}

/** 放棄寫入的使用者可讀原因。文本變化已不在其中——那是正常情況,會 rebase 後照常寫入。 */
const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': '已切換聊天，本次沒有寫入生圖 tag',
  'floor-changed': '該樓層已被刪除或替換，本次沒有寫入生圖 tag',
  'swipe-changed': '已切換 swipe，本次沒有寫入生圖 tag',
  'build-failed': '樓層正文已被大幅改寫或已存在生圖 tag，本次沒有寫入',
  unavailable: '當前聊天不可寫入，本次沒有寫入生圖 tag',
};

/** 重定位結果的一行摘要;全部原位命中時返回空串(無需記日誌)。 */
function describeRebase(report: RebaseReport): string {
  if (!report.remapped && !report.drifted) return '';
  const parts = [`原位 ${report.anchored}`];
  if (report.remapped) parts.push(`跟隨改寫句 ${report.remapped}`);
  if (report.drifted) parts.push(`順延到上一段 ${report.drifted}`);
  return parts.join(' · ');
}

/** 把 AI 報告的 changes 轉成當前樓層操作;真正寫回在正文 CAS 成功時一次完成。 */
function planChangeOps(plan: ImagePlan): PositionedCharOp[] {
  const ops: PositionedCharOp[] = [];
  for (const change of plan.changes) {
    let op: CharTagAutoOp | null = null;
    if (change.field === 'new') {
      // value 可能是結構化欄位的 JSON 串(protocol.ts 拼),也可能是整串 tag 文本
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const field of CHAR_TAG_FIELDS) {
            const value = parsed[field];
            if (typeof value === 'string' && value.trim()) picked[field] = value.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* 非 JSON → 當整串處理 */
        }
      }
      if (!fields && change.value) value = change.value;
      op = createCharTagNewOp(
        {
          name: change.name,
          fields: { ...emptyCharFields(), ...(fields ?? {}) },
          raw: value,
          nl: change.nl ?? '',
          source: 'ai',
          desc: '',
        },
        change.reason,
      );
    } else if (change.field === 'nl') {
      op = createCharTagSetOp(change.name, 'nl', change.value || change.nl || '', change.reason);
    } else {
      op = createCharTagSetOp(change.name, change.field, change.value, change.reason);
    }
    if (op) ops.push({ op, sourceLine: change.sourceLine });
  }
  return ops.sort((left, right) => left.sourceLine - right.sourceLine);
}

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<void> {
  const context = getContext();
  diagnostic('runForFloor:enter', {
    floor,
    manual: Boolean(opts.manual),
    append: Boolean(opts.append),
    slotSeq: opts.slot?.seq ?? null,
    chatId: context?.getCurrentChatId?.() ?? '',
    extensionEnabled: settings.enabled,
    autoTagEnabled: settings.autoTag.enabled,
  });
  if (!context) {
    abort(floor, 'missing-context', opts.manual, 'SillyTavern 還沒就緒，請稍後重試');
    return;
  }
  if (!settings.enabled) {
    abort(floor, 'extension-disabled', opts.manual, '虎哩繪已停用，請先在外掛設定裡開啟');
    return;
  }
  if (!opts.manual && !settings.autoTag.enabled) {
    diagnostic('runForFloor:skip', { floor, reason: 'auto-tag-disabled' });
    return;
  }
  // 排除角色閘門:該角色名所在聊天的自動 tag 全流程停用,
  // 手動按鈕也在 actionButton 層撤掉,這裡做兜底(手動觸發時給反饋)。
  if (isCurrentChatExcluded()) {
    abort(floor, 'chat-excluded', opts.manual, '該角色已被排除，不生成生圖 tag');
    return;
  }
  const message = context.chat[floor];
  const messageDiagnostic = message
    ? {
        isUser: message.is_user,
        isSystem: message.is_system,
        textLength: typeof message.mes === 'string' ? message.mes.length : -1,
        extraType: message.extra?.type ?? null,
      }
    : null;
  // 與樓層按鈕同一個謂詞(st/context.ts):被 /hide 隱藏的普通樓算劇情樓,照樣能跑
  if (!isAiStoryMessage(message)) {
    abort(floor, 'not-ai-story-message', opts.manual, '這一樓不是可插圖的劇情樓層（使用者樓 / ST 系統樓）', {
      message: messageDiagnostic,
    });
    return;
  }
  const rawSource = message.mes;
  const slot = opts.slot;
  // 單槽重寫的目標:開跑時快照第 seq 條 tag 的原文,寫回前用它確認 seq 指的還是同一條
  // (同提示詞編輯彈窗的紀律)。正文這會兒已經沒這條 tag = 期間被刪/換 swipe,直接放棄。
  const slotRawTag = slot ? parseImageTags(rawSource)[slot.seq] : undefined;
  if (slot && slotRawTag === undefined) {
    abort(
      floor,
      'slot-missing',
      true,
      `第 ${slot.seq + 1} 張圖片的提示詞已不存在（可能已換 swipe 或被編輯），本次沒有重寫`,
    );
    return;
  }
  // 探測口徑與按鈕層同源(imageTagRegex.hasImageTagTrace):兩側漂移過一次——
  // 按鈕只認開標籤、這裡認開也認閉,只剩 `</hooli_image>` 的樓就卡成「點了沒反應」。
  // 單槽重寫與追加一張以「本樓已有 tag」為前提,不受此閘門攔截。
  if (hasImageTagTrace(rawSource) && !opts.append && !slot) {
    abort(
      floor,
      'already-has-image-tag',
      opts.manual,
      '本樓已有生圖 tag，沒有確認重新生成，本次未改動',
    );
    if (!opts.manual) console.debug(`[虎哩繪] 第 ${floor} 樓已經含有 hooli_image tag，跳過自動分析`);
    return;
  }
  // append / slot:分析都基於剔除舊 tag 後的正文(tag 不是敘事)。寫回時舊 tag 原樣保留:
  // slot 按 seq 原位替換,append 在保留舊 tag 的正文上插入新的一張。
  const source = opts.append || slot ? stripImageTags(rawSource) : rawSource;
  if (!source.trim()) {
    abort(floor, 'empty-source', opts.manual, '本樓正文是空的（或只剩生圖 tag），沒有可分析的內容');
    return;
  }
  const preparedTarget = prepareTargetText(source, settings.excludes.customStripTags);
  if (!preparedTarget.segments.length) {
    abort(
      floor,
      'no-target-segments',
      opts.manual,
      '本樓正文清洗後沒剩下敘事內容（可能被「剔除標籤」名單或思維鏈/註釋規則全刪了），沒有可分析的段落',
      { sourceLength: source.length },
    );
    return;
  }

  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) {
    abort(floor, 'missing-chat-id', opts.manual, '當前沒有開啟的聊天，本次沒有生成生圖 tag');
    return;
  }
  const swipeId = activeSwipeId(message);
  const identity = `${chatId}\u0000${floor}\u0000${swipeId ?? 'none'}\u0000${textHash(source)}`;
  // 手動是顯式意圖:即使同一正文自動流程已處理過(比如結論是無需插圖)也照跑,
  // 但仍寫入 processed,防止自動流程隨後對同一正文重複請求。
  if (!opts.manual && processed.has(identity)) {
    diagnostic('runForFloor:skip', { floor, reason: 'already-processed', chatId, swipeId, identity });
    return;
  }
  processed.add(identity);
  diagnostic('runForFloor:start', {
    floor,
    chatId,
    swipeId,
    identity,
    sourceLength: source.length,
    segmentCount: preparedTarget.segments.length,
  });

  const runKey = `${chatId}\u0000${floor}`;
  running.get(runKey)?.abort();
  const controller = new AbortController();
  running.set(runKey, controller);

  try {
    // 單槽重寫 / 追加一張:庫文本要包含本樓已落檔的增量(首次全量分析建的檔),否則 AI 會把
    // 已建檔角色當新人重寫。charTagsBeforeFloor(floor + 1) 正好含本樓(swipe 匹配時生效)。
    const entriesBefore = slot || opts.append ? charTagsBeforeFloor(floor + 1) : charTagsBeforeFloor(floor);
    // 已建檔的角色外貌以角色庫為準:Horae 區塊對他們只送著裝與狀態
    const memory = readHoraeMemory(
      context.chat,
      floor,
      context.chat[floor]?.mes ?? '',
      context.name1,
      new Set(entriesBefore.map(entry => entry.name)),
    );
    // 鎖定名(全域性庫 ⊖ 本聊天基線):AI 的 changes 對這些名字一律無效,庫文本裡帶 [locked] 標記
    const lockedNames = lockedCharTagNames();
    // 在場判定:Horae 在場名單(全名,不受暱稱影響)+ 名字出現在目標正文/上下文樓層 + 主角。
    // 只有在場角色送完整外貌欄位,其餘角色只報名字。
    const nearbyText = recentFloors(context, floor, settings.autoTag.contextMessages)
      .map(index => context.chat[index]?.mes ?? '')
      .join('\n');
    const presentNames = new Set([
      ...readFloorPresent(context.chat, floor),
      context.name1,
      ...entriesBefore.filter(entry => nearbyText.includes(entry.name)).map(entry => entry.name),
    ]);
    // 純本地渲染:建檔由主請求在同一次輸出裡完成(changes 的 field="new")
    const anchors = resolveCharAnchors(entriesBefore, lockedNames, presentNames);
    // 單槽重寫 / 追加一張:協議強制「恰好 1 張」,並把已有畫面的摘要帶給模型
    // (重寫錨住同一個畫面;追加另選不同的瞬間)。min/max 要同時覆蓋 build 的規則文案與下面的
    // parse 校驗,只改一處會自相矛盾。
    const promptOptions = slot || opts.append
      ? { ...settings.autoTag, minImages: 1, maxImages: 1 }
      : settings.autoTag;
    const taskNote = slot
      ? buildSlotTaskNote(rawSource, slot.seq)
      : opts.append
        ? buildAppendTaskNote(rawSource, preparedTarget.segments)
        : '';
    const messages = await buildAutoTagMessages(
      context,
      floor,
      promptOptions,
      memory,
      preparedTarget,
      anchors.text,
      taskNote,
    );
    const channel = getTagGenChannel();
    // 失敗重試:請求異常與「返回無法解析/校驗不通過」都視為可重試的異常(後者常見於模型沒遵守協議);
    // 中止訊號立即收手,不消耗重試。parseImagePlan 對壞輸出拋錯,「無畫面」則是正常返回空陣列。
    // 解析/校驗放進 validate 回撥:不過則請求歷史如實記為失敗(而非「HTTP 拿到文本」的綠色成功),
    // 錯誤原樣拋回這裡走重試——顯示與行為同口徑。
    const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
    let plan: ImagePlan | null = null;
    let lastError = '';
    for (let attempt = 0; attempt <= retries && !plan; attempt++) {
      if (controller.signal.aborted) {
        processed.delete(identity);
        return;
      }
      try {
        // parsed 用物件殼裝著:validate 閉包寫入,await 之後讀取——請求成功 + 驗收通過才非空。
        // (直接 let 會被 TS 收窄成 null:閉包內的賦值控制流分析看不見。)
        const parsed: { plan: ImagePlan | null } = { plan: null };
        const validate = (raw: string) => {
          const candidate = parseImagePlan(
            raw,
            preparedTarget.segments,
            promptOptions.minImages,
            promptOptions.maxImages,
          );
          parsed.plan = candidate;
        };
        // 有重試時給 source 帶上第幾次,歷史裡兩條記錄一眼看出是重試關係
        const source = slot
          ? `重寫提示詞(第 ${floor} 樓 · 第 ${slot.seq + 1} 張${retries > 0 ? ` · 第 ${attempt + 1} 次` : ''})`
          : retries > 0
            ? `自動 tag(第 ${floor} 樓 · 第 ${attempt + 1} 次)`
            : `自動 tag(第 ${floor} 樓)`;
        if (channel) {
          await requestCompletion(channel, messages, {
            signal: controller.signal,
            source,
            validate,
          });
        } else {
          await requestViaMainApi(messages, {
            signal: controller.signal,
            source,
            validate,
          });
        }
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        plan = parsed.plan;
      } catch (error) {
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[虎哩繪] 第 ${floor} 樓第 ${attempt + 1}/${retries + 1} 次生成 tag 失敗`, error);
      }
    }
    if (!plan) {
      // 重試耗盡:允許同一正文在後續重新渲染後再試
      processed.delete(identity);
      toastr.error(
        `${lastError}${retries > 0 ? `(已自動重試 ${retries} 次)` : ''}`,
        '虎哩繪自動 tag 失敗',
      );
      return;
    }

    // 單槽重寫不落 changes:首次全量分析已為整樓建過檔,這裡再應用一次只會產生
    // 重複的建檔/變更記錄;庫文本已含本樓增量(見上面 entriesBefore),AI 照抄即可。
    // 追加一張只收真正的新角色建檔:已建檔角色的變更歸首次全量分析,這裡不重記。
    const libraryNames = new Set(entriesBefore.map(entry => entry.name));
    const planOps = slot
      ? []
      : opts.append
        ? planChangeOps(plan).filter(item => item.op.kind === 'new' && !libraryNames.has(item.op.name))
        : planChangeOps(plan);
    // 鎖定角色(全域性庫)不接受 AI changes:丟棄,不寫入樓層、不參與 @替換。
    // 重放側 applyCharTagOps 也會按鎖定名再攔一次(舊訊息裡可能已存這類 ops)。
    const effectiveOps = lockedNames.size
      ? planOps.filter(item => !lockedNames.has(item.op.name))
      : planOps;
    const floorOps = effectiveOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(message);

    // @佔位符按正文位置替換：變化前圖片用舊檔，變化位置及之後用新檔。
    const unknownNames = new Set<string>();
    for (const image of plan.images) {
      const tagRes = applyPositionedCharRefs(
        image.tag,
        anchors.entries,
        effectiveOps,
        image.sourceLine,
        'tag',
        lockedNames,
      );
      if (tagRes.text) image.tag = tagRes.text;
      if (image.nl) {
        const nlRes = applyPositionedCharRefs(
          image.nl,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'nl',
          lockedNames,
        );
        image.nl = nlRes.text;
        for (const n of nlRes.unknown) unknownNames.add(n);
      }
      for (const character of image.characters) {
        const charTag = applyPositionedCharRefs(
          character.tag,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'tag',
          lockedNames,
        );
        character.tag = charTag.text;
        for (const n of charTag.unknown) unknownNames.add(n);
        if (character.nl) {
          const charNl = applyPositionedCharRefs(
            character.nl,
            anchors.entries,
            effectiveOps,
            image.sourceLine,
            'nl',
            lockedNames,
          );
          character.nl = charNl.text;
          for (const n of charNl.unknown) unknownNames.add(n);
        }
      }
      for (const n of tagRes.unknown) unknownNames.add(n);
    }
    if (unknownNames.size) {
      // 模型認為這是角色、卻沒給它建檔 —— 該角色在圖裡將完全沒有外貌。
      // 這是漏建檔唯一的確定性訊號,藏進控制台等於沒有,必須讓使用者看見。
      const names = [...unknownNames].join('、');
      console.warn('[虎哩繪] AI 引用了庫裡沒有的角色佔位符,已剝除:', names);
      toastr.warning(`角色「${names}」沒有建檔，本次畫面中缺少其外貌`, '虎哩繪');
    }

    // 單槽重寫沒給出新提示詞:保留原提示詞與原圖,不替換(空 images 不是錯誤)。
    if (slot && !plan.images.length) {
      toastr.info('模型沒有給出新的提示詞，本張保持原樣', '虎哩繪');
      return;
    }
    // 沒有圖片、沒有角色變化、也沒有舊樓層變化要清理時,保持原來的無寫入早退。
    if (!plan.images.length && !floorOps.length && !previousDelta) {
      if (opts.manual) toastr.info('模型認為本樓沒有值得插圖的畫面', '虎哩繪');
      else console.debug(`[虎哩繪] 第 ${floor} 樓無需插圖`);
      return;
    }

    // 觸發 MESSAGE_EDITED / MESSAGE_UPDATED,卡片水合掛載時消費標記並自動開始生成
    // (見 floor/autoGenerate.ts);寫回失敗則撤銷標記。
    // 單槽重寫是使用者在卡片上的顯式意圖(同提示詞編輯彈窗的「應用並重新生成」),
    // 不受 autoTag.autoGenerate 開關約束,一律 force 出圖。
    // 追加一張的新 tag 會插在既有 tag 之間,它的 seq 要等寫回正文算出來才知道,標記在 buildNext 裡掛。
    const markSwipeId = message.swipe_id ?? 0;
    const marked = plan.images.length > 0 && (settings.autoTag.autoGenerate || !!slot);
    if (marked && !opts.append) {
      if (slot) {
        markForAutoGenerate(chatId, floor, markSwipeId, slot.seq, 'force');
      } else {
        for (let seq = 0; seq < plan.images.length; seq++) {
          markForAutoGenerate(chatId, floor, markSwipeId, seq);
        }
      }
    }
    // 正文在 buildNext 裡基於「落盤那一刻的真實正文」現算:分析期間別的外掛對正文的修改
    // (翻譯/潤色/追加狀態列/改寫句子)全部保留,tag 按敘事行重新定位後照常注入。
    let rebaseNote = '';
    const result = await applyMessageText(
      floor,
      currentText => {
        // 單槽重寫:只替換第 seq 條 tag,正文與其它 tag 一字不動,也不需要位置重定位。
        // 模型返回的 position 在這裡刻意不參與——畫面釘死在原位,它只負責重寫內容。
        // 開跑時快照的原文對不上 = 期間被使用者/別的流程改過,放棄覆蓋(同提示詞編輯彈窗)。
        if (slot) {
          if (parseImageTags(currentText)[slot.seq] !== slotRawTag) return null;
          return replaceImageTagAt(currentText, slot.seq, serializeImageTag(plan.images[0]));
        }
        // 追加一張:在保留既有 tag 的當前正文上插入;敘事行定位照常(tag 行不參與對齊)
        const base = currentText;
        if (!plan.images.length) return base;
        // 請求期間使用者/別的外掛已經貼過 tag:再注入就是重複,交回 build-failed 走放棄分支
        if (!opts.append && hasImageTagTrace(currentText)) return null;
        const rebased = rebaseImagePositions(
          base,
          preparedTarget.segments,
          plan.images,
          settings.excludes.customStripTags,
        );
        if (!rebased) return null;
        rebaseNote = describeRebase(rebased.report);
        const next = injectImageTags(base, rebased.images);
        if (opts.append && marked) {
          for (const seq of addedTagSeqs(parseImageTags(base), parseImageTags(next))) {
            markForAutoGenerate(chatId, floor, markSwipeId, seq);
          }
        }
        return next;
      },
      chatId,
      swipeId,
      message,
      // 單槽不寫法:本樓角色增量與其它槽點陣圖片都不歸它管,不傳 extraUpdate 即保持原樣。
      // 追加一張:有新建檔才把它接在本樓既有增量之後,否則同樣保持原樣。
      slot || (opts.append && !floorOps.length)
        ? undefined
        : {
            key: BBI_CHAR_EXTRA_KEY,
            value: makeCharTagFloorDelta(
              opts.append ? [...(previousDelta?.ops ?? []), ...floorOps] : floorOps,
              swipeId ?? 0,
            ),
          },
    );
    if (result === 'saved') {
      if (slot) {
        toastr.success(`已重寫第 ${slot.seq + 1} 張的提示詞，正在按新提示詞出圖`, '虎哩繪');
        return;
      }
      recomputeCharTags();
      if (rebaseNote) console.info(`[虎哩繪] 第 ${floor} 樓 tag 位置重定位:${rebaseNote}`);
      if (opts.append) {
        toastr.success(`已在第 ${floor} 樓追加 1 張新畫面`, '虎哩繪');
      } else if (plan.images.length) {
        toastr.success(`已在第 ${floor} 樓插入 ${plan.images.length} 個生圖 tag`, '虎哩繪');
      } else if (opts.manual) {
        toastr.info('模型認為本樓沒有值得插圖的畫面', '虎哩繪');
      } else {
        console.debug(`[虎哩繪] 第 ${floor} 樓無需插圖`);
      }
      return;
    }
    // 撤銷標記只撤自己那一枚:clearAutoGenerateForFloor 會連累同樓其它槽位的待消費標記。
    if (marked) {
      if (slot) consumeAutoGenerate(chatId, floor, markSwipeId, slot.seq);
      else clearAutoGenerateForFloor(chatId, floor);
    }
    console.info(`[虎哩繪] 第 ${floor} 樓放棄寫入生圖 tag：${result}`);
    // 單槽重寫的放棄原因與全量不同:正文其它部分改沒改不重要,關鍵是這一條 tag 被改過
    if (slot && result === 'build-failed') {
      toastr.warning('這張圖的提示詞在生成期間已被改動，本次沒有覆蓋它', '虎哩繪');
    } else {
      toastr.warning(ABANDON_REASON[result] ?? '本次沒有寫入生圖 tag', '虎哩繪');
    }
  } catch (error) {
    // 請求失敗或被切換聊天取消時允許同一正文在後續重新渲染後重試。
    processed.delete(identity);
    // 異常發生在掛標記之後時(如儲存失敗回滾),撤銷本樓標記,不留殘留。
    // 單槽只撤自己那一枚:clearAutoGenerateForFloor 會連累同樓其它槽位的待消費標記。
    if (slot) consumeAutoGenerate(chatId, floor, swipeId ?? 0, slot.seq);
    else clearAutoGenerateForFloor(chatId, floor);
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[虎哩繪] 第 ${floor} 樓自動生成 tag 失敗`, error);
    toastr.error(message, '虎哩繪自動 tag 失敗');
  } finally {
    if (running.get(runKey) === controller) running.delete(runKey);
  }
}

function cancelAll(): void {
  diagnostic('cancelAll', { scheduled: scheduled.size, running: running.size });
  clearGeneration();
  for (const timer of scheduled) clearTimeout(timer);
  scheduled.clear();
  for (const controller of running.values()) controller.abort();
  running.clear();
}

function scheduleForGeneratedFloor(floor: number, chatId: string): void {
  diagnostic('schedule', { floor, chatId });
  const timer = setTimeout(() => {
    scheduled.delete(timer);
    const currentChatId = getContext()?.getCurrentChatId?.() ?? '';
    diagnostic('schedule:fire', { floor, chatId, currentChatId, sameChat: currentChatId === chatId });
    if (currentChatId !== chatId) return;
    void runForFloor(floor);
  }, 0);
  scheduled.add(timer);
}

/**
 * 樓層按鈕的手動入口:每按一次固定追加一張。第一次是本樓最值得畫的瞬間,再按一次是其餘裡最好的,
 * 既有 tag 與圖片原樣保留。「每樓最多幾張」只管新回覆的自動生成;單張重寫在卡片的提示詞編輯彈窗裡。
 */
export async function requestFloorTags(floor: number): Promise<void> {
  await runForFloor(floor, { manual: true, append: true });
}

/**
 * 「AI 重寫提示詞」的手動入口:只重寫並替換第 seq 條 tag(0-based)。
 *
 * 入口在提示詞編輯彈窗裡(floor/promptEditor.ts)——手改與 AI 改是同一件事的兩種手段。
 * 呼叫方把本函式交給 floor/tagPlanState.ts 的 runTagPlan 託管:請求的生命週期歸那個
 * store,**關掉彈窗不中斷重寫**。
 *
 * 畫的仍是原來那個瞬間:寫回按 seq 原位替換,模型返回的 position 不參與,措辭口徑見
 * slotPlan.buildSlotTaskNote(把該槽位當前提示詞喂回去當錨點)。
 * 分析基底剔除全部舊 tag(AI 不該把 tag 當正文),強制輸出 1 張;本樓其它 tag 與圖片
 * 一字不動,舊圖留在該槽位歷史裡。本次 AI 輸出的 changes 一律忽略(首次全量分析時已建檔)。
 */
export async function requestSlotTag(floor: number, seq: number): Promise<void> {
  await runForFloor(floor, { manual: true, slot: { seq } });
}

/** 中止某樓在途的 tag 請求(全量分析與單槽重寫共用同一把「每樓一把」的鎖)。 */
export function cancelFloorTags(floor: number): void {
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  running.get(`${chatId}\u0000${floor}`)?.abort();
}

/** Only pair automatic tagging with the final render of a real ST generation. */
export function bindAutoTagging(): void {
  if (bound) {
    diagnostic('bind:skip', { reason: 'already-bound' });
    return;
  }
  const context = getContext();
  const events = context?.eventTypes;
  if (!context?.eventSource || !events?.GENERATION_STARTED || !events.CHARACTER_MESSAGE_RENDERED) {
    diagnostic('bind:skip', {
      reason: 'missing-events',
      hasContext: Boolean(context),
      hasEventSource: Boolean(context?.eventSource),
      generationStarted: events?.GENERATION_STARTED ?? null,
      characterRendered: events?.CHARACTER_MESSAGE_RENDERED ?? null,
    });
    return;
  }
  bound = true;

  diagnostic('bind', {
    generationStarted: events.GENERATION_STARTED,
    characterRendered: events.CHARACTER_MESSAGE_RENDERED,
    generationEnded: events.GENERATION_ENDED ?? null,
    generationStopped: events.GENERATION_STOPPED ?? null,
    chatChanged: events.CHAT_CHANGED,
  });
  context.eventSource.on(
    events.GENERATION_STARTED,
    (type: unknown, options: unknown, dryRun: unknown) => {
      const chatId = getContext()?.getCurrentChatId?.() ?? '';
      const eligible = Boolean(
        chatId && !dryRun && typeof type === 'string' && type !== 'quiet' && type !== 'impersonate',
      );
      diagnostic('GENERATION_STARTED', { chatId, type, dryRun, eligible, options });
      beginGeneration(chatId, type, dryRun);
    },
  );
  context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    const matched = consumeGeneration(chatId, type);
    diagnostic('CHARACTER_MESSAGE_RENDERED', { chatId, messageId, type, matched });
    if (!matched) return;
    const floor = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) {
      diagnostic('render:skip', { chatId, messageId, type, reason: 'invalid-floor' });
      return;
    }
    // Do not block ST finalization, and pin the deferred run to the originating chat.
    scheduleForGeneratedFloor(floor, chatId);
  });
  if (events.GENERATION_ENDED) {
    context.eventSource.on(events.GENERATION_ENDED, (...args: unknown[]) => {
      // ST may emit this before the final CHARACTER_MESSAGE_RENDERED; that render consumes the gate.
      diagnostic('GENERATION_ENDED', { args, action: 'keep-pending-until-final-render' });
    });
  }
  if (events.GENERATION_STOPPED) {
    context.eventSource.on(events.GENERATION_STOPPED, (...args: unknown[]) => {
      diagnostic('GENERATION_STOPPED', { args });
      clearGeneration();
    });
  }
  context.eventSource.on(events.CHAT_CHANGED, (...args: unknown[]) => {
    diagnostic('CHAT_CHANGED', { args, currentChatId: getContext()?.getCurrentChatId?.() ?? '' });
    cancelAll();
  });
}
