import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { normalizeOrientation } from '@/backends/size';
import { NaiError } from '@/backends/nai';
import { ComfyUIError } from '@/backends/comfyui';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { saveExternalImage } from '@/floor/storage';
import { getContext } from '@/st/context';
import { serializeImageTag } from '@/st/imageTagRegex';
import {
  buildEntryTag,
  charTagLib,
  charTagsBeforeFloor,
  lockedCharTagNames,
  type CharTagEntry,
} from '@/state/charTags';
import { PLUGIN_VERSION } from '@/version';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type GetCharactersOptions,
  type PublicBackendStatus,
  type PublicCharacter,
  type PublicCharacterList,
  type PublicError,
  type PublicErrorCode,
  type PublicGenerateProgress,
} from './types';

/**
 * 公開介面的實現層。**跨外掛邊界的全部髒活都收在這裡。**
 *
 * 三條紀律,每條都對應一類真實會咬人的問題:
 *
 * 1. **一切出去的資料都深複製**。charTagLib.entries 是 Vue reactive 陣列,
 *    原樣遞出去等於把角色庫的寫許可權也一起給了 —— 第三方隨手改一下,輕則被下一次
 *    recomputeCharTags() 靜默沖掉(使用者看見「我改的東西又沒了」),重則把 reactive
 *    代理帶進它自己的響應式系統,兩邊互相觸發更新。
 *
 * 2. **錯誤一律歸一成帶 code 的普通 Error**。NaiError / ComfyUIError / DOMException
 *    的 instanceof 跨 bundle 必然失效(兩份建構函式),第三方只能匹配 message 文案——
 *    而文案是中文、會隨版本改。故這裡統一掛 code,文件明說「按 code 分支」。
 *
 * 3. **圖一律轉 data URL 再交出去**。ComfyUI 直連模式返回的是 blob: URL,要配對
 *    revokeObjectURL:第三方忘了就洩漏,我們替它 revoke 它的 <img> 就變空白。
 *    data URL 無主、無生命週期,代價是字串大一些 —— 這個代價值得。
 */

export function clonePublic<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* —— 修訂號:角色庫每變一次 +1,第三方據此做快取失效 —— */

let revision = 0;

export function getPublicRevision(): number {
  return revision;
}

export function bumpPublicRevision(): number {
  revision += 1;
  return revision;
}

/* —— 錯誤歸一 —— */

/**
 * 造一個帶 code 的 Error。**不派生 Error 子類**:子類的 instanceof 跨 bundle 無效,
 * 造出來的型別資訊第三方拿不到,純屬自欺。
 */
export function publicError(code: PublicErrorCode, message: string): PublicError {
  const error = new Error(message) as PublicError;
  error.code = code;
  return error;
}

/** 已經是我們造的、帶合法 code 的錯誤嗎(避免二次包裝丟原始 code)。 */
function hasPublicCode(error: unknown): error is PublicError {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return (
    code === 'aborted' ||
    code === 'not_configured' ||
    code === 'invalid_args' ||
    code === 'rate_limited' ||
    code === 'backend_error'
  );
}

/**
 * 把內部錯誤翻成公開 code。
 *
 * 取消判定看 `name === 'AbortError'` 而非 instanceof DOMException:
 * abort 可能由第三方自己的 AbortController 觸發,那個 DOMException 來自**它的** realm,
 * instanceof 在我們這邊是 false —— 於是使用者主動取消會被報成 backend_error。
 *
 * rate_limited 與 backend_error 分開,是因為兩者的**處置方式**不同:前者該等一會兒再來
 * (虎哩繪的自動退避已經用盡了),後者是配置/網路問題,再來一次也是同樣的錯。
 */
