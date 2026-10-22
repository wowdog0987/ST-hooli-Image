<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { containsTagMarkup, type ImageTagContent } from '@/st/imageTagRegex';

/**
 * 手動編輯生圖提示詞的彈窗(樓層卡片 ⋯ 選單裡的鉛筆鈕)。
 *
 * 【為什麼編輯結構化欄位而不是一個大文本框】
 * 卡片上那個 promptText(Card.vue)是拼給人看的展示串,帶「角色: 小雪」「Negative: 」
 * 字首,**不可逆解析**。這裡按 ImageTagContent 的五個欄位分別編輯,儲存時由
 * serializeImageTag 統一序列化 —— 沒給編輯的欄位也原樣帶回,不會靜默吃掉 characters。
 *
 * 【本元件是命令式掛載的(floor/promptEditor.ts),活得比卡片長】
 * 任一兄弟槽位出圖都會重水合、銷燬卡片,而彈窗還開著。故樓層座標一律由呼叫方快照後
 * 傳參,元件內絕不去讀卡片的 props —— 與 Lightbox 同一條紀律。
 */

const props = defineProps<{
  /** 開啟時的原始內容(解析結果);草稿以此為基準比對「有沒有真的改」。 */
  content: ImageTagContent;
  /** 當前提示詞下已有幾張圖(>1 時提示改提示詞會收成一張)。 */
  historyCount: number;
  /** 後端是否已配置好(未配置時「應用並重新生成」不可點)。 */
  configured: boolean;
  /** 忙碌中(寫回正在進行):停用底部按鈕,避免連點寫兩次。 */
  busy?: boolean;
  /**
   * AI 重寫提示詞在途(執行態在 floor/tagPlanState.ts,**不屬於本彈窗**)。
   * 關窗不中斷重寫,重開的彈窗照樣看到它亮著 —— 故由呼叫方按 store 傳進來。
   */
  rewriting?: boolean;
  /** 本窗內已有過一次 AI 重寫落盤:下面輸入框裡的是**已儲存**的版本,明說一句。 */
  rewritten?: boolean;
  /**
   * 呼叫方要求關閉:置 true 後本元件播離場動畫。
   * **不能反過來用 ref 拿元件例項**——本元件是 render(h(...)) 命令式掛載的,
   * 沒有父元件例項,`ref` 的 owner 為 null:掛載時 Vue 靜默跳過(有 parentComponent 護欄),
   * 解除安裝時那道護欄沒有,直接讀 owner.refs 拋 "Cannot read properties of null"。
   * 狀態一律走 props/emit,別把 ref 當逃生口。
   */
  closing?: boolean;
}>();

const emit = defineEmits<{
  /** 應用;regenerate=true 表示寫回後直接開跑出圖。 */
  (e: 'apply', value: ImageTagContent, regenerate: boolean): void;
  /** 請求 AI 重寫這一張的提示詞(落盤與出圖由呼叫方做,本元件只負責把結果讀回草稿)。 */
  (e: 'rewrite'): void;
  /** 取消在途的 AI 重寫。 */
  (e: 'cancel-rewrite'): void;
  /** 草稿是否已改動(呼叫方據此決定關窗前要不要問「放棄修改?」)。 */
  (e: 'dirty', value: boolean): void;
  (e: 'close'): void;
}>();

/**
 * 顯隱態。**初值必須是 false**:Vue 的 <Transition> 預設不給首次渲染播動畫(沒有 appear),
 * 掛載時就 true 的話彈窗會硬邦邦地直接出現。掛載後翻成 true 才有入場動畫 ——
 * 與設定頁那些「open 從 false 翻上來」的彈窗表現一致。
 */
const open = ref(false);

const tag = ref(props.content.tag);
const nl = ref(props.content.nl);
const negative = ref(props.content.negative);
const size = ref<Orientation>(props.content.size);
const characters = ref<ImageCharacterPrompt[]>(
  props.content.characters.map(character => ({ ...character })),
);

