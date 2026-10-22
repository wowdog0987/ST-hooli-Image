<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';

/**
 * 自適應高度 textarea(預設一行,內容超出按內容長高,封頂後內部滾動)。
 *
 * 為什麼做成元件:此前各頁散裝「textarea + v-autosize 指令 + 自配 max-height class」,
 * 口徑不一還各有缺口。元件統一收口:
 * - 行數口徑:props.rows 起始行、maxRows 封頂行,以 lineHeight 換算畫素,
 *   不再讓呼叫方自己寫 max-height。
 * - v-model 按 Vue 原生 textarea 口徑用 compositionstart/end 擋 IME 拼音串,
 *   這是指令版(v-autosize)沒有的。
 * - ResizeObserver 監聽自身寬度變化(視窗縮放/抽屜拖動)後重量,
 *   Book 那邊窄視窗下手動拖寬後高度不回落就是漏了這個。
 * - focus()/insertAtCursor() 暴露給呼叫方(提示詞彈窗的宏插入依賴游標操作)。
 *
 * 高度測量與指令版同思路:height 先歸零再讀 scrollHeight(歸零是必須的,
 * 否則內容減少時 scrollHeight 不回落),寫回時再夾在 [min,max] 之間。
 * 掛載/更新都等一幀再量,避免編輯回填時讀到塌陷中的佈局。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 起始行數(空內容時的高度) */
    rows?: number;
    /** 封頂行數;超出後出現捲軸。預設 12 */
    maxRows?: number;
    /** 等寬字型(工作流 JSON / tag 串用) */
    mono?: boolean;
    /** 佔位符 */
    placeholder?: string;
    /** 關閉拼寫檢查(tag/JSON 場景預設關;純中文描述可開) */
    spellcheck?: boolean;
  }>(),
  { rows: 1, maxRows: 12, mono: false, placeholder: '', spellcheck: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

// 透傳 class/style(合併到根 textarea,保持 .bbi-input 等既有工具類可用)
const attrs = useAttrs();

const el = ref<HTMLTextAreaElement | null>(null);
/** 單行畫素高:mounted 後測一次;行數→畫素換算的基準 */
let lineHeightPx = 21;

const composing = ref(false);
function onInput(event: Event) {
  if (composing.value) return;
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
function onCompositionStart() {
  composing.value = true;
}
function onCompositionEnd(event: CompositionEvent) {
  composing.value = false;
  // 相容部分瀏覽器不觸發 input 的口徑:結束時統一以最終值回寫一次
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

function measure(): void {
  const node = el.value;
  if (!node) return;
  node.style.height = 'auto';
  // scrollHeight 只含內容+上下 padding,box-sizing:border-box 時須補邊框才是總佔用高度
  const content = node.scrollHeight;
  const style = window.getComputedStyle(node);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const min = lineHeightPx * props.rows;
  const max = lineHeightPx * props.maxRows;
  node.style.height = `${Math.max(min, Math.min(max, content + border))}px`;
  node.style.overflowY = content + border > max ? 'auto' : 'hidden';
}

let ro: ResizeObserver | null = null;

function setup() {
  const node = el.value;
  if (!node) return;
  const style = window.getComputedStyle(node);
  lineHeightPx = parseFloat(style.lineHeight) || 21;
  ro?.disconnect();
  ro = new ResizeObserver(() => measure());
  // 觀察自身:寬度變化(拖動/縮放)時高度要跟著重排
  ro.observe(node);
  requestAnimationFrame(() => measure());
}

defineExpose({
  /** 聚焦 */
  focus() {
    el.value?.focus();
  },
  /**
   * 在游標處插入文本並選中;無焦點時追加到末尾。
   * 用於宏按鈕:返回插入後的游標位置,呼叫方如需移動游標再自行處理。
   */
  insertAtCursor(text: string): void {
    const node = el.value;
    if (!node) {
      emit('update:modelValue', props.modelValue + text);
      return;
    }
    const start = node.selectionStart ?? props.modelValue.length;
    const end = node.selectionEnd ?? start;
    const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end);
    emit('update:modelValue', next);
    void nextTick(() => {
      node.focus();
      const pos = start + text.length;
      node.setSelectionRange(pos, pos);
    });
  },
});

onMounted(setup);
// rows/maxRows 變化時上下限變了,重新夾一次高度(模板編輯等場景會動態改)
watch(() => [props.rows, props.maxRows], () => requestAnimationFrame(() => measure()));
// 程式化改值(彈窗回填草稿/恢復預設)不觸發 input 事件,這裡補量(輸入路徑重複量一次無害)
watch(
  () => props.modelValue,
  () => requestAnimationFrame(() => measure()),
);

onBeforeUnmount(() => ro?.disconnect());

defineOptions({ inheritAttrs: false });
</script>

<template>
  <textarea
    ref="el"
    class="bbi-textarea"
    :class="{ 'is-mono': mono }"
    v-bind="attrs"
    :value="modelValue"
    :placeholder="placeholder"
    :spellcheck="spellcheck"
    :rows="rows"
    @input="onInput"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  ></textarea>
</template>

<style scoped>
.bbi-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  display: block;
  resize: none;
  overflow-y: hidden;
}
.bbi-textarea.is-mono {
  font-family: var(--bbi-font-mono);
  font-variant-ligatures: none;
}
.bbi-textarea:focus {
  outline: none;
  border-color: var(--bbi-accent);
}
.bbi-textarea::placeholder {
  color: var(--bbi-ink-muted);
}
.bbi-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