export function toPublicError(error: unknown): PublicError {
  if (hasPublicCode(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') {
    return publicError('aborted', message || '已取消');
  }
  // NaiError 帶 status:429/408 是限流(能重試),其餘 4xx/5xx 是後端錯
  if (error instanceof NaiError) {
    const status = error.status;
    if (status === 429 || status === 408) return publicError('rate_limited', message);
    return publicError('backend_error', message);
  }
  if (error instanceof ComfyUIError) return publicError('backend_error', message);
  // 兜底也看一眼文案:上面兩個 instanceof 在同 bundle 內是可靠的,但內部還有別處拋的
  // 純 Error(如 uploadUserImage 的 ImageStoreError),它們沒有 status 可看
  if (/\b429\b|限流|rate limit/i.test(message)) return publicError('rate_limited', message);
  return publicError('backend_error', message || '生成失敗');
}

/* —— 角色列表 —— */

function toPublicCharacter(entry: CharTagEntry, locked: ReadonlySet<string>): PublicCharacter {
  return {
    name: entry.name,
    // tag 用 buildEntryTag 現算,不自己拼:它是「欄位 → tag 串」的唯一口徑
    // (含「老條目只有整串 raw」那條回落),抄第二份必然與卡片實際出圖的串漂移
    tag: buildEntryTag(entry),
    fields: { ...entry.fields },
    nl: entry.nl,
    source: entry.source,
    // 鎖定名 = 全域性庫有、本聊天沒同名覆蓋。這正是「全域性條目」的判據
    // (見 charTags.ts computeLockedCharTagNames),不必另立標記
    scope: locked.has(entry.name) ? 'global' : 'chat',
    desc: entry.desc,
    // history 刻意不給:50 條變更記錄對第三方無用,而**給出去就刪不掉了**
    // (刪欄位要升 apiVersion)。真有人要,日後加個 options 開關即可。
  };
}

export function getCharacters(options: GetCharactersOptions = {}): PublicCharacterList {
  const floor = options.floor;
  if (floor !== undefined && !Number.isInteger(floor)) {
    throw publicError('invalid_args', 'floor 必須是整數');
  }
  // 指定樓層走快照重放(那一樓當時的檔案);否則用現成的響應式庫
  const entries = floor === undefined ? charTagLib.entries : charTagsBeforeFloor(floor);
  const locked = lockedCharTagNames();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision,
    floor: floor ?? null,
    // map 出的物件已是新建的普通物件(fields 也展開過),不含 reactive 代理
    characters: entries.map(entry => toPublicCharacter(entry, locked)),
  };
}

/* —— 後端狀態 —— */

/**
 * 後端狀態。**欄位是白名單而非黑名單**:只挑這四項出去,
 * 而不是「把 status 整個遞出去再刪掉敏感欄位」—— 後者日後往內部結構加欄位時會靜默洩漏。
 * 尤其 settings.nai.key 與各後端 url 絕不出現在這裡。
 */
export function getBackendStatus(): PublicBackendStatus {
  const status = backendStatus();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    backend: status.backend,
    configured: status.configured,
    model: status.model,
    supportsCharacters: status.supportsCharacters,
    reason: status.reason,
  };
}

/* —— 生成 —— */

/** 第三方傳進來的 characters:逐項清洗成內部形狀,名字或 tag 空的丟掉。 */
function normalizeCharacters(raw: GenerateRequest['characters']): ImageCharacterPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
    const nl = typeof item.nl === 'string' ? item.nl.trim() : '';
    return name && tag ? [{ name, tag, nl }] : [];
  });
}

/**
 * 結果圖 → data URL。
 *
 * server 代理模式下 result.url 本就是 data URL,原樣返回(不過一遍 fetch,省一次複製);
 * 直連模式是 blob: URL,讀回來重編碼。理由見檔案頭第 3 條。
 */
async function toDataUrl(url: string, format: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`讀取圖片失敗 (${response.status})`);
  const bytes = new Uint8Array(await (await response.blob()).arrayBuffer());
  let binary = '';
  // 分塊拼接:一次 String.fromCharCode(...幾 MB) 會爆呼叫棧
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = format === 'jpg' ? 'jpeg' : format;
  return `data:image/${mime};base64,${btoa(binary)}`;
}

/** 進度回撥包裝:第三方的回撥拋錯不能連累生成(它只是想看個進度)。 */
function safeProgress(
  onProgress: GenerateOptions['onProgress'],
): (progress: PublicGenerateProgress) => void {
  if (typeof onProgress !== 'function') return () => {};
  return progress => {
    try {
      onProgress(progress);
    } catch (error) {
      console.warn('[虎哩繪] 公共介面 onProgress 回撥異常', error);
    }
  };
}

