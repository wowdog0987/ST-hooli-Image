<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import NavBar from '@/components/NavBar.vue';
import FloatingOrb from '@/components/FloatingOrb.vue';
import { getPage } from '@/pages/registry';
import { closePanel, cycleTheme, lastOpenedAt, modalHost, THEMES, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 題首主題按鈕:圖示是「目前」主題,提示文字說明點選後切到哪一套
const currentTheme = computed(() => THEMES.find(t => t.value === ui.theme) ?? THEMES[0]);
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// 是否窄屏(移動端):用於 nav 'auto' 的方向判定 + 抽屜手勢開關。
// matchMedia 變化 Vue 不會自動追蹤,用 ref 橋接成響應式。
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));

// —— 遮罩點選關閉:僅當按下與鬆開都在遮罩本身。
// 避免:1) 移動端開啟手勢的合成 click 穿透秒關;2) 窗內按下拖到窗外誤關。
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closePanel();
  pressedOnOverlay = false;
}

// —— 移動端:下滑關閉抽屜 ——
const dragY = ref(0); // 當前下拉位移(px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // 超過此位移鬆手即關閉

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // 只跟隨向下的位移
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closePanel();
  }
  dragY.value = 0;
}

// 抽屜跟手樣式:拖動時停用過渡,鬆手時回彈有過渡
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbi-root" :data-theme="ui.theme">
    <!-- 彈窗 Teleport 宿主:.bbi-root 直接子級,在 .bbi-body 滾動容器之外。
         各頁彈窗 Teleport 到此,避開 iOS「可滾動祖先內 fixed 後代定位錯亂」(詳見 state/ui.ts)。 -->
    <div ref="modalHost"></div>
    <!-- 懸浮球:留在 shadow 內才能用 --bbi-* 主題變數;自身 position:fixed 貼邊,不受 host 影響 -->
    <FloatingOrb v-if="ui.showOrb" />
    <Transition name="bbi-fade">
      <div
        v-if="ui.open"
        class="bbi-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        @keydown.esc="closePanel"
        tabindex="-1"
      >
        <!-- 視窗常駐於遮罩內(不獨立 v-if、不巢狀 Transition):
             巢狀 Transition 在父子 v-if 同時翻轉時,子的 leave 不會觸發(實測視窗直接隨父被移除,
             無任何動畫)。改由遮罩 Transition 的 class 作後代選擇器驅動視窗的進出場動畫
             (見 <style> 裡 .bbi-fade-enter-from/.bbi-fade-leave-to 下的 .bbi-window)。 -->
        <div class="bbi-window" :style="windowStyle" role="dialog" aria-modal="true" aria-label="虎哩繪">
            <!-- 移動端抓手:可下滑關閉 -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbi-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbi-grabber-bar"></span>
            </div>

            <!-- 題首 -->
            <header class="bbi-head">
              <span class="bbi-brand-name">虎哩繪</span>
              <div class="bbi-head-actions">
                <button
                  class="bbi-icon-btn"
                  type="button"
                  :title="`主題:${currentTheme.label}(點選切換到${nextTheme.label})`"
                  @click="cycleTheme"
                >
                  <Icon :name="currentTheme.icon" />
                </button>
                <button class="bbi-icon-btn" type="button" title="關閉" @click="closePanel">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" :narrow="narrowFlag" />

            <main class="bbi-body">
              <Transition name="bbi-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" :narrow="narrowFlag" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— 移動端抓手:桌面隱藏 —— */
.bbi-grabber {
  display: none;
}

.bbi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  flex: 0 0 auto;
}

.bbi-brand-name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--bbi-ink);
}

.bbi-head-actions {
  display: flex;
  gap: 8px;
}
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
.bbi-icon-btn:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}

/* —— 過渡:遮罩淡入淡出,視窗靠遮罩的過渡 class 聯動(見下) —— */
.bbi-fade-enter-active,
.bbi-fade-leave-active {
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-fade-enter-from,
.bbi-fade-leave-to {
  opacity: 0;
}

/* 視窗進出場:由遮罩 Transition 的 class 作後代選擇器驅動(視窗自身不再套 Transition——
   父子 v-if 同時翻轉時子 Transition 的 leave 不觸發,實測視窗會無動畫直接被移除)。
   進出場兩端同款 transform → 對稱。PC 微升+略放大;移動端在 media query 裡改成滑回底部。 */
.bbi-fade-enter-from .bbi-window,
.bbi-fade-leave-to .bbi-window {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbi-page-enter-active,
.bbi-page-leave-active {
  transition:
    opacity 0.13s var(--bbi-ease),
    transform 0.13s var(--bbi-ease);
}
.bbi-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbi-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 視窗過渡:進出場(transform+opacity)與拖動回彈(transform)共用;
   拖動跟手時由內聯 style 的 transition:none 覆蓋,鬆手回彈再走這條。 */
.bbi-window {
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    opacity var(--bbi-dur) var(--bbi-ease);
}

/* ============ 移動端:抓手 + 抽屜上滑入場 ============ */
@media (max-width: 640px) {
  .bbi-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbi-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbi-radius-pill);
    background: var(--bbi-line-strong);
  }
  .bbi-head {
    padding: 4px 16px 12px;
  }
  /* 抽屜從底部滑入 / 滑回底部(純位移,不淡透明) */
  .bbi-fade-enter-from .bbi-window,
  .bbi-fade-leave-to .bbi-window {
    opacity: 1;
    transform: translateY(100%) scale(1);
  }
  /* 遮罩離場延後淡出:讓抽屜先滑回底部,背景殿後再撤,否則視窗隨遮罩一起被拉透明,
     滑動過程看不見(視窗是遮罩子元素,父 opacity 會合成到子)。 */
  .bbi-fade-leave-active {
    transition: opacity 0.16s var(--bbi-ease) 0.18s;
  }
  /* 視窗滑回底部要走完整 --bbi-dur,不被上面遮罩的短時長牽連(各自 transition 獨立,這裡僅強調) */
}
</style>
