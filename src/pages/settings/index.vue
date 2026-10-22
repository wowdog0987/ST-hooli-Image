<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import {
  BACKENDS,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  DEFAULT_PREFILL_PROMPT,
  newChannel,
  sanitizeTagName,
  settings,
  type ApiChannel,
  type AutoTagPrompts,
  type BackendId,
} from '@/state/settings';
import { getContext } from '@/st/context';
import {
  ORB_SHAPES,
  THEMES,
  ui,
  type NavPosition,
  type OrbShape,
  type ThemeName,
} from '@/state/ui';
import { PLUGIN_VERSION } from '@/version';
import { computed, nextTick, ref } from 'vue';

const NAV_OPTIONS: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 'top', label: '頂部' },
  { value: 'bottom', label: '底部' },
];

// 出圖後端可選項:與渠道頁頁籤同口徑,藏掉未開放的 webui
const BACKEND_OPTIONS = BACKENDS.filter(b => b.value !== 'webui');

/**
 * 思考強度候選:各家取值的並集,**不是**某一家的官方列表。
 * auto 是顯式選項(值為空串 = 不傳送該引數),不是「留空」——
 * 用 BbiSelect 而非可輸入的 BbiCombo:移動端點輸入框會彈出輸入法,很打擾。
 * 取值不做校驗,原樣發給端點(見 ApiChannel.reasoningEffort)。
 */
const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'auto' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

/* —— 自繪下拉(BbiSelect)的 v-model 適配:元件按 string 收發,這裡收窄回具體聯合型別 —— */
const themeSel = computed<string>({
  get: () => ui.theme,
  set: v => (ui.theme = v as ThemeName),
});
const navSel = computed<string>({
  get: () => ui.navPosition,
  set: v => (ui.navPosition = v as NavPosition),
});
// 樓層卡片主題不再提供設定項:卡片無邊框化後恆跟隨 ST 主題。
// settings.ui.cardTheme 欄位與 hydrate 讀取保留(舊使用者已改的值繼續生效,無害)。
const orbShapeSel = computed<string>({
  get: () => ui.orbShape,
  set: v => (ui.orbShape = v as OrbShape),
});
const backendSel = computed<string>({
  get: () => settings.defaultBackend,
  set: v => (settings.defaultBackend = v as BackendId),
});

/* —— 渠道:列表只讀展示,編輯/新建都在彈窗裡進行,避免一長列表平鋪誤觸。 —— */
// editingId:正在編輯的「已有渠道」id;新建時為 null。僅用於「完成」時定位寫回目標。
const editingId = ref<string | null>(null);
// 編輯用「草稿副本」:v-model 全改在草稿上,只有點「完成」才寫回 settings(避免每敲一字就觸發存檔)。
// 彈窗開關也以它為準:草稿存在 = 彈窗開啟。
const editingChannel = ref<ApiChannel | null>(null);
// 深複製渠道(純資料,JSON 即可),切斷與 settings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 金鑰預設隱藏;每次開啟/關閉彈窗都復位,避免金鑰意外保持明文
const showKey = ref(false);

function normalizeAutoTagNumbers(changed?: 'minImages' | 'maxImages' | Event) {
  settings.autoTag.contextMessages = Math.max(1, Math.floor(Number(settings.autoTag.contextMessages) || 1));
  let minImages = Math.max(0, Math.floor(Number(settings.autoTag.minImages) || 0));
  let maxImages = Math.max(1, Math.floor(Number(settings.autoTag.maxImages) || 1));
  // 使用者抬高下限時順帶抬高上限;使用者壓低上限時順帶壓低下限。
  // 這樣正在編輯的那一格始終保留使用者意圖,不會出現 min > max 的瞬時髒配置。
  if (changed === 'minImages') maxImages = Math.max(maxImages, minImages);
  else minImages = Math.min(minImages, maxImages);
  settings.autoTag.minImages = minImages;
  settings.autoTag.maxImages = maxImages;
  settings.autoTag.retryCount = Math.min(5, Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0)));
}

/* —— 自定義提示詞:列表只讀展示,編輯在彈窗裡進行。
   空串 = 回落內建預設;是否已自定義按 trim 非空判定。 —— */
