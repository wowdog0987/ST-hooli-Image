import { watch } from 'vue';

import { charTagLib } from '@/state/charTags';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import {
  bumpPublicRevision,
  clonePublic,
  generate,
  getBackendStatus,
  getCharacters,
  getPublicRevision,
} from './api';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GetCharactersOptions,
  type PublicCapabilities,
  type PublicChangeListener,
  type PublicChangeNotice,
  type STBaiBaiImageApi,
} from './types';

/**
 * 公開介面的註冊與事件面。
 *
 * 第三方怎麼拿到介面——**兩條路都得給**,因為外掛載入順序不確定:
 * - 它比虎哩繪晚載入:直接讀 globalThis.STBaiBaiImage 就有;
 * - 它比虎哩繪早載入:讀到 undefined,只能等 window 的 'st-baibai-image:ready'。
 * 只給其中一條,另一半場合的第三方就得寫輪詢——那是我們的鍋,不是它的。
 */

export const PUBLIC_READY_EVENT = 'st-baibai-image:ready';
export const PUBLIC_CHANGED_EVENT = 'st-baibai-image:changed';

const capabilities: PublicCapabilities = {
  globalApi: true,
  characterLibrary: true,
  generate: true,
  saveToGallery: true,
  events: true,
};

const listeners = new Set<PublicChangeListener>();
let registered = false;
let ready = false;
let changeQueued = false;

function chatId(): string | null {
  return getContext()?.getCurrentChatId?.() ?? null;
}

function notice(type: PublicChangeNotice['type']): PublicChangeNotice {
  return {
    type,
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chatId: chatId(),
    capabilities: clonePublic(capabilities),
  };
}

/**
 * 發通知。**每個接收方各拿一份深複製**:同一個 detail 物件傳給 N 個訂閱者時,
 * 頭一個改了它、後面的就收到被篡改的內容(而且兩邊都不知道發生了什麼)。
 * 訂閱回撥拋錯只記 console:一個第三方寫崩了不能連累其餘訂閱者收不到通知。
 */
function emitNotice(type: PublicChangeNotice['type']): void {
  const detail = notice(type);
  for (const listener of listeners) {
    try {
      listener(clonePublic(detail));
    } catch (error) {
      console.warn('[虎哩繪] 公共介面訂閱回撥異常', error);
    }
  }
  const eventName = type === 'ready' ? PUBLIC_READY_EVENT : PUBLIC_CHANGED_EVENT;
  window.dispatchEvent(new CustomEvent(eventName, { detail: clonePublic(detail) }));
}

/**
 * 攢一個微任務再發。recomputeCharTags() 一次會整體替換 entries,
 * 而切聊天/刪樓/滑動會連著觸發好幾次重算 —— 不攢的話第三方一秒內收到十幾條同樣的通知,
 * 每條都可能引它去做一次全量重新整理。
 */
function queueChangedNotice(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    bumpPublicRevision();
    if (ready) emitNotice('changed');
  });
}

function createApi(): STBaiBaiImageApi {
  // 凍結:第三方(或它引的某個庫)往介面物件上掛東西、或替換掉 generate,
  // 會讓後到的另一個第三方拿到被改過的介面。凍結讓這類改動直接失敗而不是靜默生效。
  return Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    get capabilities() {
      return clonePublic(capabilities);
    },
    getCharacters: (options?: GetCharactersOptions) => getCharacters(options),
    getBackendStatus: () => getBackendStatus(),
    generate: (request: GenerateRequest, options?: GenerateOptions) => generate(request, options),
    subscribe(listener: PublicChangeListener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe listener 必須是函式');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/**
 * 註冊公開介面。**必須在 hydrateSettings() 之後調**:
 * 設定回灌前 settings 還是記憶體裡的預設值,getBackendStatus() 會把「其實配好了的使用者」
 * 報成 not_configured,第三方據此直接不給出圖入口。
 */
export function registerPublicInterface(): void {
  if (registered) return;
  registered = true;

  bumpPublicRevision();
  const api = createApi();
  (globalThis as typeof globalThis & { STBaiBaiImage?: STBaiBaiImageApi }).STBaiBaiImage = api;

  // 角色庫是響應式派生結果,一律 watch 它本身,不去逐個訂閱那些**導致**它變的事件
  // (CHAT_CHANGED / 刪樓 / 滑動 / 使用者手動編輯……漏一個就少一次通知)。
  watch(() => charTagLib.entries, queueChangedNotice, { deep: true });

  ready = true;
  emitNotice('ready');
  console.log('[虎哩繪] 公共介面已就緒', clonePublic(capabilities));
}
