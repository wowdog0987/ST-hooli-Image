import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  getWorkflowPlaceholders,
  parseWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';
import { getTagGenChannel } from '@/state/settings';

export type WorkflowBindingPurpose =
  | 'positive_tag'
  | 'positive_nl'
  | 'positive_combined'
  | 'negative'
  | 'seed'
  | 'width'
  | 'height';

export interface WorkflowBinding {
  node: string;
  input: string;
  purpose: WorkflowBindingPurpose;
  /** 需要跨每張圖保留的原提示詞片段編號；文本由外掛按編號讀取，AI不複製原文。 */
  keep?: string[];
}

export interface WorkflowChange extends WorkflowBinding {
  before: string | number;
  after: string;
}

export interface WorkflowAssistResult {
  workflow: string;
  changes: WorkflowChange[];
  nlMode: 'none' | 'separate' | 'combined';
  hasNegative: boolean;
}

const PURPOSES = new Set<WorkflowBindingPurpose>([
  'positive_tag',
  'positive_nl',
  'positive_combined',
  'negative',
  'seed',
  'width',
  'height',
]);

const SYSTEM_PROMPT = `你是 ComfyUI API 格式工作流的動態引數定位器。你只負責判斷現有節點的哪個 inputs 欄位承擔什麼用途，不得重寫工作流。

只返回一個 JSON 物件，不要 Markdown、解釋或思維過程：
{"bindings":[{"node":"6","input":"text","purpose":"positive_combined","keep":["F1","F2"]}]}

purpose 只能是：
- positive_tag：正向 danbooru/tag 提示詞輸入。
- positive_nl：與 tag 分開的自然語言正向輸入。
- positive_combined：同一個文本輸入同時接收 tag 與自然語言；原值同時包含逗號 tag 和完整句子，或該模型用同一編碼器接收兩者時選擇此項。
- negative：負面提示詞輸入。
- seed：主生成鏈使用的隨機種子。
- width / height：主生成畫布或初始 latent 的寬高。

規則：
1. node 和 input 必須逐字對應工作流中真實存在的節點 ID 與 inputs 鍵。
2. 只選擇值為字串或數字的可編輯輸入，不得選擇形如 ["節點ID", 輸出序號] 的連線陣列。
3. 同一輸入只能選擇一個 purpose；tag 與自然語言共用時必須選 positive_combined。
4. 可以返回多個同用途輸入，例如雙編碼器、多個同步 seed。
5. 不要選擇模型名、LoRA、取樣步數、CFG、取樣器、排程器、放大/裁剪/預覽尺寸。
6. width/height 只標記主生成尺寸，不標記後期放大、裁剪或輸出尺寸。
7. 文本輸入會提供 fragments。keep 只能填寫該輸入中需要跨所有圖片永久保留的片段 ID：
   - 正向保留質量詞、模型/LoRA觸發詞、固定風格詞、固定評級詞。
   - 正向刪除匯出示例裡的角色數量、人物外貌、服裝、動作、場景、構圖、光線和自然語言畫面描述。
   - 同一風格已由簡短觸發詞表達時，不再保留自然語言中的重複風格句。
   - 負向保留通用質量、解剖、偽影和固定風格排除詞；刪除只針對匯出示例人物或場景的臨時排除詞。
   - 不得複製片段文本，只返回 ID；沒有固定片段就返回空陣列。seed/width/height 的 keep 必須為空陣列。
8. 至少必須找到一個 positive_tag 或 positive_combined。無法可靠確認的輸入不要猜。`;

interface PromptFragment {
  id: string;
  text: string;
}

const KNOWN_PLACEHOLDER_PATTERN = /%(?:prompt|negative_prompt|seed|nl|width|height)%/g;

function promptFragments(value: string): PromptFragment[] {
  return value
    .replace(KNOWN_PLACEHOLDER_PATTERN, '')
    .split(/[,，;；\r\n]+/)
    .map(text => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `F${index + 1}`, text }));
}

function workflowAnalysisPayload(workflow: ComfyWorkflow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(workflow).map(([nodeId, node]) => {
      const inputs =
        node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
          ? Object.fromEntries(
              Object.entries(node.inputs as Record<string, unknown>).map(([input, value]) => [
                input,
                typeof value === 'string'
                  ? { kind: 'text', fragments: promptFragments(value) }
                  : value,
              ]),
            )
          : node.inputs;
      return [
        nodeId,
        {
          class_type: node.class_type,
          title:
            node._meta && typeof node._meta === 'object' && !Array.isArray(node._meta)
              ? (node._meta as Record<string, unknown>).title
              : undefined,
          inputs,
        },
      ];
    }),
  );
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates = [cleaned];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

