<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readHoraeAppearance } from '@/autoTag/horaeMemory';
import { suggestWorldSettingFromHorae } from '@/autoTag/worldImport';
import { WORLD_SETTING_MAX, setWorldSetting, worldSetting } from '@/state/worldSetting';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { computed, ref, watch } from 'vue';

/**
 * 角色管理 —— 兩層固定外貌庫:
 * - 全域性庫:跨所有聊天生效的只讀模板,AI 永不修改,僅手動維護(適合玩家角色等固定形象)。
 * - 本聊天庫:僅當前聊天,Horae自動建檔、AI 隨劇情變更;同名時優先於全域性。
 * 外貌按欄位記錄(sex/hair/eyes/...),拼接結果即最終 tag;生成 tag 時 AI 照抄庫中欄位 —— 外貌穩定不漂移。
 * 角色以名字逐字比對正文與 Horae 記錄,名字前面不加 @。
 */

type Scope = 'chat' | 'global';

/* —— 世界背景(本聊天):一行時代/地域,題詞用來定服裝與建築風格,取代每次讀世界書 —— */
const worldDraft = ref(worldSetting.text);
// 切換聊天時 hydrate 會換掉 worldSetting.text,草稿跟著換
watch(
  () => worldSetting.text,
  text => {
    worldDraft.value = text;
  },
);
const worldImporting = ref(false);

function saveWorld() {
  if (worldDraft.value.trim() === worldSetting.text) return;
  if (!setWorldSetting(worldDraft.value)) {
    toastr.info('當前沒有開啟的聊天', '虎哩繪');
    return;
  }
  toastr.success(worldSetting.text ? '世界背景已儲存' : '已清空世界背景', '虎哩繪');
}

async function importWorldFromHorae() {
  worldImporting.value = true;
  try {
    const line = await suggestWorldSettingFromHorae();
    worldDraft.value = line;
    setWorldSetting(line);
    toastr.success('已從 Horae 匯入世界背景,可直接修改', '虎哩繪');
  } catch (error) {
    toastr.warning(error instanceof Error ? error.message : String(error), '虎哩繪');
  } finally {
    worldImporting.value = false;
  }
}

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName:正在編輯的已有條目名;null = 新建。彈窗開關以 draft 是否存在為準。
const editingName = ref<string | null>(null);
// editingScope:被編輯條目所在層;draftScope:草稿儲存到哪層(僅新建時可選)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// 草稿來源:手改內容即轉 manual;「從Horae生成」後轉 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// 彈窗內歷史面板開關
const historyOpen = ref(false);
// 回滾確認
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: '同人角色填: character name (copyright name), 不帶轉義括號; 原創留空',
  sex: '如 1girl / 1boy',
  hair: '如 long black hair',
  eyes: '如 red eyes',
  skin: '如 pale skin(可不填)',
  body: '如 petite, small breasts',
  extra: '如 heterochromia(可不填)',
  outfit: '固定著裝,可不填',
};

/** 全域性庫名字集(響應式),用於分割槽與「覆蓋」徽標。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分割槽 = 派生庫裡「屬於本聊天」的條目:
 * 本聊天基線裡的(含覆蓋全域性的同名條目)+ 非全域性的(AI 樓層建檔等)。
 * 純全域性條目只出現在全域性分割槽。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** 是否整串模式:有 raw 且沒有欄位。 */
const draftIsRaw = computed(
  () => !!draft.value && !!draft.value.raw.trim() && CHAR_TAG_FIELDS.every(f => !draft.value!.fields[f].trim()),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** 正在編輯的本聊天條目的即時歷史(回滾後隨之重新整理);全域性條目不記歷史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** 卡片上的欄位 chips:有欄位用欄位,整串模式回退 raw 文本(模板裡分支)。 */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
}

