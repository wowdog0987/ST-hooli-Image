import { buildSimpleWorkflow } from '@/backends/comfyTemplates';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';
import { type ComfyRunConn } from '@/state/settings';

type JsonObject = Record<string, unknown>;
export type ComfyWorkflow = Record<string, JsonObject>;

export interface ComfyTemplateValues {
  prompt: string;
  negative_prompt?: string;
  seed?: number;
  /** 自然語言部分;僅寫入顯式含 %nl% 的工作流,不自動拼進 %prompt%。 */
  nl?: string;
  /** 畫面寬高;僅寫入顯式含 %width%/%height% 的工作流,預設時工作流裡寫死的尺寸原樣生效。 */
  width?: number;
  height?: number;
  /** 畫幅方向;generateComfyImage 據此從渠道配置解析出 width/height。 */
  size?: Orientation;
}

export interface ComfyImageResult {
  url: string;
  filename: string;
  format: string;
  /** 瀏覽器直連使用 object URL 時釋放資源；data URL 無需釋放。 */
  revoke(): void;
}

const SUPPORTED_PLACEHOLDERS = new Set(['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height']);
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;
const SERVER_BASE = '/api/sd/comfy';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 生成隨機種子（0 ≤ seed < 2^53，與 Python random.randint(0, 2**53 - 1) 同範圍）。
 * 必須在發起生成時就生成並顯式傳值：部分節點（如部分取樣器包裝）不接受 -1 自動隨機。
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 53);
}

export class ComfyUIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析並做最低限度的 API 工作流結構校驗。 */
export function parseWorkflowTemplate(template: string): ComfyWorkflow {
  if (!template.trim()) throw new ComfyUIError('請先貼上 ComfyUI API 格式工作流');

  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 常見筆誤：佔位符寫成了裸值（seed: %seed%），JSON 裡必須是字串（"%seed%"）
    const hint = detail.includes('%')
      ? '；佔位符必須寫成字串形式，如 "seed": "%seed%"（帶引號）'
      : '';
    throw new ComfyUIError(`工作流 JSON 格式錯誤：${detail}${hint}`);
  }

  if (!isObject(parsed) || Object.keys(parsed).length === 0) {
    throw new ComfyUIError('工作流必須是非空的 JSON 物件');
  }

  const hasApiNode = Object.values(parsed).some(
    node => isObject(node) && typeof node.class_type === 'string' && isObject(node.inputs),
  );
  if (!hasApiNode) {
    throw new ComfyUIError('未找到 API 格式節點，請在 ComfyUI 中使用「Save (API Format)」匯出');
  }

  return parsed as ComfyWorkflow;
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPlaceholders(item, found));
    return;
  }
  if (isObject(value)) Object.values(value).forEach(item => collectPlaceholders(item, found));
}

export function getWorkflowPlaceholders(template: string): string[] {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);
  return [...found].sort();
}

function replacePlaceholders(value: unknown, replacements: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^%([a-z][a-z0-9_]*)%$/);
    if (exact && Object.hasOwn(replacements, exact[1])) return replacements[exact[1]];

    return value.replace(PLACEHOLDER_PATTERN, (marker, name: string) =>
      Object.hasOwn(replacements, name) ? String(replacements[name]) : marker,
    );
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, replacements));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, replacements)]));
  }
  return value;
}

/**
 * 把模板渲染成可提交工作流。先解析後遞迴替換，提示詞中的引號和換行不會破壞 JSON；
 * 精確等於 %seed% / %width% / %height% 的字串會被替換為數值，而不是字串
 * （EmptyLatentImage 的 width/height 必須是數字）。
 *
 * 畫幅是 opt-in 的：工作流沒寫 %width%/%height% 時完全不受影響，尺寸仍由工作流自己決定；
 * 寫了卻拿不到有效尺寸才報錯，提示去面板補配置——靜默按預設值出圖會讓使用者以為設定生效了。
 */