interface TagPromptMeta {
  key: keyof AutoTagPrompts;
  label: string;
  hint: string;
  builtin: string;
  macros: { token: string; desc: string }[];
}

// 規範與思維鏈按後端成對排列:兩者必須配對使用(思維鏈槽位要填的欄位,
// 得在同後端規範裡有判據和詞表),列在一起是為了改一個時能看見另一個。
// 不按當前後端過濾——過濾會讓「現在用的是哪份」變成隱式狀態,反而更難排查。
//
// ⚠ NAI 只列一對,存的是 naiV5Spec / naiV5Thinking(鍵名帶 V5 是歷史包袱,見 settings.ts)。
// 4.5 以下那套單串 tag 的 naiSpec / naiThinking 已隨模型列表收窄一起下線,不再列出:
// 可選模型只剩 4.5/V5,那兩份永遠走不到,列出來只會讓人以為還有第二種口徑要維護。
const TAG_PROMPT_METAS: TagPromptMeta[] = [
  {
    key: 'jailbreak',
    label: '破限詞',
    hint: '作為置頂 system 附加在自動 tag 請求裡，降低副 API 拒答率。留空則用內建預設。全後端通用。',
    builtin: DEFAULT_JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'naiV5Spec',
    label: 'NAI \u89c4\u8303',
    hint: '\u9ed8\u8ba4\u540e\u7aef\u4e3a NAI \u65f6\u62fc\u8fdb\u81ea\u52a8 tag \u8bf7\u6c42\uff0c\u5b9a\u4e49 Base Prompt\u3001\u539f\u751f Character Prompts \u4e0e\u82f1\u6587\u81ea\u7136\u8bed\u8a00\uff08nl \u4e00\u5f8b\u5199\u82f1\u6587\uff09\u30024.5 \u4e0e V5 \u5171\u7528\u8fd9\u4e00\u4efd\uff1achar_captions \u672c\u5c31\u662f v4 \u65f6\u4ee3\u7684\u534f\u8bae\uff0c\u4e24\u4ee3\u5199\u6cd5\u53e3\u5f84\u76f8\u540c\u3002\u7559\u7a7a\u7528\u5185\u7f6e\u9ed8\u8ba4\u3002',
    builtin: DEFAULT_NAI_V5_SPEC,
    macros: [],
  },
  {
    key: 'naiV5Thinking',
    label: 'NAI 思維鏈',
    hint: '預設後端為 NAI 時使用的輸出前思考清單，作為 system 壓在任務訊息之後（解析時會自動剝掉思考塊）。槽位塊是「Base 塊 + 每角色一塊」，對應 characters[] 協議，與 ComfyUI 那份的單串形態不通用。與「NAI 規範」配套。留空用內建預設。',
    builtin: DEFAULT_NAI_V5_THINKING,
    macros: [],
  },
  {
    key: 'comfySpec',
    label: 'ComfyUI 規範',
    hint: '預設後端為 ComfyUI 時拼進自動 tag 請求，約束 tag / nl 的書寫規範。留空用內建預設。',
    builtin: DEFAULT_COMFY_SPEC,
    macros: [
      {
        token: '{{nl}}',
        desc: '自然語言規範；ComfyUI 面板開啟「生成自然語言」時展開，關閉時置空。不寫此宏時，開啟開關會自動追加到末尾。',
      },
    ],
  },
  {
    key: 'comfyThinking',
    label: 'ComfyUI 思維鏈',
    hint: '預設後端為 ComfyUI 時使用的輸出前思考清單，作為 system 壓在任務訊息之後（解析時會自動剝掉思考塊）。與「ComfyUI 規範」配套。留空用內建預設。',
    builtin: DEFAULT_COMFY_THINKING,
    macros: [],
  },
  {
    key: 'prefill',
    label: '預填充',
    hint: 'assistant 預填充，以 <thinking> 開頭引導模型從思維鏈續寫；隨渠道「傳送預填充」開關生效。留空用內建預設。全後端通用。',
    builtin: DEFAULT_PREFILL_PROMPT,
    macros: [],
  },
];