/** 換行折成空格:與 parseImageTagContent 的 oneLine 同口徑(提示詞裡換行沒有意義)。 */
function oneLine(text: string): string {
  return text.trim().replace(/[\r\n]+/g, ' ');
}

/** 草稿歸一後的結果 —— 儲存與「有沒有改」都以它為準,兩處不能各算一次。 */
const draft = computed<ImageTagContent>(() => ({
  tag: oneLine(tag.value),
  nl: oneLine(nl.value),
  negative: oneLine(negative.value),
  characters: characters.value
    .map(character => ({
      name: oneLine(character.name),
      tag: oneLine(character.tag),
      nl: oneLine(character.nl),
    }))
    // 與 parseImageTagContent 同口徑:name/tag 缺一條即丟棄(空行不落進正文)
    .filter(character => character.name && character.tag),
  size: size.value,
}));

function sameCharacters(a: ImageCharacterPrompt[], b: ImageCharacterPrompt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, index) =>
      item.name === b[index].name && item.tag === b[index].tag && item.nl === b[index].nl,
  );
}

/**
 * 草稿與原始內容是否一致。**按欄位比對,不比對序列化結果**:
 * 解析是容忍式的(裸文本 / 顯式 <tag> / 缺子標籤都收),序列化是規範式的,
 * 一個手寫的非規範 tag 開啟再原樣儲存,序列化出來的原文就變了 → promptHash 變了 →
 * 明明什麼都沒改,老圖卻全變成「舊提示詞」。
 */
const dirty = computed(() => {
  const next = draft.value;
  return (
    next.tag !== props.content.tag ||
    next.nl !== props.content.nl ||
    next.negative !== props.content.negative ||
    next.size !== props.content.size ||
    !sameCharacters(next.characters, props.content.characters)
  );
});

/** 校驗:tag 必填 + 全欄位禁含子標籤字面量(口徑與 AI 側同一份)。 */
const error = computed(() => {
  const next = draft.value;
  if (!next.tag) return '畫面 tag 不能為空';
  const fields: Array<[string, string]> = [
    ['畫面 tag', next.tag],
    ['自然語言', next.nl],
    ['負面提示詞', next.negative],
  ];
  for (const character of next.characters) {
    fields.push([`角色「${character.name}」`, `${character.name} ${character.tag} ${character.nl}`]);
  }
  for (const [label, value] of fields) {
    if (value && containsTagMarkup(value)) {
      return `${label}不能包含 <hooli_image> / <tag> / <nl> / <negative> / <characters> / <size> 標籤`;
    }
  }
  return '';
});

const canApply = computed(() => !error.value && !props.busy && !props.rewriting);

/**
 * AI 重寫落盤後,把新提示詞讀回輸入框。
 *
 * 重寫是**真落盤**的(runner 寫正文 + 出圖),所以 content 變了就意味著「正文裡現在
 * 是這一份」;彈窗裡的草稿必須跟著換,否則使用者點「應用」會拿舊草稿把剛重寫的覆蓋掉。
 * 刻意不問「要不要丟棄草稿」:重寫是使用者自己點的,且草稿內容原樣躺在下面的輸入框裡,
 * 他看得見、隨時能再改。
 */
watch(
  () => props.content,
  next => {
    tag.value = next.tag;
    nl.value = next.nl;
    negative.value = next.negative;
    size.value = next.size;
    characters.value = next.characters.map(character => ({ ...character }));
  },
);

function addCharacter(): void {
  characters.value.push({ name: '', tag: '', nl: '' });
}

function removeCharacter(index: number): void {
  characters.value.splice(index, 1);
}

function apply(regenerate: boolean): void {
  if (!canApply.value) return;
  emit('apply', draft.value, regenerate);
}

function rewrite(): void {
  if (props.busy || props.rewriting || !props.configured) return;
  emit('rewrite');
}

/**
 * 關閉前的丟棄確認交給呼叫方(它有 confirmDialog,且要按 dirty 決定問不問)。
 * 重寫在途時照常允許關閉:請求屬於 tagPlanState 而非本彈窗,關窗不中斷它,
 * 重開時還能接上(見 promptEditor.ts 的 rejoin)。
 */
