<script setup lang="ts">
/**
 * 彈窗遮罩外殼:統一承載各頁彈窗的 .bbi-modal-mask 層 + 遮罩點選關閉。
 *
 * Teleport 到 modalHost(.bbi-root 直接子級,在 .bbi-body 滾動容器之外):
 * 修復 iOS Safari 的老問題——「可滾動祖先內的 position:fixed 後代」會相對滾動內容、
 * 而非視口定位,導致設定頁滾動後彈窗整體偏上、頂出螢幕(渠道彈窗最先暴露)。
 * 宿主仍在 shadow root 內,scoped 樣式與 --bbi-* 主題變數照常生效,
 * 故 to 的是 shadow 內元素,而非會逃出 shadow 的 Teleport to="body"。
 *
 * 內容經 <slot> 投入,scoped data-v 標記隨之保留,各頁彈窗的獨立類樣式不受 Teleport 影響。
 *
 * 顯隱用 open prop(而非呼叫方在 <ModalMask> 上寫 v-if):Transition 容器須常駐、由內部
 * v-if 切換彈窗,離場動畫才能播(否則元件隨父 v-if 一起解除安裝,leave 來不及觸發)。
 * slot 是惰性函式,open=false 時走不到 <slot/>、不會求值,故 slot 裡引用關閉後變 null 的
 * 物件(editingChannel.name 等)也不會報錯——無需在各呼叫點加守衛。
 */
import { modalHost } from '@/state/ui';

defineProps<{
  /** 彈窗是否顯示 */
  open?: boolean;
  /** 疊加在其它彈窗之上(更高 z-index),如渠道彈窗裡再開刪除確認 */
  topLayer?: boolean;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <!-- modalHost 未就緒時就地渲染兜底,絕不丟彈窗 -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbi-modal">
      <div
        v-if="open"
        class="bbi-modal-mask"
        :class="{ 'bbi-modal-mask-top': topLayer }"
        @mousedown.self="emit('close')"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 疊加層:蓋在普通彈窗之上(與 ConfirmDialog 的 -top 同級) */
.bbi-modal-mask-top {
  z-index: 10002;
}
</style>