// 正在編輯的提示詞;draft 是草稿,點「完成」才寫回 settings(取消則丟棄)。
const editingTagPrompt = ref<TagPromptMeta | null>(null);
const tagPromptDraft = ref('');
const tagPromptArea = ref<InstanceType<typeof BbiTextarea> | null>(null);

// 該條是否已自定義(非空即視為已覆蓋內建)
function isTagPromptCustom(key: keyof AutoTagPrompts): boolean {
  return settings.autoTag.prompts[key].trim().length > 0;
}

function openTagPrompt(meta: TagPromptMeta) {
  editingTagPrompt.value = meta;
  // 已自定義→載入使用者內容;未自定義→預填內建模板,方便直接在其上改
  tagPromptDraft.value = settings.autoTag.prompts[meta.key].trim() || meta.builtin;
}
function closeTagPrompt() {
  editingTagPrompt.value = null;
  tagPromptDraft.value = '';
}
function saveTagPrompt() {
  const meta = editingTagPrompt.value;
  if (!meta) return;
  // 草稿與內建完全一致→存空串(回落內建),避免把模板冗餘存進設定、也便於顯示「預設」
  const v = tagPromptDraft.value.trim();
  settings.autoTag.prompts[meta.key] = v === meta.builtin.trim() ? '' : tagPromptDraft.value;
  closeTagPrompt();
}
// 「恢復預設」:把草稿重置回內建模板(儲存後即回落內建)
function resetTagPromptDraft() {
  if (editingTagPrompt.value) tagPromptDraft.value = editingTagPrompt.value.builtin;
}
// 點宏標籤 → 插入到文本框游標處(無焦點則追加到末尾);游標定位由元件內部處理
function insertTagMacro(token: string) {
  tagPromptArea.value?.insertAtCursor(token);
}

