<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 標題文本。用 #header 插槽時可留空。 */
    title?: string;
    /** 初始是否展開 */
    open?: boolean;
  }>(),
  { title: '', open: true },
);

const expanded = ref(props.open);

// 用 grid-template-rows 0fr<->1fr 做高度過渡,無需測量 scrollHeight,內容自適應。
</script>

<template>
  <section class="bbi-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbi-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <!-- 預設只放標題文本;需要在標題行放徽章/元資訊時用 #header 插槽覆蓋
           (插槽內不要放按鈕等可互動元素——整個頭本身就是一個 button)。 -->
      <slot name="header">
        <span class="bbi-collapsible-title">{{ title }}</span>
      </slot>
      <Icon name="chevron" class="bbi-collapsible-chevron" />
    </button>
    <div class="bbi-collapsible-outer">
      <div class="bbi-collapsible-inner">
        <div class="bbi-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbi-collapsible {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
}

.bbi-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  cursor: pointer;
  font-family: var(--bbi-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible-head:hover {
  background: var(--bbi-surface-2);
}
.bbi-collapsible-head:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}

.bbi-collapsible-chevron {
  font-size: 18px;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
/* 用直接子代 > 限定:巢狀 Collapsible 時,外層 .is-open 不得波及內層的 outer/chevron,
   否則內層會被外層釘死在展開態、永遠收不起來。 */
.bbi-collapsible.is-open > .bbi-collapsible-head .bbi-collapsible-chevron {
  transform: rotate(180deg);
}

/* 高度過渡:grid 0fr -> 1fr */
.bbi-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible.is-open > .bbi-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbi-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbi-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--bbi-line);
}

/* 移動端:摺疊區標題略小一號,與窄屏整體節奏更協調 */
@media (max-width: 640px) {
  .bbi-collapsible-head {
    font-size: 13px;
  }
}
</style>
