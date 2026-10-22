<script setup lang="ts">
/**
 * 通用確認彈窗。替代瀏覽器原生 confirm()——原生彈窗在 Shadow DOM 外、樣式不統一。
 * 受控:用 v-model:open 控制顯隱;點確定 emit confirm,點取消/遮罩/關閉 emit cancel。
 *
 * Teleport 到 modalHost(.bbi-root 直接子級,在 .bbi-body 滾動容器之外):
 * 避開 iOS「可滾動祖先內 fixed 後代定位錯亂」。宿主仍在 shadow root 內,
 * scoped 樣式與 --bbi-* 變數照常生效——故 to 的是 shadow 內元素,而非 Teleport to="body"。
 */
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 確定按鈕文案 */
    confirmText?: string;
    /** 取消按鈕文案 */
    cancelText?: string;
    /** 確定按鈕風格:primary=主色,danger=危險(低調描邊,hover 顯紅) */
    tone?: 'primary' | 'danger';
    /** 確定按鈕前的圖示名(可選,如 trash) */
    confirmIcon?: string;
    /** 忙碌中:停用確定按鈕並顯示 busyText(供「更新中…」這類需保持彈窗的非同步操作) */
    busy?: boolean;
    /** 忙碌時確定按鈕文案 */
    busyText?: string;
    /** 疊加在其它彈窗之上(更高 z-index),如渠道彈窗裡再開刪除確認 */
    topLayer?: boolean;
  }>(),
  {
    confirmText: '確定',
    cancelText: '取消',
    tone: 'primary',
    confirmIcon: '',
    busy: false,
    busyText: '',
    topLayer: false,
  },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

function cancel() {
  emit('update:open', false);
  emit('cancel');
}
function confirm() {
  emit('confirm');
}
</script>

<template>
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbi-modal">
      <div
        v-if="open"
        class="bbi-modal-mask"
        :class="{ 'bbi-modal-mask-top': topLayer }"
        @mousedown.self="cancel"
      >
        <div class="bbi-modal bbi-modal-confirm" role="dialog" aria-modal="true" :aria-label="title">
          <header class="bbi-modal-head">
            <span class="bbi-modal-title">{{ title }}</span>
          </header>
          <p class="bbi-confirm-text">
            <slot />
          </p>
          <footer class="bbi-modal-foot">
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="cancel">{{ cancelText }}</button>
            <button
              class="bbi-btn"
              :class="tone === 'danger' ? 'bbi-btn-danger' : 'bbi-btn-primary'"
              type="button"
              :disabled="busy"
              @click="confirm"
            >
              <Icon v-if="confirmIcon" :name="confirmIcon" />
              {{ busy && busyText ? busyText : confirmText }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 確認彈窗特有樣式(基礎 .bbi-modal* 在 base.css 全域性)。 */
.bbi-modal-mask-top {
  z-index: 10002;
}
.bbi-modal-confirm {
  max-width: 380px;
}
.bbi-confirm-text {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危險操作按鈕:描邊低調,hover 才顯紅,避免誤觸 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
</style>
