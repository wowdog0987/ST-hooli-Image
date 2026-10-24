<script setup lang="ts">
import {
  CHATU8_SETTINGS_KEY,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  importVibesFromChatu8,
  planPrefixGroups,
  type Chatu8ArtistDetectInfo,
  type Chatu8ArtistImportResult,
  type Chatu8DetectInfo,
} from '@/backends/chatu8Vibe';
import {
  buildNaiv4vibe,
  BUILTIN_NAI_ARTISTS,
  encodeVibeImage,
  isBuiltinNaiArtist,
  isNai5,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiSamplers,
  naiSupportsVibes,
  NAI_NOISE_SCHEDULES,
  parseNaiv4vibe,
  testNaiConnection,
  vibeModelKey,
} from '@/backends/nai';
import {
  clampVibeStrength,
  deleteVibeData,
  loadVibeData,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import NaiArtistManager from '@/pages/backend/panels/NaiArtistManager.vue';
import { backendStatus } from '@/generate';
import { acquireNaiSlot } from '@/floor/genQueue';
import { makeJpegThumbnail } from '@/st/imageFile';
import { deleteUserImage } from '@/st/images';
import {
  groupKey,
  groupVibes,
  isGroupActive,
  matchVibe,
  GROUP_PREFIX,
  NEW_GROUP,
  UNGROUPED,
  type VibeGroup,
} from '@/backends/vibeGroups';
import Collapsible from '@/components/Collapsible.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { getContext } from '@/st/context';
import {
  activeNaiArtist,
  activeNaiEndpoint,
  effectiveNai,
  isOfficialNaiEndpoint,
  newNaiArtist,
  newNaiEndpoint,
  NAI_MODELS,
  NAI_OFFICIAL_URL,
  settings,
  type NaiArtistPreset,
  type NaiEndpoint,
  type NaiVibe,
} from '@/state/settings';
import { computed, nextTick, onMounted, ref } from 'vue';

/** 本渠道是否為當前出圖渠道;「使用此渠道」按鈕與設定頁選擇器、頁籤徽標同屬一個開關。 */
const inUse = computed(() => settings.defaultBackend === 'nai');
/** 還沒設定好(或還沒選它出圖)時,新手設定步驟預設展開。 */
const needsSetup = settings.defaultBackend !== 'nai' || !backendStatus().configured;

const testing = ref(false);
const showKey = ref(false);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    // 測當前選中那條接入點(而非渠道級存量 url/key),與出圖同一份連線
    const result = await testNaiConnection(effectiveNai());
    toastr.success(result.message, `NAI 連線 · ${endpoint.value.name}`);
  } catch (error) {
    toastr.error(errorMessage(error), `NAI 連線失敗 · ${endpoint.value.name}`);
  } finally {
    testing.value = false;
  }
}

/* ============ 接入點庫(地址 + 金鑰;形制照搬下方畫師序列) ============ */

/**
 * 多條接入點解決的是「公益站換著用」:同一套出圖引數,換個出口。
 * 故這裡只管 url/key,模型/取樣器/尺寸一概留在渠道級,切站不用重配。
 */
const endpoint = computed<NaiEndpoint>(() => activeNaiEndpoint());

/** 官方那條只讀:名字/地址不給改、不給刪,複製出來的副本才隨便改。 */
const isOfficialEndpoint = computed(() => isOfficialNaiEndpoint(endpoint.value.id));

const endpointOptions = computed(() =>
  settings.nai.endpoints.map(e => ({ value: e.id, label: e.name || '未命名接入點' })),
);

/** 下拉取「實際生效的那條」而非存的 id:懸空時 activeNaiEndpoint 回落首條,下拉要跟著顯示。 */
const activeEndpointId = computed<string>({
  get: () => endpoint.value.id,
  set: id => {
    settings.nai.activeEndpointId = id;
  },
});

/** 改名低頻:平時只顯示下拉,點「改名」才把選擇器原地換成輸入框(同畫師序列)。 */
const renamingEndpoint = ref(false);
const endpointNameDraft = ref('');
const endpointNameInput = ref<HTMLInputElement | null>(null);
const endpointDeleteOpen = ref(false);

function startRenameEndpoint() {
  if (isOfficialEndpoint.value) return; // 官方條只讀(按鈕已停用,雙保險)
  endpointNameDraft.value = endpoint.value.name;
  renamingEndpoint.value = true;
  nextTick(() => endpointNameInput.value?.focus());
}

/** Enter / 失焦都算確認;Esc 直接置 false 不經過這裡,即為取消。 */
function commitRenameEndpoint() {
  if (renamingEndpoint.value && !isOfficialEndpoint.value) {
    endpoint.value.name = endpointNameDraft.value.trim() || endpoint.value.name;
  }
  renamingEndpoint.value = false;
}

