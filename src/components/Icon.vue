<script setup lang="ts">
import { computed } from 'vue';

/**
 * 內聯 SVG 圖示 —— 不依賴字型庫,天然跨 shadow DOM。
 * 統一 24×24 視框、描邊風格(currentColor + stroke),
 * 通過 CSS color / font-size(1em=當前字號)繼承尺寸與顏色。
 * 新增圖示:往 PATHS 裡加一條 name -> 內部 <path>/<circle> 標記。
 */
const props = defineProps<{ name: string; size?: number | string }>();

// 僅放路徑資料,統一的 svg 外殼在模板裡。stroke 風格。
const PATHS: Record<string, string> = {
  // 渠道頁:插座/連線
  backend:
    '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-5.5 5.5A5.5 5.5 0 0 1 6.5 11.5V8z"/><path d="M12 17v4"/>',
  // 生成頁:圖片(山 + 日,經典 image 圖示)
  generate:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5 10 12l4 4 3-3 3.5 3.5"/>',
  // 提示詞頁:魔法棒(自動生成)
  prompt:
    '<path d="M6 21 17.5 9.5"/><path d="M15 4.5v3M15 12v.5M19.5 9h-3M11 9h-.5M17.7 5.3l-1.4 1.4M17.7 12.7l-1.4-1.4M12.3 5.3l1.4 1.4"/>',
  // WebUI 頁:伺服器/機箱
  webui:
    '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4"/>',
  // ComfyUI 頁:節點連線(工作流)
  comfyui:
    '<rect x="3.5" y="4" width="6" height="6" rx="1.2"/><rect x="14.5" y="14" width="6" height="6" rx="1.2"/><rect x="14.5" y="4" width="6" height="6" rx="1.2"/><path d="M9.5 7h5M17.5 10v4M12 17h2.5M6.5 10v4.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  // NAI 頁:羽毛筆
  nai: '<path d="M20 4c-5 0-11 3-13 9-1.2 3.6-1 5.5-1 7l-2 1"/><path d="M20 4c1 5-1 11-7 13-2 .8-4 .8-6 .5"/><path d="M20 4 9 15"/>',
  // 畫筆(品牌標/懸浮球預設圖示)
  palette:
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.4-2.2-.6-1.3.2-2.3 1.6-2.3h1.5a4 4 0 0 0 4-4C20.5 7.3 16.7 3.5 12 3.5z"/><circle cx="8" cy="9.5" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16" cy="9.5" r="1.1"/>',
  // 摘要:文件 + 文本行
  summary:
    '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h6M9 9h2"/>',
  // 角色:人像
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // 請求歷史:時鐘 + 左上回撥箭頭(時間倒流)。墨跡 3.5~20.5,與 characters/settings 同量級
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 7.5V12l3 1.8"/>',
  // 相簿:疊放的圖片(後卡露邊 + 前卡山日),區別於 generate 的單張圖
  gallery:
    '<path d="M7.5 3.5H19a1.5 1.5 0 0 1 1.5 1.5v11"/><rect x="3.5" y="6.5" width="13.5" height="12" rx="1.5"/><circle cx="7.3" cy="10.3" r="1.2"/><path d="M4 15.8 8 12l2.8 2.8 2-2 3.7 3.7"/>',
  // NPC 名冊(導航):雙人像,區別於單人 characters
  npcs:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 4.8"/><path d="M17 14.8c2.3.5 3.9 2.3 3.9 4.7"/>',
  // 隨行:圖釘(標記/取消同伴)
  pin: '<path d="M12 2.5 9 5.5l1 1L7 13l-3 .5 3.5 3.5L11 14l6.5-3 1 1 3-3-6.5-6.5z"/><path d="M5 19l3.2-3.2"/>',
  // 主要角色:五角星(描邊=未標記,可點亮)
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>',
  // 場景:山 + 日
  scenes:
    '<circle cx="8" cy="8" r="2"/><path d="M3.5 19.5 9 12l4 5"/><path d="M11.5 19.5 16 13.5l4.5 6"/><path d="M3.5 19.5h17"/>',
  // 物品:立方體
  items:
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  // 設定:滑塊
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // 變數:花括號 { } —— 自定義 JSON 變數,區別於設定的滑塊
  vars:
    '<path d="M9 4.5c-2 0-2 2.4-2 4 0 1.8-.8 2.9-2.5 3 1.7.1 2.5 1.2 2.5 3 0 1.6 0 4 2 4"/><path d="M15 4.5c2 0 2 2.4 2 4 0 1.8.8 2.9 2.5 3-1.7.1-2.5 1.2-2.5 3 0 1.6 0 4-2 4"/>',
  // 匯出/分享:箭頭向上出托盤
  upload: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 匯入:箭頭向下入托盤
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 複製:重疊文件
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/>',
  // 書籤(品牌標)
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  // 月亮
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // 虎哩主題:正面虎臉(尖耳、額頭王字紋、兩頰鬍鬚斑)
  tiger:
    '<path d="M12 20c-4.2 0-7-2.6-7-6.3 0-2.6 1.2-4.6 3-5.8L7 4.5l3.2 2.2c.6-.1 1.2-.2 1.8-.2s1.2.1 1.8.2L17 4.5l-1 3.4c1.8 1.2 3 3.2 3 5.8 0 3.7-2.8 6.3-7 6.3z"/><path d="M12 8.6v1.8M9.9 9.3l.6 1.3M14.1 9.3l-.6 1.3"/><path d="M9.2 12.9h.01M14.8 12.9h.01"/><path d="M11 15.4h2l-1 1.2z"/><path d="M12 16.6c-.4.9-1.3 1.1-2 .6M12 16.6c.4.9 1.3 1.1 2 .6"/><path d="M5.4 13.3h1.9M5.8 15.6l1.7-.6M18.6 13.3h-1.9M18.2 15.6l-1.7-.6"/>',
  // 蜜桃主題:水蜜桃(中央凹線、梗與葉)
  peach:
    '<path d="M12 20.5c-4 0-7-3-7-7 0-3.6 2.6-6.2 5.5-6.2.6 0 1.1.1 1.5.3.4-.2.9-.3 1.5-.3 2.9 0 5.5 2.6 5.5 6.2 0 4-3 7-7 7z"/><path d="M12 7.6c-1.6 3.1-1.6 8.2.4 12.7"/><path d="M12 7.6V5.4"/><path d="M12 6.2c1-2 3-2.8 5-2.5-.4 2-2.2 3.2-5 2.5z"/>',
  // 太陽
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // 關閉
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // 對勾:確認/儲存
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  // 新增/加號
  plus: '<path d="M12 5v14M5 12h14"/>',
  // 顯示(睜眼)
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // 隱藏(閉眼/劃線)
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 5.8A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.8 15.8 0 0 1-3.3 3.9"/><path d="M6.3 8.1A15.9 15.9 0 0 0 2.5 12S6 18.5 12 18.5a8.5 8.5 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  // 向下箭頭(摺疊指示)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // 文本行:提示詞面板開關(樓層卡片浮鈕)
  text: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"/>',
  // 更多操作:豎三點(樓層卡片觸屏收納鈕,點開展開豎排選單)。
  // 元件根是 fill=none 描邊風格,圓點太小描邊會成空心環,故自身覆蓋為實心。
  more: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none"/>',
  // 前往地點:帶長箭桿的向右箭頭,區別於摺疊用 chevron
  navigate: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/>',
  // 搜尋:放大鏡
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // 多選:勾選清單(左側對勾 + 右側行,一眼看出「勾選多條」)
  checklist: '<path d="M3.5 6.5 5 8l2.5-2.5M3.5 12.5 5 14l2.5-2.5M3.5 18.5 5 20l2.5-2.5"/><path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5"/>',
  // 宮格:庫管理入口(卡片網格),區別於 gallery 的疊圖
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  // 閃電:立即/瞬時(立即總結)。原始 y 範圍偏滿(頂天立地顯高),
  // 以中心 y=12 略壓到 ~4.0~20.0,視覺高度向放大鏡/清單看齊(壓太狠會顯矮,取中)。
  bolt: '<path d="M13 4 5 13h6l-1 7 8-9h-6z"/>',
  // 計劃/懸念:旗標
  plans: '<path d="M6 21V4M6 4.5h11l-2.5 3.5L17 11.5H6"/>',
  // 連線/測試
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // 重新整理/拉取
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // 刪除/垃圾桶:墨跡 x 4~20 / y 4.5~19.5,與 copy(4~19 / 4~20)、download(4~20 / 4~20)
  // 光學尺寸對齊——原來只到 y 6~18.5,同一按鈕組裡挨著 copy/download 會明顯矮一號,
  // 按鈕畫素尺寸相同也看得出來。桶身仍向下收窄,減輕視覺分量。
  trash: '<path d="M4 6.5h16M9.5 6.5v-2h5v2M6.5 6.5l.9 13h9.2l.9-13"/>',
  // 編輯/鉛筆:斜跨 4.5~19.5,墨跡比原來鋪滿,視覺分量與垃圾桶相當(否則鉛筆顯小一號)
  edit: '<path d="M4.5 19.5h4L19 9 15 5 4.5 15.5z"/><path d="M13 7 17 11"/>',
  // 閃耀/夢幻(粉彩主題)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbi-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbi-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