/* —— 分割槽摺疊 ——
 * 標題行兼作摺疊開關;摺疊態是本機檢視偏好,走 localStorage、不進設定(跨裝置同步沒意義)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用時僅本次會話生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 無條目即無可摺疊:不顯示箭頭與計數,也強制展開(避免刪空後卡在收攏的空態)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** 手動編輯過的欄位 → 條目歸手動(但仍可被 AI 變更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能為空', '虎哩繪');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('至少填一個外貌欄位(或整串 tag)', '虎哩繪');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) closeEntry();
}

/* —— 刪除:二次確認 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  closeEntry();
}

/* —— 提升為全域性 / 複製到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}」已提升為全域性角色,所有聊天生效`, '虎哩繪');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`已把「${name}」複製到本聊天,之後本聊天以副本為準`, '虎哩繪');
  }
  closeEntry();
}

/* —— 從Horae最新狀態建檔:取最新樓的角色參考,找到同名角色的外貌記錄,批次轉換介面轉欄位 —— */
async function regenerateFromHorae() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填寫角色名', '虎哩繪');
    return;
  }
  const ctx = getContext();
  if (!ctx?.chat.length) {
    toastr.info('當前沒有開啟的聊天', '虎哩繪');
    return;
  }
  regenerating.value = true;
  try {
    const desc = readHoraeAppearance(ctx.chat, name);
    if (!desc) {
      toastr.info('Horae 裡沒有該角色的外貌記錄,可手動填寫', '虎哩繪');
      return;
    }
    const [result] = await generateCharTags([{ name, desc }]);
    if (!result) {
      toastr.warning('模型沒有返回該角色的 tag,請重試或手動填寫', '虎哩繪');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = desc;
    toastr.success('已按Horae最新外貌生成,點「完成」儲存', '虎哩繪');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '虎哩繪');
  } finally {
    regenerating.value = false;
  }
}