// 排除引數:內部存 string[],編輯時用逗號分隔的單行文本承載,讀/寫兩向轉換。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel() {
  showKey.value = false;
  editingId.value = null; // null = 新建,完成時 push
  editingChannel.value = newChannel(); // 草稿,尚未進 settings
}
function openChannel(id: string) {
  const src = settings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 編輯草稿副本,不動真身
}
/** 取消(× / 點遮罩):丟棄草稿,不寫回 settings(無論新建還是編輯,改動都作廢)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿寫回 settings —— 新建則 push,編輯則按 id 覆蓋。此時才觸發存檔。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = settings.channels;
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 編輯期間原渠道被刪等異常 → 兜底為新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 刪除渠道前的二次確認:點刪除先開確認彈窗,確認後才真正刪。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 刪除針對「已有渠道」(editingId);新建草稿尚未入庫,等同直接丟棄草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const list = settings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:生成 tag 若指派了該渠道則清空(回落跟隨主 API)
  if (settings.assignments.tagGen === id) settings.assignments.tagGen = '';
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = '測試中…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取狀態
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = '未返回任何模型';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 排除角色:勾選的角色名(含重名卡)的聊天裡,自動 tag 全流程停用。
   按「名字」排除,同名卡是一批一起排除。列表很長時易卡,故:① 僅在彈窗開啟時取/去重角色名;
   ② 帶搜尋框過濾;③ 用 v-show + 子串匹配,渲染量隨搜尋收斂。 —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// 彈窗開啟時一次性算出去重後的角色名(按名排序),關閉後不再持有,避免常駐大列表。
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

// 過濾:空搜尋顯示全部;否則大小寫不敏感子串匹配
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return settings.excludes.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = settings.excludes.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 自定義清洗標籤:使用者填標籤名(如 snow),清洗正文時把 <snow>…</snow> 整塊刪掉。 —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!settings.excludes.customStripTags.includes(tag)) settings.excludes.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = settings.excludes.customStripTags.indexOf(tag);
  if (idx >= 0) settings.excludes.customStripTags.splice(idx, 1);
}

/* —— 模型可搜尋下拉(combobox):輸入框既是當前值也是過濾詞,聚焦彈出過濾列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦後用戶輸入的過濾詞;失焦時清空
// 已拉取到的當前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 過濾:有 query 按子串(大小寫不敏感)過濾;為空則顯示全部。效能上限 200 條,避免超長列表卡頓。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延遲關閉,讓 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}
</script>

<template>
  <section class="bbi-page">
    <!-- 標題行右端顯示版本號 -->
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">設定</h2>
      <span class="bbi-ver">v{{ PLUGIN_VERSION }}</span>
    </div>
    <hr class="bbi-rule" />

    <!-- 總開關:整個外掛的主控。全頁唯一的大號滑動開關,與下方各項的小核取方塊拉開層級。 -->
    <div class="bbi-master" :class="{ 'is-off': !settings.enabled }">
      <span class="bbi-master-spine" aria-hidden="true"></span>
      <span class="bbi-master-title">虎哩繪 · 文生圖</span>
      <button
        type="button"
        role="switch"
        class="bbi-toggle"
        :class="{ 'is-on': settings.enabled }"
        :aria-checked="settings.enabled"
        :title="settings.enabled ? '點選停用' : '點選啟用'"
        @click="settings.enabled = !settings.enabled"
      >
        <span class="bbi-toggle-knob"></span>
      </button>
    </div>

    <div class="bbi-sections">
      <!-- 基本設定:主題 / 導航 / 入口 / 懸浮球等介面項,置於首位 -->
      <Collapsible title="基本設定" :open="false">
        <div class="bbi-select-row">
          <span class="bbi-field-label">主題</span>
          <BbiSelect v-model="themeSel" :options="THEMES" aria-label="主題" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">導航位置</span>
          <BbiSelect v-model="navSel" :options="NAV_OPTIONS" aria-label="導航位置" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">出圖後端</span>
          <BbiSelect v-model="backendSel" :options="BACKEND_OPTIONS" aria-label="出圖後端" />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">新圖儲存為 JPG</span>
          <input v-model="settings.storage.saveAsJpeg" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          體積約為 PNG 的一到兩成;代價是圖片不再內嵌生成引數(提示詞與種子仍留在聊天記錄裡)。
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">樓層圖片預設摺疊</span>
          <input v-model="settings.ui.autoCollapseImages" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          開啟後圖片預設收成一條細條,點選才展開,適合在外面玩時防窺。在卡片上手動展開/摺疊過的以手動狀態為準(重新整理頁面後重置)。
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">移動端點當前頁導航關窗</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">移動端再點一下當前所在頁的導航按鈕即可關閉整個視窗,省得去夠右上角的 ×。怕誤觸可關。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">在 ST 頂欄顯示按鈕</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">在酒館頂部導航欄加一個快速開啟虎哩繪的按鈕。左下角魔杖入口照舊保留。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">顯示螢幕懸浮球</span>
          <input v-model="ui.showOrb" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">在螢幕邊緣掛一枚可拖動的懸浮球,點選即開虎哩繪。拖到中間可常駐懸浮,拖近左右邊緣則吸附貼邊。</p>

        <!-- 懸浮球外觀:配置項多,開啟後才收進小分組 -->
        <Collapsible v-if="ui.showOrb" title="懸浮球外觀" :open="false">
          <div class="bbi-select-row">
            <span class="bbi-field-label">形狀</span>
            <BbiSelect v-model="orbShapeSel" :options="ORB_SHAPES" aria-label="懸浮球形狀" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">大小</span>
              <span class="bbi-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input class="bbi-range" type="range" min="32" max="80" step="1" v-model.number="ui.orbSize" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">靜止透明度</span>
              <span class="bbi-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input class="bbi-range" type="range" min="20" max="100" step="1" v-model.number="ui.orbOpacity" />
            <p class="bbi-field-hint">懸浮球靜止時的不透明度;喚起 / 拖動時一律全顯。</p>
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">自定義圖示</span>
            </div>
            <input class="bbi-input" type="text" v-model="ui.orbImage" placeholder="ST 伺服器圖片路徑" spellcheck="false" />
            <p class="bbi-field-hint">留空用預設畫筆圖示。</p>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- 副 API:生成畫圖 tag 用的模型渠道 -->
      <Collapsible title="副 API" :open="false">
        <!-- 任務指派:只有一個任務——生成 tag -->
        <div class="bbi-field bbi-assign">
          <label class="bbi-assign-row">
            <span class="bbi-field-label">生成 tag 使用</span>
            <select v-model="settings.assignments.tagGen" class="bbi-input bbi-select">
              <option value="">跟隨主 API</option>
              <option v-for="c in settings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>
        <p class="bbi-field-hint">不指派渠道時跟隨主 API:直接借用你主介面當前正在用的 API(聊天補全/文本補全)來生成畫圖 tag,無需額外配置。想用不同模型再在下方建副渠道指派。</p>

        <hr class="bbi-rule" />

        <!-- 渠道:頂部新增按鈕 + 緊湊只讀列表(點行進彈窗編輯),不再一長列表平鋪 -->
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">渠道</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addChannel()">
            <Icon name="plus" /> 新增渠道
          </button>
        </div>

        <ul v-if="settings.channels.length" class="bbi-channel-list">
          <li v-for="ch in settings.channels" :key="ch.id" class="bbi-channel-item">
            <button class="bbi-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbi-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
              <span class="bbi-channel-item-model">{{ ch.model || '未設模型' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">還沒有渠道。點「新增渠道」配置生成 tag 要用的 API。</p>
      </Collapsible>

      <Collapsible title="自動生成 tag" :open="false">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">自動生成 tag</span>
          <input v-model="settings.autoTag.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">AI 正文生成後自動判斷該樓是否需要插圖,需要就寫入生圖 tag。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">自動生成圖片</span>
          <input v-model="settings.autoTag.autoGenerate" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">寫入 tag 後立即按當前出圖渠道自動出圖;關閉則只寫 tag,在卡片上手動生成。</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">攜帶最近 AI 樓數</span>
          <input
            v-model.number="settings.autoTag.contextMessages"
            class="bbi-input bbi-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">按 AI 故事樓計數,中間的 user 樓一併攜帶。</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">單樓最少圖片數</span>
          <input
            v-model.number="settings.autoTag.minImages"
            class="bbi-input bbi-num"
            type="number"
            min="0"
            :max="settings.autoTag.maxImages"
            step="1"
            @change="normalizeAutoTagNumbers('minImages')"
          />
        </label>

        <label class="bbi-num-row">
          <span class="bbi-field-label">單樓最多圖片數</span>
          <input
            v-model.number="settings.autoTag.maxImages"
            class="bbi-input bbi-num"
            type="number"
            :min="Math.max(1, settings.autoTag.minImages)"
            step="1"
            @change="normalizeAutoTagNumbers('maxImages')"
          />
        </label>
        <p class="bbi-field-hint">最少設為 0 時允許不出圖;最多數量始終受外掛硬限制。</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">失敗自動重試次數</span>
          <input
            v-model.number="settings.autoTag.retryCount"
            class="bbi-input bbi-num"
            type="number"
            min="0"
            max="5"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">副 API 請求失敗或返回無法解析時自動重試；0 = 不重試，最多 5 次。</p>
      </Collapsible>

      <!-- 排除角色 -->
      <Collapsible title="排除角色" :open="false">
        <p class="bbi-field-hint">名單內角色的聊天裡不自動生成生圖 tag。</p>
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">已排除 {{ settings.excludes.excludedChars.length }} 個</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> 編輯名單
          </button>
        </div>
        <ul v-if="settings.excludes.excludedChars.length" class="bbi-exclude-chips">
          <li v-for="name in settings.excludes.excludedChars" :key="name" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">{{ name }}</span>
            <button class="bbi-exclude-chip-x" type="button" title="移出名單" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">名單為空,所有角色都啟用自動 tag。</p>
      </Collapsible>

      <!-- 自定義清洗標籤 -->
      <Collapsible title="自定義清洗標籤" :open="false">
        <p class="bbi-field-hint">
          填入標籤名(如 <code>snow</code>),清洗正文時會把 <code>&lt;snow&gt;…&lt;/snow&gt;</code> 整塊刪掉。
        </p>
        <div class="bbi-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbi-input"
            type="text"
            placeholder="標籤名,如 snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> 新增
          </button>
        </div>
        <ul v-if="settings.excludes.customStripTags.length" class="bbi-exclude-chips">
          <li v-for="tag in settings.excludes.customStripTags" :key="tag" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbi-exclude-chip-x" type="button" title="移除" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">暫無自定義標籤。僅內建清洗(思維鏈、註釋、物品旁註等)生效。</p>
      </Collapsible>

      <!-- 自定義提示詞 -->
      <Collapsible title="自定義提示詞" :open="false">
        <ul class="bbi-prompt-list">
          <li v-for="m in TAG_PROMPT_METAS" :key="m.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openTagPrompt(m)">
              <span class="bbi-prompt-name">{{ m.label }}</span>
              <span class="bbi-prompt-state" :class="{ 'is-custom': isTagPromptCustom(m.key) }">
                {{ isTagPromptCustom(m.key) ? '已自定義' : '預設' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>
    </div>

    <!-- ===== 排除角色彈窗:搜尋 + 勾選列表 ===== -->
    <ModalMask :open="excludeOpen" @close="closeExclude">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="編輯排除名單">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">排除角色</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbi-input"
          type="search"
          placeholder="搜尋角色名…"
          spellcheck="false"
        />

        <div class="bbi-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbi-exclude-row">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbi-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbi-field-hint">未讀取到角色列表。請先在 ST 裡加載角色卡。</p>
          <p v-else-if="!filteredCharNames.length" class="bbi-field-hint">沒有匹配「{{ excludeSearch }}」的角色。</p>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-exclude-count">共 {{ charNames.length }} 個角色 · 已排除 {{ settings.excludes.excludedChars.length }}</span>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeExclude">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 渠道編輯彈窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbi-modal" role="dialog" aria-modal="true" aria-label="編輯渠道">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">編輯渠道</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">渠道名</span>
          <input v-model="editingChannel.name" class="bbi-input" placeholder="渠道名" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API 地址</span>
          <input v-model="editingChannel.url" class="bbi-input" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API 金鑰</span>
          <div class="bbi-model-row">
            <input
              v-model="editingChannel.key"
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API 金鑰"
            />
            <button
              class="bbi-icon-mini"
              type="button"
              :title="showKey ? '隱藏金鑰' : '顯示金鑰'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">模型</span>
          <div class="bbi-model-row">
            <!-- 可搜尋 combobox:已拉取到模型列表時,聚焦彈出過濾選單;沒列表時就是普通輸入框 -->
            <div class="bbi-combo">
              <input
                v-model="editingChannel.model"
                class="bbi-input"
                :placeholder="modelList.length ? '搜尋或輸入模型名…' : '模型名,如 gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自繪下拉三角(純裝飾,pointer-events:none → 點選穿透到輸入框照常聚焦展開);僅在有可選模型時顯示 -->
              <span v-if="modelList.length" class="bbi-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbi-combo-menu">
                <li v-if="!filteredModels.length" class="bbi-combo-empty">無匹配模型</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbi-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbi-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbi-channel-row">
          <label class="bbi-mini-field">
            <span>溫度</span>
            <input v-model.number="editingChannel.temperature" class="bbi-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbi-mini-field">
            <span>最大 token</span>
            <input v-model.number="editingChannel.maxTokens" class="bbi-input" type="number" step="256" min="256" />
          </label>
          <label class="bbi-mini-field">
            <span>超時(秒)</span>
            <input v-model.number="editingChannel.timeoutSec" class="bbi-input" type="number" step="10" min="1" />
          </label>
          <!-- 思考強度用 BbiSelect(純選擇,不喚起輸入法);它自帶 180px 固定寬,
               這裡要跟其餘三個等分,故在 .bbi-mini-field 內用 :deep 放開寬度 -->
          <div class="bbi-mini-field">
            <span>思考強度</span>
            <BbiSelect
              v-model="editingChannel.reasoningEffort"
              :options="REASONING_EFFORT_OPTIONS"
              aria-label="思考強度"
            />
          </div>
        </div>
        <span class="bbi-field-hint">思考強度不知道的就選 auto，DS 系推薦 max</span>
        <label class="bbi-switch-row">
          <span class="bbi-modal-label">流式傳輸</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbi-checkbox" />
        </label>
        <label class="bbi-switch-row">
          <span class="bbi-modal-label">傳送預填充</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="bbi-checkbox" />
        </label>
        <span class="bbi-field-hint">預設開。若副 API 報錯資訊裡出現 prefill 字樣,關掉它即可。</span>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">排除引數</span>
          <input
            v-model="excludeParamsText"
            class="bbi-input"
            type="text"
            placeholder="逗號分隔,如 temperature, max_tokens"
          />
          <span class="bbi-field-hint">這些引數會在發請求前從請求體裡刪除,用於規避不接受該引數的相容端點報錯。逗號分隔,留空則不排除。</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbi-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbi-modal-foot">
          <!-- 刪除靠左、與右側主操作拉開,破壞性動作不與「完成」相鄰,降低誤觸。
               刪除:始終顯示文字;測試:PC 顯「測試渠道」,移動端只顯「測試」(短版,省版面) -->
          <button class="bbi-btn bbi-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> 刪除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" title="測試渠道" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbi-btn-label-full">測試渠道</span><span class="bbi-btn-label-short">測試</span>
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmChannel">完成</button>
        </footer>

        <!-- 刪除渠道二次確認:疊在渠道彈窗之上。置於 v-if="editingChannel" 塊內,
             渠道為 null 時整體不渲染——既合語義,也讓 editingChannel.name 型別收窄。
             ConfirmDialog 自身 teleport + top-layer,放這兒不影響其渲染層級。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="刪除渠道"
          confirm-text="刪除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          確定刪除渠道「{{ editingChannel.name || '未命名渠道' }}」嗎?此操作不可撤銷,已指派該渠道的任務會被清空。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 自定義提示詞編輯彈窗 ===== -->
    <ModalMask :open="!!editingTagPrompt" @close="closeTagPrompt">
      <div
        v-if="editingTagPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`編輯${editingTagPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">編輯{{ editingTagPrompt.label }}</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="closeTagPrompt"><Icon name="close" /></button>
        </header>

        <p class="bbi-modal-label">{{ editingTagPrompt.hint }}</p>

        <!-- 可用宏:點一下插入到游標處(僅 ComfyUI 規範有 {{nl}};無宏的條目不顯示這一欄) -->
        <div v-if="editingTagPrompt.macros.length" class="bbi-macro-bar">
          <span class="bbi-macro-tip">點選插入宏:</span>
          <button
            v-for="mac in editingTagPrompt.macros"
            :key="mac.token"
            class="bbi-macro"
            type="button"
            :title="mac.desc"
            @click="insertTagMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <BbiTextarea
          ref="tagPromptArea"
          v-model="tagPromptDraft"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
        />

        <footer class="bbi-modal-foot">
          <button class="bbi-btn bbi-btn-danger" type="button" @click="resetTagPromptDraft">
            <Icon name="refresh" /> 恢復預設
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeTagPrompt">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveTagPrompt">完成</button>
        </footer>
      </div>
    </ModalMask>

  </section>
</template>

<style scoped>
/* —— 版本標籤:實心強調底 + 反白字 —— */
.bbi-ver {
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 總開關主控卡 —— */
/* 左緣一道強調色豎脊;停用時整卡褪色、豎脊轉灰,狀態一眼可辨 */
.bbi-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  box-shadow: var(--bbi-shadow);
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-master.is-off .bbi-master-spine {
  background: var(--bbi-line-strong);
}
.bbi-master.is-off .bbi-master-title {
  opacity: 0.7;
}
.bbi-master-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--bbi-ink);
}

