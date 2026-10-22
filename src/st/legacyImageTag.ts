import { getContext } from '@/st/context';

/**
 * 舊版圖片 tag 遷移:改名前的版本把圖片寫成 <bbi_image>…</bbi_image>,並註冊了
 * bbi-image-tag-slot / bbi-image-tag-hide 兩條正則。改名後新正則只認 <hooli_image>,
 * 舊樓層的 tag 既不顯示成卡片、也不再從提示詞裡隱藏(每張圖數百 token 灌進上下文)。
 *
 * 這裡把聊天記錄裡的舊 tag 原地改寫成新名字(內容格式完全相同),並移除舊正則。
 * 每個聊天只會真正改寫一次:改寫後再掃描就找不到舊 tag 了。
 */
const LEGACY_TAG_RE = /<(\/?)bbi_image>/gi;
const HAS_LEGACY_TAG = /<\/?bbi_image>/i;
const LEGACY_REGEX_IDS = ['bbi-image-tag-slot', 'bbi-image-tag-hide'];

export function renameLegacyImageTags(text: string): string {
  return text.replace(LEGACY_TAG_RE, '<$1hooli_image>');
}

/** 改寫當前聊天裡的舊 tag;返回改寫的樓層數。有改動時存檔並重新載入聊天以重繪卡片。 */
export async function migrateLegacyImageTags(): Promise<number> {
  const context = getContext();
  if (!context?.chat?.length) return 0;
  const chat = context.chat;
  let changedFloors = 0;
  for (const message of chat) {
    let changed = false;
    if (typeof message.mes === 'string' && HAS_LEGACY_TAG.test(message.mes)) {
      message.mes = renameLegacyImageTags(message.mes);
      changed = true;
    }
    if (Array.isArray(message.swipes)) {
      message.swipes = message.swipes.map(swipe => {
        if (typeof swipe !== 'string' || !HAS_LEGACY_TAG.test(swipe)) return swipe;
        changed = true;
        return renameLegacyImageTags(swipe);
      });
    }
    if (changed) changedFloors += 1;
  }
  if (!changedFloors) return 0;
  await context.saveChat();
  await context.reloadCurrentChat?.();
  console.log(`[虎哩繪] 已把 ${changedFloors} 樓的舊圖片 tag 改寫為 <hooli_image>`);
  return changedFloors;
}

/** 從 ST 全域性正則列表移除改名前註冊的兩條舊規則。 */
export function removeLegacyImageTagRegex(): boolean {
  const context = getContext();
  const list = context?.extensionSettings?.regex;
  if (!Array.isArray(list)) return false;
  const kept = list.filter(item => !LEGACY_REGEX_IDS.includes((item as { id?: unknown })?.id as string));
  if (kept.length === list.length) return false;
  context!.extensionSettings!.regex = kept;
  context!.saveSettingsDebounced?.();
  return true;
}

let bound = false;

export function bindLegacyImageTagMigration(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  removeLegacyImageTagRegex();
  const run = () => {
    void migrateLegacyImageTags().catch(error => {
      console.warn('[虎哩繪] 舊圖片 tag 遷移失敗', error);
    });
  };
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, run);
  run();
}