function addEndpoint() {
  const preset = newNaiEndpoint(`接入點 ${settings.nai.endpoints.length + 1}`);
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function duplicateEndpoint() {
  // 官方條也走這裡:複製出來的是普通條目,地址可改 —— 這是「照著官方改個映象」的捷徑
  const src = endpoint.value;
  const preset: NaiEndpoint = { ...newNaiEndpoint(), name: `${src.name} 副本`, url: src.url, key: src.key };
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function confirmRemoveEndpoint() {
  endpointDeleteOpen.value = false;
  if (isOfficialEndpoint.value) return; // 官方條不可刪:endpoints 恆非空靠它保底
  const list = settings.nai.endpoints;
  const index = list.findIndex(e => e.id === endpoint.value.id);
  if (index < 0) return;
  list.splice(index, 1);
  // 接位到原位置那一條(已是最後一條則退一格)。**不**像畫師串那樣回落空串:
  // 地址是必需品,空了就出不了圖 —— 與工作流庫同口徑。
  settings.nai.activeEndpointId = list[Math.min(index, list.length - 1)].id;
}

/* ============ 畫師串庫(形制照搬 ComfyUI 工作流庫) ============ */

/**
 * 當前選中的畫師串;null = 不使用(庫為空、使用者主動選了「不使用」、或 id 懸空)。
 * settings 是 reactive,直接把它的欄位綁 v-model 即可就地編輯。
 */
const artist = computed<NaiArtistPreset | null>(() => activeNaiArtist());

/** 當前是否 V5 模型:控制畫師串編輯區的 V5 差異提醒。 */
const isV5Model = computed(() => isNai5(settings.nai.model));

/** 「不使用」的下拉值。preset id 恆為 art_* / bi_* 形狀,空串不會與任何一條相撞,無需裝箱。 */
const NO_ARTIST = '';

const artistOptions = computed(() => [
  { value: NO_ARTIST, label: '不使用' },
  // 內建配方排使用者庫前面:新使用者預設選中的是內建條,放在「不使用」旁邊最順;
  // 名稱後括注內建,與使用者自建的同名條目區分開
  ...BUILTIN_NAI_ARTISTS.map(a => ({ value: a.id, label: `${a.name}(內建)` })),
  ...settings.nai.artistPresets.map(a => ({ value: a.id, label: a.name || '未命名畫師串' })),
]);

/**
 * 下拉的值取「實際生效的那一條」而非存的 id:存的 id 懸空時 activeNaiArtist 返回 null,
 * 下拉也該跟著顯示「不使用」,不能顯示空白。
 */
const activeArtistId = computed<string>({
  get: () => artist.value?.id ?? NO_ARTIST,
  set: id => {
    settings.nai.activeArtistId = id;
  },
});

/** 改名/複製/刪除都只對「真的選中了一條」有意義;選「不使用」時一律停用。 */
const hasArtist = computed(() => artist.value !== null);

/** 當前選中的是內建配方:只讀(改名/刪除/內容編輯停用),「複製」是自定義的唯一入口。 */
const isBuiltinArtist = computed(() =>
  artist.value ? isBuiltinNaiArtist(artist.value.id) : false,
);

/** 改名是低頻操作:平時只顯示下拉,點「改名」才把選擇器原地換成輸入框。 */
const renamingArtist = ref(false);
const artistNameDraft = ref('');
const artistNameInput = ref<HTMLInputElement | null>(null);
const artistDeleteOpen = ref(false);
/** 管理器彈窗:搜尋/預覽圖/勾選批次刪除都在那邊,下拉這裡只留高頻切換。 */
const artistManagerOpen = ref(false);

function startRenameArtist() {
  if (!artist.value || isBuiltinArtist.value) return; // 內建只讀(按鈕已停用,雙保險)
  artistNameDraft.value = artist.value.name;
  renamingArtist.value = true;
  nextTick(() => artistNameInput.value?.focus());
}

/** Enter / 失焦都算確認;Esc 直接置 renamingArtist=false 不經過這裡,即為取消。 */
function commitRenameArtist() {
  if (renamingArtist.value && artist.value) artist.value.name = artistNameDraft.value.trim();
  renamingArtist.value = false;
}

function addArtist() {
  const preset = newNaiArtist(`畫師串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

function duplicateArtist() {
  const src = artist.value;
  if (!src) return;
  // 只換 id 與名字;id 生成仍由 settings 統一口徑。
  // 內建配方也走這裡:複製出來的副本是普通使用者條目,隨便改——這是內建條唯一的自定義路徑。
  // 顯式逐欄位複製,不帶 previewPath:預覽檔案隨原條目刪除,共指一個路徑會讓副本日後破圖。
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

async function confirmRemoveArtist() {
  artistDeleteOpen.value = false;
  const list = settings.nai.artistPresets;
  const index = list.findIndex(a => a.id === artist.value?.id);
  if (index < 0) return;
  // 預覽圖檔案 best-effort 連帶清理(與管理器刪除同口徑:檔案刪不掉不阻塞刪條目)
  const previewPath = list[index].previewPath;
  if (previewPath) {
    try {
      await deleteUserImage(previewPath);
    } catch (error) {
      toastr.warning(`條目已刪除,但預覽圖檔案清理失敗：${errorMessage(error)}`, '畫師串');
    }
  }
  list.splice(index, 1);
  // 接位到原位置那一條(已是最後一條則退一格);刪空了就回「不使用」——
  // `?? ''` 正是畫師串庫與工作流庫的分水嶺(那邊恆非空、回落 [0]),不能省。
  settings.nai.activeArtistId = list[Math.min(index, list.length - 1)]?.id ?? '';
}

/* ============ 從智繪姬遷移提示詞預設 ============ */

/**
 * 智繪姬(st-chatu8)的提示詞預設整批搬過來,對映與智繪姬拼裝位置一致:
 * 前置固定正向 → 畫師串,後置固定正向 → 正面質量詞,固定負向 → 負面提示詞(前面拼上當前模型官方基線)。
 * 與 vibe 遷移同原則:只建副本、不改源資料;同名條目重新匯入會覆蓋更新
 * (舊版遷移把正向整體塞進畫師串的條目,重導即被修好),內容完全相同的跳過,隨時可再來。
 * 純邏輯在 chatu8Vibe.ts(collect/detect/import 三件套),這裡只做檢測展示、彈窗預覽與落盤。
 *
 * 刻意不做「還剩 N 個可匯入」的常駐提示:去重鍵是名字+內容,使用者改過或刪過
 * 本地副本後鍵就對不上,提示會反覆復活,很吵。入口收進下方「從智繪姬遷移」
 * 摺疊區,手動點開彈窗時才算預覽,有沒有新預設一看便知。
 */
const chatu8ArtistDetect = ref<Chatu8ArtistDetectInfo>({ found: false, total: 0 });
/** 彈窗開啟時算一次的預覽結果(純函式,不落盤);plans 逐條帶徽標狀態。 */
const artistImportResult = ref<Chatu8ArtistImportResult | null>(null);
const artistImportOpen = ref(false);
/** 匯入後是否把智繪姬當前使用的預設設為虎哩繪當前畫師串。 */
const switchActiveArtist = ref(true);

const chatu8ActiveRef = computed(() => artistImportResult.value?.plans.find(p => p.active) ?? null);

function openArtistImport() {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  artistImportResult.value = importArtistsFromChatu8(settings.nai.artistPresets, chatu8, settings.nai.model);
  switchActiveArtist.value = true;
  artistImportOpen.value = true;
}

/** 純同步:結果在開啟彈窗時就算好了,確認只是 push/覆蓋 + 可選切換。 */
function runArtistImport() {
  const result = artistImportResult.value;
  artistImportOpen.value = false;
  if (!result || (result.imported === 0 && result.overwritten === 0)) return;
  for (const plan of result.plans) {
    if (plan.state === 'import') {
      settings.nai.artistPresets.push(plan.preset!);
    } else if (plan.state === 'overwrite') {
      const target = settings.nai.artistPresets.find(p => p.id === plan.targetId);
      if (target && plan.preset) {
        target.prompt = plan.preset.prompt;
        target.quality = plan.preset.quality;
        target.negative = plan.preset.negative;
      }
    }
  }
  if (switchActiveArtist.value && result.activeArtistId) {
    settings.nai.activeArtistId = result.activeArtistId;
  }
  const parts = [`新增 ${result.imported} 個`];
  if (result.overwritten) parts.push(`覆蓋更新 ${result.overwritten} 個`);
  if (result.duplicates) parts.push(`相同跳過 ${result.duplicates}`);
  if (switchActiveArtist.value && result.activeArtistId) {
    parts.push('已切換為智繪姬當前使用的預設');
  }
  toastr.success(parts.join(', '), '從智繪姬匯入');
  artistImportResult.value = null;
}

/* ============ 提示詞:正/負面詞分兩級——畫師串綁定值 → 渠道覆蓋值 → 內建預設 ============ */

/**
 * 一條正/負面詞的編輯目標;渠道級與畫師串綁定級共用同一個彈窗。
 *
 * fallback = 留空時跟隨的下一級取值(渠道級 → 模型官方詞;綁定級 → 渠道值 → 官方詞)。
 * 開啟彈窗預填它——框裡空著就是把「看不到實際生效了什麼」的老問題原地搬家;
 * 儲存時與回落一致就存空串(與設定頁 saveTagPrompt 同口徑:不把下一級的值冗餘存進來,
 * 保留「跟隨」語義,下一級變了能跟著變)。
 *
 * fallback 必須是函式而非常量:它隨 settings.nai.model / 渠道覆蓋值變,要在讀取時才求值。
 */
interface NaiPromptTarget {
  key: 'quality' | 'negative';
  label: string;
  hint: string;
  /** 內建配方的綁定位只讀:彈窗純檢視,不給儲存(寫進模組常量就糟了)。 */
  readonly?: boolean;
  fallback: () => string;
  read: () => string;
  write: (v: string) => void;
}

/** 渠道級兩條:畫師串未綁定對應欄位時生效,再留空則按模型取官方詞。 */
const CHANNEL_PROMPT_TARGETS: NaiPromptTarget[] = [
  {
    key: 'quality',
    label: '正面質量詞',
    hint: '拼在畫面 tag 之後(整體順序:畫師串 → 畫面 tag → 質量詞)。畫師串裡設定了質量詞時,會用畫師串那份,這裡的不生效。',
    fallback: () => naiDefaultQualityTags(settings.nai.model),
    read: () => settings.nai.qualityTags,
    write: v => (settings.nai.qualityTags = v),
  },
  {
    key: 'negative',
    label: '負面提示詞',
    hint: '留空 = 按模型取官方負面詞;要額外排除什麼,直接往這一份裡接。畫師串裡設定了負面詞時,會用畫師串那份,這裡的不生效。',
    fallback: () => naiDefaultUndesired(settings.nai.model),
    read: () => settings.nai.undesiredContent,
    write: v => (settings.nai.undesiredContent = v),
  },
];

/**
 * 當前畫師串的兩個綁定位;read/write 直接落在選中條目上(settings 是 reactive,就地編輯)。
 * 只在真的選中了一條時存在(選「不使用」時沒有綁定物件,列表整個不渲染)。
 */
const artistBoundTargets = computed<NaiPromptTarget[]>(() => {
  const a = artist.value;
  if (!a) return [];
  const readonly = isBuiltinArtist.value;
  return [
    {
      key: 'quality',
      label: '正面質量詞',
      readonly,
      hint: readonly
        ? '內建畫師串的綁定位隨外掛版本更新,不可改;複製為我的畫師串後可自定義。留空 = 用渠道級設定(渠道級也留空,則按模型取官方詞)。'
        : '這份質量詞隨當前畫師串一起切換。留空 = 用渠道級設定(渠道級也留空,則按模型取官方詞)。',
      fallback: () => settings.nai.qualityTags.trim() || naiDefaultQualityTags(settings.nai.model),
      read: () => a.quality,
      write: v => (a.quality = v),
    },
    {
      key: 'negative',
      label: '負面提示詞',
      readonly,
      hint: readonly
        ? '內建畫師串的綁定位隨外掛版本更新,不可改;複製為我的畫師串後可自定義。留空 = 用渠道級設定(渠道級也留空,則按模型取官方負面詞)。'
        : '這份負面詞隨當前畫師串一起切換。留空 = 用渠道級設定(渠道級也留空,則按模型取官方負面詞)。',
      fallback: () =>
        settings.nai.undesiredContent.trim() || naiDefaultUndesired(settings.nai.model),
      read: () => a.negative,
      write: v => (a.negative = v),
    },
  ];
});

/** 該條是否已有自定義值(非空即視為覆蓋下一級)。 */
function isTargetCustom(target: NaiPromptTarget): boolean {
  return target.read().trim().length > 0;
}

/** 當前畫師串是否綁定了該欄位——綁定時渠道值被覆蓋,渠道列表的徽標要說出這件事。 */
function isShadowedByArtist(key: NaiPromptTarget['key']): boolean {
  const a = artist.value;
  if (!a) return false;
  return key === 'quality' ? !!a.quality.trim() : !!a.negative.trim();
}

// 正在編輯的那條;draft 是草稿,點「完成」才寫回 settings(取消則丟棄)。
const editingNaiPrompt = ref<NaiPromptTarget | null>(null);
const naiPromptDraft = ref('');

function openNaiPrompt(target: NaiPromptTarget) {
  editingNaiPrompt.value = target;
  // 已自定義→載入使用者內容;未自定義→預填下一級回落值,方便直接在其上改
  naiPromptDraft.value = target.read().trim() || target.fallback();
}
function closeNaiPrompt() {
  editingNaiPrompt.value = null;
  naiPromptDraft.value = '';
}
function saveNaiPrompt() {
  const target = editingNaiPrompt.value;
  if (!target || target.readonly) return; // 內建配方的綁定位只讀(按鈕已隱藏,雙保險)
  const v = naiPromptDraft.value.trim();
  target.write(v === target.fallback().trim() ? '' : naiPromptDraft.value);
  closeNaiPrompt();
}
/** 「恢復預設」:把草稿重置回落值(儲存後即變回「跟隨下一級」) */
function resetNaiPromptDraft() {
  const target = editingNaiPrompt.value;
  if (target) naiPromptDraft.value = target.fallback();
}

/* ============ Vibe 庫 ============ */

const vibeEncoding = ref(false);
const vibeFileInput = ref<HTMLInputElement | null>(null);
const vibeImportInput = ref<HTMLInputElement | null>(null);

let vibeSeq = 0;

/** 當前模型的 vibe 編碼 key;vibe 缺此 key 時生成會被跳過,列表裡給「補編碼」入口。 */
const currentVibeKey = computed(() => vibeModelKey(settings.nai.model));
const vibesSupported = computed(() => naiSupportsVibes(settings.nai.model));
const samplerOptions = computed(() => naiSamplers(settings.nai.model));

/** BbiSelect 的 modelValue 是 string,而 nai.model 是字面量聯合;這層 get/set 只為搭橋。
 *  寫入前對一遍 NAI_MODELS:下拉本就只發合法值,但少了這句型別斷言就是空口無憑。 */
const modelSel = computed<string>({
  get: () => settings.nai.model,
  set: v => {
    const hit = NAI_MODELS.find(m => m.value === v);
    if (hit) settings.nai.model = hit.value;
  },
});

/** 生成 vibe 列表縮圖(最長邊 96px 的 jpeg dataURL);失敗回空串,由入庫方按「無縮圖」處理。 */
async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    return await makeJpegThumbnail(dataUrl, 96);
  } catch {
    return '';
  }
}

/**
 * 取閘門槽位跑一次 vibe 編碼。
 *
 * 編碼是一次真實的 NAI 請求,所以與樓層卡片共用同一個閘門(floor/genQueue.ts):
 * 否則「一邊出圖一邊編碼」在賬號上就是兩條併發,且完全繞過 429 冷卻。
 * 代價是出圖在跑時點編碼會先等出圖完 —— 這是對的,按鈕那邊有 vibeEncoding 轉圈提示。
 */
async function encodeVibeGated(imageBase64: string): Promise<string> {
  const release = await acquireNaiSlot();
  try {
    return await encodeVibeImage(effectiveNai(), imageBase64, settings.nai.model);
  } finally {
    release();
  }
}

/** 上傳參考圖 → 調 /ai/encode-vibe 編碼(按當前模型)→ 入庫。 */
async function onVibeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('讀取圖片失敗'));
      reader.readAsDataURL(file);
    });
    const imageBase64 = dataUrl.split(',')[1] ?? '';
    const encoding = await encodeVibeGated(imageBase64);
    const thumbnail = await makeThumbnail(dataUrl);
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = {
      image: imageBase64,
      thumbnail,
      encodings: { [currentVibeKey.value]: { encoding, infoExtracted: 1 } },
    };
    const paths = await saveVibeFiles(data, null, id);
    settings.nai.vibes.push(
      vibeMetaFromData(
        id,
        file.name.replace(/\.[^.]+$/, '') || `Vibe ${settings.nai.vibes.length + 1}`,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        0.6,
        true,
      ),
    );
    toastr.success(`已按 ${settings.nai.model} 編碼並加入 Vibe 庫`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 編碼失敗');
  } finally {
    vibeEncoding.value = false;
  }
}

/**  vibe 缺當前模型編碼時單獨補(切換模型後常見)。 */
async function reencodeVibe(vibe: NaiVibe) {
  if (!vibe.hasImage || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const data = await loadVibeData(vibe);
    if (!data.image) throw new Error('該 Vibe 沒有參考原圖');
    const encoding = await encodeVibeGated(data.image);
    data.encodings[currentVibeKey.value] = { encoding, infoExtracted: 1 };
    const paths = await saveVibeFiles(data, vibe, vibe.id);
    vibe.dataPath = paths.dataPath;
    vibe.thumbnailPath = paths.thumbnailPath;
    vibe.modelKeys = Object.keys(data.encodings);
    vibe.fingerprint = vibeFingerprint(data.encodings);
    toastr.success(`「${vibe.name}」已補 ${settings.nai.model} 編碼`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 編碼失敗');
  } finally {
    vibeEncoding.value = false;
  }
}

/* ============ Vibe 分組 ============ */

/** 歸攏/搜尋/生效判定的純邏輯在 backends/vibeGroups.ts,此處只做互動與落盤。 */
const vibeSearch = ref('');
/** 收起的組 key 集合(預設全展開;只存「收起」的,新建組自然是展開的)。 */
const collapsedGroups = ref<Set<string>>(new Set());

const vibeGroups = computed(() => groupVibes(settings.nai.vibes, vibeSearch.value));

/** 搜尋命中總數:用於「沒有匹配」空態,不必再算一遍列表。 */
const matchedCount = computed(() =>
  settings.nai.vibes.reduce((n, v) => n + (matchVibe(v, vibeSearch.value) ? 1 : 0), 0),
);

/** 庫裡已有的組名(去重,給「移到分組」下拉用;基於全庫而非搜尋結果)。 */
const groupNames = computed(() => {
  const names = new Set<string>();
  for (const vibe of settings.nai.vibes) {
    const name = vibe.group.trim();
    if (name) names.add(name);
  }
  return [...names];
});

/** 單條 vibe 的「所屬分組」下拉項:未分組 + 已有組 + 新建(組名裝箱,避免與哨兵撞名)。 */
const groupOptions = computed(() => [
  { value: UNGROUPED, label: '未分組' },
  ...groupNames.value.map(name => ({ value: `${GROUP_PREFIX}${name}`, label: name })),
  { value: NEW_GROUP, label: '＋ 新建分組…' },
]);

/** 選「新建分組」時就地問一個名字;取消或空名則維持原值(下拉是受控的,得回寫)。 */
function onGroupPick(vibe: NaiVibe, value: string) {
  if (value === UNGROUPED) {
    vibe.group = '';
    return;
  }
  if (value.startsWith(GROUP_PREFIX)) {
    vibe.group = value.slice(GROUP_PREFIX.length);
    return;
  }
  const name = window.prompt('新分組名稱')?.trim();
  if (name) vibe.group = name;
}

function isGroupCollapsed(key: string): boolean {
  return collapsedGroups.value.has(key);
}

function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (!next.delete(key)) next.add(key);
  collapsedGroups.value = next;
}

function groupActive(group: VibeGroup): boolean {
  return isGroupActive(group, settings.nai.vibes);
}

/** 只開這組:清掉組外的勾選並開啟本組。解決「換一套搭配」要逐條點的痛點。 */
function soloGroup(group: VibeGroup) {
  const ids = new Set(group.all.map(v => v.id));
  for (const vibe of settings.nai.vibes) vibe.enabled = ids.has(vibe.id);
}

/** 全開/全關只動本組,組外不碰——想疊加兩組就各點一次「全開」。 */
function setGroupEnabled(group: VibeGroup, enabled: boolean) {
  for (const vibe of group.all) vibe.enabled = enabled;
}

const enabledCount = computed(() => settings.nai.vibes.filter(v => v.enabled).length);

function groupEnabledCount(group: VibeGroup): number {
  return group.all.filter(v => v.enabled).length;
}

/** 重新命名整組:對成員 group 欄位批次賦值,不存在懸空引用。 */
function renameGroup(group: VibeGroup) {
  if (!group.name) return;
  const name = window.prompt('重新命名分組', group.name)?.trim();
  if (!name || name === group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = name;
  }
  // 收起狀態跟著改名走(集合裡存的是裝箱 key),否則改完名字會莫名展開
  const from = groupKey(group.name);
  if (collapsedGroups.value.has(from)) {
    const next = new Set(collapsedGroups.value);
    next.delete(from);
    next.add(groupKey(name));
    collapsedGroups.value = next;
  }
}

/** 解散分組:只清 group 欄位,vibe 本體與啟用狀態都不動(不是刪除)。 */
function dissolveGroup(group: VibeGroup) {
  if (!group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = '';
  }
}

/**
 * 舊版從智繪姬遷移時把組名拼進了顯示名(「組名 · 原名」),分組結構因此丟失。
 * 這裡按字首還原:只動未分組的條目,不覆蓋使用者已手工分好的組。
 * 按鈕僅在真有可整理的條目時出現——沒得整理時擺一顆點不出反應的按鈕不如不擺。
 */
const prefixGroupPlans = computed(() => planPrefixGroups(settings.nai.vibes));

function applyPrefixGroups() {
  const plans = prefixGroupPlans.value;
  if (!plans.length) return;
  const byId = new Map(settings.nai.vibes.map(v => [v.id, v]));
  for (const plan of plans) {
    const vibe = byId.get(plan.id);
    if (!vibe) continue;
    vibe.group = plan.group;
    vibe.name = plan.name;
  }
  const groups = new Set(plans.map(p => p.group)).size;
  toastr.success(`已把 ${plans.length} 個 Vibe 整理進 ${groups} 個分組`, 'Vibe');
}

/* ============ 從智繪姬遷移 ============ */

/**
 * 智繪姬 vibe 檢測:面板掛載時做一次(讀的是 settings 裡的引用列表,同步廉價)。
 * 不做「只問一次」那套:區塊常駐,遷移冪等(內容指紋去重),使用者隨時可以再來。
 */
const chatu8Detect = ref<Chatu8DetectInfo>({ found: false, total: 0, presets: 0, groups: 0 });
onMounted(() => {
  chatu8Detect.value = detectChatu8Vibes(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
  chatu8ArtistDetect.value = detectChatu8Artists(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
});

const migrateConfirmOpen = ref(false);
const migrating = ref(false);
const migrateMsg = ref('');

async function runMigrate() {
  migrateConfirmOpen.value = false;
  if (migrating.value) return;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const result = await importVibesFromChatu8(settings.nai.vibes, {
      onProgress: (current, total) => {
        migrateMsg.value = `正在遷移 ${current}/${total}…`;
      },
    });
    settings.nai.vibes.push(...result.vibes);
    const parts = [`新增 ${result.imported} 個`];
    if (result.duplicates) parts.push(`重複跳過 ${result.duplicates}`);
    if (result.failed) parts.push(`失敗 ${result.failed}`);
    migrateMsg.value = `遷移完成：${parts.join(' / ')}。`;
    if (result.imported) migrateMsg.value += '新遷移的 Vibe 預設未啟用，請按需開啟。';
    if (result.failed) migrateMsg.value += '失敗項可能不在本機瀏覽器，或儲存檔案時出錯。';
    toastr.success(migrateMsg.value, '從智繪姬遷移');
  } catch (error) {
    migrateMsg.value = `遷移失敗：${errorMessage(error)}`;
  } finally {
    migrating.value = false;
  }
}

async function onVibeImportChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = parseNaiv4vibe(await file.text());
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
    const paths = await saveVibeFiles(data, null, id);
    settings.nai.vibes.push(
      vibeMetaFromData(id, parsed.name, paths.dataPath, paths.thumbnailPath, data, parsed.strength, true),
    );
    toastr.success(`已匯入「${parsed.name}」`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 匯入失敗');
  }
}

async function exportVibe(vibe: NaiVibe) {
  try {
    const json = await buildNaiv4vibe(vibe, await loadVibeData(vibe));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vibe.name || 'vibe'}.naiv4vibe`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 匯出失敗');
  }
}

/**
 * 強度取值:滑塊與數字框共用 clampVibeStrength(與設定反序列化、vibe 匯入同一口徑)。
 * 滑塊步進 0.01 只是「拖著好用」的粒度,數字框 step="any" 才是真正的自由填值——
 * 想要 0.375 就填 0.375,不再被步進吸附到 5 的倍數上。
 */
function setVibeStrength(vibe: NaiVibe, raw: unknown) {
  vibe.strength = clampVibeStrength(raw, vibe.strength);
}

/**
 * 數字框走 change(而非 input):中途輸入 "0." / "-" 這類殘缺串不該立刻被夾成 0。
 * 夾取後回寫 input.value——填了 5 會被夾到 1,而當強度本來就是 1 時模型值沒變、
 * Vue 不會重渲染,框裡就會留著一個騙人的 "5"。
 */
function commitVibeStrength(vibe: NaiVibe, event: Event) {
  const input = event.target as HTMLInputElement;
  setVibeStrength(vibe, input.value);
  input.value = String(vibe.strength);
}

async function removeVibe(vibe: NaiVibe) {
  let deleteError: unknown = null;
  try {
    await deleteVibeData(vibe);
  } catch (error) {
    deleteError = error;
  }
  const index = settings.nai.vibes.indexOf(vibe);
  if (index >= 0) settings.nai.vibes.splice(index, 1);
  if (deleteError) toastr.warning(`索引已刪除，但檔案清理失敗：${errorMessage(deleteError)}`, 'Vibe');
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      NovelAI 生圖介面。地址預設為官方,填第三方相容站(映象/轉發)即走第三方,協議一致。
    </p>

    <div class="bbi-sections">
      <Collapsible title="第一次使用？照這幾步設定" :open="needsSetup">
        <ol class="quickstart">
          <li>到 NovelAI 官網登入 → 左下角齒輪「User Settings」→「Account」→「Get Persistent API Token」，複製產生的 Token。</li>
          <li>展開下方「配置」，在 API Key 貼上 Token（官方網址已內建，不用改），按「測試連線」，再按「使用此渠道出圖」。</li>
          <li>選模型：4.5 只看 tag，V5 也讀得懂自然語言描述，兩者都能用。</li>
          <li>回到聊天，AI 回覆後會自動配圖；也可以按樓層選單「⋯」裡的調色盤按鈕手動加一張。</li>
        </ol>
      </Collapsible>

      <Collapsible title="配置" :open="false">
        <!-- 接入點庫:公益站換著用的人不止一個出口,但換站只換地址+金鑰,
             模型/取樣器/尺寸等出圖引數一概留在下面,渠道級共用,切站不用重配 -->
        <div class="art-row">
          <span class="bbi-field-label">接入點</span>
          <input
            v-if="renamingEndpoint"
            ref="endpointNameInput"
            class="bbi-input"
            type="text"
            v-model="endpointNameDraft"
            placeholder="接入點名稱"
            spellcheck="false"
            title="Enter 確認，Esc 取消"
            @keydown.enter.prevent="commitRenameEndpoint"
            @keydown.esc.stop.prevent="renamingEndpoint = false"
            @blur="commitRenameEndpoint"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeEndpointId"
            :options="endpointOptions"
            aria-label="當前接入點"
          />
          <span v-if="!renamingEndpoint" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? '官方接入點不可改名' : '重新命名當前接入點'"
              aria-label="重新命名當前接入點"
              @click="startRenameEndpoint"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="新建一條空接入點"
              aria-label="新建一條空接入點"
              @click="addEndpoint"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :title="
                isOfficialEndpoint
                  ? '照官方複製一條,複製出來的地址可以改'
                  : '複製當前接入點(含地址與金鑰)'
              "
              aria-label="複製當前接入點"
              @click="duplicateEndpoint"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? '官方接入點不可刪除' : '刪除當前接入點'"
              aria-label="刪除當前接入點"
              @click="endpointDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">介面地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="endpoint.url"
            :readonly="isOfficialEndpoint"
            :placeholder="NAI_OFFICIAL_URL"
            spellcheck="false"
            :title="isOfficialEndpoint ? '官方接入點地址固定,不可修改' : ''"
          />
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? '官方接入點,地址固定;要用第三方站請點上方「+」新建一條。'
                : '第三方站填域名即可,自動補全 /ai 端點。'
            }}
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="endpoint.key"
              placeholder="nai-..."
              spellcheck="false"
            />
            <button
              class="bbi-btn"
              type="button"
              :title="showKey ? '隱藏' : '顯示'"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
          <!-- key 隨條目走而非渠道級共用:公益站各有各的 key,共用一份等於每次換站都要重填 -->
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? '在 NovelAI 設定頁生成。每條接入點各存各的 key。'
                : '該站自己的 key;每條接入點各存各的,切回官方不會串。'
            }}
          </p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 當前出圖渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 書寫規範會切到 NAI"
            @click="settings.defaultBackend = 'nai'"
          >
            使用此渠道出圖
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '連線中…' : '測試連線' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="提示詞" :open="false">
        <!-- 畫師串庫:形制與 ComfyUI 工作流庫一致,多一個「不使用」選項 -->
        <div class="art-row">
          <span class="bbi-field-label">畫師串</span>
          <input
            v-if="renamingArtist"
            ref="artistNameInput"
            class="bbi-input"
            type="text"
            v-model="artistNameDraft"
            placeholder="畫師串名稱"
            spellcheck="false"
            title="Enter 確認，Esc 取消"
            @keydown.enter.prevent="commitRenameArtist"
            @keydown.esc.stop.prevent="renamingArtist = false"
            @blur="commitRenameArtist"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeArtistId"
            :options="artistOptions"
            aria-label="當前畫師串"
          />
          <span v-if="!renamingArtist" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="管理畫師串庫:搜尋、預覽圖、批次刪除"
              aria-label="管理畫師串庫"
              @click="artistManagerOpen = true"
            >
              <Icon name="grid" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? '未選中畫師串'
                  : isBuiltinArtist
                    ? '內建畫師串不可改名,點複製建一條自己的'
                    : '重新命名當前畫師串'
              "
              aria-label="重新命名當前畫師串"
              @click="startRenameArtist"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="新建一條空畫師串"
              aria-label="新建一條空畫師串"
              @click="addArtist"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist"
              :title="
                !hasArtist
                  ? '未選中畫師串'
                  : isBuiltinArtist
                    ? '複製為我的畫師串,複製出來的可以隨便改'
                    : '複製當前畫師串'
              "
              aria-label="複製當前畫師串"
              @click="duplicateArtist"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? '未選中畫師串'
                  : isBuiltinArtist
                    ? '內建畫師串不可刪除,它會隨外掛版本更新'
                    : '刪除當前畫師串'
              "
              aria-label="刪除當前畫師串"
              @click="artistDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <!-- 從智繪姬匯入提示詞預設的入口在下方「從智繪姬遷移」摺疊區,這裡不做常駐提示 -->

        <!-- 內容內聯編輯:畫師串通常就幾個 tag,讓「選中哪條」與「這條寫了什麼」一眼同框 -->
        <template v-if="artist">
          <BbiTextarea
            v-model="artist.prompt"
            :rows="3"
            :max-rows="8"
            mono
            :readonly="isBuiltinArtist"
            placeholder="artist:xxx, artist:yyy"
          />
          <p v-if="isBuiltinArtist" class="bbi-field-hint art-hint">
            內建畫師串隨外掛版本更新,不可直接改;點上方複製按鈕建一條自己的再改。
          </p>
          <!-- 僅 V5 模型下提醒:V5 與 4.5 的畫師串響應差異大,4.5 及以下不需要這條噪音 -->
          <p v-if="isV5Model" class="bbi-field-hint art-hint art-hint-warn">
            NAI 5 對畫師串的響應與 4.5 差異很大,舊畫師串直接套用效果可能跑偏,建議重新除錯。
          </p>

          <!-- 隨畫師串一起切換的正/負面詞:設定了覆蓋下面渠道級,沒設定就用下面的 -->
          <ul class="bbi-prompt-list art-bound-list">
            <li v-for="t in artistBoundTargets" :key="t.key" class="bbi-prompt-item">
              <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
                <span class="bbi-prompt-name">{{ t.label }}</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                  {{ isTargetCustom(t) ? '已設定' : '未設定' }}
                </span>
                <Icon name="edit" class="bbi-prompt-edit" />
              </button>
            </li>
          </ul>
          <p class="bbi-field-hint art-hint">
            這裡設定的提示詞會覆蓋下面的，隨畫師串一起切換;這裡沒設定，就會用下面的。
          </p>
        </template>
        <!-- 不選畫師串時無提示:下拉裡「不使用」已自明 -->

        <hr class="art-divider" />

        <!-- 渠道級質量詞/負面詞:只讀列表行,點行進彈窗編輯(與設定頁「自定義提示詞」同款) -->
        <ul class="bbi-prompt-list">
          <li v-for="t in CHANNEL_PROMPT_TARGETS" :key="t.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
              <span class="bbi-prompt-name">{{ t.label }}</span>
              <span v-if="isShadowedByArtist(t.key)" class="bbi-prompt-state is-shadowed">
                已被畫師串覆蓋
              </span>
              <span v-else class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                {{ isTargetCustom(t) ? '已自定義' : '預設' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
        <p class="bbi-field-hint art-hint">
          畫師串裡沒設定正/負面詞時，就會用這裡的;這裡也留空，則按模型取官方詞。
        </p>
      </Collapsible>

      <Collapsible title="預設引數" :open="false">
        <!-- 語義配對緊湊行:雙欄位行兩列、數字引數行四列;說明統一收進行下的一行 hint -->
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">模型</span>
          </div>
          <BbiSelect
            class="be-select"
            v-model="modelSel"
            :options="NAI_MODELS"
            aria-label="NAI 模型"
          />
        </div>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">豎屏尺寸(寬×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.portraitSize"
              list="nai-portrait-presets"
              placeholder="832×1216"
              spellcheck="false"
            />
            <datalist id="nai-portrait-presets">
              <option value="832×1216">豎版</option>
              <option value="1024×1536">大豎版</option>
              <option value="1024×1024">方圖</option>
            </datalist>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">橫屏尺寸(寬×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.landscapeSize"
              list="nai-landscape-presets"
              placeholder="1216×832"
              spellcheck="false"
            />
            <datalist id="nai-landscape-presets">
              <option value="1216×832">橫版</option>
              <option value="1536×1024">大橫版</option>
              <option value="1024×1024">方圖</option>
            </datalist>
          </div>
        </div>
        <p class="bbi-field-hint">豎屏用於單人、特寫、立繪;橫屏用於群像、遠景、全景;方向由自動 tag 判定。</p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">取樣器</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.sampler"
              :options="samplerOptions"
              aria-label="取樣器"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">噪聲表</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.noiseSchedule"
              :options="NAI_NOISE_SCHEDULES"
              aria-label="噪聲表"
            />
          </div>
        </div>

        <div class="be-row be-row--nums">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步數</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.steps" min="1" max="50" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Scale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.scale"
              min="0"
              max="35"
              step="0.1"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Rescale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.cfgRescale"
              min="0"
              max="1"
              step="0.05"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">種子</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.seed" min="0" />
          </div>
        </div>
        <p class="bbi-field-hint">Scale = 提示詞相關性;Rescale = 相關性調整;種子 0 = 隨機。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Variety Boost(畫面多樣性,按尺寸自動計算)</span>
          <input v-model="settings.nai.varietyBoost" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-num-row">
          <span class="bbi-field-label">同時出圖數</span>
          <input
            class="bbi-input bbi-num"
            type="number"
            v-model.number="settings.nai.concurrency"
            min="1"
            max="4"
          />
        </div>
        <p class="bbi-field-hint">
          NAI 服務端不排隊,併發高容易被限流(429),建議保持 1;超出的請求自動排隊等待。
          被限流時會自動退避重試(最多 3 次),並讓所有排隊任務一起冷卻,不會連著撞上去。
        </p>
      </Collapsible>

      <Collapsible title="Vibe 庫(氛圍轉移)" :open="false">
        <p v-if="vibesSupported" class="bbi-field-hint vibe-hint">
          上傳參考圖,生成時疊加其風格/氛圍;編碼按當前選中的模型進行,會消耗一次介面呼叫。
        </p>
        <p v-else class="bbi-field-hint vibe-hint">
          Current model does not support Vibe Transfer.
        </p>

        <div class="vibe-actions">
          <button class="bbi-btn" type="button" :disabled="vibeEncoding || !vibesSupported" @click="vibeFileInput?.click()">
            <Icon name="plus" />
            {{ vibeEncoding ? '編碼中…' : '上傳圖片編碼' }}
          </button>
          <button class="bbi-btn" type="button" @click="vibeImportInput?.click()">
            <Icon name="download" />
            匯入 .naiv4vibe
          </button>
          <label class="bbi-switch-row vibe-normalize">
            <span class="bbi-field-label">強度歸一化</span>
            <input v-model="settings.nai.normalizeRefStrength" type="checkbox" class="bbi-checkbox" :disabled="!vibesSupported" />
          </label>
          <input ref="vibeFileInput" type="file" accept="image/*" hidden @change="onVibeFileChange" />
          <input ref="vibeImportInput" type="file" accept=".naiv4vibe" hidden @change="onVibeImportChange" />
        </div>

        <p v-if="!settings.nai.vibes.length" class="bbi-field-hint">還沒有 vibe;上傳一張參考圖開始。</p>

        <template v-else>
          <div class="vibe-toolbar">
            <input
              class="bbi-input vibe-search"
              type="search"
              v-model="vibeSearch"
              placeholder="搜尋名稱或分組…"
              spellcheck="false"
              aria-label="搜尋 Vibe"
            />
            <span class="vibe-count">
              共 {{ settings.nai.vibes.length }} 個 · 已啟用 {{ enabledCount }}
            </span>
            <button
              v-if="prefixGroupPlans.length"
              class="bbi-btn bbi-btn-sm"
              type="button"
              title="舊版遷移把組名拼進了名字,點此還原成真正的分組"
              @click="applyPrefixGroups"
            >
              <Icon name="checklist" :size="12" />
              按名稱整理分組({{ prefixGroupPlans.length }})
            </button>
          </div>

          <p v-if="!matchedCount" class="bbi-field-hint">沒有匹配「{{ vibeSearch }}」的 Vibe。</p>

          <div v-for="group in vibeGroups" :key="group.key" class="vibe-group">
            <div class="vibe-group-head">
              <button
                class="vibe-group-toggle"
                type="button"
                :aria-expanded="!isGroupCollapsed(group.key)"
                @click="toggleGroup(group.key)"
              >
                <Icon
                  name="chevron"
                  :size="14"
                  class="vibe-group-chevron"
                  :class="{ 'is-collapsed': isGroupCollapsed(group.key) }"
                />
                <span class="vibe-group-name">{{ group.label }}</span>
                <span class="vibe-group-meta">
                  {{ groupEnabledCount(group) }}/{{ group.all.length }}
                  <template v-if="group.items.length !== group.all.length">
                    · 顯示 {{ group.items.length }}
                  </template>
                </span>
                <span v-if="groupActive(group)" class="bbi-prompt-state vibe-group-active">
                  生效中
                </span>
              </button>
              <span class="vibe-group-ops">
                <button
                  class="bbi-btn bbi-btn-sm bbi-btn-primary"
                  type="button"
                  title="只疊加這一組:關掉組外全部勾選,開啟本組"
                  @click="soloGroup(group)"
                >
                  只開這組
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="開啟本組,不影響其它組(用來疊加多組)"
                  @click="setGroupEnabled(group, true)"
                >
                  全開
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="關閉本組"
                  @click="setGroupEnabled(group, false)"
                >
                  全關
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="重新命名分組"
                  aria-label="重新命名分組"
                  @click="renameGroup(group)"
                >
                  <Icon name="edit" :size="12" />
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="解散分組(只取消歸類,不刪除 Vibe)"
                  aria-label="解散分組"
                  @click="dissolveGroup(group)"
                >
                  <Icon name="close" :size="12" />
                </button>
              </span>
            </div>

            <div v-show="!isGroupCollapsed(group.key)" class="vibe-group-body">
              <div v-for="vibe in group.items" :key="vibe.id" class="vibe-item">
                <img
                  v-if="vibe.thumbnailPath"
                  class="vibe-thumb"
                  :src="vibe.thumbnailPath"
                  :alt="vibe.name"
                  loading="lazy"
                  decoding="async"
                />
                <div v-else class="vibe-thumb vibe-thumb--empty"><Icon name="generate" /></div>
                <div class="vibe-main">
                  <div class="vibe-head">
                    <input class="bbi-input vibe-name" type="text" v-model="vibe.name" spellcheck="false" />
                    <label class="vibe-enable" title="生成時疊加此 vibe">
                      <input v-model="vibe.enabled" type="checkbox" class="bbi-checkbox" />
                      啟用
                    </label>
                  </div>
                  <div class="vibe-strength">
                    <span class="vibe-strength-label">強度</span>
                    <input
                      class="bbi-range"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      :value="vibe.strength"
                      aria-label="強度"
                      @input="setVibeStrength(vibe, ($event.target as HTMLInputElement).value)"
                    />
                    <input
                      class="bbi-input vibe-strength-num"
                      type="number"
                      min="0"
                      max="1"
                      step="any"
                      :value="vibe.strength"
                      aria-label="強度數值"
                      @change="commitVibeStrength(vibe, $event)"
                    />
                  </div>
                  <div class="vibe-ops">
                    <BbiSelect
                      class="vibe-group-select"
                      :model-value="groupKey(vibe.group)"
                      :options="groupOptions"
                      aria-label="所屬分組"
                      @update:model-value="onGroupPick(vibe, $event)"
                    />
                    <button
                      v-if="vibesSupported && !vibe.modelKeys.includes(currentVibeKey) && vibe.hasImage"
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      :disabled="vibeEncoding"
                      title="該 vibe 缺當前模型的編碼,生成時會被跳過;點選按當前模型補編碼"
                      @click="reencodeVibe(vibe)"
                    >
                      <Icon name="refresh" :size="12" /> 補當前模型編碼
                    </button>
                    <span v-else-if="!vibesSupported" class="vibe-missing">
                      當前模型暫不支援 Vibe
                    </span>
                    <span v-else-if="!vibe.modelKeys.includes(currentVibeKey)" class="vibe-missing">
                      缺當前模型編碼且無原圖,無法使用
                    </span>
                    <button
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      title="匯出 .naiv4vibe"
                      @click="exportVibe(vibe)"
                    >
                      <Icon name="upload" :size="12" /> 匯出
                    </button>
                    <button class="bbi-btn bbi-btn-sm" type="button" title="刪除" @click="removeVibe(vibe)">
                      <Icon name="trash" :size="12" /> 刪除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </Collapsible>

      <Collapsible title="從智繪姬遷移" :open="false">
        <p class="bbi-field-hint vibe-hint">
          複製智繪姬(st-chatu8)的 vibe 到本庫:只建副本、不改源資料,重複的自動跳過。
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8Detect.found">未檢測到智繪姬（外掛未安裝或未啟用）。</template>
          <template v-else-if="!chatu8Detect.total">智繪姬裡沒有找到 vibe。</template>
          <template v-else>
            檢測到智繪姬有 {{ chatu8Detect.total }} 個 vibe（預設 {{ chatu8Detect.presets }} 個 / 組內
            {{ chatu8Detect.groups }} 個）。
          </template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="migrating || !chatu8Detect.total"
            @click="migrateConfirmOpen = true"
          >
            <Icon name="download" />
            {{ migrating ? '遷移中…' : '遷移智繪姬的 vibe' }}
          </button>
        </div>
        <p v-if="migrateMsg" class="bbi-field-hint">{{ migrateMsg }}</p>

        <hr class="art-divider" />

        <!-- 提示詞預設匯入:與 vibe 同區同級;有沒有新預設不在這裡報,點開彈窗看預覽 -->
        <p class="bbi-field-hint vibe-hint">
          提示詞預設同理:前置固定正向 → 畫師串，後置固定正向 → 正面質量詞，固定負向 → 負面提示詞（自動帶上當前模型官方基線）。
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8ArtistDetect.found">未檢測到智繪姬（外掛未安裝或未啟用）。</template>
          <template v-else-if="!chatu8ArtistDetect.total">智繪姬裡沒有找到提示詞預設。</template>
          <template v-else>檢測到智繪姬有 {{ chatu8ArtistDetect.total }} 個提示詞預設。</template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="!chatu8ArtistDetect.total"
            @click="openArtistImport"
          >
            <Icon name="download" />
            匯入智繪姬的提示詞預設
          </button>
        </div>
      </Collapsible>
    </div>

    <ModalMask :open="migrateConfirmOpen" @close="migrateConfirmOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="從智繪姬遷移">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">從智繪姬遷移 vibe</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="migrateConfirmOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          將把智繪姬的 {{ chatu8Detect.total }} 個 vibe 複製到虎哩繪 Vibe
          庫，只是建立副本，不會改動智繪姬的資料。內容相同的會自動跳過，重複遷移不會產生重複條目。
        </p>
        <p class="bbi-modal-label">
          注意：智繪姬未開「酒館儲存」時 vibe 存在瀏覽器本地儲存裡，只有本裝置本瀏覽器讀得到。
        </p>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="migrateConfirmOpen = false">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="runMigrate">開始遷移</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 從智繪姬匯入提示詞預設:預覽 + 確認(開啟時算一次結果,純函式不落盤) ===== -->
    <ModalMask :open="artistImportOpen" @close="artistImportOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="從智繪姬匯入提示詞預設">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">從智繪姬匯入提示詞預設</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="artistImportOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          把智繪姬的全部 {{ artistImportResult?.plans.length ?? 0 }} 個提示詞預設複製到虎哩繪，只建副本、不改動智繪姬的資料。
          對映：前置固定正向 → 畫師串，後置固定正向 → 正面質量詞，固定負向 → 負面提示詞（前面自動拼上當前模型的官方基線）。
          同名條目會覆蓋更新（之前匯入過的可直接重新匯入修復），內容完全相同的自動跳過。
        </p>
        <ul class="art-import-list">
          <li v-for="(plan, i) in artistImportResult?.plans ?? []" :key="i" class="art-import-item">
            <div class="art-import-head">
              <span class="art-import-name" :title="plan.source">{{ plan.source || '(未命名)' }}</span>
              <span class="art-import-badge" :class="`is-${plan.state}`">
                {{ plan.state === 'import' ? '將匯入' : plan.state === 'overwrite' ? '將覆蓋' : '已存在' }}
              </span>
              <span v-if="plan.active" class="art-import-badge is-active">當前使用中</span>
            </div>
            <div class="art-import-fields">
              <code class="art-import-line" :title="plan.prompt"
                ><span class="art-import-key">畫師串</span>{{ plan.prompt || '(空)' }}</code
              >
              <code class="art-import-line" :title="plan.quality"
                ><span class="art-import-key">正向</span>{{ plan.quality || '(空)' }}</code
              >
              <code class="art-import-line" :title="plan.negative"
                ><span class="art-import-key">負向</span>{{ plan.negative || '(空)' }}</code
              >
            </div>
          </li>
        </ul>
        <label v-if="chatu8ActiveRef" class="art-import-switch">
          <input type="checkbox" v-model="switchActiveArtist" />
          <span>
            匯入後切換到智繪姬當前使用的預設
            <code>{{ chatu8ActiveRef.source }}</code>
          </span>
        </label>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="artistImportOpen = false">取消</button>
          <button
            class="bbi-btn bbi-btn-primary"
            type="button"
            :disabled="!artistImportResult || artistImportResult.imported + artistImportResult.overwritten === 0"
            @click="runArtistImport"
          >
            {{ artistImportResult && artistImportResult.imported + artistImportResult.overwritten === 0 ? '全部相同' : '開始匯入' }}
          </button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 畫師串庫管理器:搜尋/預覽圖/勾選批次刪除 ===== -->
    <NaiArtistManager v-model:open="artistManagerOpen" />

    <ConfirmDialog
      v-model:open="endpointDeleteOpen"
      title="刪除接入點"
      confirm-text="刪除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveEndpoint"
    >
      確定刪除接入點「{{ endpoint.name || '未命名接入點' }}」？地址與 API Key 會一併刪除。
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="artistDeleteOpen"
      title="刪除畫師串"
      confirm-text="刪除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveArtist"
    >
      確定刪除畫師串「{{ artist?.name || '未命名畫師串' }}」？刪除後無法恢復。
    </ConfirmDialog>

    <!-- ===== 質量詞 / 負面詞編輯彈窗(與設定頁自定義提示詞同款) ===== -->
    <ModalMask :open="!!editingNaiPrompt" @close="closeNaiPrompt">
      <div
        v-if="editingNaiPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`編輯${editingNaiPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingNaiPrompt.readonly ? '檢視' : '編輯' }}{{ editingNaiPrompt.label }}
          </span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="closeNaiPrompt">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-modal-label">{{ editingNaiPrompt.hint }}</p>

        <BbiTextarea
          v-model="naiPromptDraft"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
          :readonly="editingNaiPrompt.readonly"
        />

        <footer class="bbi-modal-foot">
          <template v-if="!editingNaiPrompt.readonly">
            <button class="bbi-btn bbi-btn-danger" type="button" @click="resetNaiPromptDraft">
              <Icon name="refresh" /> 恢復預設
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="closeNaiPrompt">取消</button>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="saveNaiPrompt">完成</button>
          </template>
          <template v-else>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="closeNaiPrompt">關閉</button>
          </template>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* 預設引數的語義配對緊湊行:雙欄位行兩列、數字引數行四列;
   窄屏雙欄位行落單列、數字行落 2×2。
   垂直節奏由行容器統一管(行內欄位的 margin-bottom 歸零),
   不靠 .bbi-field 自帶的:last-child 規則——行尾欄位會被它吃掉下間距。 */
.be-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
  margin-bottom: 18px;
}

.be-row .bbi-field {
  margin-bottom: 0;
}

/* 引數區的自繪下拉吃滿欄位寬:與同行的 .bbi-input(模型名/尺寸)左右對齊,
   子元件根類預設 180px/flex:none,這裡壓過去。 */
.be-select {
  width: 100%;
}

.be-row--nums {
  grid-template-columns: repeat(4, 1fr);
}

@media (max-width: 640px) {
  .be-row {
    grid-template-columns: 1fr;
  }

  .be-row--nums {
    grid-template-columns: repeat(2, 1fr);
  }
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .bbi-input {
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
.vibe-hint {
  margin-top: 0;
}

/* —— 畫師串庫(形制照搬 ComfyUIPanel 的 .wf-*) —— */
/* 選擇行:grid 而非 flex——靠 flex-basis 撐出的對齊一 wrap 就散,
   固定首列寬讓標籤列與下方各行的標籤列同起點。 */
.art-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.art-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.art-row > .bbi-input {
  min-width: 0;
}
/* 下拉不吃滿:名稱通常很短,拉滿只會拖出半截空白(子元件根類預設 180px/不伸縮,此處 0,2,0 壓過) */
.art-row > .art-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.art-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* 四個操作低頻且同級,圖示化後整行只剩下拉一個視覺重點;文案退到 title/aria-label */
.art-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.art-op:disabled {
  opacity: 0.4;
  cursor: default;
}
.art-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.art-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.art-hint {
  margin-top: 8px;
}

/* V5 畫師串差異提醒:警示色,與常規說明區分開 */
.art-hint-warn {
  color: var(--bbi-warning);
}
/* 畫師串與下方質量詞/負面詞的分界 */
.art-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 12px 0;
}
/* 綁定列表與上方畫師串編輯區拉開一點;「已被畫師串覆蓋」用警示色——渠道值正被覆蓋,
   使用者在渠道行改了卻不生效,需要一眼看出原因 */
.art-bound-list {
  margin-top: 10px;
}
.bbi-prompt-state.is-shadowed {
  color: var(--bbi-warning);
  background: transparent;
}

/* —— 從智繪姬遷移提示詞預設 —— */
.art-import-list {
  list-style: none;
  margin: 10px 0 4px;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.art-import-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.art-import-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.art-import-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.art-import-fields {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.art-import-line {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
.art-import-key {
  opacity: 0.55;
  margin-right: 6px;
}
.art-import-badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
  white-space: nowrap;
}
.art-import-badge.is-skip {
  background: var(--bbi-line);
  color: var(--bbi-ink-muted);
}
.art-import-badge.is-overwrite {
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
}
.art-import-badge.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.art-import-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
  cursor: pointer;
}
.art-import-switch code {
  font-size: 12px;
  background: var(--bbi-surface-2);
  border-radius: 4px;
  padding: 0 4px;
}

/* 操作按鈕基類:.bbi-icon-btn 只在 App.vue 的 scoped 塊裡宣告,此處補一份
   (與 ComfyUIPanel 同款處理;漏了會渲染成瀏覽器原生按鈕,shadow DOM 裡也拿不到 ST 樣式) */
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

/* —— 質量詞/負面詞列表行 + 彈窗:樣式隨設定頁「自定義提示詞」,scoped 不跨元件故補一份 —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可點進彈窗編輯(狀態藥丸 .bbi-prompt-state 在 base.css 全域性,無需補) */
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
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
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
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}
/* 彈窗:更寬 + 大文本框 */
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
/* 把「恢復預設」推到最左(本檔案的遷移彈窗此前裸用過此類名,靠 foot 的 flex-end 蒙對) */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危險按鈕:與設定頁/ConfirmDialog 同一份口徑。base 規則不能只寫 :hover ——
   scoped 不跨元件、base.css 裡也沒有,只寫 hover 的話平時是預設墨色,滑鼠一過才變紅。 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.migrate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.vibe-normalize {
  margin-left: auto;
}
.vibe-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--bbi-border, rgba(127, 127, 127, 0.2));
}
.vibe-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 auto;
}
.vibe-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.12);
  color: var(--bbi-ink-muted);
}
.vibe-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vibe-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.vibe-enable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-strength-label {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
  /* .bbi-range 的 margin 是給「整行佔一欄」的設定頁留的,這裡在同一行裡要壓掉 */
  margin: 0;
}
/* 數字框窄一檔:四位小數夠用,再寬就把滑塊擠沒了 */
.vibe-strength-num {
  flex: 0 0 auto;
  width: 68px;
  padding: 4px 6px;
  font-size: 12px;
  text-align: right;
  -moz-appearance: textfield;
  appearance: textfield;
}
/* step="any" 下瀏覽器仍畫上下箭頭,但規範讓 stepUp/stepDown 直接拋錯 → 按了沒反應。
   擺一對點不動的箭頭不如不擺;要微呼叫左邊滑塊(方向鍵 0.01 一檔)。 */
