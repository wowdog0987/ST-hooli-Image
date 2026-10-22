<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closePanel, ui } from '@/state/ui';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

// 移動端:再點一下當前頁的導航按鈕即關閉整窗(省得去夠右上角的 ×);非當前頁正常切頁。
// 受 ui.navTapClose 開關控制(預設開,怕誤觸的使用者可在設定裡關)。
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closePanel();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav class="bbi-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbi-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbi-nav-icon-wrap">
        <Icon :name="p.id" class="bbi-nav-icon" />
      </span>
      <!-- 頂部帶文字;但窄屏(移動端)頂部也只放圖示,否則一排帶字膠囊橫向放不下,會把後面的項擠出螢幕 -->
      <span v-if="placement === 'top' && !narrow" class="bbi-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbi-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— 頂部:膠囊分段,橫排圖示+字 —— */
.bbi-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbi-line);
}
.bbi-nav.is-top .bbi-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: transparent;
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-top .bbi-nav-item:hover {
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
}
.bbi-nav.is-top .bbi-nav-item.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.bbi-nav.is-top .bbi-nav-icon {
  font-size: 17px;
}

/* —— 頂部 + 窄屏(移動端):降級為僅圖示,樣式與底部導航完全一致(尺寸/配色/選中態),
   僅位置在頂,免得帶字膠囊橫向溢位把後面的項擠出螢幕 —— */
.bbi-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.bbi-nav.is-top.is-narrow .bbi-nav-item {
  flex: 1;
  justify-content: center;
  gap: 0;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item:hover {
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item.is-active {
  background: transparent;
  color: var(--bbi-accent);
}
.bbi-nav.is-top.is-narrow .bbi-nav-icon {
  font-size: 23px;
}

/* —— 底部:僅圖示,等分,觸達區大 —— */
.bbi-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--bbi-line);
  background: var(--bbi-surface);
}
.bbi-nav.is-bottom .bbi-nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-bottom .bbi-nav-icon {
  font-size: 23px;
}
.bbi-nav.is-bottom .bbi-nav-item.is-active {
  color: var(--bbi-accent);
}

.bbi-nav-item:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
  border-radius: var(--bbi-radius-sm);
}

.bbi-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

</style>