export function parseWorkflowBindings(raw: string): WorkflowBinding[] {
  let parsed: unknown;
  for (const candidate of jsonObjects(raw)) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // 嘗試下一個 JSON 候選。
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 沒有返回可解析的工作流定位 JSON');
  }
  const bindings = (parsed as Record<string, unknown>).bindings;
  if (!Array.isArray(bindings)) throw new Error('AI 返回結果缺少 bindings 陣列');

  const byPath = new Map<string, WorkflowBinding>();
  for (const item of bindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const node = typeof value.node === 'string' ? value.node.trim() : '';
    const input = typeof value.input === 'string' ? value.input.trim() : '';
    const purpose = typeof value.purpose === 'string' ? value.purpose.trim() : '';
    const keep = Array.isArray(value.keep)
      ? value.keep
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim().toUpperCase())
          .filter(id => /^F\d+$/.test(id))
      : [];
    if (!node || !input || !PURPOSES.has(purpose as WorkflowBindingPurpose)) continue;
    const next = { node, input, purpose: purpose as WorkflowBindingPurpose, keep: [...new Set(keep)] };
    const key = `${node}\u0000${input}`;
    const previous = byPath.get(key);
    if (!previous || previous.purpose === next.purpose) {
      byPath.set(key, next);
      continue;
    }
    const positivePair = new Set([previous.purpose, next.purpose]);
    if (
      positivePair.has('positive_combined') ||
      (positivePair.has('positive_tag') && positivePair.has('positive_nl'))
    ) {
      byPath.set(key, {
        node,
        input,
        purpose: 'positive_combined',
        keep: [...new Set([...(previous.keep ?? []), ...(next.keep ?? [])])],
      });
      continue;
    }
    throw new Error(`AI 為節點 ${node}.${input} 返回了互相沖突的用途`);
  }
  return [...byPath.values()];
}

function appendComma(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed.replace(/[\s,，]+$/, '')}, ${marker}`;
}

function appendLine(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed}\n${marker}`;
}

function fixedText(value: string, keep: string[], binding: WorkflowBinding): string {
  const fragments = promptFragments(value);
  const available = new Map(fragments.map(fragment => [fragment.id, fragment.text]));
  const unknown = keep.filter(id => !available.has(id));
  if (unknown.length) {
    throw new Error(`AI 為節點 ${binding.node}.${binding.input} 返回了不存在的片段：${unknown.join('、')}`);
  }
  return fragments
    .filter(fragment => keep.includes(fragment.id))
    .map(fragment => fragment.text)
    .join(', ');
}

function renderTextBinding(value: string, binding: WorkflowBinding): string {
  const base = fixedText(value, binding.keep ?? [], binding);
  if (binding.purpose === 'positive_tag') return appendComma(base, '%prompt%');
  if (binding.purpose === 'positive_nl') return appendLine(base, '%nl%');
  if (binding.purpose === 'positive_combined') {
    return appendLine(appendComma(base, '%prompt%'), '%nl%');
  }
  if (binding.purpose === 'negative') return appendComma(base, '%negative_prompt%');
  return `%${binding.purpose}%`;
}

function editableInput(workflow: ComfyWorkflow, binding: WorkflowBinding): string | number {
  const node = workflow[binding.node];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`AI 返回的節點 ${binding.node} 不存在`);
  }
  const inputs = node.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error(`節點 ${binding.node} 沒有可編輯的 inputs`);
  }
  if (!Object.hasOwn(inputs, binding.input)) {
    throw new Error(`節點 ${binding.node} 不存在輸入 ${binding.input}`);
  }
  const value = (inputs as Record<string, unknown>)[binding.input];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`節點 ${binding.node}.${binding.input} 不是可直接替換的文本或數字輸入`);
  }
  return value;
}

export function applyWorkflowBindings(template: string, bindings: WorkflowBinding[]): WorkflowAssistResult {
  const workflow = parseWorkflowTemplate(template);
  const changes: WorkflowChange[] = [];
  let hasPositive = false;
  let nlMode: WorkflowAssistResult['nlMode'] = 'none';
  let hasNegative = false;

  for (const binding of bindings) {
    const before = editableInput(workflow, binding);
    if (binding.purpose === 'positive_tag' || binding.purpose === 'positive_combined') hasPositive = true;
    if (binding.purpose === 'positive_nl' && nlMode === 'none') nlMode = 'separate';
    if (binding.purpose === 'positive_combined') nlMode = 'combined';
    if (binding.purpose === 'negative') hasNegative = true;

    const after =
      binding.purpose === 'seed' || binding.purpose === 'width' || binding.purpose === 'height'
        ? `%${binding.purpose}%`
        : renderTextBinding(String(before), binding);
    const inputs = workflow[binding.node].inputs as Record<string, unknown>;
    inputs[binding.input] = after;
    if (String(before) !== after) changes.push({ ...binding, before, after });
  }

  if (!hasPositive && !getWorkflowPlaceholders(template).includes('prompt')) {
    throw new Error('AI 沒有找到正向提示詞輸入');
  }
  const rendered = JSON.stringify(workflow, null, 2);
  if (!getWorkflowPlaceholders(rendered).includes('prompt')) {
    throw new Error('自動配置後的工作流仍缺少 %prompt%');
  }
  return { workflow: rendered, changes, nlMode, hasNegative };
}

export async function configureWorkflowWithAi(
  template: string,
  signal?: AbortSignal,
): Promise<WorkflowAssistResult> {
  const workflow = parseWorkflowTemplate(template);
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `請定位以下 ComfyUI API 工作流的動態輸入。文本值已拆成片段編號：\n${JSON.stringify(workflowAnalysisPayload(workflow))}`,
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: 'ComfyUI 工作流配置' })
    : await requestViaMainApi(messages, { signal, source: 'ComfyUI 工作流配置' });
  return applyWorkflowBindings(template, parseWorkflowBindings(raw));
}