export function renderWorkflowTemplate(template: string, values: ComfyTemplateValues): ComfyWorkflow {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);

  const unsupported = [...found].filter(name => !SUPPORTED_PLACEHOLDERS.has(name));
  if (unsupported.length) throw new ComfyUIError(`工作流含暫不支援的佔位符：${unsupported.map(x => `%${x}%`).join('、')}`);
  if (!found.has('prompt')) throw new ComfyUIError('工作流中缺少 %prompt% 佔位符');

  const needsSize = found.has('width') || found.has('height');
  if (needsSize && !(values.width && values.height)) {
    throw new ComfyUIError('工作流用到了 %width%/%height%，請先在 ComfyUI 渠道頁填寫豎屏與橫屏尺寸（如 832×1216）');
  }

  const seed = values.seed ?? randomSeed();
  return replacePlaceholders(workflow, {
    prompt: values.prompt,
    negative_prompt: values.negative_prompt ?? '',
    nl: values.nl ?? '',
    width: values.width ?? 0,
    height: values.height ?? 0,
    seed,
  }) as ComfyWorkflow;
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `：${text.slice(0, 500)}` : ''}`, response.status);
}

/**
 * 請求通道自動選擇。策略:
 * 1. 瀏覽器直連優先(延遲最低,不佔 ST 服務端);
 * 2. 僅當請求「根本沒送達後端」的網路級失敗(fetch TypeError:CORS 攔截/拒連/斷網)時,
 *    回退到 ST 後端轉發;
 * 3. HTTP 狀態錯誤是服務端真實反饋,不重試——轉發過去結果一樣;
 * 4. 使用者主動取消(AbortError)一律直接丟擲。
 * 兩個通道都通時「優先瀏覽器直連」天然成立:直連成功就不試轉發,無需探測、無快取過期問題。
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

function requireContext() {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');
  return context;
}

export interface ComfyTestResult {
  /** 實際打通的通道:browser=瀏覽器直連;server=ST 後端轉發 */
  mode: 'browser' | 'server';
}

export async function testComfyConnection(conn: ComfyRunConn, signal?: AbortSignal): Promise<ComfyTestResult> {
  if (!conn.url.trim()) throw new ComfyUIError('請先填寫 ComfyUI 服務地址');

  // 瀏覽器直連優先;僅網路級失敗(CORS/拒連)才回退 ST 後端轉發
  try {
    const response = await fetch(endpoint(conn.url, 'system_stats'), { signal });
    if (!response.ok) throw await responseError(response, '瀏覽器連線 ComfyUI 失敗');
    return { mode: 'browser' };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
  }

  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/ping`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({ url: conn.url.trim() }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ST 後端連線 ComfyUI 失敗');
  return { mode: 'server' };
}

interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

function findOutputFile(item: unknown): ComfyOutputFile | null {
  if (!isObject(item) || !isObject(item.outputs)) return null;
  for (const output of Object.values(item.outputs)) {
    if (!isObject(output)) continue;
    for (const key of ['images', 'gifs']) {
      const files = output[key];
      if (!Array.isArray(files)) continue;
      const file = files.find(x => isObject(x) && typeof x.filename === 'string');
      if (file) return file as unknown as ComfyOutputFile;
    }
  }
  return null;
}

function executionError(item: unknown): string | null {
  if (!isObject(item) || !isObject(item.status)) return null;
  if (item.status.status_str !== 'error') return null;
  const messages = item.status.messages;
  if (!Array.isArray(messages)) return 'ComfyUI 工作流執行失敗';

  const details = messages
    .filter(message => Array.isArray(message) && message[0] === 'execution_error' && isObject(message[1]))
    .map(message => {
      const data = message[1] as JsonObject;
      return `${String(data.node_type ?? '節點')} [${String(data.node_id ?? '?')}]：${String(data.exception_message ?? data.exception_type ?? '執行失敗')}`;
    });
  return details.length ? details.join('\n') : 'ComfyUI 工作流執行失敗';
}

function executionCompleted(item: unknown): boolean {
  return isObject(item) && isObject(item.status) && item.status.completed === true;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fileFormat(filename: string, mime = ''): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && /^[a-z0-9]+$/.test(extension)) return extension;
  return mime.split('/').pop()?.toLowerCase() || 'png';
}

