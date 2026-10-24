<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { cancelFloorTags } from '@/autoTag/runner';
import type { Orientation } from '@/backends/size';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { consumeAutoGenerate, shouldAutoGenerate } from '@/floor/autoGenerate';
import { isCollapsed, setCollapsed } from '@/floor/collapseState';
import { imageDownloadFileName, saveImageFile } from '@/floor/download';
import {
  beginGen,
  cancelGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  reconcileGen,
  setGenPhase,
  setGenRetry,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';
import { hydrateMessage } from '@/floor/hydrate';
import { openLightbox } from '@/floor/lightbox';
import { confirmImageMissing, isImageMissing } from '@/floor/missingImages';
import { openPromptEditor } from '@/floor/promptEditor';
import {
  deleteImageResult,
  promptHash,
  saveImageResult,
  type BbiImageEntry,
} from '@/floor/storage';
import { isTagPlanning } from '@/floor/tagPlanState';
import { activeComfyPreset, settings } from '@/state/settings';
import { beginImage, failImage, finishImage, safeHistory } from '@/state/history';
import { copyText } from '@/st/clipboard';
import { getContext } from '@/st/context';
import { formatPromptText } from '@/st/imageTagRegex';

/**
 * 樓層生圖卡片(DESIGN-FLOOR-UI.md §8)。
 *
 * 【重要】本元件是**純展示層**,不持有執行態。
 * 卡片的生命週期由外部水合決定:任一槽位出圖成功都會 hydrateMessage 重水合,
 * 而重水合解除安裝**整樓**卡片;ST 重渲染樓層時錨點 DOM 也會重建。
 * 執行態(生成中/錯誤/在途請求)一律存 floor/genState.ts 的模組級 store,按槽位 key 認領,
 * 元件重建後立刻讀回——否則會出現「一張圖完成,其餘卡片的『生成中…』集體消失並退回 pending」
 * (標記已消費,不會自動重跑)。改這裡前先讀 genState.ts 頂部註釋。
 *
 * 展示態分兩層:
 * - 執行態(store):queued / generating / error —— 跨重建存活;
 * - 派生態(props):ready(有本提示詞歷史)/ stale(僅有舊提示詞結果)/ pending —— 每次由 props 算出。
 */

const props = defineProps<{
  /** tag 原文解析出的 tag 部分(danbooru 短 tag;展示與生成用)。 */
  prompt: string;
  /** tag 原文解析出的自然語言部分(無則空串;生成時寫入 %nl% 佔位符)。 */
  nl: string;
  /** tag 原文解析出的動態負面部分(無則空串;生成時寫入 %negative_prompt% 佔位符)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 畫幅方向(模型判定,隨 tag 持久化):決定用渠道配置裡的豎屏還是橫屏尺寸。 */
  size: Orientation;
  /** tag 原文(含 <hooli_image> 殼):生成提交與 promptHash 的輸入。 */
  tag: string;
  messageId: number;
  seq: number;
  swipeId: number;
  /** 當前提示詞同槽位的全部歷史(時間正序,最新在末尾)。 */
  history: BbiImageEntry[];
  /** 無匹配歷史時,舊提示詞同槽位的最新結果(stale)。 */
  staleEntry: BbiImageEntry | null;
  /** 所在聊天 id(水合時傳入):槽位 key 的一部分,不再各自去 getContext 取。 */
  chatId: string;
}>();

type Phase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const key = computed(() => slotKey(props.chatId, props.messageId, props.swipeId, props.seq));
const hash = computed(() => promptHash(props.tag));

/**
 * 檔案仍在的那部分歷史。**卡片一律用它,不用 props.history**。
 *
 * 相簿現在能直接刪 user/images 下的檔案,而那張圖的指標還留在本樓的 extra 裡
 * (相簿按目錄列圖、指標在某個聊天裡,兩者無反向索引,掃全庫反查不可行——
 * 見 floor/missingImages.ts 頂部)。破指標不過濾掉的話:翻頁器會多出翻得到卻是空的格子,
 * 摺疊條的「N 張」也跟著虛高。
 *
 * 過濾只看**已確認 404**的圖(missingImages 冊),不是猜的:沒被標記的圖一律當作還在。
 */
const liveHistory = computed(() => props.history.filter(entry => !isImageMissing(entry.path)));
/** 舊提示詞結果同樣要對賬:它的檔案一樣可能被相簿刪掉。 */
const liveStale = computed(() =>
  props.staleEntry && !isImageMissing(props.staleEntry.path) ? props.staleEntry : null,
);

/** 翻頁位置:預設最新一張。history 變化(新圖落盤 / 刪掉破指標)後自動跟到最新。 */
const index = ref(liveHistory.value.length ? liveHistory.value.length - 1 : 0);
watch(
  () => liveHistory.value.length,
  length => {
    // 刪掉的若是當前這張,index 會越界 → 鉗回最後一張;新圖落盤則跟到最新
    index.value = length ? length - 1 : 0;
  },
);

const promptOpen = ref(false);

/**
 * 摺疊態:存模組級 store 按槽位 key 認領(元件隨時被水合重建,ref 會丟),
 * 未手動設定過的槽位回落到設定項「樓層圖片預設摺疊」。見 floor/collapseState.ts。
 */
const collapsed = computed<boolean>({
  get: () => isCollapsed(key.value, settings.ui.autoCollapseImages),
  set: value => setCollapsed(key.value, value),
});

/** 觸屏收納選單(⋯ 鈕)的展開態;桌面 hover 一排直達,不用它。 */
const menuOpen = ref(false);

/** 執行態記錄(可能為 undefined = 無在途任務)。 */
const record = computed(() => getGenRecord(key.value));

/**
 * 「AI 重寫提示詞」的請求在途(模組級 store,見 floor/tagPlanState.ts)。
 * 與出圖執行態刻意分開:它跑的是 LLM 請求,取消/併發語義與出圖各自獨立。
 */
const planning = computed(() => isTagPlanning(key.value));

const phase = computed<Phase>(() => {
  const running = record.value;
  if (running) return running.phase;
  // 用存活口徑:圖被相簿刪光後該退回 pending 給出「生成圖片」入口,
  // 而不是頂著 ready 顯示一張破圖(那樣連重新生成都點不了)。
  if (liveHistory.value.length) return 'ready';
  if (liveStale.value) return 'stale';
  return 'pending';
});

const error = computed(() => record.value?.error ?? '');
const queueAhead = computed(() => record.value?.queueAhead ?? null);
/** 限流退避中(NAI 自動重試);非 null 時狀態文案優先報它。 */
const retryInfo = computed(() => record.value?.retry ?? null);

const comfyActive = computed(() => settings.defaultBackend === 'comfyui');
const naiActive = computed(() => settings.defaultBackend === 'nai');
/**
 * 後端是否已配齊(決定給「生成圖片」按鈕還是配置引導)。
 * 判據在 generate.ts 的 backendStatus 裡,與真正出圖、與公開介面同源——
 * 曾經這裡自己判一套,改了 ComfyUI 簡易模式的校驗就得兩處同步改。
 */
const configured = computed(() => backendStatus().configured);

const current = computed(() => liveHistory.value[index.value] ?? null);
/** 提示詞全文:複製、燈箱、展開區共用。口徑與相簿同源(st/imageTagRegex.ts)。 */
const promptText = computed(() =>
  formatPromptText({
    tag: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters,
  }),
);
/**
 * 當前展示的結果。**刻意不看執行態**:生成失敗/重繪中都該繼續顯示上一張圖,
 * 否則「有圖 → 點重繪 → 失敗」會讓圖憑空消失(只剩一行報錯),看著像把圖弄丟了。
 */
const shownEntry = computed(() => (liveHistory.value.length ? current.value : liveStale.value));
const imageSrc = computed(() => shownEntry.value?.path ?? '');

/**
 * `<img>` 載入失敗:確認確實是 404 再落冊,讓上面那些 live* 把它摘掉。
 *
 * 不一 error 就當刪除——error 分不清「檔案沒了」和「網斷了」(詳見 missingImages.ts)。
 * 確認失敗時什麼都不做:破圖佔位留著,下次重掛 <img> 會自然重試。
 */
async function onImageError(): Promise<void> {
  const path = imageSrc.value;
  if (!path) return;
  await confirmImageMissing(path);
}
const downloadFileName = (entry: BbiImageEntry): string => {
  const context = getContext();
  const characterName = context?.chat[props.messageId]?.name || context?.name2 || '';
  return imageDownloadFileName(entry.path, characterName, entry.generationId);
};
/** 展示的圖是否屬於舊提示詞(有舊結果但當前提示詞還沒出過圖)。 */
const isStale = computed(() => !liveHistory.value.length && !!liveStale.value);
/** 生成中/排隊中仍顯示上一張(若有),避免卡片塌空;骨架疊在其上。 */
const busy = computed(() => phase.value === 'generating' || phase.value === 'queued');
/** 歷史翻頁:多於一張且不忙才給(按存活張數,破指標不佔格)。 */
const pageable = computed(() => liveHistory.value.length > 1 && !busy.value && !planning.value);

/** 有過結果、但檔案已被刪光(通常是在相簿裡刪的)。據此給一句說明,免得像憑空丟圖。 */
const filesGone = computed(
  () =>
    !busy.value &&
    !liveHistory.value.length &&
    !liveStale.value &&
    !!(props.history.length || props.staleEntry),
);

const statusLabel = computed(() => {
  // 退避優先:請求已經失敗過、正在等重試,不能繼續報「生成中」騙人
  const retry = retryInfo.value;
  if (retry) return `請求受限,稍後第 ${retry.attempt}/${retry.max} 次重試…`;
  if (phase.value === 'queued') return '排隊中…';
  const ahead = queueAhead.value;
  if (phase.value === 'generating' && ahead !== null && ahead > 0) return `排隊中(前面 ${ahead} 個)`;
  return '生成中…';
});

/** 摺疊條主文案:生成中報進度;出錯報原因;有圖給提示詞摘要(區分同樓多圖);空槽位顯示待生成。 */
const barText = computed(() => {
  if (planning.value) return 'AI 重寫提示詞…';
  if (busy.value) return statusLabel.value;
  if (phase.value === 'error') return error.value || '生成失敗';
  if (shownEntry.value) return props.prompt || props.nl || '圖片';
  if (filesGone.value) return '圖片檔案已刪除';
  return '待生成';
});

/** 無圖且後端未就緒時,佔位區中央的配置引導。 */
const pendingHint = computed(() => {
  if (!comfyActive.value && !naiActive.value)
    return '出圖後端未選擇,請到虎哩繪「渠道」頁選擇出圖渠道';
  // 帶上具體缺什麼(沒填網址、沒選模型、工作流是空的……),新手照著補就好
  const reason = backendStatus().reason;
  return naiActive.value
    ? `NovelAI 還沒設定好${reason ? `:${reason}` : ''}。請到虎哩繪「渠道」頁設定`
    : `ComfyUI 還沒設定好${reason ? `:${reason}` : ''}。請到虎哩繪「渠道」頁的 ComfyUI 區塊,用「簡易引數」選模型,或貼上 API 格式的工作流`;
});

async function generate(): Promise<void> {
  if (busy.value || planning.value || !configured.value) return;
  const slot = key.value;
  const currentHash = hash.value;
  // 本次任務的輸入全部就地取值:請求在途時本元件很可能已被重水合銷燬
  // (任一兄弟槽位出圖都會觸發全樓重建),銷燬後再讀 props 不可靠。
  const job = {
    messageId: props.messageId,
    swipeId: props.swipeId,
    seq: props.seq,
    tag: props.tag,
    prompt: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters.map(character => ({ ...character })),
    size: props.size,
  };
  // NAI 需要閘門排隊 → 先顯示「排隊中」;ComfyUI 有服務端佇列,直接進 generating
  const { signal, token } = beginGen(slot, currentHash, naiActive.value ? 'queued' : 'generating');
  // 歷史記錄 id:在 seed 確定後才登記(見下),故這裡先置空,catch 裡據此判斷要不要收尾。
  let historyId: number | null = null;

  try {
    // 發起時就確定種子(NAI 面板種子 > 0 時用固定值;否則隨機),隨結果落盤進 extra
    // (entry.seed),歷史翻頁可查/可複用。口徑在 generate.ts,與公開介面同源。
    const seed = decideSeed(settings.defaultBackend);
    // 歷史埋點:seed 已定、請求將發,此刻登記。圖片本身不進 store(dataURL 會爆記憶體,
    // 且圖隨後就落盤進 ST 了)——只留元資訊 + 樓層座標,夠回溯「這張圖是怎麼來的」。
    historyId = safeHistory(() =>
      beginImage({
        backend: naiActive.value ? 'nai' : 'comfyui',
        model: naiActive.value ? settings.nai.model : activeComfyPreset().name,
        prompt: job.prompt,
        nl: job.nl,
        negative: job.negative,
        characters: job.characters,
        seed,
        size: job.size,
        floor: job.messageId,
        seq: job.seq,
      }),
    );
    // 閘門、後端分派都在 generateImage 裡(公開介面走同一條路,見 generate.ts);
    // 本元件只把進度回撥接到自己的槽位執行態上。
    const { result } = await generateImage({ ...job, seed }, signal, {
      onStart: () => setGenPhase(slot, token, 'generating'),
      onQueue: ahead => setQueueAhead(slot, token, ahead),
      onRetry: retry => setGenRetry(slot, token, retry),
    });
    // 圖已經拿到手:此時若發現本任務已被取代(取消後重繪 / reconcile),不要落盤,
    // 否則會把舊提示詞的結果寫進 extra,並觸發一次多餘的重水合打斷新任務。
    if (!isCurrentGen(slot, token)) {
      result.revoke();
      // 圖出來了卻被丟棄,歷史裡記成「已取消」——否則這條會永遠停在「進行中」。
      if (historyId !== null) safeHistory(() => failImage(historyId!, '', true));
      return;
    }
    // 落盤:圖片進 ST 檔案系統 + extra 寫指標。成功後重水合,
    // 卡片從 extra 恢復為 ready(blob/dataURL 生命週期隨之結束)。
    await saveImageResult(job.messageId, job.swipeId, job.seq, job.tag, seed, result);
    result.revoke();
    if (historyId !== null) safeHistory(() => finishImage(historyId!));
    // 先清執行態再重水合:重水合會重建本元件,清完才不會帶著 generating 復活
    clearGen(slot, token);
    const ctx = getContext();
    if (ctx) hydrateMessage(job.messageId, ctx);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (historyId !== null) {
      safeHistory(() => failImage(historyId!, e instanceof Error ? e.message : String(e), aborted));
    }
    if (aborted) {
      clearGen(slot, token);
    } else {
      failGen(slot, token, e instanceof Error ? e.message : String(e));
    }
  }
}

function cancel(): void {
  cancelGen(key.value);
}

function openImage(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  // 就地取值:燈箱掛在外掛 shadow root,**活得比本卡片長**——任一兄弟槽位出圖都會
  // 重水合銷燬本元件,而燈箱還開著。回撥裡再讀 props 就是讀已銷燬例項,故全部先快照。
  const at = { messageId: props.messageId, swipeId: props.swipeId };
  openLightbox({
    src: entry.path,
    prompt: promptText.value,
    filename: downloadFileName(entry),
    onDelete: () => void removeEntry(entry, at),
  });
}

/**
 * 開啟提示詞編輯彈窗。與燈箱同一條紀律:彈窗掛外掛 shadow root、**活得比本卡片長**,
 * 樓層座標與內容一律先快照(任一兄弟槽位出圖都會重水合銷燬本元件)。
 * 提示詞的真源是正文,故寫回與後續重水合都在 promptEditor.ts 裡做,本元件不參與。
 */
function openEditor(): void {
  openPromptEditor({
    at: {
      chatId: props.chatId,
      messageId: props.messageId,
      swipeId: props.swipeId,
      seq: props.seq,
      rawTag: props.tag,
    },
    content: {
      tag: props.prompt,
      nl: props.nl,
      negative: props.negative,
      characters: props.characters.map(character => ({ ...character })),
      size: props.size,
    },
    // 存活口徑:文案要許諾「改回提示詞即可找回」,被相簿刪掉的圖找不回來,不能算進去
    historyCount: liveHistory.value.length,
    configured: configured.value,
  });
}

/**
 * 取消在途的「AI 重寫提示詞」。
 *
 * 入口在提示詞編輯彈窗裡(floor/promptEditor.ts),不在卡片上 —— 手改與 AI 改是同一件事。
 * 但**請求不屬於那個彈窗**:使用者關掉彈窗後重寫照跑,故卡片這邊仍要顯示進度並留取消口,
 * 否則關了窗就只剩一張悄悄變化的圖、沒處叫停。展示態讀 tagPlanState,中止靠 runner
 * 的每樓請求鎖。
 */
function cancelReplan(): void {
  cancelFloorTags(props.messageId);
}

/** 刪除當前展示的這一條結果(DESIGN-FLOOR-UI.md §8.2)。 */function removeCurrent(): void {
  const target = shownEntry.value;
  if (!target) return;
  void removeEntry(target, { messageId: props.messageId, swipeId: props.swipeId });
}

/**
 * 刪除一條結果。樓層座標由呼叫方傳入而非現場讀 props:
 * 本函式可能在元件銷燬後才真正執行(燈箱回撥 + 確認彈窗都是非同步的)。
 */
async function removeEntry(
  target: BbiImageEntry,
  at: { messageId: number; swipeId: number },
): Promise<void> {
  const ok = await confirmDialog({
    title: '刪除這張圖',
    text: '將刪除這張圖的聊天記錄，無法恢復；images 中的檔案會一併刪除，files 中的舊圖保留。同一提示詞的其它歷史結果不受影響。',
    confirmText: '刪除',
    tone: 'danger',
  });
  if (!ok) return;
  // stale 的圖存在別的 hash 桶裡,刪除要用它自己的 promptHash,不能用當前 tag 的
  const bucketHash = promptHash(target.prompt);
  const removed = await deleteImageResult(
    at.messageId,
    at.swipeId,
    bucketHash,
    target.generationId,
  );
  if (!removed) {
    toastr.error('刪除失敗,聊天記錄未能儲存', '虎哩繪');
    return;
  }
  const ctx = getContext();
  if (ctx) hydrateMessage(at.messageId, ctx);
}

async function copyPrompt(): Promise<void> {
  await copyText(promptText.value, '提示詞已複製');
}

/** 另存當前展示的這張圖(與燈箱共用 download.ts,免得兩份邏輯漂移)。 */
function downloadCurrent(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  saveImageFile(entry.path, downloadFileName(entry));
}

// 提示詞變更對賬放 watch 而非 onMounted:差分水合(hydrate.ts)下同錨點卡片是
// props patch 而非重掛,onMounted 不會再跑;tag 一變必須立刻作廢舊提示詞的任務。
watch(hash, current => reconcileGen(key.value, current), { immediate: true });

onMounted(() => {
  // 「寫入 tag 後自動生成圖片」:本槽位帶著標記水合掛載 → 消費標記並直接開始生成。
  // **標記一律先消費再判斷**:留著它會在日後同槽位重現(比如使用者刪掉舊圖)時被新卡片
  // 誤認領,憑空開跑一次使用者沒點過的生成。判定本身抽成 shouldAutoGenerate 純函式
  // (本元件沒有單測,留在這兒鎖不住),口徑見 floor/autoGenerate.ts。
  // 未配置後端時不跑(卡片維持 pending,顯示配置引導);標記同樣已消費掉。
  if (!props.chatId) return;
  const mode = consumeAutoGenerate(props.chatId, props.messageId, props.swipeId, props.seq);
  if (!mode) return;
  if (!shouldAutoGenerate(mode, phase.value)) return;
  if (!configured.value) return;
  void generate();
});
</script>

<template>
  <!-- 沉浸式設計:圖即卡片。無邊框/無背景面板/無品牌欄,控制元件懸浮在圖上,
       桌面 hover 浮現、觸屏常駐淡顯;提示詞收進懸浮按鈕喚起的面板,平時零佔位。 -->
  <div class="bbi-figure" :data-phase="phase">
    <!-- 摺疊態:收成一條細條,職責只有「佔位 + 展開」——整條點選展開,
         生成中/出錯在條上給狀態但不放操作按鈕(要操作先展開)。 -->
    <button
      v-if="collapsed"
      class="bbi-figure__bar"
      type="button"
      title="展開圖片"
      @click="collapsed = false"
    >
      <span v-if="busy || planning" class="bbi-figure__bar-spin" aria-hidden="true" />
      <Icon v-else name="generate" :size="14" class="bbi-figure__bar-icon" />
      <span class="bbi-figure__bar-text" :data-error="phase === 'error' && !busy && !planning ? '1' : ''">
        {{ barText }}
      </span>
      <span v-if="liveHistory.length > 1 && !busy" class="bbi-figure__bar-count">
        {{ liveHistory.length }} 張
      </span>
      <Icon name="chevron" :size="13" class="bbi-figure__bar-chevron" />
    </button>

    <!-- 摺疊容器:常駐 DOM(grid-template-rows 1fr→0fr 過渡做高度動畫),摺疊時只是
         高度歸零 + 淡出,<img> 不解除安裝——展開瞬間圖就在,不會重新發起請求。 -->
    <div class="bbi-figure__collapse" :data-collapsed="collapsed ? '1' : ''">
      <div class="bbi-figure__collapse-inner">
    <div class="bbi-figure__stage" :data-size="size" :data-placeholder="imageSrc ? '' : '1'">
      <img
        v-if="imageSrc"
        class="bbi-figure__img"
        :src="imageSrc"
        alt="生圖結果"
        @click="openImage"
        @error="onImageError"
      />

      <!-- 無圖時的生成中:骨架微光掃過佔位底 -->
      <div v-if="busy && !imageSrc" class="bbi-figure__skeleton" />

      <!-- 生成中遮罩:絕對定位蓋在整個舞臺上(有圖=磨砂蓋住舊圖,無圖=壓住骨架)。
           居中 spinner + 狀態 + 取消,不再像舊版那樣作為 flex 子項跟圖片並排互擠。 -->
      <div v-if="busy" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">{{ statusLabel }}</span>
        <button class="bbi-figure__cancel" type="button" @click="cancel">取消</button>
      </div>

      <!-- 提示詞重寫遮罩(AI 重寫提示詞):還是同一張圖,只蓋一層進度與取消;
           與出圖遮罩互斥(replan/generate 的守衛保證兩者不同時在途) -->
      <div v-else-if="planning" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">AI 重寫提示詞…</span>
        <button class="bbi-figure__cancel" type="button" @click="cancelReplan">取消</button>
      </div>

      <!-- 無圖且空閒:生成入口 / 配置引導 -->
      <div v-if="!imageSrc && !busy" class="bbi-figure__pending">
        <button v-if="configured" class="bbi-figure__generate" type="button" @click="generate">
          <Icon name="palette" :size="15" />
          {{ phase === 'error' ? '重試' : '生成圖片' }}
        </button>
        <p v-else class="bbi-figure__hint">{{ pendingHint }}</p>
      </div>

      <!-- 提示詞已改:角標提示,不再整圖壓暗 -->
      <span v-if="isStale && !busy && !planning" class="bbi-figure__badge">舊提示詞</span>

      <!-- 懸浮操作組:⋯ 收納鈕釘在右上角常駐淡顯;桌面 hover 在其左側橫向浮現一排,
           觸屏點開在其下方豎排展開,點任意操作後自動收起(圖片平時只有一顆小點) -->
      <span v-if="!busy && !planning" class="bbi-figure__actions" :data-open="menuOpen ? '1' : ''">
        <button
          class="bbi-fab bbi-figure__more"
          type="button"
          title="更多操作"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <Icon name="more" :size="15" />
        </button>
        <span class="bbi-figure__menu">
          <button
            class="bbi-fab"
            type="button"
            title="摺疊圖片"
            @click="menuOpen = false; collapsed = true"
          >
            <Icon name="chevron" :size="15" style="transform: rotate(180deg)" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            :disabled="!configured"
            :title="configured ? '重繪' : '請先在虎哩繪「渠道」頁完成配置'"
            @click="menuOpen = false; generate()"
          >
            <Icon name="refresh" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            title="下載這張圖"
            @click="menuOpen = false; downloadCurrent()"
          >
            <Icon name="download" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab bbi-fab--danger"
            type="button"
            title="刪除這張圖"
            @click="menuOpen = false; removeCurrent()"
          >
            <Icon name="trash" :size="15" />
          </button>
          <button
            class="bbi-fab"
            type="button"
            title="編輯提示詞"
            @click="menuOpen = false; openEditor()"
          >
            <Icon name="edit" :size="15" />
          </button>
          <button
            v-if="promptText"
            class="bbi-fab"
            :class="{ 'bbi-fab--on': promptOpen }"
            type="button"
            title="檢視提示詞"
            :aria-expanded="promptOpen"
            @click="menuOpen = false; promptOpen = !promptOpen"
          >
            <Icon name="text" :size="15" />
          </button>
        </span>
      </span>

      <!-- 翻頁器:疊在圖片右下角的膠囊 -->
      <span v-if="pageable" class="bbi-figure__pager">
        <button class="bbi-figure__pager-btn" type="button" :disabled="index <= 0" @click="index--">◀</button>
        <span class="bbi-figure__pager-count">{{ index + 1 }}/{{ liveHistory.length }}</span>
        <button
          class="bbi-figure__pager-btn"
          type="button"
          :disabled="index >= liveHistory.length - 1"
          @click="index++"
        >
          ▶
        </button>
      </span>
    </div>

    <!-- 狀態行:僅出錯 / 提示詞已改時出現,平時零佔位 -->
    <p v-if="phase === 'error'" class="bbi-figure__status bbi-figure__status--error">
      {{ error
      }}<button v-if="configured" class="bbi-figure__retry" type="button" @click="generate">
        重試
      </button>
    </p>
    <p v-else-if="isStale && !busy && !planning" class="bbi-figure__status bbi-figure__status--warn">
      提示詞已修改,上圖由舊提示詞生成;點右上角重繪按新提示詞出圖
    </p>
    <!-- 檔案被刪(通常是在相簿裡刪的):記錄還在但圖沒了,明說一句免得像憑空丟圖 -->
    <p v-else-if="filesGone" class="bbi-figure__status bbi-figure__status--warn">
      圖片檔案已刪除(在相簿裡刪掉了);可點上方重新生成
    </p>

    <!-- 提示詞面板:懸浮 文本按鈕喚起,複製按鈕跟著面板走 -->
    <div v-if="promptOpen && promptText" class="bbi-figure__prompt-box">
      <pre class="bbi-figure__prompt">{{ promptText }}</pre>
      <button class="bbi-figure__prompt-copy" type="button" title="複製提示詞" @click="copyPrompt">
        <Icon name="copy" :size="14" />
      </button>
    </div>
      </div>
    </div>
  </div>
</template>
