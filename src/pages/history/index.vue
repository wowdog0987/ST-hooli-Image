<script setup lang="ts">
import { computed, ref } from 'vue';

import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  clearHistory,
  records,
  roughTokens,
  type HistoryRecord,
  type LlmRecord,
} from '@/state/history';
import { copyText } from '@/st/clipboard';

/**
 * 請求歷史頁。
 *
 * 副 API 推理與生圖各自的呼叫收口點(api/client.ts、floor/Card.vue)把過程寫進
 * state/history.ts,這裡只負責展示。**純記憶體,重新整理即清空**——定位是除錯輔助,
 * 不是資產,所以既不落盤也不提供匯出。
 *
 * 結構:一條請求 = 一個摺疊區;展開後裡面是「一段提示詞 = 一行」的只讀列表
 * (與設定頁「自定義提示詞」同款觀感),點行進彈窗看全文。
 */

type Filter = 'all' | 'llm' | 'image';

/** 展開後列表裡的一段:副 API 是各條 message + 返回,生圖是各段提示詞。 */
interface Segment {
  /** 行首標籤:system / user / assistant / 返回 / 正向提示詞 … */
  label: string;
  text: string;
}

const filter = ref<Filter>('all');
/** 彈窗裡正在看的那一段(null = 關閉)。 */
const viewing = ref<{ title: string; segment: Segment } | null>(null);

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'llm', label: '副 API' },
  { value: 'image', label: '生圖' },
];