async function generateViaServer(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<ComfyImageResult> {
  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/generate`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
      url: conn.url.trim(),
      prompt: JSON.stringify({ prompt: workflow }),
    }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ComfyUI 生圖失敗');

  const data = (await response.json()) as { format?: unknown; data?: unknown };
  if (typeof data.data !== 'string' || !data.data) throw new ComfyUIError('ST 後端未返回圖片資料');
  const format = typeof data.format === 'string' && data.format ? data.format.toLowerCase() : 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${data.data}`,
    filename: `comfy-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

async function queueDirect(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<string> {
  const queued = await fetch(endpoint(conn.url, 'prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!queued.ok) throw await responseError(queued, 'ComfyUI 拒絕了工作流');
  const queuedData = (await queued.json()) as { prompt_id?: unknown; node_errors?: unknown };
  if (typeof queuedData.prompt_id !== 'string' || !queuedData.prompt_id) {
    throw new ComfyUIError(`ComfyUI 未返回 prompt_id${queuedData.node_errors ? `：${JSON.stringify(queuedData.node_errors).slice(0, 500)}` : ''}`);
  }
  return queuedData.prompt_id;
}

/** GET /queue 的條目形如 [number, prompt_id, prompt, extra_data, outputs_to_execute]。 */
type QueueEntry = [number, string, ...unknown[]];

interface QueuePosition {
  /** 任務正在執行。 */
  running: boolean;
  /** 前面還有幾個任務;running 時為 0;任務已不在佇列(執行完/被刪)為 null。 */
  ahead: number | null;
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return Array.isArray(value) && typeof value[1] === 'string';
}

/**
 * 查任務在 ComfyUI 服務端佇列裡的位置。
 * 取不到/解析不了一律返回 null——排隊位置只是展示資訊,不值得中斷出圖(降級優先)。
 *
 * 「前面幾個」按優先順序序號(條目 index 0)比較,不用陣列下標:
 * queue_pending 是堆結構的原始快照,列表順序不等於執行順序。
 */
async function fetchQueuePosition(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
): Promise<QueuePosition | null> {
  try {
    const response = await fetch(endpoint(conn.url, 'queue'), { signal });
    if (!response.ok) return null;
    const data = (await response.json()) as JsonObject;
    // 兩個鍵都必須是陣列才算有效快照(空陣列 = 佇列真的空了,是有效資訊)。
    // 形狀不對 = 響應不可信,按「位置未知」處理——不能當成「任務已結束」,
    // 否則取消時會只發 delete,漏掉對正在跑的任務的中斷。
    if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) return null;
    const running = data.queue_running.filter(isQueueEntry);
    const pending = data.queue_pending.filter(isQueueEntry);

    if (running.some(entry => entry[1] === promptId)) return { running: true, ahead: 0 };
    const mine = pending.find(entry => entry[1] === promptId);
    if (!mine) return { running: false, ahead: null };
    // 正在執行的那個也算在前面
    const ahead = pending.filter(entry => entry[0] < mine[0]).length + running.length;
    return { running: false, ahead };
  } catch {
    return null;
  }
}

/**
 * 取消一個已入隊的任務。
 *
 * 必須分情況——ComfyUI 的兩個介面各管一段,用錯了會取消到別人:
 * - 任務還在排隊 → POST /queue {delete:[id]} 把它摘出佇列;`/interrupt` 對它無效。
 * - 任務正在執行 → POST /interrupt 中斷,並帶上 prompt_id。
 * - 佇列位置查不到(介面 502/解析失敗,position=null):**兩條都發**。
 *   delete 摘不到是無害空操作;interrupt 帶 prompt_id,新版據此校驗,只有確實在跑的
 *   才會被中斷。若只發 delete,「正在跑但查不到位置」會漏中斷、白燒 GPU 到跑完。
 *
 * 反過來若不查佇列就無腦 /interrupt:併發出圖時取消排在後面的任務,
 * 打斷的會是正在跑的**別的**任務(舊版無視 body 裡的 prompt_id,必現)。
 *
 * 殘留競態(已知、可接受):查佇列與發 interrupt 之間有一個往返,期間我們的任務可能剛跑完、
 * 下一個剛開始——此時舊版 ComfyUI(無視 prompt_id)會誤傷下一個任務。
 * 帶上 prompt_id 讓新版免疫;舊版無法從客戶端根治(沒有「按 id 中斷」的介面),
 * 故只在確認自己在跑時才發 interrupt,把視窗壓到最小。
 */
async function cancelPrompt(conn: ComfyRunConn, promptId: string): Promise<void> {
  // 此處不傳 signal:呼叫方的 signal 正是「已取消」本身,帶上會讓清理請求當場夭折。
  const position = await fetchQueuePosition(conn, promptId);
  const post = (path: string, body: JsonObject) =>
    fetch(endpoint(conn.url, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    if (position?.running) {
      await post('interrupt', { prompt_id: promptId });
      return;
    }
    if (position) {
      // 位置已確認:在排隊(ahead>=0)或已結束(ahead=null),都只需摘佇列
      await post('queue', { delete: [promptId] });
      return;
    }
    // 位置未知:兩條都發,誰生效算誰
    await Promise.allSettled([
      post('queue', { delete: [promptId] }),
      post('interrupt', { prompt_id: promptId }),
    ]);
  } catch {
    /* 取消是盡力而為:網路失敗就讓它跑完,結果沒人接收 */
  }
}

export interface ComfyProgressHooks {
  /** 排隊位置變化:0=已在執行,n>0=前面還有 n 個,null=未知。 */
  onQueue?(ahead: number | null): void;
}

async function pollDirectResult(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  const onAbort = () => {
    void cancelPrompt(conn, promptId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const startedAt = Date.now();
    let file: ComfyOutputFile | null = null;
    // 一旦觀察到自己在執行就不再查佇列:位置資訊已無意義,省掉每輪一次請求
    let watchQueue = !!hooks?.onQueue;
    while (!file) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new ComfyUIError('等待 ComfyUI 結果超時（10 分鐘）');
      const historyResponse = await fetch(endpoint(conn.url, `history/${encodeURIComponent(promptId)}`), { signal });
      if (!historyResponse.ok) throw await responseError(historyResponse, '讀取 ComfyUI 任務狀態失敗');
      const history = (await historyResponse.json()) as JsonObject;
      const item = history[promptId];
      const error = executionError(item);
      if (error) throw new ComfyUIError(error);
      file = findOutputFile(item);
      if (!file && executionCompleted(item)) {
        throw new ComfyUIError('工作流已執行完成，但沒有找到圖片輸出；請確認工作流包含 SaveImage 或 PreviewImage 節點');
      }
      if (file) break;
      if (watchQueue) {
        const position = await fetchQueuePosition(conn, promptId, signal);
        hooks?.onQueue?.(position?.ahead ?? null);
        if (position?.running || position?.ahead === null) watchQueue = false;
      }
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }

    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    const imageResponse = await fetch(`${endpoint(conn.url, 'view')}?${query}`, { signal });
    if (!imageResponse.ok) throw await responseError(imageResponse, '讀取 ComfyUI 輸出圖片失敗');
    const blob = await imageResponse.blob();
    const url = URL.createObjectURL(blob);
    return {
      url,
      filename: file.filename,
      format: fileFormat(file.filename, blob.type),
      revoke: () => URL.revokeObjectURL(url),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function generateComfyImage(
  conn: ComfyRunConn,
  values: ComfyTemplateValues,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  if (!conn.url.trim()) throw new ComfyUIError('請先填寫 ComfyUI 服務地址');
  if (!values.prompt.trim()) throw new ComfyUIError('正向提示詞不能為空');
  // 按方向取渠道配置裡的尺寸;解析不出就傳空,由 renderWorkflowTemplate 決定是報錯還是無視
  // (工作流沒用 %width%/%height% 時,尺寸配錯了也不該妨礙出圖)
  const size = values.width && values.height
    ? { width: values.width, height: values.height }
    : parseSize(pickSize(conn, values.size ?? 'portrait'));
  // 兩模式互斥的分叉點:simple 由模板組裝(無佔位符),custom 走宏渲染。
  // 匯合點即「拿到可提交 JSON」,之後的排隊/輪詢/取消完全共用。
  let workflow: ComfyWorkflow;
  if (conn.mode === 'simple') {
    try {
      workflow = buildSimpleWorkflow(conn.simple, {
        prompt: values.prompt,
        nl: values.nl,
        negative: values.negative_prompt,
        seed: values.seed ?? randomSeed(),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      });
    } catch (error) {
      throw new ComfyUIError(error instanceof Error ? error.message : String(error));
    }
  } else {
    workflow = renderWorkflowTemplate(conn.workflow, { ...values, ...size });
  }

  // 通道自動選擇:瀏覽器直連優先;僅當請求根本沒送達 ComfyUI(網路級失敗)時回退 ST 後端轉發。
  // 回退只發生在「排隊」之前——拿到 prompt_id 後任務已入隊,輪詢階段的任何失敗都不重發,避免重複生圖。
  let queued = false;
  try {
    const promptId = await queueDirect(conn, workflow, signal);
    queued = true;
    return await pollDirectResult(conn, promptId, signal, hooks);
  } catch (error) {
    if (queued || signal?.aborted || !isNetworkError(error)) throw error;
    return generateViaServer(conn, workflow, signal);
  }
}
