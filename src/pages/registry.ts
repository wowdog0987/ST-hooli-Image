import type { Component } from 'vue';
import Backend from './backend/index.vue';
import Characters from './characters/index.vue';
import Gallery from './gallery/index.vue';
import History from './history/index.vue';
import Settings from './settings/index.vue';

export interface PageDef {
  /** 唯一 id,存進 ui.activePage / localStorage;同時作為 Icon 的 name */
  id: string;
  /** 導航欄全稱 */
  label: string;
  component: Component;
}

/**
 * 分頁登錄檔 —— 新增一頁:建一個 pages/<id>/index.vue,再往這裡加一行,
 * 並在 Icon.vue 的 PATHS 裡加一條同 id 的圖示。順序即導航順序,設定放最末。
 */
export const PAGES: PageDef[] = [
  { id: 'backend', label: '渠道', component: Backend },
  { id: 'characters', label: '角色管理', component: Characters },
  { id: 'gallery', label: '相簿', component: Gallery },
  { id: 'history', label: '請求歷史', component: History },
  { id: 'settings', label: '設定', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
