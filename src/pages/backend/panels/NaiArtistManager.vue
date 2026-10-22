<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import { newNaiArtist, settings, type NaiArtistPreset } from '@/state/settings';

/**
 * 畫師串庫管理器(NAI 面板「管理」按鈕喚起)。
 *
 * 分工:面板裡的下拉管「高頻切換」,這裡管「低頻管理」——搜尋、預覽圖、
 * 勾選批次刪除、逐條編輯/複製/刪除。
 *
 * 互動約定:
 * - 點卡片主體 = 啟用該條(再點當前條 = 停用,回「不使用」);
 * - 左上角勾選框 = 管理態多選,只服務於批次刪除,與啟用狀態無關;
 * - 內建條(bi_*)隨外掛版本更新,只讀:無勾選框、不可刪改,「複製」是唯一自定義入口;
 * - 預覽圖上傳後壓成最長邊 512 的 jpeg,落 user/images/柏宝绘_画师串/<條目id>.jpg,
 *   路徑記在條目 previewPath 上,不維護額外索引;換圖同名覆蓋,刪條目時連帶刪檔案。
 */

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

function close() {
  emit('update:open', false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 列表條目:內建庫排前(與下拉的順序一致),附帶只讀標記。 */
interface ManagerItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

const search = ref('');
/** 管理態勾選集(只存使用者條目 id;內建條不可勾選,天然進不來)。 */
const selected = ref<ReadonlySet<string>>(new Set());

// 每次打開回到乾淨狀態:搜尋詞與勾選都是「這一輪管理」的臨時態,不該跨次殘留。
watch(
  () => props.open,
  open => {
    if (!open) return;
    search.value = '';
    selected.value = new Set();
  },
);

const items = computed<ManagerItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...settings.nai.artistPresets.map(p => ({ preset: p, builtin: false })),
]);

const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

/** 當前篩選結果裡的可勾選(使用者)條目:全選/計數都以它為準,內建條不參與批次。 */
const selectableFiltered = computed(() => filtered.value.filter(i => !i.builtin));

const allFilteredSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every(i => selected.value.has(i.preset.id)),
);

const activeId = computed(() => settings.nai.activeArtistId);

/** 點卡片:啟用;再點當前條:停用(回「不使用」,是有意義的儲存值)。 */
function toggleActive(item: ManagerItem) {
  settings.nai.activeArtistId = item.preset.id === activeId.value ? '' : item.preset.id;
}

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

function toggleSelectAllFiltered() {
  const next = new Set(selected.value);
  if (allFilteredSelected.value) {
    for (const i of selectableFiltered.value) next.delete(i.preset.id);
  } else {
    for (const i of selectableFiltered.value) next.add(i.preset.id);
  }
  selected.value = next;
}

