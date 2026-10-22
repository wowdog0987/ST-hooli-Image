<script setup lang="ts">
import { BACKENDS, settings, type BackendId } from '@/state/settings';
import { computed, ref, watch, type Component } from 'vue';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import NaiPanel from './panels/NaiPanel.vue';
import WebUIPanel from './panels/WebUIPanel.vue';

// 渠道頁:頁籤只負責「看哪個面板」(純瀏覽,本地狀態,初始跟隨當前出圖渠道)。
// 真正的選擇在各面板的「使用此渠道出圖」按鈕(選中後顯示「當前出圖渠道」)
// 與設定頁「出圖後端」下拉,兩處都讀寫 settings.defaultBackend,任一處改動自動跟隨。
// webui 暫不開放:入口藏掉(程式碼保留,便於後續恢復);merge 已把存量 webui 值遷移走,這裡恆有匹配頁籤。
const VISIBLE_BACKENDS = BACKENDS.filter(b => b.value !== 'webui');

// 上次停在哪個渠道頁籤:與 activePage 同理——純本機瀏覽態,存 localStorage,
// 不進 settings.json(翻頁籤即回寫伺服器太頻繁,且跨裝置同步無意義)。
const TAB_STORAGE_KEY = 'bbi.backend.tab.v1';

function loadViewing(): BackendId | null {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return VISIBLE_BACKENDS.some(b => b.value === v) ? (v as BackendId) : null;
  } catch {
    return null;
  }
}

// 優先順序:上次看的頁籤 > 當前出圖渠道 > 第一個可見頁籤。
const viewing = ref<BackendId>(
  loadViewing() ??
    (VISIBLE_BACKENDS.some(b => b.value === settings.defaultBackend)
      ? settings.defaultBackend
      : VISIBLE_BACKENDS[0].value),
);

watch(viewing, v => {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, v);
  } catch {
    /* localStorage 不可用時靜默 */
  }
});

const PANELS: Record<BackendId, Component> = {
  webui: WebUIPanel,
  comfyui: ComfyUIPanel,
  nai: NaiPanel,
};
const activePanel = computed(() => PANELS[viewing.value]);
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">渠道</h2>
      <div class="bbi-segmented" role="tablist" aria-label="生圖渠道">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': viewing === b.value }"
          type="button"
          role="tab"
          :aria-selected="viewing === b.value"
          @click="viewing = b.value"
        >
          {{ b.label }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive:切換渠道時保留各面板的摺疊/輸入狀態 -->
    <KeepAlive>
      <component :is="activePanel" :key="viewing" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* 窄屏下標題與渠道分段控制元件分兩行,不擠壓 */
.bbi-page-head {
  flex-wrap: wrap;
}
</style>