const shown = computed(() =>
  filter.value === 'all' ? records : records.filter(r => r.kind === filter.value),
);

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function duration(ms: number | null): string {
  if (ms === null) return '進行中';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(record: HistoryRecord): string {
  if (record.status === 'running') return '進行中';
  if (record.status === 'ok') return '成功';
  if (record.status === 'aborted') return '已取消';
  return '失敗';
}

function title(record: HistoryRecord): string {
  return record.kind === 'llm' ? record.source : `第 ${record.floor} 樓 · 第 ${record.seq + 1} 張`;
}

function subtitle(record: HistoryRecord): string {
  if (record.kind === 'llm') {
    return [record.channelName, record.model].filter(Boolean).join(' · ');
  }
  return [record.backend === 'nai' ? 'NAI' : 'ComfyUI', record.model].filter(Boolean).join(' · ');
}

/**
 * token 數展示。估算值加 ≈ 字首:估算走的是 ST 主介面當前模型的分詞器,
 * 與副 API 渠道模型未必同源,不能與上游返回的真實 usage 混顯。
 */
function tokenLabel(record: LlmRecord): string {
  if (record.promptTokens === null) return '';
  return `${record.tokensEstimated ? '≈' : ''}${record.promptTokens.toLocaleString()}`;
}

function tokenTitle(record: LlmRecord): string {
  return record.tokensEstimated
    ? '本地估算：用的是 ST 主介面當前模型的分詞器，與本渠道模型未必一致，僅供參考'
    : '上游返回的真實用量（usage）';
}

/** 把一條記錄攤成「按順序的若干段」——展開區就是照這個順序渲染的。 */
function segments(record: HistoryRecord): Segment[] {
  if (record.kind === 'llm') {
    const out: Segment[] = record.messages.map(m => ({ label: m.role, text: m.content }));
    if (record.response) out.push({ label: '返回', text: record.response });
    return out;
  }
  const out: Segment[] = [{ label: '正向提示詞', text: record.prompt }];
  if (record.nl) out.push({ label: '自然語言', text: record.nl });
  for (const character of record.characters ?? []) {
    out.push({
      label: `\u89d2\u8272: ${character.name}`,
      text: [character.tag, character.nl].filter(Boolean).join('\n\n'),
    });
  }
  if (record.negative) out.push({ label: '負面', text: record.negative });
  return out;
}

/** 行內預覽:壓掉換行,長的靠 CSS 省略號截斷。 */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 展開區頂部那排事實標籤。 */
function facts(record: HistoryRecord): string[] {
  const out = [subtitle(record), duration(record.durationMs), new Date(record.startedAt).toLocaleString()];
  if (record.kind === 'llm') {
    if (record.stream) out.push('流式');
    // 標題行那個數字是提示詞 token(標題行地方緊,不帶單位);這裡補全口徑。
    if (record.promptTokens !== null) out.push(`提示詞 ${tokenLabel(record)} token`);
    if (record.completionTokens !== null) {
      out.push(`輸出 ${record.tokensEstimated ? '≈' : ''}${record.completionTokens.toLocaleString()} token`);
    }
  } else {
    out.push(`種子 ${record.seed}`, record.size);
  }
  return out.filter(Boolean);
}

/** 整條記錄拷成文本,方便貼去別處排查。 */
function copyAll(record: HistoryRecord): void {
  const head = [
    `【${title(record)}】${subtitle(record)}`,
    `狀態：${statusLabel(record)}  耗時：${duration(record.durationMs)}`,
    record.kind === 'llm' && record.promptTokens !== null
      ? `提示詞 token：${tokenLabel(record)}`
      : '',
    record.error ? `錯誤：${record.error}` : '',
  ].filter(Boolean);
  const body = segments(record).map(s => `--- ${s.label} ---\n${s.text}`);
  void copyText([...head, '', ...body].join('\n'), '記錄已複製');
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">請求歷史</h2>
      <span class="bbi-count" title="本次會話已記錄的請求數">{{ records.length }}</span>
    </div>
    <hr class="bbi-rule" />

    <div class="bbi-hist-bar">
      <div class="bbi-segmented-wrap">
        <div class="bbi-segmented" role="tablist" aria-label="記錄型別">
          <button
            v-for="f in FILTERS"
            :key="f.value"
            class="bbi-seg"
            :class="{ 'is-on': filter === f.value }"
            type="button"
            role="tab"
            :aria-selected="filter === f.value"
            @click="filter = f.value"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <button
        class="bbi-btn bbi-btn-danger bbi-btn-sm"
        type="button"
        :disabled="!records.length"
        @click="clearHistory"
      >
        <Icon name="trash" /> 清空
      </button>
    </div>

    <!-- 一條請求 = 一個摺疊區 -->
    <div v-if="shown.length" class="bbi-sections">
      <Collapsible v-for="record in shown" :key="record.id" :open="false">
        <template #header>
          <span class="bbi-hist-head">
            <span class="bbi-hist-name">{{ title(record) }}</span>
            <span class="bbi-hist-sub">{{ subtitle(record) }}</span>
            <span
              v-if="record.kind === 'llm' && tokenLabel(record)"
              class="bbi-hist-tok"
              :class="{ 'is-est': record.tokensEstimated }"
              :title="tokenTitle(record)"
            >
              {{ tokenLabel(record) }}
            </span>
            <span class="bbi-hist-time">{{ time(record.startedAt) }}</span>
            <span class="bbi-prompt-state" :class="`is-${record.status}`">{{ statusLabel(record) }}</span>
          </span>
        </template>

        <div class="bbi-hist-facts">
          <span v-for="(f, i) in facts(record)" :key="i" class="bbi-hist-fact">{{ f }}</span>
        </div>

        <p v-if="record.error" class="bbi-hist-error">{{ record.error }}</p>

        <p
          v-if="record.kind === 'llm' && record.tokensEstimated && record.promptTokens !== null"
          class="bbi-field-hint"
        >
          帶 ≈ 的 token 數是本地估算：流式與「跟隨主 API」拿不到上游用量，
          這裡用 ST 主介面當前模型的分詞器估的，與本渠道模型未必一致。
        </p>

        <!-- 按順序的提示詞列表:與設定頁「自定義提示詞」同款行 -->
        <ul class="bbi-prompt-list">
          <li v-for="(seg, i) in segments(record)" :key="i">
            <button
              class="bbi-prompt-open"
              type="button"
              @click="viewing = { title: `${title(record)} · ${seg.label}`, segment: seg }"
            >
              <span class="bbi-prompt-role">{{ seg.label }}</span>
              <span class="bbi-prompt-preview">{{ inline(seg.text) }}</span>
              <span
                class="bbi-prompt-len"
                title="本段 token 粗估（本地按字元估算，僅供段間比較，與標題行的真實用量口徑不同）"
              >≈{{ roughTokens(seg.text).toLocaleString() }}</span>
              <Icon name="eye" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>

        <div class="bbi-hist-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="copyAll(record)">
            <Icon name="copy" /> 複製整條
          </button>
        </div>
      </Collapsible>
    </div>
    <p v-else-if="records.length" class="bbi-field-hint">當前篩選下沒有記錄。</p>
    <p v-else class="bbi-field-hint">
      本次會話還沒有請求記錄。觸發一次自動 tag 或生成一張圖，這裡就會出現條目（重新整理頁面會清空）。
    </p>

    <!-- ===== 單段全文彈窗 ===== -->
    <ModalMask :open="!!viewing" @close="viewing = null">
      <div v-if="viewing" class="bbi-modal bbi-modal-wide" role="dialog" aria-modal="true" aria-label="提示詞全文">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">{{ viewing.title }}</span>
          <button class="bbi-icon-mini" type="button" title="關閉" @click="viewing = null">
            <Icon name="close" />
          </button>
        </header>

        <pre class="bbi-hist-text">{{ viewing.segment.text }}</pre>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="copyText(viewing!.segment.text, '已複製')">
            <Icon name="copy" /> 複製
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="viewing = null">完成</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— 計數藥丸:與角色頁/設定頁同款觀感 —— */
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

.bbi-hist-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0;
}

/* —— 摺疊區標題行:名稱 + 渠道 + token + 時間 + 狀態 ——
   收縮優先順序(擠不下時誰先讓路):渠道/模型 → 標題 → 時間;
   token 與狀態藥丸**永不收縮**——它們是這一行最該被讀到的兩個值。 */
.bbi-hist-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
/* 標題可收縮(min-width:0 是省略號生效的前提)。
   原先是 flex:0 0 auto 不可收縮,長標題會把後面的 token/狀態整個擠出容器——
   窄屏「看不到 token」正是這麼來的,不是被 media query 藏了。 */
.bbi-hist-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 渠道/模型:最先讓路的那個 */
.bbi-hist-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbi-hist-tok {
  flex: 0 0 auto;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
}
/* 估算值弱化:與真實用量視覺上就分開,免得被當成權威數字 */
.bbi-hist-tok.is-est {
  color: var(--bbi-ink-muted);
  font-weight: 400;
}
.bbi-hist-time {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* 狀態藥丸:複用全域性 .bbi-prompt-state 的幾何,只改配色。
   成功走它自帶的 .is-custom 同款強調色,失敗紅、取消橙(取消不是故障)。 */
.bbi-prompt-state.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-aborted {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 展開區:事實標籤條 —— */
.bbi-hist-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.bbi-hist-fact {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-soft);
  background: var(--bbi-surface-2);
}

.bbi-hist-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-danger-soft);
  color: var(--bbi-danger);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

/* —— 提示詞分段列表:幾何照搬設定頁「自定義提示詞」 —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
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
/* 角色標籤 = 這段提示詞的身份,與設定頁 .bbi-prompt-name 同口徑:走 --bbi-ink。
   定寬讓各行預覽的左邊緣對齊成一條線。
   【寬度按最長標籤定】ASSISTANT 是 9 個大寫等寬字元 + letter-spacing,原來拍腦袋
   給的 72px 裝不下,被省略成「ASSISTAN…」。用 ch 單位跟著字號走,換字號不會再截斷。
   【勿改成 --bbi-accent】它在粉彩主題下是 #ffafcc(淺粉,本就是給背景用的,
   配套 --bbi-accent-ink 白字),當文字色壓在淺色面上幾乎看不見。 */
.bbi-prompt-role {
  flex: 0 0 auto;
  width: 10.5ch;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.bbi-prompt-preview {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* token 粗估:一眼看出哪段最佔篇幅,是這個列表最該被讀到的值。
   定寬 + 右對齊 + tabular-nums:各行個位對齊成一列,不同位數(≈400 / ≈3,700)
   才能直接比長短;不定寬的話數字隨預覽寬度浮動,比大小就得逐個讀。
   寬度含 ≈ 字首 + 5 位數(萬級),用 ch 跟著字號走。 */
.bbi-prompt-len {
  flex: 0 0 auto;
  width: 7ch;
  text-align: right;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

.bbi-hist-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* —— 彈窗:更寬 + 長文本限高滾動 —— */
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-hist-text {
  margin: 0;
  padding: 12px 14px;
  max-height: 52vh;
  overflow-y: auto;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  user-select: text;
}

/* —— 危險按鈕 / 圖示按鈕 / 底部佔位:scoped 過不了元件邊界,各頁各抄一份 —— */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.bbi-icon-mini {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— 窄屏:標題行擠不下,讓次要資訊退場 ——
   token 與狀態**必須留下**:token 是這頁的核心資訊,比渠道名/時間重要得多。 */
@media (max-width: 640px) {
  .bbi-hist-name {
    font-size: 13px;
  }
  .bbi-hist-sub,
  .bbi-hist-time {
    display: none;
  }
  /* 窄屏:預覽讓位給 token 估算。估算值是判斷「哪段佔篇幅」的唯一依據,預覽只是
     輔助辨認——兩者只能留一個時留數字。預覽撤走後靠 margin-left:auto 把它頂回右側,
     否則會貼著角色標籤擠在左邊,離眼睛按鈕老遠、看著也不像一列。
     角色標籤寬度不再壓縮:壓到 56px 會把 ASSISTANT 截斷,而它正是要看的身份資訊。 */
  .bbi-prompt-preview {
    display: none;
  }
  .bbi-prompt-len {
    margin-left: auto;
    font-size: 12px;
    color: var(--bbi-ink);
  }
  .bbi-hist-text {
    font-size: 11.5px;
  }
}
</style>
