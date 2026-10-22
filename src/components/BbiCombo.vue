<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * 可輸入可下拉的組合框(combobox,互動與副 API 的模型框一致):
 * 輸入框既是當前值也是過濾詞,聚焦彈出候選選單;候選為空時退化為普通輸入框。
 *
 * 為什麼選單 Teleport 到 modalHost 而不是就地絕對定位(副 API 那個是就地):
 * 本元件用在 Collapsible(overflow:hidden)裡,就地定位會被裁剪,
 * 故與 BbiSelect 同方案 —— 視口級 fixed,由輸入框 getBoundingClientRect 推算,
 * 下方空間不足時向上翻。
 *
 * 互動:聚焦/輸入展開;↑↓ 移動高亮,Enter 選中,Esc 只關選單(不觸發視窗級 Esc);
 * 點外部(輸入框失焦)/滾動/縮放關閉。選單內 mousedown 一律 preventDefault,
 * 讓點選選項/捲軸不搶輸入框焦點,選項靠 click 選中。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 候選列表;空陣列 = 普通輸入框(不彈選單、不畫三角) */
    options: string[];
    placeholder?: string;
    ariaLabel?: string;
    /** 過濾結果展示上限,避免超長列表卡頓 */
    maxShown?: number;
  }>(),
  { placeholder: '', ariaLabel: undefined, maxShown: 200 },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
/** 聚焦後用戶輸入的過濾詞;聚焦/關閉時清空(清空=顯示全部候選) */
const query = ref('');
const trigger = ref<HTMLInputElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const activeIndex = ref(0);

// 過濾:子串、大小寫不敏感;query 為空顯示全部
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out = q ? props.options.filter(o => o.toLowerCase().includes(q)) : props.options;
  return out.slice(0, props.maxShown);
});

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value || !props.options.length) return;
  const rect = el.getBoundingClientRect();
  // 估算選單高度決定朝向:下方不夠且上方更寬裕就向上翻
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 30 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
  activeIndex.value = Math.max(0, filtered.value.indexOf(props.modelValue));
  open.value = true;
  document.addEventListener('keydown', onDocKeydown, true);
  // 選單是視口級 fixed,不隨內容滾動;滾動/縮放時直接關掉,比重算位置乾淨
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu() {
  if (!open.value) return;
  open.value = false;
  query.value = '';
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
}

function closeOnViewportChange() {
  closeMenu();
}

function onFocus() {
  query.value = '';
  openMenu();
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', value);
  query.value = value;
  activeIndex.value = 0;
  openMenu();
}

function pick(option: string) {
  emit('update:modelValue', option);
  closeMenu();
  // 焦點留在輸入框(選單 mousedown 被 prevent,從未失焦),方便繼續敲下一個欄位
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.bbi-combo-item')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = filtered.value.length;
  if (event.key === 'Escape') {
    // 捕獲階段攔截,只關選單,別觸發視窗級 Esc(關整個面板)
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!count) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    if (!count) return;
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter') {
    const option = filtered.value[activeIndex.value];
    if (option) {
      event.preventDefault();
      pick(option);
    }
  }
}

/** 收起態按 ↓ 直接展開(原生 combobox 習慣) */
function onTriggerKeydown(event: KeyboardEvent) {
  if (!open.value && event.key === 'ArrowDown') {
    event.preventDefault();
    openMenu();
  }
}

/** 選單內 mousedown 全攔:點選項/拖捲軸都不搶輸入框焦點,選項走 click 選中 */
function keepFocus() {}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <div class="bbi-combo-box">
    <input
      ref="trigger"
      class="bbi-input bbi-combo-input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
      @focus="onFocus"
      @blur="closeMenu"
      @keydown="onTriggerKeydown"
    />
    <!-- 下拉三角(裝飾):僅在有候選時顯示;pointer-events:none → 點選穿透照常聚焦展開 -->
    <Icon
      v-if="options.length"
      name="chevron"
      class="bbi-combo-caret"
      :class="{ 'is-open': open }"
      :size="12"
    />
    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul
        v-if="open"
        ref="menu"
        class="bbi-combo-menu"
        role="listbox"
        :style="menuStyle"
        @mousedown.prevent="keepFocus"
      >
        <li v-if="!filtered.length" class="bbi-combo-empty">無匹配項</li>
        <li
          v-for="(option, i) in filtered"
          :key="option"
          class="bbi-combo-item"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option === modelValue }"
          role="option"
          :aria-selected="option === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          {{ option }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbi-combo-box {
  position: relative;
  width: 100%;
  min-width: 0;
}
.bbi-combo-input {
  width: 100%;
  padding-right: 26px; /* 給右側三角讓位 */
}
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 9px;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--bbi-ink-soft);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}

/* 選單 Teleport 到 modalHost(scoped 樣式在同 shadow root 內照常生效) */
.bbi-combo-menu {
  position: fixed;
  z-index: 10001; /* 視窗(10000)之上,與 BbiSelect 選單同級 */
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-combo-item.is-active {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-selected {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
</style>