/** 新建:入庫 + 設為當前 + 直接開編輯彈窗,一步到位。 */
function addArtist() {
  const preset = newNaiArtist(`畫師串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
  openEdit({ preset, builtin: false });
}

/**
 * 複製:預覽圖不隨副本走——預覽檔案隨原條目刪除,共指一個路徑會讓副本日後破圖。
 * 也不切換當前條:管理器裡複製常用於批次攢變體,啟用哪條由使用者點卡片明示。
 */
function duplicate(item: ManagerItem) {
  const src = item.preset;
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  settings.nai.artistPresets.push(preset);
  toastr.success(`已複製為「${preset.name}」`, '畫師串');
}

/* ============ 預覽圖 ============ */

/** 預覽圖最長邊:卡片顯示約 200px 寬,512 留足高分屏餘量,又不把 user/images 撐大。 */
const PREVIEW_MAX_EDGE = 512;

const previewFileInput = ref<HTMLInputElement | null>(null);
/** 本次上傳要為哪條換圖;檔案框是共享的一個,靠它在 change 時找回目標。 */
let previewTarget: NaiArtistPreset | null = null;
const uploadingId = ref<string | null>(null);

/**
 * 覆蓋同名檔案後 URL 不變,瀏覽器快取會讓卡片繼續顯示舊圖;
 * 本元件內記一份 id → 版本號,上傳成功後 bump,<img src> 帶上 query 即可破快取。
 */
const previewVersions = ref<ReadonlyMap<string, number>>(new Map());

function previewSrc(preset: NaiArtistPreset): string {
  if (!preset.previewPath) return '';
  const v = previewVersions.value.get(preset.id);
  return v ? `${preset.previewPath}?v=${v}` : preset.previewPath;
}

function pickPreview(preset: NaiArtistPreset) {
  if (uploadingId.value) return;
  previewTarget = preset;
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = previewTarget;
  previewTarget = null;
  if (!file || !target) return;
  uploadingId.value = target.id;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, PREVIEW_MAX_EDGE, 0.85);
    const base64 = jpeg.split(',')[1] ?? '';
    // 檔名 = 條目 id:換圖同名覆蓋,不會攢孤兒檔案
    target.previewPath = await uploadUserImage(ARTIST_PREVIEW_FOLDER, target.id, base64, 'jpg');
    previewVersions.value = new Map(previewVersions.value).set(target.id, Date.now());
    toastr.success(`「${target.name || '未命名畫師串'}」預覽圖已更新`, '畫師串');
  } catch (error) {
    toastr.error(errorMessage(error), '預覽圖上傳失敗');
  } finally {
    uploadingId.value = null;
  }
}

/** 移除預覽:先清欄位(介面立即響應),檔案刪除 best-effort,失敗只警告不回滾。 */
async function removePreview(preset: NaiArtistPreset) {
  const path = preset.previewPath;
  if (!path) return;
  preset.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`預覽圖引用已移除,但檔案清理失敗：${errorMessage(error)}`, '畫師串');
  }
}

/* ============ 刪除(單條與批次共用確認彈窗) ============ */

const deleteOpen = ref(false);
const deleteList = ref<NaiArtistPreset[]>([]);
const deleting = ref(false);

function askDelete(presets: NaiArtistPreset[]) {
  if (!presets.length) return;
  deleteList.value = presets;
  deleteOpen.value = true;
}

function askDeleteSelected() {
  const byId = new Map(settings.nai.artistPresets.map(p => [p.id, p]));
  askDelete([...selected.value].map(id => byId.get(id)).filter((p): p is NaiArtistPreset => !!p));
}

async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  const ids = new Set(deleteList.value.map(p => p.id));
  const plan = planArtistRemoval(settings.nai.artistPresets, ids, activeId.value);
  // 預覽檔案清理 best-effort:檔案沒刪掉不阻塞刪條目(孤兒檔案可手動清,條目刪不掉才煩人)
  let fileFailures = 0;
  for (const p of plan.removed) {
    if (!p.previewPath) continue;
    try {
      await deleteUserImage(p.previewPath);
    } catch {
      fileFailures += 1;
    }
  }
  settings.nai.artistPresets = plan.remaining;
  settings.nai.activeArtistId = plan.nextActiveId;
  const nextSelected = new Set(selected.value);
  for (const id of ids) nextSelected.delete(id);
  selected.value = nextSelected;
  deleteOpen.value = false;
  deleting.value = false;
  if (fileFailures) {
    toastr.warning(
      `已刪除 ${plan.removed.length} 條,但 ${fileFailures} 張預覽圖檔案清理失敗`,
      '畫師串',
    );
  } else {
    toastr.success(`已刪除 ${plan.removed.length} 條畫師串`, '畫師串');
  }
}

/* ============ 編輯/檢視彈窗(內建條只讀) ============ */

const editItem = ref<ManagerItem | null>(null);
const editName = ref('');
const editPrompt = ref('');

function openEdit(item: ManagerItem) {
  editItem.value = item;
  editName.value = item.preset.name;
  editPrompt.value = item.preset.prompt;
}

function closeEdit() {
  editItem.value = null;
}

function saveEdit() {
  const item = editItem.value;
  if (!item || item.builtin) return; // 內建只讀(按鈕已隱藏,雙保險)
  item.preset.name = editName.value.trim();
  item.preset.prompt = editPrompt.value;
  closeEdit();
}

/** 編輯彈窗裡複製內建條:副本入庫後關掉檢視窗,讓使用者回到網格看到新卡。 */
function duplicateFromEdit() {
  const item = editItem.value;
  if (!item) return;
  duplicate(item);
  closeEdit();
}
</script>

<template>
  <ModalMask :open="open" @close="close">
    <div class="bbi-modal am-modal" role="dialog" aria-modal="true" aria-label="畫師串庫">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">畫師串庫</span>
        <button class="bbi-icon-mini" type="button" title="關閉" aria-label="關閉" @click="close">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-toolbar">
        <input
          class="bbi-input am-search"
          type="search"
          v-model="search"
          placeholder="搜尋名稱或畫師串內容…"
          spellcheck="false"
          aria-label="搜尋畫師串"
        />
        <span class="am-count">共 {{ items.length }} 條</span>
        <button class="bbi-btn bbi-btn-primary" type="button" @click="addArtist">
          <Icon name="plus" /> 新建
        </button>
      </div>

      <div v-if="selected.size" class="am-batch">
        <span class="am-batch-count">已選 {{ selected.size }} 條</span>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="toggleSelectAllFiltered">
          {{ allFilteredSelected ? '取消全選' : `全選當前結果(${selectableFiltered.length})` }}
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="selected = new Set()">清空</button>
        <span class="am-batch-spacer"></span>
        <button
          class="bbi-btn bbi-btn-sm am-btn-danger"
          type="button"
          @click="askDeleteSelected"
        >
          <Icon name="trash" :size="12" /> 刪除所選
        </button>
      </div>

      <div class="am-scroll">
        <p v-if="!filtered.length" class="am-empty">
          <template v-if="items.length">沒有匹配「{{ search }}」的畫師串。</template>
          <template v-else>還沒有畫師串,點右上角「新建」開始。</template>
        </p>

        <div v-else class="am-grid">
          <div
            v-for="item in filtered"
            :key="item.preset.id"
            class="am-card"
            :class="{
              'is-active': item.preset.id === activeId,
              'is-selected': selected.has(item.preset.id),
            }"
            :title="item.preset.id === activeId ? '當前畫師串,點選停用' : '點選設為當前畫師串'"
            @click="toggleActive(item)"
          >
            <div class="am-art">
              <img
                v-if="item.preset.previewPath"
                class="am-art-img"
                :src="previewSrc(item.preset)"
                :alt="item.preset.name"
                loading="lazy"
                decoding="async"
              />
              <button
                v-else-if="!item.builtin"
                class="am-art-empty"
                type="button"
                :disabled="uploadingId === item.preset.id"
                title="上傳預覽圖"
                @click.stop="pickPreview(item.preset)"
              >
                <Icon name="generate" :size="20" />
                <span>{{ uploadingId === item.preset.id ? '上傳中…' : '新增預覽圖' }}</span>
              </button>
              <div v-else class="am-art-empty am-art-empty--static">
                <Icon name="nai" :size="22" />
              </div>

              <label
                v-if="!item.builtin"
                class="am-check"
                title="勾選後可批次刪除"
                @click.stop
              >
                <input
                  type="checkbox"
                  class="bbi-checkbox"
                  :checked="selected.has(item.preset.id)"
                  aria-label="選擇此畫師串"
                  @change="toggleSelect(item.preset.id)"
                />
              </label>

              <span v-if="item.preset.id === activeId" class="am-badge is-on">使用中</span>
              <span v-else-if="item.builtin" class="am-badge">內建</span>

              <button
                v-if="!item.builtin && item.preset.previewPath"
                class="am-art-change"
                type="button"
                :disabled="uploadingId === item.preset.id"
                @click.stop="pickPreview(item.preset)"
              >
                {{ uploadingId === item.preset.id ? '上傳中…' : '更換預覽圖' }}
              </button>
            </div>

            <div class="am-body">
              <div class="am-name-row">
                <!-- 單選圈:明示「啟用是單選切換」;整卡都可點,圈只是狀態視覺化和提示 -->
                <span
                  class="am-radio"
                  :class="{ 'is-on': item.preset.id === activeId }"
                  aria-hidden="true"
                >
                  <Icon v-if="item.preset.id === activeId" name="check" :size="9" />
                </span>
                <div class="am-name" :title="item.preset.name">
                  {{ item.preset.name || '未命名畫師串' }}
                </div>
              </div>
              <div class="am-prompt" :title="item.preset.prompt">
                {{ item.preset.prompt || '(空)' }}
              </div>
              <div class="am-ops" @click.stop>
                <button
                  class="am-op"
                  type="button"
                  :title="item.builtin ? '檢視內容(內建只讀)' : '編輯名稱與內容'"
                  :aria-label="item.builtin ? '檢視內容' : '編輯'"
                  @click="openEdit(item)"
                >
                  <Icon name="edit" :size="13" />
                </button>
                <button
                  class="am-op"
                  type="button"
                  title="複製為我的畫師串"
                  aria-label="複製"
                  @click="duplicate(item)"
                >
                  <Icon name="copy" :size="13" />
                </button>
                <button
                  v-if="!item.builtin"
                  class="am-op am-op-danger"
                  type="button"
                  title="刪除"
                  aria-label="刪除"
                  @click="askDelete([item.preset])"
                >
                  <Icon name="trash" :size="13" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="bbi-modal-foot am-foot">
        <span class="am-foot-hint">點卡片或單選圈啟用/停用;勾選左上角方框可批次刪除。</span>
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="close">關閉</button>
      </footer>
    </div>
  </ModalMask>

  <!-- 刪除確認:單條與批次共用;疊在管理器之上 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    top-layer
    title="刪除畫師串"
    :confirm-text="deleting ? '刪除中…' : '刪除'"
    confirm-icon="trash"
    tone="danger"
    :busy="deleting"
    @confirm="confirmDelete"
  >
    <template v-if="deleteList.length === 1">
      確定刪除畫師串「{{ deleteList[0]?.name || '未命名畫師串' }}」?刪除後無法恢復。
    </template>
    <template v-else>
      確定刪除選中的 {{ deleteList.length }} 條畫師串?刪除後無法恢復。
    </template>
  </ConfirmDialog>

  <!-- 編輯/檢視:名稱 + 內容 + 預覽圖;綁定的正/負面詞仍在面板裡隨「當前條」編輯 -->
  <ModalMask :open="!!editItem" top-layer @close="closeEdit">
    <div
      v-if="editItem"
      class="bbi-modal am-edit"
      role="dialog"
      aria-modal="true"
      :aria-label="editItem.builtin ? '檢視畫師串' : '編輯畫師串'"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">{{ editItem.builtin ? '檢視畫師串(內建)' : '編輯畫師串' }}</span>
        <button class="bbi-icon-mini" type="button" title="關閉" aria-label="關閉" @click="closeEdit">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-edit-preview">
        <img
          v-if="editItem.preset.previewPath"
          class="am-edit-thumb"
          :src="previewSrc(editItem.preset)"
          :alt="editItem.preset.name"
        />
        <div v-else class="am-edit-thumb am-edit-thumb--empty"><Icon name="generate" /></div>
        <div v-if="!editItem.builtin" class="am-edit-preview-ops">
          <button
            class="bbi-btn bbi-btn-sm"
            type="button"
            :disabled="uploadingId === editItem.preset.id"
            @click="pickPreview(editItem.preset)"
          >
            <Icon name="upload" :size="12" />
            {{ uploadingId === editItem.preset.id ? '上傳中…' : editItem.preset.previewPath ? '更換預覽圖' : '上傳預覽圖' }}
          </button>
          <button
            v-if="editItem.preset.previewPath"
            class="bbi-btn bbi-btn-sm am-btn-danger"
            type="button"
            @click="removePreview(editItem.preset)"
          >
            <Icon name="trash" :size="12" /> 移除預覽圖
          </button>
        </div>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">名稱</span>
        <input
          class="bbi-input"
          type="text"
          v-model="editName"
          :readonly="editItem.builtin"
          placeholder="畫師串名稱"
          spellcheck="false"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">畫師串(拼在正向提示詞最前面)</span>
        <BbiTextarea
          v-model="editPrompt"
          :rows="4"
          :max-rows="12"
          mono
          :readonly="editItem.builtin"
          placeholder="artist:xxx, artist:yyy"
        />
      </div>

      <p class="bbi-modal-label">
        綁定的正面質量詞「{{ editItem.preset.quality.trim() ? '已設定' : '未設定' }}」、負面提示詞「{{
          editItem.preset.negative.trim() ? '已設定' : '未設定'
        }}」;要改它們,先在面板裡把這條設為當前畫師串,再點提示詞區的對應行。
      </p>

      <footer class="bbi-modal-foot">
        <button class="bbi-btn" type="button" @click="toggleActive(editItem)">
          {{ editItem.preset.id === activeId ? '停用這條' : '設為當前畫師串' }}
        </button>
        <template v-if="editItem.builtin">
          <button class="bbi-btn" type="button" @click="duplicateFromEdit">
            <Icon name="copy" /> 複製為我的畫師串
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeEdit">關閉</button>
        </template>
        <template v-else>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeEdit">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">完成</button>
        </template>
      </footer>
    </div>
  </ModalMask>

  <input
    ref="previewFileInput"
    type="file"
    accept="image/*"
    hidden
    @change="onPreviewFileChange"
  />
</template>

<style scoped>
/* 管理器彈窗:比通用彈窗寬一檔裝卡片網格;固定高度,網格區內滾,頭/工具條/底欄釘住。
   .bbi-modal 預設 overflow-y:auto,這裡改為 hidden,滾動交給 .am-scroll。 */
.am-modal {
  max-width: 760px;
  height: 86vh;
  height: 86dvh;
  overflow: hidden;
}

.am-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.am-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.am-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* 批次操作條:有勾選時才出現,accent 淺底與常規內容分割槽 */
.am-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-accent-soft);
  font-size: 12px;
}
.am-batch-count {
  font-weight: 600;
  color: var(--bbi-accent);
  white-space: nowrap;
}
.am-batch-spacer {
  flex: 1 1 auto;
}

.am-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.am-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
  padding: 2px 2px 6px;
}

.am-empty {
  margin: 0;
  padding: 56px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-soft);
}

/* —— 卡片:點主體 = 啟用/停用;選中態用淺底區分(與啟用態的描邊是兩回事) —— */
.am-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.am-card:hover {
  border-color: var(--bbi-accent);
}
.am-card.is-active {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}
.am-card.is-selected {
  background: var(--bbi-accent-soft);
}

/* 預覽圖區:固定 4:3,佔位與實圖同幾何,卡片高度才齊 */
.am-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}
.am-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.am-art-empty {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  cursor: pointer;
}
.am-art-empty:hover {
  color: var(--bbi-accent);
}
.am-art-empty:disabled {
  cursor: default;
  opacity: 0.6;
}
.am-art-empty--static,
.am-art-empty--static:hover {
  cursor: default;
  color: var(--bbi-ink-muted);
}

/* 勾選框墊一片 surface 底,壓在圖上也可辨認 */
.am-check {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  padding: 2px;
  border-radius: 6px;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  cursor: pointer;
}
.am-check .bbi-checkbox {
  width: 15px;
  height: 15px;
}

.am-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink-muted);
  border: 1px solid var(--bbi-line);
}
.am-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  border-color: transparent;
}

/* 「更換預覽圖」:hover 才浮現的居中膠囊,平時不擋圖;
   觸屏沒有 hover,走編輯彈窗裡的同款按鈕(雙通道,不藏死) */
.am-art-change {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  padding: 4px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.am-card:hover .am-art-change,
.am-art-change:focus-visible,
.am-art-change:disabled {
  opacity: 1;
}
.am-art-change:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.am-body {
  padding: 8px 10px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.am-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 單選圈:與勾選框(方形、批次)形態區分開,傳達「啟用是互斥單選」 */
.am-radio {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-accent-ink);
}
.am-radio.is-on {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.am-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 內容摘要:等寬兩行截斷,min-height 撐齊沒填內容的卡 */
.am-prompt {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  min-height: 2.9em;
}

.am-ops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}
.am-op {
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
}
.am-op:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
/* 刪除推到行尾,與編輯/複製兩個「建設性」操作拉開距離 */
.am-op-danger {
  margin-left: auto;
}
.am-op-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.am-foot {
  align-items: center;
}
.am-foot-hint {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— 編輯/檢視彈窗 —— */
.am-edit {
  max-width: 560px;
}
.am-edit-preview {
  display: flex;
  align-items: center;
  gap: 12px;
}
.am-edit-thumb {
  width: 112px;
  height: 84px;
  object-fit: cover;
  border-radius: var(--bbi-radius-sm);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}
.am-edit-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-muted);
  font-size: 20px;
}
.am-edit-preview-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* 危險按鈕:與設定頁/ConfirmDialog 同一口徑,scoped 不跨元件故補一份 */
.am-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.am-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 組頭/彈窗裡的小圖示鈕:與 NaiPanel 同款,scoped 不跨元件故補一份 */
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
  .am-modal {
    max-width: 100%;
  }
  .am-grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  }
  .am-foot-hint {
    display: none;
  }
}
</style>