/* —— 歷史展示與回滾(僅本聊天條目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return '建檔';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然語言';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`已回滾「${p.name}」的${fieldLabel(p.record.field)}變更`, '虎哩繪');
  } else {
    toastr.warning('回滾失敗:條目可能已刪除', '虎哩繪');
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? 'Horae' : entry.source === 'ai' ? 'AI 維護' : '手動';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色管理</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      角色固定外貌庫:生成 tag 時 AI 照抄庫中欄位,外貌穩定不漂移。角色名要和正文、Horae 記錄的名字一模一樣,前面不要加 @。
    </p>
    <p class="bbi-field-hint">
      <strong>建議開始生圖前先整理這裡:</strong>主要角色最好手動建立,或用「從Horae生成」後檢查一遍。AI 自動建檔可能抓錯髮色瞳色,或混入臉紅、黑眼圈這類暫時狀態;
      這些欄位之後每張圖都會照抄,一開始填正確,後面的圖才會穩定。
    </p>

    <!-- ===== 世界背景(本聊天) ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <span class="bbi-field-label">世界背景</span>
        <button
          class="bbi-btn bbi-btn-sm"
          type="button"
          title="依 Horae 最新一樓的地點、場景記憶與在場服裝,請模型濃縮成一行(不讀世界書)"
          :disabled="worldImporting"
          @click="importWorldFromHorae"
        >
          <Icon name="refresh" /> {{ worldImporting ? '匯入中…' : '從Horae匯入' }}
        </button>
      </div>
      <input
        v-model="worldDraft"
        class="bbi-input"
        :maxlength="WORLD_SETTING_MAX"
        placeholder="例:18世紀歐洲・洛可可貴族宮廷 / 1920年代上海・民國初年 / 現代韓國首爾"
        @change="saveWorld"
        @keydown.enter="saveWorld"
      />
      <p class="bbi-field-hint">
        僅本聊天生效。生成 tag 時作為服裝、建築、道具的時代風格預設值;正文另有描述時以正文為準。留空則由模型從正文推斷。
      </p>
    </div>

    <!-- ===== 全域性角色庫 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? '收起全域性角色庫' : '展開全域性角色庫') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">全域性角色庫</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="新增全域性角色" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自適應、無需寫死 max-height -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            所有聊天生效,僅手動維護——AI 不會修改全域性角色,適合玩家角色等固定形象。本聊天有同名角色時以本聊天為準。
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-char-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'global')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span class="bbi-char-pill is-global">全域性</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="本聊天有同名角色,當前聊天以本聊天的為準">
                    本聊天已覆蓋
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            還沒有全域性角色。在本聊天角色的編輯彈窗裡點「提升為全域性」,或點右上角「+」新增。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? '收起本聊天角色' : '展開本聊天角色') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">本聊天角色</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="新增本聊天角色" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            僅當前聊天生效:Horae角色自動建檔,AI 隨劇情報告永久變化;可檢視歷史並回滾。
          </p>
          <ul v-if="chatEntries.length" class="bbi-char-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'chat')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >
                    {{ sourceLabel(entry) }}
                  </span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="與全域性庫同名,當前聊天以本條為準">
                    覆蓋全域性
                  </span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} 條變更記錄,點卡片檢視`"
                  >
                    <Icon name="history" />{{ entry.history.length }}
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            本聊天還沒有角色。生成 tag 時Horae角色會自動建檔,也可點右上角「+」手動補。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 角色編輯彈窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="編輯角色">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '編輯角色' : '新增角色' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? '全域性' : '本聊天' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- 作用域:僅新建時可選;已有條目換層用底部「提升為全域性 / 複製到本聊天」 -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">儲存到</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              本聊天
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              全域性
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? '全域性:所有聊天生效,AI 不會修改,tag 有問題需手動改。' : '本聊天:僅當前聊天,AI 可隨劇情自動變更。' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="與正文/Horae中的名字一致" @input="markManual" />
        </label>
        <span class="bbi-field-hint">名字要和正文、Horae 記錄的寫法一模一樣(包括間隔號「・」),前面不要加 @,否則會對不上這個角色。改名不會自動跟隨。</span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">外貌欄位</span>
          <div class="bbi-char-form">
            <label
              v-for="f in CHAR_TAG_FIELDS"
              :key="f"
              class="bbi-char-form-row"
              :class="{ 'is-wide': f === 'outfit' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
              <input
                v-model="draft.fields[f]"
                class="bbi-input"
                :placeholder="FIELD_PLACEHOLDERS[f]"
                @input="markManual"
              />
            </label>
          </div>
        </div>
        <span class="bbi-field-hint">只寫固定基礎特徵;服裝、表情、動作不入庫,每次按劇情生成。</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">整串模式(可選)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="留空則用上面的欄位拼接;填了整串且欄位全空時,以整串為準(舊資料格式)"
            @input="markManual"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">自然語言外貌(可選)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="一句連貫的英文外貌描述(可不填)"
            @input="markManual"
          />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">最終 tag 預覽</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(空)' }}</code>
          <span v-if="draftIsRaw" class="bbi-char-preview-mode">整串模式</span>
        </div>

        <!-- 變更歷史:僅本聊天條目;全域性條目無歷史(AI 不可改,手動編輯不留痕) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            變更歷史({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `第${record.floor}樓` : '手動' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="把該欄位回滾到變更前的值" @click="askRollback(record)">
                回滾
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> 刪除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            v-if="editingName && editingScope === 'chat'"
            class="bbi-btn"
            type="button"
            title="把當前外貌快照進全域性庫,所有聊天生效;本聊天副本與變更記錄將清除"
            @click="askPromote"
          >
            <Icon name="star" /> 提升為全域性
          </button>
          <button
            v-if="editingName && editingScope === 'global'"
            class="bbi-btn"
            type="button"
            title="複製為本聊天副本:之後本聊天以副本為準,AI 可對其變更"
            @click="copyToChat"
          >
            <Icon name="copy" /> 複製到本聊天
          </button>
          <button
            class="bbi-btn"
            type="button"
            title="讀取Horae最新狀態裡該角色的外貌,重新轉換成欄位"
            :disabled="regenerating"
            @click="regenerateFromHorae"
          >
            <Icon name="refresh" /> {{ regenerating ? '生成中…' : '從Horae生成' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="刪除角色"
          confirm-text="刪除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          確定刪除「{{ editingName }}」的固定外貌 tag 嗎?之後生成時該角色的外貌將不再錨定。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="提升為全域性"
          confirm-text="提升"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          把「{{ editingName }}」的當前外貌快照進全域性庫?之後所有聊天(包括本聊天)都以全域性值為準,
          AI 不能再修改它;本聊天的副本與變更記錄將被清除。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 回滾確認 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滾變更"
      confirm-text="回滾"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」從
        <code>{{ pendingRollback.record.to }}</code> 回滾到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建檔記錄的回滾會刪除整個條目。
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* —— 計數藥丸:與設定頁版本號同款觀感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 分割槽 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 摺疊開關 ——
 * 標題行整體可點:左箭頭 + 標題 + 計數標。無框透明,摺疊是輔助操作,標題仍是主體。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 摺疊箭頭:展開朝下,收攏轉 -90° 朝右。描邊繼承 currentColor(muted),hover 整行點亮強調色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度隨內容自適應,無需寫死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 區頭右側小「+」:透明底,hover 才點亮,不噴賓奪主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

/* —— 角色卡片網格 —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— 徽標藥丸:全域性=實心強調;Horae/AI=強調淺底;手動=弱化;覆蓋=警示色 —— */
.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 欄位 chips:兩行封頂,超出裁切 —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* 整串模式:mono 小字兩行截斷 */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 彈窗加寬,容納兩列欄位表單 —— */
.bbi-char-modal {
  max-width: 600px;
}

/* —— 欄位表單:兩列網格,固定著裝獨佔一行 —— */
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— 彈窗內歷史面板 —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 最終 tag 預覽 —— */
.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
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

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