.bbi-auto-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 4px 0 8px;
}

/* —— 滑動開關:全頁僅總開關一處使用 —— */
.bbi-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-line-strong);
  cursor: pointer;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on {
  background: var(--bbi-accent);
}
.bbi-toggle:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
.bbi-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbi-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on .bbi-toggle-knob {
  transform: translateX(20px);
}

/* ============ 副 API:渠道 ============ */

/* 任務指派 */
.bbi-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* 指派下拉:比全域性 bbi-select 更窄小一號,與右側對齊、不撐滿半行 */
.bbi-assign-row .bbi-select {
  max-width: 60%;
  font-size: 12px;
}

/* 渠道:頂部操作條(標籤 + 新增按鈕) */
.bbi-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:緊湊只讀列表,每渠道一行,點行進彈窗編輯 */
.bbi-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主體:整塊可點,左名字右模型 */
.bbi-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-channel-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* 渠道名:完整顯示,允許換行,佔據剩餘空間 */
.bbi-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要資訊,過長則截斷,不擠佔名字 */
.bbi-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 渠道編輯彈窗 —— */
.bbi-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbi-model-row .bbi-input {
  flex: 1;
}
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* —— 模型可搜尋 combobox —— */
.bbi-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbi-combo .bbi-input {
  width: 100%;
  padding-right: 26px; /* 給右側自繪三角讓位,文字不壓到箭頭 */
}
/* 自繪下拉三角:與原生 <select> 同款 SVG,貼右側居中;展開時翻轉。裝飾元素不攔點選 */
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 過濾選單:絕對定位貼在輸入框下方,限高滾動,長列表不撐爆彈窗 */
.bbi-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbi-combo-item:hover {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-active {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* 溫度/最大 token/超時/思考強度:四個短控制元件並排,窄屏落到 2×2(見媒體查詢) */
.bbi-channel-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.bbi-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
/* BbiSelect 自帶 180px 固定寬(為設定頁的行佈局設計),這裡要跟其餘三個等分 */
.bbi-mini-field :deep(.bbi-select-box) {
  width: 100%;
}
/* 與相鄰 number 輸入等高:觸發器預設 padding 比 .bbi-input 略小 */
.bbi-mini-field :deep(.bbi-select-trigger) {
  padding: 7px 10px;
}
.bbi-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbi-ink-soft);
  word-break: break-all;
}