.vibe-strength-num::-webkit-inner-spin-button,
.vibe-strength-num::-webkit-outer-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.vibe-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vibe-missing {
  font-size: 12px;
  color: #c44747;
}

/* —— 分組 —— */
/* 工具條:搜尋框吃滿,計數與「整理分組」靠右。長列表口徑與設定頁排除彈窗一致
   (搜尋 + 子串匹配收斂渲染量),故不做分頁——vibe 靠縮圖認人,翻頁只會
   把「我那張圖在第幾頁」變成新的記憶負擔。 */
.vibe-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.vibe-search {
  flex: 1 1 160px;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
}
.vibe-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
/* 組頭:整塊淺底,把「組」和組內條目在視覺上分層;粘頂讓長組滾動時組名不丟 */
.vibe-group {
  margin-top: 10px;
}
.vibe-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
/* 組名區整體可點(摺疊):按鈕撐滿剩餘寬度,點空白處也能收起 */
.vibe-group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.vibe-group-chevron {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
/* 展開態朝下(與 Collapsible 同口徑:收起時回到未旋轉的朝右/朝上) */
.vibe-group-chevron.is-collapsed {
  transform: rotate(-90deg);
}
.vibe-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vibe-group-meta {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
}
/* 「生效中」複用狀態藥丸基樣式,上色口徑與 wf-state.is-ok 一致 */
.vibe-group-active {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.vibe-group-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
/* 組內條目左縮排一格,讀得出層級 */
.vibe-group-body {
  padding-left: 10px;
}
/* 組頭本身就是一條分界,組內首條不再畫上邊線(否則緊貼組頭是兩道線) */
.vibe-group-body > .vibe-item:first-child {
  border-top: 0;
}
.vibe-group-select {
  width: 130px;
}
/* 組頭操作裡的小圖示鈕:.bbi-icon-mini 只在其它頁的 scoped 塊裡宣告,此處補一份 */
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 12px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
@media (max-width: 640px) {
  /* 窄屏:組頭兩行——組名一行,操作另起一行靠右,避免按鈕把組名擠成一條縫 */
  .vibe-group-ops {
    width: 100%;
    justify-content: flex-end;
  }
  .vibe-group-body {
    padding-left: 0;
  }
  /* 同理:四個圖示鈕 + 標籤會把畫師串下拉擠成一條縫,標籤獨佔首行,
     下拉與操作組同行分據兩端 */
  .art-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .art-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .art-row > .art-select {
    max-width: none;
  }
}
</style>
