import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import { getContext, type STMessage } from '@/st/context';
import { getTagGenChannel } from '@/state/settings';

/**
 * 角色管理頁「從 Horae 匯入」世界背景:使用者主動點的一次性動作。
 *
 * 只取最新一則有 Horae 記錄的 AI 樓:日期、地點(含上層地點)的場景記憶、在場角色服裝。
 * 不讀物品 / NPC 表 / 待辦 / 劇情軌跡,也不讀世界書——服裝與地點描述已足夠看出時代。
 */

interface HoraeMetaLike {
  timestamp?: { story_date?: unknown };
  scene?: { location?: unknown };
  costumes?: Record<string, unknown>;
}

const SYSTEM = `你負責為繪圖判斷故事的「世界背景」。根據使用者給的 Horae 場景線索,用一行繁體中文(30 字以內)概括時代、地域與社會階層,供畫圖時決定服裝、建築、道具風格。
格式範例:
18世紀歐洲・洛可可貴族宮廷
1920年代上海・民國初年
現代韓國首爾・都市生活
架空西幻・中世紀王國
只輸出那一行,不要解釋、不要引號。服裝描述比日期可靠(架空故事的日期常是隨手設定的)。完全無法判斷時只輸出:未知`;

function str(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function latestHoraeMeta(chat: STMessage[]): HoraeMetaLike | null {
  for (let floor = chat.length - 1; floor >= 0; floor -= 1) {
    const message = chat[floor];
    if (message?.is_user) continue;
    const meta = (message as { horae_meta?: HoraeMetaLike }).horae_meta;
    if (str(meta?.scene?.location) || Object.keys(meta?.costumes ?? {}).length) return meta ?? null;
  }
  return null;
}

/** 地點及其各級上層(「皇宮·休息室」→ 皇宮、皇宮·休息室)的場景記憶,只查這條路徑。 */
function locationPathDescs(chat: STMessage[], location: string): string[] {
  const root = (chat[0] as { horae_meta?: { locationMemory?: Record<string, unknown> } } | undefined)
    ?.horae_meta?.locationMemory;
  if (!root || !location) return [];
  const parts = location.split(/[·・]/).map(part => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    const name = parts.slice(0, i).join('·');
    const entry = (root[name] ?? root[parts.slice(0, i).join('・')]) as
      | { desc?: unknown; _deleted?: unknown }
      | undefined;
    const desc = entry && !entry._deleted ? str(entry.desc) : '';
    if (desc) out.push(`${name}:${desc.slice(0, 150)}`);
  }
  return out;
}

export function collectWorldHints(): string {
  const chat = getContext()?.chat ?? [];
  const meta = latestHoraeMeta(chat);
  if (!meta) return '';
  const lines: string[] = [];
  const date = str(meta.timestamp?.story_date);
  if (date) lines.push(`故事日期:${date}`);
  const location = str(meta.scene?.location);
  if (location) lines.push(`當前地點:${location}`);
  const descs = locationPathDescs(chat, location);
  if (descs.length) lines.push('地點特徵:', ...descs.map(d => `- ${d}`));
  const costumes = Object.entries(meta.costumes ?? {})
    .map(([name, outfit]) => [name, str(outfit)])
    .filter(([, outfit]) => !!outfit);
  if (costumes.length) lines.push('在場服裝:', ...costumes.map(([name, outfit]) => `- ${name}:${outfit}`));
  return lines.join('\n');
}

/** 返回一行世界背景;Horae 沒有可用線索 → 拋錯,由頁面提示手動填寫。 */
export async function suggestWorldSettingFromHorae(signal?: AbortSignal): Promise<string> {
  const hints = collectWorldHints();
  if (!hints) throw new Error('Horae 目前沒有地點或服裝記錄,請手動填寫');
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: hints },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: '世界背景匯入' })
    : await requestViaMainApi(messages, { signal, source: '世界背景匯入' });
  const line = raw
    .replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '')
    .split(/\r?\n/)
    .map(text => text.replace(/^["'「『]|["'」』]$/g, '').trim())
    .find(Boolean);
  if (!line || line === '未知') throw new Error('模型判斷不出時代背景,請手動填寫');
  return line;
}