/* 彈窗底部:spacer 把刪除鍵推到最左,與右側操作分隔 */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危險操作按鈕:描邊低調,hover 才顯紅,避免誤觸 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 測試按鈕文字:預設(PC)顯完整版,短版藏起;窄屏在媒體查詢裡互換 */
.bbi-btn-label-short {
  display: none;
}

/* —— 自定義提示詞列表 —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可點進彈窗編輯;佈局沿用渠道列表的觀感(描邊、hover 顯強調色) */
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
.bbi-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 狀態藥丸(.bbi-prompt-state / .is-custom)已提到 base.css 全域性:渠道頁也用它 */
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

/* —— 提示詞彈窗:更寬 + 大文本框 —— */
.bbi-modal-wide {
  max-width: 680px;
}
/* 宏標籤條:可橫向裹行,每個宏點選插入 */
.bbi-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbi-macro-tip {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  margin-right: 2px;
}
.bbi-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease), border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-macro:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* ============ 排除名單(chips + 彈窗列表) ============ */
.bbi-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbi-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbi-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbi-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}
.bbi-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbi-striptag-bar .bbi-input {
  flex: 1;
  min-width: 0;
}
.bbi-striptag-bar .bbi-btn {
  flex: none;
}
.bbi-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbi-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbi-radius-sm);
  cursor: pointer;
}
.bbi-exclude-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* ============ 移動端:摺疊區內部正文整體收一號,與窄屏標題節奏統一 ============ */
@media (max-width: 640px) {
  .bbi-auto-grid {
    grid-template-columns: 1fr;
  }
  /* 渠道引數四連:窄屏一行四個每個只剩幾十 px,落成 2×2 */
  .bbi-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .bbi-channel-item-name {
    font-size: 13px;
  }
  .bbi-channel-item-model {
    font-size: 11px;
  }
  /* 渠道彈窗底部:測試按鈕窄屏只顯短版「測試」,PC 顯完整「測試渠道」 */
  .bbi-btn-label-full {
    display: none;
  }
  .bbi-btn-label-short {
    display: inline;
  }
}
</style>
