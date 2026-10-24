<script setup lang="ts">
import {
  COMFY_TEMPLATE_OPTIONS,
  COMFY_TEMPLATES,
  familyWantsNl,
  isComfyTemplateId,
  simpleDefaults,
  validateSimpleConfig,
  type ComfyPresetMode,
} from '@/backends/comfyTemplates';
import {
  FALLBACK_SAMPLERS,
  FALLBACK_SCHEDULERS,
  fetchComfyModelLists,
  type ComfyModelLists,
} from '@/backends/comfyObjectInfo';
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import {
  configureWorkflowWithAi,
  type WorkflowAssistResult,
  type WorkflowBindingPurpose,
} from '@/backends/comfyWorkflowAssistant';
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  activeComfyPreset,
  effectiveComfyConn,
  newComfyWorkflow,
  settings,
} from '@/state/settings';
import { backendStatus } from '@/generate';
import { computed, nextTick, ref, watch } from 'vue';

const testing = ref(false);
const configuring = ref(false);
const assistOpen = ref(false);
const assistDraft = ref('');
const assistResult = ref<WorkflowAssistResult | null>(null);
/** AI 預覽針對哪一套:預覽期間使用者可能切走或刪掉,應用時按 id 回寫而不是寫「當前」。 */
const assistTargetId = ref('');
const confirmDeleteOpen = ref(false);

/** 還沒設定好(或還沒選它出圖)時,新手設定步驟預設展開。 */
const needsSetup = settings.defaultBackend !== 'comfyui' || !backendStatus().configured;

/** 本渠道是否為當前出圖渠道;「使用此渠道」按鈕與設定頁選擇器、頁籤徽標同屬一個開關。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

/* ============ 工作流庫 ============ */

/** 當前預設。settings 是 reactive,直接把它的欄位綁 v-model 即可就地編輯。 */
const active = computed(() => activeComfyPreset());

const workflowOptions = computed(() =>
  settings.comfyui.workflows.map(w => ({ value: w.id, label: w.name || '未命名工作流' })),
);

/**
 * 下拉的值取「實際生效的那一套」而非存的 id:存的 id 懸空時
 * activeComfyPreset 會回落第一條,下拉也該跟著顯示第一條,不能顯示空白。
 */
const activeId = computed<string>({
  get: () => active.value.id,
  set: id => {
    settings.comfyui.activeWorkflowId = id;
  },
});

/** 只剩一套時不給刪:workflows 恆非空是全域性不變式,停用比「點了沒反應」誠實。 */
const canRemove = computed(() => settings.comfyui.workflows.length > 1);

function switchTo(preset: { id: string }) {
  settings.comfyui.activeWorkflowId = preset.id;
}

/** 改名是低頻操作:平時只顯示下拉,點「改名」才把選擇器原地換成輸入框,省掉常駐的名稱行。 */
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename() {
  renameDraft.value = active.value.name;
  renaming.value = true;
  nextTick(() => renameInput.value?.focus());
}

/** Enter / 失焦都算確認;Esc 直接置 renaming=false 不經過這裡,即為取消。 */
function commitRename() {
  if (renaming.value) active.value.name = renameDraft.value.trim();
  renaming.value = false;
}

function addWorkflow() {
  const preset = newComfyWorkflow(`工作流 ${settings.comfyui.workflows.length + 1}`);
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}

function duplicateWorkflow() {
  // 拷全部欄位(JSON/開關/尺寸一起複製),只換 id 與名字;id 生成仍由 settings 統一口徑。
  // simple 是巢狀物件(含 loras 陣列),必須深拷——淺拷會讓兩套預設共享同一份引數。
  const preset = {
    ...active.value,
    id: newComfyWorkflow().id,
    name: `${active.value.name} 副本`,
    simple: {
      ...active.value.simple,
      loras: active.value.simple.loras.map(lora => ({ ...lora })),
    },
  };
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}

