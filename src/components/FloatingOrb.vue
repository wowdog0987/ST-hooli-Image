<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { openPanel, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

/**
 * 懸浮球 —— 虎哩繪伸進宿主頁面的「書籤墜」。
 *
 * 形態:豎向緞帶 + 底部燕尾缺口(clip-path),呼應品牌的 bookmark 圖示;自定義圖片也被
 * 切成同一書籤輪廓,任意圖都收進統一形狀(這是與「又一個圓 fab」拉開差距的簽名手法)。
 *
 * 行為(按使用者要求):自由拖動 —— 拖到螢幕中間就停在中間;拖到接近左/右邊緣才吸附貼邊。
 * 貼邊時半隱於邊緣(只露一窄條),hover/聚焦/觸控才整條滑出;停在中間則常顯。
 *
 * 位置存本機 localStorage(純視覺態、各裝置螢幕尺寸不同,同步反而會跑到螢幕外)。
 * 開關與自定義圖示(ui.orbImage,伺服器路徑)跨裝置同步,由設定承載。
 */

// 尺寸隨形狀 + 使用者基準尺寸(ui.orbSize):書籤按 0.78 寬高比(豎長方),圓/方等邊正方。
// 拖動/吸附計算與內聯尺寸都讀它。
const orbW = computed(() => (ui.orbShape === 'bookmark' ? Math.round(ui.orbSize * 0.78) : ui.orbSize));
const orbH = computed(() => ui.orbSize);
const SNAP_ZONE = 56; // 鬆手時距左/右邊緣 ≤ 此值即吸附貼邊
const CLICK_SLOP = 6; // 位移 < 此值視為點選而非拖動
const POS_KEY = 'bbi.orb.pos.v1';

type Dock = 'left' | 'right' | 'none';
interface OrbPos {
  dock: Dock;
  /** 貼邊時無意義;free 時為左上角 x(px) */
  x: number;
  /** 左上角 y(px),三種狀態都用 */
  y: number;
}

function loadPos(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* ignore */
  }
  // 預設:右側貼邊、縱向居中偏下
  return { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.6) };
}

const pos = reactive<OrbPos>(loadPos());
const dragging = ref(false);
const awake = ref(false); // hover/聚焦/拖動 → 貼邊態整條滑出
let activePointer: number | null = null;
let startX = 0;
let startY = 0;
let moved = 0; // 累計位移,用於點選/拖動判定

// 進入視口後把座標夾進可視範圍(換了更小的螢幕/旋轉後不至於跑出去)
function clampToViewport(): void {
  const maxY = Math.max(0, window.innerHeight - orbH.value);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - orbW.value);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// —— 定位樣式:貼邊用 left/right 錨定 + translateX 控制隱/現;free 用絕對 x/y ——
const orbStyle = computed(() => {
  const base: Record<string, string> = {
    top: `${pos.y}px`,
    width: `${orbW.value}px`,
    height: `${orbH.value}px`,
    // 靜止不透明度走 CSS 變數,喚起/拖動態由類覆蓋回全顯
    '--orb-rest-opacity': String(Math.min(100, Math.max(20, ui.orbOpacity)) / 100),
    // 圖示字號隨基準尺寸縮放(原 48 球 ≈ 22px),保持圖示與球體比例協調
    '--orb-icon-size': `${Math.round(ui.orbSize * 0.46)}px`,
  };
  if (pos.dock === 'left') {
    base.left = '0px';
    // 靜止半隱(露 ~40%);拖動/喚起時整條滑出
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(-58%)';
  } else if (pos.dock === 'right') {
    base.right = '0px';
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(58%)';
  } else {
    base.left = `${pos.x}px`;
    base.transform = 'translateX(0)';
  }
  return base;
});

const orbImage = computed(() => ui.orbImage.trim());

// —— 拖動 ——
function onDown(e: PointerEvent) {
  activePointer = e.pointerId;
  dragging.value = true;
  moved = 0;
  startX = e.clientX;
  startY = e.clientY;
  // 記錄手指相對左上角的抓取點,拖動時保持
  grabDX = e.clientX - currentLeft();
  grabDY = e.clientY - pos.y;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

let grabDX = 0;
let grabDY = 0;

/** 當前左上角的實際 x(貼邊態由 right/translate 折算成絕對畫素,供拖動起步用) */
function currentLeft(): number {
  if (pos.dock === 'right') return window.innerWidth - orbW.value;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function onMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY));
  // 拖動中一律切 free 跟手(整條可見)
  pos.dock = 'none';
  pos.x = e.clientX - grabDX;
  pos.y = e.clientY - grabDY;
  clampToViewport();
}

function onUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;

  if (moved < CLICK_SLOP) {
    // 視為點選 → 開啟虎哩繪(貼邊態保持)
    openPanel();
    return;
  }

  // 鬆手吸附判定:靠近左/右邊緣才貼邊,否則停在原地(中間)
  const left = pos.x;
  const right = window.innerWidth - (pos.x + orbW.value);
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  savePos();
}

// —— 鍵盤可達 ——
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPanel();
  }
}

const onResize = () => {
  clampToViewport();
  savePos();
};
onMounted(() => {
  clampToViewport();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div
    class="bbi-orb"
    :class="[`shape-${ui.orbShape}`, { 'is-dragging': dragging, 'has-image': !!orbImage }]"
    :style="orbStyle"
    role="button"
    tabindex="0"
    aria-label="開啟虎哩繪"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerenter="awake = true"
    @pointerleave="awake = false"
    @focus="awake = true"
    @blur="awake = false"
    @keydown="onKey"
  >
    <img v-if="orbImage" :src="orbImage" class="bbi-orb-img" alt="" draggable="false" />
    <Icon v-else name="palette" class="bbi-orb-icon" />
  </div>
</template>

<style scoped>
.bbi-orb {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbi-surface);
  color: var(--bbi-accent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* drop-shadow 對 clip-path(書籤)與 border-radius(圓/方)都跟隨輪廓,統一用它 */
  filter: drop-shadow(0 6px 14px oklch(0 0 0 / 0.28));
  opacity: var(--orb-rest-opacity, 0.62);
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    opacity var(--bbi-dur) var(--bbi-ease);
}

/* —— 形狀 —— */
/* 書籤:緞帶輪廓 + 底部燕尾缺口。clip-path 天然裁切自定義圖。 */
.bbi-orb.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
}
/* 圓 / 方:border-radius + overflow 裁切自定義圖 */
.bbi-orb.shape-circle {
  border-radius: 999px;
  overflow: hidden;
}
.bbi-orb.shape-square {
  border-radius: 12px;
  overflow: hidden;
}

/* 喚起(hover/聚焦/拖動)或停在中間(free) → 全顯 */
.bbi-orb:hover,
.bbi-orb:focus-visible,
.bbi-orb.is-dragging {
  opacity: 1;
}
.bbi-orb:focus-visible {
  outline: none;
  color: var(--bbi-accent);
}
.bbi-orb:active {
  cursor: grabbing;
}

.bbi-orb-icon {
  font-size: var(--orb-icon-size, 22px);
  pointer-events: none;
}
/* 書籤:圖示上移,避開底部燕尾缺口(圓/方無缺口,居中即可) */
.bbi-orb.shape-bookmark .bbi-orb-icon {
  margin-bottom: 6px;
}

.bbi-orb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bbi-orb {
    transition: none;
  }
}
</style>
