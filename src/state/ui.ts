import { onSettingsReady, settings } from '@/state/settings';
import { reactive, ref, watch } from 'vue';

/**
 * 彈窗 Teleport 宿主:由 App.vue 掛在 .bbi-root 的直接子級(在 .bbi-body 滾動容器之外)。
 * 所有 .bbi-modal-mask 彈窗都 Teleport 到這裡,避開 iOS Safari 的老問題——
 * 「可滾動祖先內的 position:fixed 後代」會相對滾動內容而非視口定位,設定頁滾動後彈窗頂出螢幕。
 * 仍在 shadow root 內,scoped 樣式與 --bbi-* 主題變數照常生效(故不能用 Teleport to="body")。
 */
export const modalHost = ref<HTMLElement | null>(null);

/** 導航位置:auto = PC 頂部、移動端底部 */
export type NavPosition = 'top' | 'bottom' | 'auto';

/**
 * 主題。新增主題只需:
 *   1) theme.css 裡加一套 .bbi-root[data-theme='xxx'] 變數;
 *   2) 這裡給 ThemeName 加上 'xxx',並往 THEMES 登錄檔加一條。
 * 設定頁與題首切換按鈕都從 THEMES 自動讀取,無需再改別處。
 */
export type ThemeName = 'tiger' | 'peach' | 'starry' | 'sand' | 'st';

export interface ThemeDef {
  value: ThemeName;
  label: string;
  /** Icon 元件名,見 components/Icon.vue */
  icon: string;
}

export const THEMES: ThemeDef[] = [
  { value: 'tiger', label: '虎哩', icon: 'tiger' },
  { value: 'peach', label: '蜜桃', icon: 'peach' },
  { value: 'starry', label: '星空', icon: 'moon' },
  { value: 'sand', label: '暖沙', icon: 'sun' },
  { value: 'st', label: '跟隨ST', icon: 'plug' },
];

/** 新安裝的預設主題;舊版主題(日間/夜間/粉彩/木白)已移除,存著舊值的使用者也落到這裡。 */
export const DEFAULT_THEME: ThemeName = 'tiger';

interface UiState {
  open: boolean;
  /** 當前分頁 id,對應 registry 裡的 key */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
  /** 移動端:再點當前頁導航按鈕即關窗(預設開,怕誤觸可關) */
  navTapClose: boolean;
  /** 在 ST 頂欄注入快速開啟按鈕(預設關) */
  showTopBar: boolean;
  /** 螢幕邊緣懸浮球(預設關) */
  showOrb: boolean;
  /** 懸浮球自定義圖示(ST 伺服器圖片路徑;空=預設畫筆圖示) */
  orbImage: string;
  /** 懸浮球形狀:bookmark / circle / square */
  orbShape: OrbShape;
  /** 懸浮球靜止不透明度(百分比 20–100) */
  orbOpacity: number;
  /** 懸浮球基準尺寸(px,32–80) */
  orbSize: number;
}

/** 懸浮球形狀 */
export type OrbShape = 'bookmark' | 'circle' | 'square';
export const ORB_SHAPES: { value: OrbShape; label: string }[] = [
  { value: 'bookmark', label: '書籤' },
  { value: 'circle', label: '圓形' },
  { value: 'square', label: '方形' },
];
function validOrbShape(s: string): OrbShape {
  return s === 'bookmark' || s === 'circle' || s === 'square' ? s : 'bookmark';
}

// activePage(上次停在哪一頁)是純本機臨時導航態,跨裝置同步無意義、且翻頁即回寫伺服器太頻繁,
// 故仍存本機 localStorage;主題/導航位置是真·設定,改存進 settings.ui(→ ST 跨裝置同步)。
const PAGE_STORAGE_KEY = 'bbi.ui.page.v1';

function loadActivePage(): string {
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) || 'backend';
  } catch {
    return 'backend';
  }
}

// 主題合法性校驗:settings.ui.theme 是裸字串,可能來自舊版本/被手改壞,落到 ui 前先校驗。
function validTheme(t: string): ThemeName {
  return THEMES.some(x => x.value === t) ? (t as ThemeName) : DEFAULT_THEME;
}
function validNav(n: string): NavPosition {
  return n === 'top' || n === 'bottom' || n === 'auto' ? n : 'auto';
}

// 先用 settings 當前值建 ui(import 階段多為預設;hydrate 完成後由 onSettingsReady 回灌真值)。
export const ui = reactive<UiState>({
  open: false,
  activePage: loadActivePage(),
  theme: validTheme(settings.ui.theme),
  navPosition: validNav(settings.ui.navPosition),
  navTapClose: settings.ui.navTapClose,
  showTopBar: settings.ui.showTopBar,
  showOrb: settings.ui.showOrb,
  orbImage: settings.ui.orbImage,
  orbShape: validOrbShape(settings.ui.orbShape),
  orbOpacity: settings.ui.orbOpacity,
  orbSize: settings.ui.orbSize,
});

// settings 跨裝置同步值就緒後,把主題/導航回灌進 ui(覆蓋 import 階段的預設)
onSettingsReady(() => {
  ui.theme = validTheme(settings.ui.theme);
  ui.navPosition = validNav(settings.ui.navPosition);
  ui.navTapClose = settings.ui.navTapClose;
  ui.showTopBar = settings.ui.showTopBar;
  ui.showOrb = settings.ui.showOrb;
  ui.orbImage = settings.ui.orbImage;
  ui.orbShape = validOrbShape(settings.ui.orbShape);
  ui.orbOpacity = settings.ui.orbOpacity;
  ui.orbSize = settings.ui.orbSize;
});

// ui 改變 → 寫回 settings.ui(由 settings 的 watch 防抖落盤、跨裝置同步);activePage 仍存本機。
watch(
  () => [
    ui.theme,
    ui.navPosition,
    ui.navTapClose,
    ui.showTopBar,
    ui.showOrb,
    ui.orbImage,
    ui.orbShape,
    ui.orbOpacity,
    ui.orbSize,
  ],
  () => {
    settings.ui.theme = ui.theme;
    settings.ui.navPosition = ui.navPosition;
    settings.ui.navTapClose = ui.navTapClose;
    settings.ui.showTopBar = ui.showTopBar;
    settings.ui.showOrb = ui.showOrb;
    settings.ui.orbImage = ui.orbImage;
    settings.ui.orbShape = ui.orbShape;
    settings.ui.orbOpacity = ui.orbOpacity;
    settings.ui.orbSize = ui.orbSize;
  },
);
watch(
  () => ui.activePage,
  () => {
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, ui.activePage);
    } catch {
      /* localStorage 不可用時靜默 */
    }
  },
);

/**
 * 視窗最近一次開啟的時間戳。用於在開啟瞬間忽略遮罩關閉——
 * 移動端開啟手勢末尾合成的 click 會穿透到剛渲染的遮罩,造成"秒關"。
 */
export let lastOpenedAt = 0;

export function openPanel(page?: string) {
  if (page) ui.activePage = page;
  ui.open = true;
  lastOpenedAt = performance.now();
}

export function closePanel() {
  ui.open = false;
}

/** 題首按鈕:在所有已註冊主題間迴圈切換 */
export function cycleTheme() {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  ui.theme = THEMES[(i + 1) % THEMES.length].value;
}