export async function generate(
  request: GenerateRequest,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  if (!request || typeof request !== 'object') {
    throw publicError('invalid_args', 'generate 需要一個引數物件');
  }
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt) throw publicError('invalid_args', 'prompt 不能為空');
  if (request.seed !== undefined && (typeof request.seed !== 'number' || !Number.isFinite(request.seed))) {
    throw publicError('invalid_args', 'seed 必須是數字');
  }

  // 先報 not_configured,別讓第三方等一個註定 401 的請求
  const status = backendStatus();
  if (!status.configured) {
    throw publicError('not_configured', status.reason || '虎哩繪出圖後端未配置');
  }

  const report = safeProgress(options.onProgress);
  const signal = options.signal;
  const characters = normalizeCharacters(request.characters);
  const nl = typeof request.nl === 'string' ? request.nl.trim() : '';
  const negative = typeof request.negative === 'string' ? request.negative.trim() : '';
  // 方向容忍式歸一:傳了認不出的值按豎屏,不為一個畫幅引數讓整次生成失敗
  const size = normalizeOrientation(request.size);
  const seed = decideSeed(status.backend, request.seed);

  // NAI 要過併發閘門,可能先排一會兒隊;ComfyUI 直接發,佇列在服務端
  report({ phase: status.backend === 'nai' ? 'queued' : 'generating' });

  let output;
  try {
    output = await generateImage({ prompt, nl, negative, characters, size, seed }, signal, {
      onStart: () => report({ phase: 'generating' }),
      onQueue: ahead => report({ phase: 'queued-remote', ahead }),
      onRetry: retry =>
        retry
          ? report({ phase: 'retrying', attempt: retry.attempt, max: retry.max })
          : report({ phase: 'generating' }),
    });
  } catch (error) {
    throw toPublicError(error);
  }

  const { result } = output;
  try {
    const dataUrl = await toDataUrl(result.url, result.format);
    // 落盤預設開(使用者定的口徑):預設進相簿,第三方要「閱後即焚」才顯式傳 false
    const wantSave = request.save !== false;
    let path: string | null = null;
    if (wantSave) {
      report({ phase: 'saving' });
      path = await saveToGallery(request, prompt, nl, negative, characters, size, seed, result);
    }
    return {
      apiVersion: PUBLIC_API_VERSION,
      pluginVersion: PLUGIN_VERSION,
      dataUrl,
      format: result.format,
      path,
      seed: output.seed,
      backend: output.backend,
      charactersApplied: output.charactersApplied,
    };
  } catch (error) {
    throw toPublicError(error);
  } finally {
    // blob URL 用完即撕:dataUrl 已經拿到,原始 blob 再留著就是純洩漏
    result.revoke();
  }
}

/**
 * 落盤進相簿。**失敗只警告不拋** —— 圖已經在 dataUrl 裡了,
 * 因為存不進相簿就讓第三方連圖都拿不到是本末倒置(它可能壓根不在乎相簿)。
 * 返回 null 讓呼叫方從 path 上看出來沒存成。
 */
async function saveToGallery(
  request: GenerateRequest,
  prompt: string,
  nl: string,
  negative: string,
  characters: ImageCharacterPrompt[],
  size: ReturnType<typeof normalizeOrientation>,
  seed: number,
  result: Parameters<typeof saveExternalImage>[3],
): Promise<string | null> {
  // 存的是 **tag 原文**(含 <hooli_image> 殼),不是拼好的展示文本:
  // 相簿讀側寫後要 parseImageTagContent 再 formatPromptText(與樓層卡片同一口徑),
  // 這裡存展示文本會讓相簿解析出一團糊在一起的裸 tag。
  const tag = serializeImageTag({ tag: prompt, nl, negative, characters, size });
  const name =
    (typeof request.character === 'string' ? request.character.trim() : '') ||
    getContext()?.name2?.trim() ||
    '未命名角色';
  try {
    return await saveExternalImage(name, tag, seed, result);
  } catch (error) {
    console.warn('[虎哩繪] 公共介面生成的圖片落盤失敗（圖片本身已返回給呼叫方）', error);
    return null;
  }
}
