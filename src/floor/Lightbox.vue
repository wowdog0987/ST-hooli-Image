<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from '@/components/Icon.vue';
import { saveImageFile } from '@/floor/download';
import { copyText } from '@/st/clipboard';
import { modalHost } from '@/state/ui';

/**
 * 圖片燈箱(樓層卡片點選放大)。
 *
 * 為什麼自建而不用 ST 原生:ST 的燈箱入口 `.mes_img` 只是個 class,真正的
 * expandMessageMedia 讀的是 `chat[mesid].extra.media[data-index]` 資料模型,且該函式
 * 模組私有、未匯出到 context——光加 class 會直接 bail。走官方 extra.media 那條路能白嫖
 * 燈箱,但圖片會被掛到 `.mes_media_wrapper`(.mes_text 的兄弟節點),脫離 tag 的行內位置,
 * 與「圖出現在 tag 所在段落」的核心設計衝突,還得再維護一份與 extra.bbiImage 平行的儲存。
 *
 * 【長按儲存】移動端能長按儲存圖片,靠三條約束共同保證,改動時務必保留:
 * 1. 只監聽 click,絕不在圖片上 preventDefault touchstart/touchend——長按喚出系統選單時
 *    瀏覽器不會補發 click,兩者天然不衝突;一旦自己攔 touch,長按儲存立刻失效。
 * 2. 圖片不加 user-select:none / -webkit-touch-callout:none / draggable=false。
 * 3. 顯式 touch-action:auto 抵消 ST 的 `body{touch-action:none}`
 *    (css/mobile-styles.css:251,移動端 ≤1000px 全域性)——它會干擾部分引擎的長按判定。
 * 【左右切換】有上一張/下一張時:桌面用 ← → 鍵或兩側箭頭;移動端未放大時左右滑。
 * 滑動只掛 passive 的 touchstart/touchend(只讀座標、絕不 preventDefault),長按不位移,
 * 不會被誤判成滑動,也不影響上面的長按儲存;放大後不判定滑動,左右滑仍是原生平移。
 * 【二段放大與平移】點選圖片在「適應螢幕 ↔ 原始尺寸」間切換(放大 = 1:1 檢查
 * 臉/手等細節,決定留還是重繪)。放大後的平移分兩條路:
 * - 桌面:滑鼠拖拽(pointer 事件只認 pointerType==='mouse',5px 閾值區分點選與拖動);
 * - 移動:stage 的原生溢位滾動,**不監聽任何 touch 事件**(見上面三條約束)。
 * stage 居中用圖片 margin:auto 而非 justify-content:center——後者會把放大後
 * 左/上兩側的溢位擠出滾動可達區(移動端「只能上下滾」的元兇)。
 */

const props = defineProps<{
  src: string;
  /** 提示詞原文(複製用);空則不顯示複製按鈕。 */
  prompt?: string;
  /** 下載檔名。 */
  filename?: string;
  /** 有值才顯示刪除按鈕。 */
  deletable?: boolean;
  /** 有上一張 / 下一張時才顯示箭頭、才響應方向鍵與滑動。 */
  hasPrev?: boolean;
  hasNext?: boolean;
}>();

const emit = defineEmits<{ close: []; delete: []; prev: []; next: [] }>();

/** 適應螢幕 ↔ 原始尺寸。 */
const zoomed = ref(false);

/** 滾動容器(放大後平移用)。 */
const stage = ref<HTMLElement | null>(null);

/** 拖動平移後的那次 click 要吞掉,否則一拖完圖片就縮回去了。 */
let suppressClick = false;

/** 點選切換縮放;放大時把點選點滾到視口中央(點哪看哪)。 */
async function onImageClick(event: MouseEvent): Promise<void> {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (zoomed.value) {
    zoomed.value = false;
    return;
  }
  const img = event.currentTarget as HTMLImageElement;
  const rect = img.getBoundingClientRect();
  const ratioX = (event.clientX - rect.left) / rect.width;
  const ratioY = (event.clientY - rect.top) / rect.height;
  zoomed.value = true;
  await nextTick();
  const el = stage.value;
  if (el) {
    el.scrollLeft = img.offsetWidth * ratioX - el.clientWidth / 2;
    el.scrollTop = img.offsetHeight * ratioY - el.clientHeight / 2;
  }
}

