import App from '@/App.vue';
import { bindAutoTagging } from '@/autoTag/runner';
import { bindTagActionButtons } from '@/floor/actionButton';
import { bindFloorHydration } from '@/floor/hydrate';
import { injectMenuButton } from '@/menu';
import { registerPublicInterface } from '@/public/register';
import { bindCharTagSync } from '@/state/charTags';
import { initGlobalCharTags } from '@/state/globalCharTags';
import { hydrateSettings } from '@/state/settings';
import { bindWorldSettingSync } from '@/state/worldSetting';
import { ui } from '@/state/ui';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { ensureImageTagRegexRegistered } from '@/st/imageTagRegex';
import { bindLegacyImageTagMigration } from '@/st/legacyImageTag';
import { syncTopBarButton } from '@/topbar';
import { versionedAssetUrl } from '@/version';
// 這兩行讓 Vite 把全域性樣式打進 dist/index.css(隨後注入 shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import { createApp, watch } from 'vue';

const HOST_ID = 'bbi-app-host';

/**
 * 可繼承的排版屬性——shadow DOM 不隔離繼承,這些會透過 host 從 ST 漏進來。
 * 在 host 上用內聯 !important 釘死,從根上切斷繼承鏈。
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'font-variant': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  color: '#1c242c',
  direction: 'ltr',
};

function mount() {
  // host 元素留在 ST 的 light DOM,Vue 應用整體活在它的 shadow root 裡。
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  // host 不參與佈局(視窗內部用 fixed 定位),並切斷繼承
  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.textContent = '';
  guardEditableArrowKeys(shadow);

  // 把我們構建出的 dist/index.css 以 <link> 注入 shadow root——
  // 這樣樣式只在這棵 shadow 樹內生效,ST 全域性樣式進不來,我們的也出不去。
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // index.js 與 index.css 在 dist 同級,據當前模組 URL 推導,部署路徑無關。
  link.href = versionedAssetUrl('./index.css', import.meta.url);
  shadow.appendChild(link);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const app = createApp(App);
  app.mount(container);

  $(window).on('pagehide', () => app.unmount());
}

$(() => {
  mount();
  injectMenuButton();
  // 頂欄快速開啟按鈕:按開關注入/移除。watch 在開關變化(含 hydrate 回灌真值)時同步。
  syncTopBarButton(ui.showTopBar);
  watch(
    () => ui.showTopBar,
    on => syncTopBarButton(on),
  );
  // 等 ST 的 getContext 就緒後再 hydrate 設定(載入順序不確定時輪詢)
  hydrateWhenReady();
});

async function hydrateWhenReady(attempt = 0) {
  if ((window as unknown as { SillyTavern?: { getContext?: unknown } }).SillyTavern?.getContext) {
    try {
      await hydrateSettings();
      // 全域性庫必須在 bindCharTagSync 之前初始化:首次重算就要把全域性條目合進派生庫
      initGlobalCharTags();
      bindCharTagSync();
      bindWorldSettingSync();
      ensureImageTagRegexRegistered();
      bindLegacyImageTagMigration();
      bindAutoTagging();
      bindFloorHydration();
      bindTagActionButtons();
      // 公開介面必須排在 hydrateSettings 之後:設定回灌前 getBackendStatus() 讀的是
      // 預設值,會把配好的使用者報成「未配置」。排在 bindCharTagSync 之後則是為了讓
      // ready 事件裡的 revision 已經對應真實角色庫。
      registerPublicInterface();
      console.log(`[虎哩繪] 已載入 v${__BBI_VERSION__},設定已同步`);
    } catch (e) {
      console.error('[虎哩繪] 設定載入失敗', e);
    }
    return;
  }
  if (attempt > 40) return; // 最多約 20s
  setTimeout(() => hydrateWhenReady(attempt + 1), 500);
}