function confirmRemoveWorkflow() {
  confirmDeleteOpen.value = false;
  const list = settings.comfyui.workflows;
  if (list.length <= 1) return;
  const index = list.findIndex(w => w.id === active.value.id);
  if (index < 0) return;
  list.splice(index, 1);
  // 刪掉的是當前項:接位到原位置那一條(已是最後一條則退一格)
  settings.comfyui.activeWorkflowId = list[Math.min(index, list.length - 1)].id;
}

/* ============ 簡易模式:選模型填引數 ============ */

// 分段開關文案要短(括注會讓小藥丸擠變形),含義靠下方的表單本身說明;
// 順序:預設項 custom 在左(與「存量預設/新預設都是自定義工作流」的口徑一致)
const modeOptions: Array<{ value: ComfyPresetMode; label: string }> = [
  { value: 'custom', label: '自定義工作流' },
  { value: 'simple', label: '簡易引數' },
];

const templateOptions = COMFY_TEMPLATE_OPTIONS;

/** 當前模板的後設資料(決定表單顯示哪些欄位)。 */
const meta = computed(() => COMFY_TEMPLATES[active.value.simple.template] ?? COMFY_TEMPLATES.checkpoint);

const lists = ref<ComfyModelLists | null>(null);
const fetching = ref(false);
const fetchError = ref('');

async function onFetchModels(silent = false) {
  if (fetching.value) return;
  fetching.value = true;
  fetchError.value = '';
  try {
    lists.value = await fetchComfyModelLists(settings.comfyui.url, { force: !!lists.value });
    if (!silent) {
      toastr.success(
        lists.value.mode === 'server'
          ? '已拉取模型列表(ST 轉發;LoRA/CLIP 需手輸檔名)'
          : '已拉取模型列表',
        '虎哩繪',
      );
    }
  } catch (error) {
    fetchError.value = errorMessage(error);
    if (!silent) toastr.error(fetchError.value, '拉取模型列表失敗');
  } finally {
    fetching.value = false;
  }
}

// 進入簡易模式且手上沒有列表時自動拉一次(靜默,失敗只在狀態行留原因)
watch(
  () => [active.value.id, active.value.mode] as const,
  () => {
    if (active.value.mode === 'simple' && !lists.value && !fetching.value && settings.comfyui.url.trim()) {
      void onFetchModels(true);
    }
  },
  { immediate: true },
);

// 狀態行只在「有話要說」時出現:直連拉成功是常態,靜默(候選已進 datalist);
// 轉發模式要提醒 LoRA/CLIP 拿不到;失敗要留原因。手動點按鈕的正反饋由 toastr 負責。
const fetchStatus = computed(() => {
  if (fetchError.value) return `拉取失敗:${fetchError.value}`;
  if (!lists.value || lists.value.mode === 'browser') return '';
  return 'ST 轉發拿不到 LoRA/CLIP 列表,這兩項需手輸(ComfyUI 加 --enable-cors-header 可直連)';
});

const modelOptions = computed(() => {
  if (!lists.value) return [];
  return meta.value.modelKind === 'checkpoint'
    ? lists.value.checkpoints
    : [...lists.value.unets, ...lists.value.ggufs];
});
const vaeOptions = computed(() => lists.value?.vaes ?? []);
const clipOptions = computed(() => lists.value?.clips ?? []);
const loraOptions = computed(() => lists.value?.loras ?? []);
const samplerOptions = computed(() =>
  lists.value?.samplers.length ? lists.value.samplers : FALLBACK_SAMPLERS,
);
const schedulerOptions = computed(() =>
  lists.value?.schedulers.length ? lists.value.schedulers : FALLBACK_SCHEDULERS,
);

// 選了列表裡的 GGUF 檔案自動勾選 GGUF;選回普通 unet 自動取消(手輸的名字不動開關)
watch(
  () => active.value.simple.model,
  name => {
    if (!lists.value || meta.value.modelKind !== 'unet') return;
    if (lists.value.ggufs.includes(name)) active.value.simple.gguf = true;
    else if (lists.value.unets.includes(name)) active.value.simple.gguf = false;
  },
);

