import { getContext } from '@/st/context';
import { reactive } from 'vue';

/**
 * 世界背景(時代 / 地域 / 階層)—— 一行短文字,例如「18世紀歐洲・洛可可貴族宮廷」。
 *
 * 存在 chatMetadata(與本聊天角色庫同層):同一張卡開不同世界線的聊天可以各填各的。
 * 題詞端只把這一行帶進請求,用來決定服裝 / 建築 / 道具的時代風格預設值——
 * 取代「每次都讀世界書」的做法。
 */
const META_KEY = 'bbiWorldSetting';
export const WORLD_SETTING_MAX = 200;

export const worldSetting = reactive<{ text: string }>({ text: '' });

export function hydrateWorldSetting(): void {
  const raw = getContext()?.chatMetadata?.[META_KEY];
  worldSetting.text = typeof raw === 'string' ? raw : '';
}

export function setWorldSetting(text: string): boolean {
  const context = getContext();
  if (!context?.chatMetadata) return false;
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, WORLD_SETTING_MAX);
  worldSetting.text = clean;
  if (clean) context.chatMetadata[META_KEY] = clean;
  else delete context.chatMetadata[META_KEY];
  context.saveMetadataDebounced?.();
  return true;
}

/** 題詞用:空值 → 空串(呼叫方不注入,改由模型從正文推斷)。 */
export function formatWorldSettingBlock(text = worldSetting.text): string {
  const clean = text.trim();
  return clean ? `【世界背景】${clean}` : '';
}

let bound = false;

export function bindWorldSettingSync(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, hydrateWorldSetting);
  hydrateWorldSetting();
}
