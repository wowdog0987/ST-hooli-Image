/**
 * 當前場景(地點 / 氛圍 / 場景特徵 / 時刻)—— 只讀 Horae「單樓 <horae> 結果」。
 *
 * ⚠ 刻意不走 Horae 聚合狀態(getLatestState / 狀態快照):那會把物品、NPC、待辦、劇情軌跡
 * 一併帶出來,這些與畫面無關卻很佔 token。這裡只碰三個點:
 *   1. 目標樓自己的 horae_meta.scene / timestamp(= 該樓 <horae> 解析結果);
 *      沒有 meta 時退回解析該樓原文裡的 <horae> 區塊。
 *   2. 目標樓漏寫地點時,往回最多 LOOKBACK 樓找最近一次的 location / atmosphere(只取這兩欄)。
 *   3. 場景特徵:本樓首次到達才會寫 scene_desc;否則只查「當前這個地點」的那一條
 *      locationMemory,不讀其他地點。
 */
import type { STMessage } from '@/st/context';

export interface FloorScene {
  location: string;
  atmosphere: string;
  /** 地點固定物理特徵(Horae scene_desc / 場景記憶),已壓成單行並截斷。 */
  sceneDesc: string;
  /** 時刻(HH:MM);只取鐘點不取日期——日期對畫面沒用,架空曆法還會誤導時代判斷。 */
  time: string;
}

interface HoraeFloorMeta {
  timestamp?: { story_time?: unknown };
  scene?: { location?: unknown; atmosphere?: unknown; scene_desc?: unknown };
}

/** 往回找地點的最大樓數:Horae 每回合必填 location,正常一兩樓內必中。 */
const LOOKBACK = 10;
const SCENE_DESC_MAX = 200;

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 解析訊息原文裡最後一個 <horae> 區塊(Horae 沒寫 meta 時的退路)。 */
export function parseHoraeBlock(mes: string): HoraeFloorMeta | null {
  const blocks = [...String(mes ?? '').matchAll(/<horae>([\s\S]*?)<\/horae>/gi)];
  const body = blocks[blocks.length - 1]?.[1];
  if (!body) return null;
  let location = '';
  let atmosphere = '';
  let sceneDesc = '';
  let time = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('location:')) {
      // 一則回覆可能經過多個地點:最後一個 location 才是當前場景,其 scene_desc 緊跟其後
      location = line.slice(9).trim();
      sceneDesc = '';
    } else if (line.startsWith('scene_desc:')) {
      sceneDesc = line.slice(11).trim();
    } else if (line.startsWith('atmosphere:')) {
      atmosphere = line.slice(11).trim();
    } else if (line.startsWith('time:')) {
      time = line.slice(5).trim().match(/\b(\d{1,2}:\d{2})\s*$/)?.[1] ?? '';
    }
  }
  if (!location && !atmosphere) return null;
  return {
    timestamp: { story_time: time },
    scene: { location, atmosphere, scene_desc: sceneDesc },
  };
}

function floorMeta(message: STMessage | undefined): HoraeFloorMeta | null {
  if (!message || message.is_user) return null;
  const meta = (message as { horae_meta?: HoraeFloorMeta }).horae_meta;
  if (meta && (oneLine(meta.scene?.location) || oneLine(meta.scene?.atmosphere))) return meta;
  return parseHoraeBlock(message.mes);
}

/** 只查當前地點這一條場景記憶;使用者刪除過的不用。 */
function locationMemoryDesc(chat: STMessage[], location: string): string {
  const root = (chat[0] as { horae_meta?: { locationMemory?: Record<string, unknown> } } | undefined)
    ?.horae_meta?.locationMemory;
  const entry = root?.[location] as { desc?: unknown; _deleted?: unknown } | undefined;
  if (!entry || entry._deleted) return '';
  return oneLine(entry.desc);
}

export function readFloorScene(chat: STMessage[], floor: number): FloorScene | null {
  const own = floorMeta(chat[floor]);
  let location = oneLine(own?.scene?.location);
  let atmosphere = oneLine(own?.scene?.atmosphere);
  let sceneDesc = oneLine(own?.scene?.scene_desc);
  const time = oneLine(own?.timestamp?.story_time);

  if (!location) {
    for (let f = floor - 1; f >= 0 && f >= floor - LOOKBACK; f -= 1) {
      const meta = floorMeta(chat[f]);
      const loc = oneLine(meta?.scene?.location);
      if (!loc) continue;
      location = loc;
      atmosphere ||= oneLine(meta?.scene?.atmosphere);
      break;
    }
  }
  if (location && !sceneDesc) sceneDesc = locationMemoryDesc(chat, location);
  if (!location && !atmosphere) return null;
  return { location, atmosphere, sceneDesc: clip(sceneDesc, SCENE_DESC_MAX), time };
}

function presentList(message: STMessage | undefined): string[] {
  if (!message || message.is_user) return [];
  const listed = (message as { horae_meta?: { scene?: { characters_present?: unknown } } }).horae_meta?.scene
    ?.characters_present;
  if (Array.isArray(listed)) {
    const names = listed.map(oneLine).filter(Boolean);
    if (names.length) return names;
  }
  const block = [...String(message.mes ?? '').matchAll(/<horae>([\s\S]*?)<\/horae>/gi)].pop()?.[1] ?? '';
  const line = block.split(/\r?\n/).map(text => text.trim()).find(text => text.startsWith('characters:'));
  return line ? line.slice(11).split(/[,，、]/).map(oneLine).filter(Boolean) : [];
}

/**
 * Horae 記錄的在場角色(全名,不受正文暱稱影響):本樓沒寫就往回找最近一樓,與地點同一套回看規則。
 */
export function readFloorPresent(chat: STMessage[], floor: number): string[] {
  for (let f = floor; f >= 0 && f >= floor - LOOKBACK; f -= 1) {
    const names = presentList(chat[f]);
    if (names.length) return names;
  }
  return [];
}

export function formatSceneBlock(scene: FloorScene | null): string {
  if (!scene) return '';
  const lines = ['【當前場景(Horae 本樓記錄,只讀參考)】'];
  if (scene.location) lines.push(`地點:${scene.location}`);
  if (scene.atmosphere) lines.push(`氛圍:${scene.atmosphere}`);
  if (scene.sceneDesc) lines.push(`場景特徵:${scene.sceneDesc}`);
  if (scene.time) lines.push(`時刻:${scene.time}`);
  return lines.join('\n');
}