function requestClose(): void {
  if (props.busy) return;
  emit('close');
}

// 草稿改動態推給呼叫方(它沒有元件例項可讀,見 closing prop 的註釋)
watch(dirty, value => emit('dirty', value), { immediate: true });

// 呼叫方要求關閉 → 播離場動畫;真正的解除安裝由呼叫方在動畫時長後做
watch(
  () => props.closing,
  value => {
    if (value) open.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // 捕獲階段:搶在 ST 的全域性快捷鍵之前拿到 Esc(否則會連帶關掉別的東西)
  event.stopPropagation();
  requestClose();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  // 翻開 open 觸發入場動畫(見 open 的宣告處);同一 tick 內改不算變化,故等一幀
  requestAnimationFrame(() => {
    open.value = true;
  });
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <ModalMask :open="open" top-layer @close="requestClose">
    <div
      class="bbi-modal bbi-modal-wide"
      role="dialog"
      aria-modal="true"
      aria-label="編輯提示詞"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">編輯提示詞</span>
        <button class="bbi-icon-mini" type="button" title="關閉" @click="requestClose">
          <Icon name="close" />
        </button>
      </header>

      <!-- AI 重寫:手改與 AI 改是同一件事的兩種手段,故聚在同一個彈窗裡。
           跑完直接落盤並出圖(見 promptEditor.ts),結果回填到下面的輸入框。 -->
      <div class="bbi-rewrite-row">
        <button
          v-if="!rewriting"
          class="bbi-btn bbi-btn-sm"
          type="button"
          :disabled="busy || !configured"
          :title="
            configured
              ? '讓 AI 重讀本樓正文，把這一張的提示詞重寫一遍'
              : '請先在虎哩繪「渠道」頁完成配置'
          "
          @click="rewrite"
        >
          <Icon name="sparkles" /> AI 重寫提示詞
        </button>
        <template v-else>
          <span class="bbi-rewrite-busy">
            <span class="bbi-rewrite-spin" />
            AI 正在重寫提示詞…
          </span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="emit('cancel-rewrite')">
            取消重寫
          </button>
        </template>
      </div>
      <p v-if="rewriting" class="bbi-editor-note">
        重寫完成後會直接儲存並按新提示詞出圖，結果填回下面的輸入框。
        現在關掉這個視窗也不會中斷，回頭再開啟還能看到進度。
      </p>
      <!-- 已落盤卻沒關窗:下面的輸入框與「使用者自己打了一半」長得一樣,不說清哪份已生效,
           使用者會以為還得再點一次「應用」(或反過來以為草稿也存了)。 -->
      <p v-else-if="rewritten" class="bbi-editor-note">
        AI 重寫完成，新提示詞已儲存並開始出圖，下面填的就是它。還想再調整就直接改，改完點「應用」。
      </p>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">畫面 tag(danbooru 短 tag,逗號分隔)</span>
        <BbiTextarea
          v-model="tag"
          class="bbi-prompt-area"
          :rows="4"
          :max-rows="14"
          mono
          placeholder="1girl, long black hair, school uniform, classroom"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">自然語言(可留空;部分後端/模型用得到)</span>
        <BbiTextarea
          v-model="nl"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          placeholder="A girl standing by the classroom window at sunset."
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">本畫面負面提示詞(可留空;與渠道級負面詞疊加)</span>
        <BbiTextarea
          v-model="negative"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          mono
          placeholder="extra people, duplicate"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">畫幅方向(具體畫素在「渠道」頁配置)</span>
        <div class="bbi-segmented" role="tablist" aria-label="畫幅方向">
          <button
            class="bbi-seg"
            :class="{ 'is-on': size === 'portrait' }"
            type="button"
            role="tab"
            :aria-selected="size === 'portrait'"
            @click="size = 'portrait'"
          >
            豎屏
          </button>
          <button
            class="bbi-seg"
            :class="{ 'is-on': size === 'landscape' }"
            type="button"
            role="tab"
            :aria-selected="size === 'landscape'"
            @click="size = 'landscape'"
          >
            橫屏
          </button>
        </div>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">
          角色提示詞(多角色;僅 NAI 後端傳送)
        </span>
        <div v-for="(character, index) in characters" :key="index" class="bbi-char-row">
          <input
            v-model="character.name"
            class="bbi-input bbi-char-name"
            type="text"
            placeholder="角色名"
          />
          <input
            v-model="character.tag"
            class="bbi-input bbi-char-tag"
            type="text"
            placeholder="tag(如 girl, black hair)"
          />
          <input
            v-model="character.nl"
            class="bbi-input bbi-char-nl"
            type="text"
            placeholder="自然語言(可空)"
          />
          <button
            class="bbi-icon-mini"
            type="button"
            title="刪除這個角色"
            @click="removeCharacter(index)"
          >
            <Icon name="trash" />
          </button>
        </div>
        <button class="bbi-btn bbi-btn-sm bbi-char-add" type="button" @click="addCharacter">
          <Icon name="plus" /> 新增角色
        </button>
        <span class="bbi-field-hint">角色名與 tag 都填了才會生效,留空的行儲存時自動丟棄。</span>
      </div>

      <!-- 改提示詞會換 promptHash 桶,而 stale 態只顯示最新一張、翻頁器不出現。
           這是既有儲存設計,但手動改提示詞會讓它從邊角情況變成日常,故明確告知。 -->
      <p v-if="historyCount > 1" class="bbi-editor-note">
        當前提示詞下已有 {{ historyCount }} 張圖。修改後只顯示最新一張(圖片沒有被刪除,
        把提示詞改回原樣即可全部找回)。
      </p>

      <p v-if="error" class="bbi-editor-error">{{ error }}</p>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" :disabled="busy" @click="requestClose">取消</button>
        <button class="bbi-btn" type="button" :disabled="!canApply" @click="apply(false)">
          應用
        </button>
        <button
          class="bbi-btn bbi-btn-primary"
          type="button"
          :disabled="!canApply || !configured"
          :title="configured ? '儲存提示詞並立即出圖' : '請先在虎哩繪「渠道」頁完成配置'"
          @click="apply(true)"
        >
          <Icon name="palette" /> 應用並重新生成
        </button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
/* —— 以下四條在 base.css 裡不是全域性的,scoped 過不了元件邊界,各處各抄一份
      (同 ConfirmDialog.vue 的做法) —— */
.bbi-modal-wide {
  max-width: 680px;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— 角色行:名字窄、tag 與自然語言各佔一半,刪除鈕跟在末尾 —— */
.bbi-char-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.bbi-char-name {
  flex: 0 0 96px;
  min-width: 0;
}
.bbi-char-tag,
.bbi-char-nl {
  flex: 1 1 0;
  min-width: 0;
}
.bbi-char-add {
  align-self: flex-start;
  margin-top: 8px;
}

/* —— AI 重寫行:釘在標題下方,與下面的欄位區拉開 —— */
.bbi-rewrite-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.bbi-rewrite-busy {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  font-size: 12.5px;
  color: var(--bbi-ink-soft);
}

.bbi-rewrite-spin {
  width: 12px;
  height: 12px;
  border: 2px solid var(--bbi-line-strong);
  border-top-color: var(--bbi-accent);
  border-radius: 50%;
  animation: bbi-rewrite-spin 0.7s linear infinite;
}

@keyframes bbi-rewrite-spin {
  to {
    transform: rotate(360deg);
  }
}

.bbi-editor-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}

.bbi-editor-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-danger);
}

/* 窄屏:角色行改豎排,否則三個輸入框擠成條 */
@media (max-width: 560px) {
  .bbi-char-row {
    flex-wrap: wrap;
  }
  .bbi-char-name {
    flex: 1 1 100%;
  }
  .bbi-char-tag,
  .bbi-char-nl {
    flex: 1 1 100%;
  }
}
</style>