/**
 * 滑鼠拖拽平移(僅放大態、僅滑鼠)。
 * 觸屏不碰:觸控平移交給 stage 的原生溢位滾動(img 上的 touch-action:auto 就是
 * 為它和長按儲存留的),自己攔觸控會違反頂部的長按儲存三約束。
 */
let pan: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (!zoomed.value || event.pointerType !== 'mouse' || event.button !== 0) return;
  const el = stage.value;
  if (!el) return;
  pan = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const el = stage.value;
  if (!pan || !el) return;
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 5) return; // 閾值內算點選,保留點選縮放
  pan.moved = true;
  el.scrollLeft = pan.left - dx;
  el.scrollTop = pan.top - dy;
}

function onPointerUp(): void {
  if (pan?.moved) suppressClick = true;
  pan = null;
}

/** 放大態平移時攔掉圖片原生拖拽殘影;非放大態保持原生行為,一概不動。 */
function onDragStart(event: DragEvent): void {
  if (zoomed.value) event.preventDefault();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  } else if (event.key === 'ArrowLeft' && props.hasPrev) {
    event.stopPropagation();
    emit('prev');
  } else if (event.key === 'ArrowRight' && props.hasNext) {
    event.stopPropagation();
    emit('next');
  }
}

/** 左右滑切換(僅未放大、單指;passive 監聽,只讀座標)。 */
let swipe: { x: number; y: number; at: number } | null = null;

function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0];
  swipe = !zoomed.value && event.touches.length === 1 && touch
    ? { x: touch.clientX, y: touch.clientY, at: Date.now() }
    : null;
}

function onTouchEnd(event: TouchEvent): void {
  const start = swipe;
  swipe = null;
  const touch = event.changedTouches[0];
  if (!start || !touch || zoomed.value) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  // 夠遠、夠快、以水平為主才算滑動;其餘(點選、長按、上下捲提示詞)一概不管
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - start.at > 800) return;
  if (dx > 0 && props.hasPrev) emit('prev');
  else if (dx < 0 && props.hasNext) emit('next');
}