/**
 * 切架構模板:取樣引數換成新模板推薦值,模型/VAE/CLIP 清空(列表不同源),
 * LoRA 與固定正負詞保留(與架構無關)。尺寸若還是舊模板預設值則跟著換,
 * 使用者自己改過的尺寸不動。
 */
function onTemplateChange(id: string) {
  if (!isComfyTemplateId(id)) return;
  const current = active.value.simple;
  if (current.template === id) return;
  const prevMeta = COMFY_TEMPLATES[current.template];
  const nextMeta = COMFY_TEMPLATES[id];
  if (active.value.portraitSize === prevMeta.portraitSize) active.value.portraitSize = nextMeta.portraitSize;
  if (active.value.landscapeSize === prevMeta.landscapeSize) active.value.landscapeSize = nextMeta.landscapeSize;
  active.value.simple = {
    ...simpleDefaults(id),
    loras: current.loras,
    positive: current.positive,
    negative: current.negative,
  };
  active.value.naturalLanguage = familyWantsNl(id);
}

/** 自訂工作流的模型類型:跟簡易模式的模板同一套,一樣帶動自然語言開關。 */
function onFamilyChange(id: string) {
  if (!isComfyTemplateId(id) || active.value.family === id) return;
  active.value.family = id;
  active.value.naturalLanguage = familyWantsNl(id);
}

function addLora() {
  active.value.simple.loras.push({ name: '', strength: 1 });
}

function removeLora(index: number) {
  active.value.simple.loras.splice(index, 1);
}

/** 簡易模式狀態藥丸:與出圖組裝同一口徑(validateSimpleConfig)。 */
const simpleState = computed(() => {
  const invalid = validateSimpleConfig(active.value.simple);
  return invalid
    ? { tone: 'error', text: '未就緒', detail: invalid }
    : { tone: 'ok', text: '有效', detail: '' };
});

const nlHint = computed(() =>
  active.value.mode === 'simple'
    ? '選模板時會自動設定:Checkpoint 只送 tag;Flux 以句子為主、附上 tag;Anima tag 與句子一起送'
    : '選模型類型時會自動設定;句子隨 %nl% 注入工作流,%prompt% 仍是 tag',
);

/** 藥丸只顯示一個詞,具體原因放 title 懸浮提示,不佔版面。 */
const workflowState = computed(() => {
  if (!active.value.workflow.trim()) return { tone: 'muted', text: '未填寫', detail: '' };
  try {
    const placeholders = getWorkflowPlaceholders(active.value.workflow);
    if (!placeholders.includes('prompt')) {
      return { tone: 'error', text: '缺 %prompt%', detail: 'JSON 有效，但缺少必需的 %prompt% 佔位符' };
    }
    const unknown = placeholders.filter(
      name => !['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height'].includes(name),
    );
    if (unknown.length) {
      return {
        tone: 'error',
        text: '佔位符不支援',
        detail: `暫不支援：${unknown.map(name => `%${name}%`).join('、')}`,
      };
    }
    return {
      tone: 'ok',
      text: '有效',
      detail: `已識別 ${placeholders.map(name => `%${name}%`).join('、')}`,
    };
  } catch (error) {
    return { tone: 'error', text: 'JSON 無效', detail: errorMessage(error) };
  }
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testComfyConnection(effectiveComfyConn());
    toastr.success(result.mode === 'server' ? 'ComfyUI 連線正常（ST 後端轉發）' : 'ComfyUI 連線正常（瀏覽器直連）');
  } catch (error) {
    toastr.error(errorMessage(error), 'ComfyUI 連線失敗');
  } finally {
    testing.value = false;
  }
}

