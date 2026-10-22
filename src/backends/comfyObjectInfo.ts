/**
 * 從 ComfyUI 拉取模型/LoRA/取樣器列表,供簡易模式表單做候選。
 *
 * 通道策略與 generateComfyImage 同口徑:瀏覽器直連優先(一次 GET /object_info 拿全,
 * 含 LoRA 與 CLIP);僅網路級失敗(CORS/拒連)回退 ST 後端轉發。
 *
 * ST 後端只有 /api/sd/comfy/models|samplers|schedulers|vaes 四個端點(都是服務端
 * 拉 /object_info 再摘欄位),**沒有 loras/clips 端點**——轉發通道下這兩組降級為空,
 * 表單退化為手輸(datalist 無候選),並在狀態行說明原因。
 *
 * 列表有 session 級快取:object_info 完整響應有幾 MB,切換預設/重開面板不該反覆拉;
 * 使用者加了新模型點「重新整理」強制重拉。
 */

import { ComfyUIError } from '@/backends/comfyui';
import { getContext } from '@/st/context';

export interface ComfyModelLists {
  checkpoints: string[];
  unets: string[];
  ggufs: string[];
  vaes: string[];
  clips: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
  /** 實際打通的通道:browser=拿到了全量;server=轉發,loras/clips 為空。 */
  mode: 'browser' | 'server';
  fetchedAt: number;
}

/** 轉發通道拿不到列表時的常見候選(datalist 兜底,仍允許手輸)。 */
export const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc'];
export const FALLBACK_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'];

const SERVER_BASE = '/api/sd/comfy';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

/** object_info 裡取某個節點某輸入的候選列表;節點未裝/形狀不符一律空陣列(降級優先)。 */
function optionList(info: JsonObject, nodeClass: string, input: string): string[] {
  const node = info[nodeClass];
  if (!isObject(node) || !isObject(node.input) || !isObject(node.input.required)) return [];
  const entry = node.input.required[input];
  if (!Array.isArray(entry)) return [];
  const options = entry[0];
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === 'string');
}

/** 瀏覽器直連的全量解析。clips 取 CLIPLoader 與 DualCLIPLoader 的並集(同文件夾,口徑可能差一版)。 */
export function parseObjectInfo(info: JsonObject): Omit<ComfyModelLists, 'mode' | 'fetchedAt'> {
  return {
    checkpoints: optionList(info, 'CheckpointLoaderSimple', 'ckpt_name'),
    unets: optionList(info, 'UNETLoader', 'unet_name'),
    ggufs: optionList(info, 'UnetLoaderGGUF', 'unet_name'),
    vaes: optionList(info, 'VAELoader', 'vae_name'),
    clips: [
      ...new Set([
        ...optionList(info, 'CLIPLoader', 'clip_name'),
        ...optionList(info, 'DualCLIPLoader', 'clip_name1'),
      ]),
    ],
    loras: optionList(info, 'LoraLoader', 'lora_name'),
    samplers: optionList(info, 'KSampler', 'sampler_name'),
    schedulers: optionList(info, 'KSampler', 'scheduler'),
  };
}

/**
 * ST 轉發 /models 的條目是 {value: 原始檔名, text: 展示名};
 * UNet/GGUF 靠 text 字首區分("UNet: xxx"/"GGUF: xxx"),其餘是 checkpoint。
 */
function classifyServerModels(data: unknown): Pick<ComfyModelLists, 'checkpoints' | 'unets' | 'ggufs'> {
  const result = { checkpoints: [] as string[], unets: [] as string[], ggufs: [] as string[] };
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    if (!isObject(item) || typeof item.value !== 'string') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.startsWith('UNet: ')) result.unets.push(item.value);
    else if (text.startsWith('GGUF: ')) result.ggufs.push(item.value);
    else result.checkpoints.push(item.value);
  }
  return result;
}

function stringArray(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `：${text.slice(0, 300)}` : ''}`, response.status);
}

async function fetchViaBrowser(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const response = await fetch(endpoint(url, 'object_info'), { signal });
  if (!response.ok) throw await responseError(response, '讀取 ComfyUI 模型列表失敗');
  const info = (await response.json()) as JsonObject;
  if (!isObject(info)) throw new ComfyUIError('ComfyUI 返回的 object_info 格式異常');
  return { ...parseObjectInfo(info), mode: 'browser', fetchedAt: Date.now() };
}

async function fetchViaServer(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');
  const post = async (path: string): Promise<unknown> => {
    const response = await fetch(`${SERVER_BASE}/${path}`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({ url: url.trim() }),
      signal,
    });
    if (!response.ok) throw await responseError(response, 'ST 後端讀取 ComfyUI 模型列表失敗');
    return response.json();
  };
  const [models, samplers, schedulers, vaes] = await Promise.all([
    post('models'),
    post('samplers'),
    post('schedulers'),
    post('vaes'),
  ]);
  return {
    ...classifyServerModels(models),
    vaes: stringArray(vaes),
    clips: [],
    loras: [],
    samplers: stringArray(samplers),
    schedulers: stringArray(schedulers),
    mode: 'server',
    fetchedAt: Date.now(),
  };
}

const cache = new Map<string, ComfyModelLists>();

/** 拉取列表;同 url 命中快取直接返回,force 強制重拉(「重新整理」按鈕)。 */
export async function fetchComfyModelLists(
  url: string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<ComfyModelLists> {
  const key = url.trim();
  if (!key) throw new ComfyUIError('請先填寫 ComfyUI 服務地址');
  if (!options?.force && cache.has(key)) return cache.get(key)!;

  let lists: ComfyModelLists;
  try {
    lists = await fetchViaBrowser(key, options?.signal);
  } catch (error) {
    // 與出圖同口徑:僅網路級失敗回退;HTTP 錯誤是服務端真實反饋,轉發過去結果一樣
    if (!isNetworkError(error)) throw error;
    lists = await fetchViaServer(key, options?.signal);
  }
  cache.set(key, lists);
  return lists;
}

/** 測試用:清空快取。 */
export function clearComfyModelListsCache(): void {
  cache.clear();
}