onMounted(() => {
  // 捕獲階段:搶在 ST 的全域性快捷鍵之前拿到 Esc
  document.addEventListener('keydown', onKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});

async function copyPrompt(): Promise<void> {
  await copyText(props.prompt ?? '', '提示詞已複製');
}

function save(): void {
  saveImageFile(props.src, props.filename);
}

const promptText = computed(() => (props.prompt ?? '').trim());
</script>

<template>
  <!-- Teleport 到 modalHost(.bbi-root 直接子級):燈箱需要 --bbi-* 主題變數,
       而 lightbox.ts 的容器掛在 shadow root 頂層、在 .bbi-root 之外拿不到變數。
       與 ConfirmDialog 同款手法。 -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <!-- 遮罩自身承接關閉點選;圖片與操作欄 stop 掉,避免誤關 -->
    <div class="bbi-lightbox" @click="emit('close')">
      <div class="bbi-lightbox__bar" @click.stop>
        <button class="bbi-lb-btn" type="button" title="儲存圖片" @click="save">
          <Icon name="download" :size="18" />
        </button>
        <button
          v-if="promptText"
          class="bbi-lb-btn"
          type="button"
          title="複製提示詞"
          @click="copyPrompt"
        >
          <Icon name="copy" :size="18" />
        </button>
        <button
          v-if="deletable"
          class="bbi-lb-btn bbi-lb-btn--danger"
          type="button"
          title="刪除這張圖"
          @click="emit('delete')"
        >
          <Icon name="trash" :size="18" />
        </button>
        <button class="bbi-lb-btn" type="button" title="關閉 (Esc)" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </div>

      <!-- 圖片容器:zoomed 時滾動(觸屏)/ 滑鼠拖拽檢視原圖 -->
      <div
        ref="stage"
        class="bbi-lightbox__stage"
        :data-zoomed="zoomed ? '1' : ''"
        @click.stop="emit('close')"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <img
          class="bbi-lightbox__img"
          :src="src"
          alt="生圖結果"
          :data-zoomed="zoomed ? '1' : ''"
          @click.stop="onImageClick"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dragstart="onDragStart"
        />
      </div>

      <button
        v-if="hasPrev"
        class="bbi-lb-btn bbi-lb-nav bbi-lb-nav--prev"
        type="button"
        title="上一張 (←)"
        aria-label="上一張"
        @click.stop="emit('prev')"
      >
        <Icon name="chevron" :size="20" />
      </button>
      <button
        v-if="hasNext"
        class="bbi-lb-btn bbi-lb-nav bbi-lb-nav--next"
        type="button"
        title="下一張 (→)"
        aria-label="下一張"
        @click.stop="emit('next')"
      >
        <Icon name="chevron" :size="20" />
      </button>

      <p v-if="promptText" class="bbi-lightbox__prompt" @click.stop>{{ promptText }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.bbi-lightbox {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  /* 與 base.css 的遮罩同款:部分移動端 WebView 不認 inset/百分比鏈,顯式給視口高 */
  height: 100vh;
  height: 100dvh;
  z-index: 10050;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: oklch(0 0 0 / 0.82);
  backdrop-filter: blur(6px);
}

.bbi-lightbox__bar {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.bbi-lb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid oklch(1 0 0 / 0.18);
  border-radius: var(--bbi-radius-pill);
  background: oklch(1 0 0 / 0.1);
  color: oklch(1 0 0 / 0.92);
  cursor: pointer;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}

.bbi-lb-btn:hover {
  background: oklch(1 0 0 / 0.2);
  border-color: oklch(1 0 0 / 0.4);
}

/* 左右切換箭頭:垂直置中貼兩側;chevron 原本朝下,轉 90° 成左右 */
.bbi-lb-nav {
  position: absolute;
  top: 50%;
  width: 44px;
  height: 44px;
  margin-top: -22px;
  background: oklch(0 0 0 / 0.45);
}

.bbi-lb-nav--prev {
  left: 12px;
}

.bbi-lb-nav--next {
  right: 12px;
}

.bbi-lb-nav--prev :deep(svg) {
  transform: rotate(90deg);
}

.bbi-lb-nav--next :deep(svg) {
  transform: rotate(-90deg);
}

.bbi-lb-btn--danger:hover {
  background: var(--bbi-danger);
  border-color: var(--bbi-danger);
  color: #fff;
}

/* 居中不用 justify-content/align-items:center:放大後圖片比容器寬時,flex 居中
   會把左/上兩側的溢位擠出滾動可達區(移動端「只能上下滾」的元兇)。
   改用圖片自身 margin:auto——小時居中,大時自動邊距歸零、起點對齊,四向皆可滾。 */
.bbi-lightbox__stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: auto;
}

.bbi-lightbox__img {
  display: block;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--bbi-radius-sm);
  cursor: zoom-in;
  /* 抵消 ST 的 body{touch-action:none}(css/mobile-styles.css:251):
     它會干擾部分引擎的長按儲存判定,也會擋住放大後的觸屏原生滾動。見 <script> 頂部註釋。 */
  touch-action: auto;
}

/* 原始尺寸:超出部分由 __stage 滾動(觸屏)/ 滑鼠拖拽檢視 */
.bbi-lightbox__img[data-zoomed='1'] {
  max-width: none;
  max-height: none;
  cursor: grab;
}

.bbi-lightbox__img[data-zoomed='1']:active {
  cursor: grabbing;
}

/* 放大態找回細捲軸(base.css 在 .bbi-root 內全域性隱藏了捲軸),
   給個「現在看到哪了」的位置感 */
.bbi-lightbox__stage[data-zoomed='1'] {
  scrollbar-width: thin;
  scrollbar-color: oklch(1 0 0 / 0.3) transparent;
}

.bbi-lightbox__stage[data-zoomed='1']::-webkit-scrollbar {
  width: 6px;
  height: 6px;
  display: block;
}

.bbi-lightbox__stage[data-zoomed='1']::-webkit-scrollbar-thumb {
  background: oklch(1 0 0 / 0.25);
  border-radius: 3px;
}

.bbi-lightbox__prompt {
  flex: 0 0 auto;
  max-height: 22%;
  overflow-y: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--bbi-radius-sm);
  background: oklch(1 0 0 / 0.08);
  color: oklch(1 0 0 / 0.85);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  /* 提示詞要可選中複製,故此處不停用選擇 */
  user-select: text;
}
</style>