const purposeLabels: Record<WorkflowBindingPurpose, string> = {
  positive_tag: '正向 tag',
  positive_nl: '獨立自然語言',
  positive_combined: '正向 tag + 自然語言共用',
  negative: '負面提示詞',
  seed: '隨機種子',
  width: '主畫布寬度',
  height: '主畫布高度',
};

async function onAutoConfigure() {
  if (configuring.value || !active.value.workflow.trim()) return;
  configuring.value = true;
  const targetId = active.value.id;
  try {
    const result = await configureWorkflowWithAi(active.value.workflow);
    if (!result.changes.length) {
      toastr.info('工作流中的動態引數已經配置，無需修改', '虎哩繪');
      return;
    }
    assistResult.value = result;
    assistDraft.value = result.workflow;
    assistTargetId.value = targetId;
    assistOpen.value = true;
  } catch (error) {
    toastr.error(errorMessage(error), 'AI 配置工作流失敗');
  } finally {
    configuring.value = false;
  }
}

function closeAssist() {
  assistOpen.value = false;
  assistResult.value = null;
  assistDraft.value = '';
  assistTargetId.value = '';
}

function applyAssist() {
  try {
    const target = settings.comfyui.workflows.find(w => w.id === assistTargetId.value);
    if (!target) throw new Error('目標工作流已被刪除，請重新配置');
    const placeholders = getWorkflowPlaceholders(assistDraft.value);
    if (!placeholders.includes('prompt')) throw new Error('預覽工作流缺少 %prompt% 佔位符');
    target.workflow = assistDraft.value;
    const name = target.name;
    closeAssist();
    toastr.success(`已應用 AI 配置的工作流（${name}）`, '虎哩繪');
    if (placeholders.includes('nl') && !target.naturalLanguage) {
      toastr.info('工作流已配置 %nl%；需要時請開啟「生成自然語言」', '虎哩繪');
    }
  } catch (error) {
    toastr.error(errorMessage(error), '工作流無法應用');
  }
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="第一次使用？照這幾步設定" :open="needsSetup">
        <ol class="quickstart">
          <li>先啟動 ComfyUI，確認瀏覽器打得開 <code>http://127.0.0.1:8188</code>。</li>
          <li>展開下方「配置」，URL 填 ComfyUI 的網址（本機就是上面那個），按「測試連線」，再按「使用此渠道出圖」。</li>
          <li>「配置方式」選「簡易引數」→ 選模板（一般二次元模型選 Checkpoint；用 Flux、Anima 就選對應的）→ 按「拉取模型列表」→ 選模型。提示詞的寫法會跟著模板自動調整。</li>
          <li>想用自己的工作流：在 ComfyUI 選單按 Workflow › Export (API) 匯出，貼到「自定義工作流」，外掛的助手會幫你找出要填提示詞的節點。</li>
          <li>回到聊天，AI 回覆後會自動配圖；也可以按樓層選單「⋯」裡的調色盤按鈕手動加一張。</li>
        </ol>
      </Collapsible>

      <Collapsible title="配置" :open="false">
        <div class="api-row">
          <span class="bbi-field-label">URL</span>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.comfyui.url"
            placeholder="http://127.0.0.1:8188"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 當前出圖渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'comfyui'"
          >
            使用此渠道出圖
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '連線中…' : '測試連線' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="工作流" :open="false">
        <div class="wf-row">
          <span class="bbi-field-label">當前工作流</span>
          <input
            v-if="renaming"
            ref="renameInput"
            class="bbi-input"
            type="text"
            v-model="renameDraft"
            placeholder="工作流名稱"
            spellcheck="false"
            title="Enter 確認，Esc 取消"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.stop.prevent="renaming = false"
            @blur="commitRename"
          />
          <BbiSelect
            v-else
            class="wf-select"
            v-model="activeId"
            :options="workflowOptions"
            aria-label="當前工作流"
          />
          <span v-if="!renaming" class="wf-ops">
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="重新命名當前工作流"
              aria-label="重新命名當前工作流"
              @click="startRename"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="新建一套空工作流"
              aria-label="新建一套空工作流"
              @click="addWorkflow"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="複製當前工作流(含開關與尺寸)"
              aria-label="複製當前工作流"
              @click="duplicateWorkflow"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op wf-remove"
              type="button"
              :disabled="!canRemove"
              :title="canRemove ? '刪除當前工作流' : '至少要保留一套工作流'"
              aria-label="刪除當前工作流"
              @click="confirmDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <!-- 分界:線以下的開關、尺寸與 JSON 均跟隨當前選中的這一套 -->
        <hr class="wf-divider" />

        <!-- 配置方式:分段開關二選一(複用全域性 bbi-segmented;兩個選項用下拉太重),狀態藥丸居右 -->
        <div class="wf-mode-bar">
          <div class="bbi-segmented" role="tablist" aria-label="配置方式">
            <button
              v-for="opt in modeOptions"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': active.mode === opt.value }"
              type="button"
              role="tab"
              :aria-selected="active.mode === opt.value"
              @click="active.mode = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <span
            v-if="active.mode === 'simple'"
            class="bbi-prompt-state wf-state"
            :class="`is-${simpleState.tone}`"
            :title="simpleState.detail || undefined"
          >
            {{ simpleState.text }}
          </span>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然語言</span>
          <input v-model="active.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint wf-switch-hint">{{ nlHint }}</p>

        <div class="bbi-num-row">
          <span class="bbi-field-label">豎屏尺寸(寬×高)</span>
          <input
            class="bbi-input wf-size"
            type="text"
            v-model="active.portraitSize"
            list="comfy-portrait-presets"
            placeholder="832×1216"
            spellcheck="false"
          />
          <datalist id="comfy-portrait-presets">
            <option value="832×1216">豎版</option>
            <option value="1024×1536">大豎版</option>
            <option value="1024×1024">方圖</option>
          </datalist>
        </div>

        <div class="bbi-num-row">
          <span class="bbi-field-label">橫屏尺寸(寬×高)</span>
          <input
            class="bbi-input wf-size"
            type="text"
            v-model="active.landscapeSize"
            list="comfy-landscape-presets"
            placeholder="1216×832"
            spellcheck="false"
          />
          <datalist id="comfy-landscape-presets">
            <option value="1216×832">橫版</option>
            <option value="1536×1024">大橫版</option>
            <option value="1024×1024">方圖</option>
          </datalist>
        </div>

        <!-- 簡易模式:選模型填引數,JSON 由外掛按模板組裝。
             分組排布(模型/LoRA/取樣/提示詞),欄位行統一「短標籤列 + 輸入列」網格,避免長標籤把輸入框擠得參差不梲。 -->
        <template v-if="active.mode === 'simple'">
          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">模型</span>
              <span class="wf-group-tools">
                <span v-if="fetchStatus" class="bbi-field-hint">{{ fetchStatus }}</span>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  :disabled="fetching"
                  @click="onFetchModels()"
                >
                  <Icon name="refresh" :size="12" />
                  {{ fetching ? '拉取中…' : lists ? '重新整理列表' : '拉取模型列表' }}
                </button>
              </span>
            </div>

            <div class="wf-field">
              <span class="wf-field-tag">架構</span>
              <BbiSelect
                class="wf-tpl"
                :model-value="active.simple.template"
                :options="templateOptions"
                aria-label="模型架構"
                @update:model-value="onTemplateChange"
              />
            </div>
            <div class="wf-field">
              <span class="wf-field-tag">模型</span>
              <BbiCombo
                v-model="active.simple.model"
                :options="modelOptions"
                placeholder="safetensors / gguf 檔名"
                aria-label="模型檔案"
              />
              <label
                v-if="meta.modelKind === 'unet'"
                class="wf-gguf"
                title="模型是 GGUF 格式(用 UnetLoaderGGUF 載入);從列表選擇會自動識別"
              >
                <input v-model="active.simple.gguf" type="checkbox" class="bbi-checkbox" />
                GGUF
              </label>
            </div>
            <div class="wf-field">
              <span class="wf-field-tag">VAE</span>
              <BbiCombo
                v-model="active.simple.vae"
                :options="vaeOptions"
                :placeholder="meta.vaePlaceholder"
                aria-label="VAE 檔案"
              />
            </div>
            <div v-for="clip in meta.clips" :key="clip.key" class="wf-field">
              <span class="wf-field-tag">{{ clip.label }}</span>
              <BbiCombo
                v-model="active.simple[clip.key]"
                :options="clipOptions"
                placeholder="clip 檔名"
                :aria-label="clip.label"
              />
            </div>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">LoRA</span>
              <button
                class="bbi-icon-btn wf-op"
                type="button"
                title="新增 LoRA(可多個串聯)"
                aria-label="新增 LoRA"
                @click="addLora"
              >
                <Icon name="plus" :size="14" />
              </button>
            </div>
            <div v-for="(lora, index) in active.simple.loras" :key="index" class="wf-lora-row">
              <BbiCombo
                v-model="lora.name"
                :options="loraOptions"
                placeholder="lora 檔名"
                aria-label="LoRA 檔案"
              />
              <input
                class="bbi-input wf-lora-str"
                type="number"
                v-model.number="lora.strength"
                min="0"
                max="2"
                step="0.05"
                title="強度"
                aria-label="LoRA 強度"
              />
              <button
                class="bbi-icon-btn wf-op wf-remove"
                type="button"
                title="刪除此 LoRA"
                aria-label="刪除此 LoRA"
                @click="removeLora(index)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </div>
            <p v-if="active.simple.loras.length" class="bbi-field-hint wf-lora-hint">
              LoRA 的觸發詞要自己寫進固定正面或 tag 裡。
            </p>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">取樣</span>
            </div>
            <div class="wf-params">
              <label class="wf-param">
                <span>步數</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.steps" min="1" max="150" />
              </label>
              <label class="wf-param" v-if="active.simple.template !== 'flux'">
                <span>CFG</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.cfg" min="1" max="30" step="0.5" />
              </label>
              <label class="wf-param" v-if="active.simple.template === 'flux'" title="FluxGuidance 強度;1 = 不加該節點">
                <span>Guidance</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.guidance" min="1" max="10" step="0.1" />
              </label>
              <label class="wf-param" v-if="active.simple.template === 'anima'" title="ModelSamplingAuraFlow 的 shift">
                <span>Shift</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.shift" min="0" max="10" step="0.1" />
              </label>
              <label class="wf-param">
                <span>取樣器</span>
                <BbiCombo v-model="active.simple.sampler" :options="samplerOptions" placeholder="euler" aria-label="取樣器" />
              </label>
              <label class="wf-param">
                <span>排程器</span>
                <BbiCombo v-model="active.simple.scheduler" :options="schedulerOptions" placeholder="normal" aria-label="排程器" />
              </label>
            </div>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">提示詞</span>
            </div>
            <div class="wf-prompts">
              <BbiTextarea
                v-model="active.simple.positive"
                :rows="2"
                :max-rows="6"
                placeholder="固定正面:質量詞/風格詞等,拼在 AI 生成內容之前"
              />
              <BbiTextarea
                v-if="meta.supportsNegative"
                v-model="active.simple.negative"
                :rows="2"
                :max-rows="6"
                placeholder="固定負面:通用負面詞;AI 生成的動態負面追加在後"
              />
            </div>
          </section>

        </template>

        <!-- 自定義模式:貼上 API 格式 JSON -->
        <template v-else>
        <div class="wf-field">
          <span class="wf-field-tag">模型類型</span>
          <BbiSelect
            class="wf-tpl"
            :model-value="active.family"
            :options="templateOptions"
            aria-label="工作流的模型類型"
            @update:model-value="onFamilyChange"
          />
        </div>
        <div class="wf-json-head">
          <span class="bbi-field-label">工作流 JSON</span>
          <span class="wf-json-tools">
            <span
              class="bbi-prompt-state wf-state"
              :class="`is-${workflowState.tone}`"
              :title="workflowState.detail || undefined"
            >
              {{ workflowState.text }}
            </span>
            <button
              class="bbi-btn bbi-btn-primary bbi-btn-sm"
              type="button"
              :disabled="configuring || !active.workflow.trim()"
              title="AI 判斷節點用途並自動配置佔位符；工作流節點、模型名和本地路徑會發送給設定頁「生成 tag 使用」的 API"
              @click="onAutoConfigure"
            >
              <Icon name="sparkles" :size="12" />
              {{ configuring ? '分析中…' : 'AI 自動配置' }}
            </button>
          </span>
        </div>
        <BbiTextarea
          v-model="active.workflow"
          :rows="8"
          :max-rows="24"
          mono
          placeholder='{"3": {"class_type": "KSampler", ...}, ...}'
        />
        <p class="bbi-field-hint wf-hint">
          「Save (API Format)」匯出；可用 %prompt% %negative_prompt% %seed% %nl% %width% %height%
        </p>
        </template>
      </Collapsible>
    </div>

    <ConfirmDialog
      v-model:open="confirmDeleteOpen"
      title="刪除工作流"
      confirm-text="刪除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveWorkflow"
    >
      確定刪除工作流「{{ active.name || '未命名工作流' }}」？刪除後無法恢復。
    </ConfirmDialog>

    <ModalMask :open="assistOpen" @close="closeAssist">
      <div
        v-if="assistResult"
        class="bbi-modal workflow-assist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="預覽 AI 配置的工作流"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">預覽工作流修改</span>
          <button class="bbi-icon-btn" type="button" aria-label="關閉" @click="closeAssist">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-field-hint">原文與宏由本地重建，AI 只返回節點用途；請檢查後再應用。</p>
        <div class="workflow-change-list">
          <div
            v-for="change in assistResult.changes"
            :key="`${change.node}:${change.input}`"
            class="workflow-change"
          >
            <span class="workflow-change-role">{{ purposeLabels[change.purpose] }}</span>
            <code>{{ change.node }}.inputs.{{ change.input }}</code>
          </div>
        </div>

        <BbiTextarea v-model="assistDraft" :rows="10" :max-rows="24" mono />

        <p v-if="assistResult.nlMode !== 'none'" class="workflow-detection">
          自然語言：{{ assistResult.nlMode === 'combined' ? '與正向 tag 共用輸入' : '使用獨立輸入' }}
        </p>
        <p v-if="assistResult.hasNegative" class="workflow-detection">
          已配置動態負面詞；生成 tag 時會按畫面輸出補充負面 tag。
        </p>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeAssist">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="applyAssist">
            <Icon name="check" />
            應用工作流
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* 工作流選擇行:grid 而非 flex——靠 flex-basis 撐出的對齊一 wrap 就散,
   固定首列寬讓標籤列與下方 switch/num 行的標籤列同起點。 */
.wf-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.wf-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.wf-row > .bbi-input {
  min-width: 0;
}
/* 下拉不吃滿:名稱通常很短,拉滿只會拖出半截空白(子元件根類預設 180px/不伸縮,此處 0,2,0 壓過) */
.wf-row > .wf-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.wf-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* 四個操作是低頻且同級的,圖示化後整行只剩下拉一個視覺重點;
   文案退到 title/aria-label,不損失可達性。 */
.wf-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.wf-op:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 選擇器與預設內容的分界:線以下均跟隨當前這套工作流 */
.wf-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 4px 0;
}
/* 開關自帶下留白,說明文字只需補一點上間距(base.css 的 .bbi-input + hint 規則不覆蓋此組合) */
.wf-switch-hint {
  margin: 2px 0 6px;
}
/* 尺寸輸入:比 .bbi-num 寬一點(要裝「1024×1536」),但不右對齊——「寬×高」是文本不是數值 */
.wf-size {
  width: 130px;
  flex: 0 0 auto;
}
/* 配置方式:分段開關在左、狀態藥丸在右 */
.wf-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0 6px;
}
/* 架構下拉不吃滿(同 .wf-select 的理由) */
.wf-tpl {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
/* 簡易模式分組:組標題帶虛線分隔,組間距固定;組內欄位行統一「短標籤列+輸入列+尾部」網格 */
.wf-group {
  padding: 10px 0 2px;
}
.wf-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--bbi-line);
}
.wf-group-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.wf-group-tools .bbi-field-hint {
  margin: 0;
}
.wf-field {
  display: grid;
  grid-template-columns: 4.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.wf-field-tag {
  color: var(--bbi-ink-soft);
  font-size: 12px;
  white-space: nowrap;
}
.wf-gguf {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
/* LoRA 行:檔名吃滿、強度定寬、刪除收尾(與欄位行同節奏) */
.wf-lora-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 30px;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
}
.wf-lora-hint {
  margin: 4px 0 2px;
}
/* 取樣引數:多列網格,標籤在上輸入在下(與 NaiPanel 的 be-row 同款語義) */
.wf-params {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 12px;
}
.wf-param {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.wf-param > span {
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.wf-prompts {
  display: grid;
  gap: 8px;
}
@media (max-width: 640px) {
  .wf-params {
    grid-template-columns: repeat(2, 1fr);
  }
}
/* JSON 頭部行:標籤在左,狀態藥丸與 AI 按鈕作為「工具組」在右(textarea 是塊級,頭部行即它的工具欄) */
.wf-json-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 0 10px;
}
.wf-json-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-hint {
  margin-top: 8px;
}
/* 危險操作按鈕:平時與其它圖示鈕同樣低調,hover 才顯紅(與 ConfirmDialog 同口徑)。
   圖示鈕無描邊,故 hover 只換底色與前景色,不碰 border。 */
.wf-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.wf-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
/* AI 預覽彈窗關閉鈕:.bbi-icon-btn 只在 App.vue 裡宣告(scoped 不跨元件),此處補一份 */
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
/* JSON 狀態藥丸:複用全域性 bbi-prompt-state 基樣式,此處只按 tone 上色 */
.wf-state.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.wf-state.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}
.workflow-assist-modal {
  width: min(720px, calc(100vw - 32px));
}
.workflow-change-list {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.workflow-change {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.workflow-change-role {
  flex: 0 0 118px;
  color: var(--bbi-ink);
  font-weight: 600;
}
.workflow-change code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bbi-accent);
  font-family: var(--bbi-font-mono);
}
.workflow-detection {
  margin: 9px 0 0;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  line-height: 1.5;
}
/* URL 標籤與輸入框同行:標籤靠左不壓縮,輸入框吃滿剩餘寬度 */
.api-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.api-row .bbi-field-label {
  flex: 0 0 auto;
}
.api-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
/* 新手設定步驟:編號清單,字級與一般提示同款 */
.quickstart {
  margin: 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--bbi-ink-soft);
  font-size: 13px;
  line-height: 1.7;
}
.quickstart code {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
}

/* 左側「使用此渠道 / 當前出圖渠道」與右側測試連線分據兩端 */
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
@media (max-width: 640px) {
  /* 窄屏:四個圖示鈕 + 標籤會把下拉擠成一條縫,標籤獨佔首行,下拉與操作組同行分據兩端 */
  .wf-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .wf-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .wf-row > .wf-select {
    max-width: none;
  }
  .workflow-change {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  .workflow-change-role {
    flex-basis: auto;
  }
}
</style>
