<script setup lang="ts">
import { formatBytes } from '@/bytes';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { imageDownloadFileName } from '@/floor/download';
import { openLightbox } from '@/floor/lightbox';
import { markImagesMissing, normalizeImagePath } from '@/floor/missingImages';
import { deleteImageFileOnly, readStore, sidecarPathFor, type BbiImageSidecar } from '@/floor/storage';
import { mapLimit } from '@/pool';
import { getContext } from '@/st/context';
import { formatPromptText, parseImageTagContent } from '@/st/imageTagRegex';
import { ARTIST_PREVIEW_FOLDER, listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { computed, onMounted, ref } from 'vue';

/**
 * 相簿頁 —— 按角色名分組瀏覽已生成的圖片（GALLERY-STORAGE-DESIGN.md）。
 *
 * 分組鍵取**目錄名**而非檔名:落盤檔名裡的角色名是雜湊
 * (floor/storage.ts imageFileName,防中文名被清洗成連續下劃線),可讀名只能從
 * `user/images/柏宝绘_<角色名>/` 的目錄名還原。
 *
 * 【刪除】支援多選刪除,但**只刪檔案、不碰聊天記錄**:圖片路徑同時被
 * message.extra.bbiImage 引用,而相簿按目錄列圖、指標散在各個聊天裡,兩者之間沒有反向
 * 索引(掃全庫反查不可行,見 floor/storage.ts 頂部)。破指標由樓層卡片側執行時降級兜底:
 * 卡片的 <img> @error 會確認 404 後把這張圖記進 floor/missingImages.ts,翻頁器與張數
 * 隨即按存活口徑重算,全刪光則退回「生成圖片」態。刪完本頁也會就地標記,免得使用者
 * 切回聊天才發現。
 *
 * 提示詞從兩處取(見 promptFor):當前聊天的 extra 直接讀,其餘靠存圖時寫下的側寫 json。
 */

const FOLDER_PREFIX = '柏宝绘_';
/** 展開後先渲染一批,每次再追加一批,不一次鋪開整個目錄。 */
const PREVIEW_COUNT = 24;
/** 側寫請求超時:點圖後要等它才開燈箱,不能讓服務端卡住把點選拖成「點了沒反應」。 */
const SIDECAR_TIMEOUT_MS = 4000;
/**
 * 批次請求(探體積、刪圖)的併發上限。
 * 不開大:ST 是單程序,幾十個請求一起壓過去會把使用者自己的聊天卡住;
 * 公網連線下更明顯。6 路夠快又不至於霸佔連線池。
 */
const REQUEST_CONCURRENCY = 6;
/** 體積攢夠這麼多張再推一次響應式更新(理由見 measureSizes)。 */
const SIZE_PUBLISH_BATCH = 12;

interface GalleryImage {
  /** 目錄內的檔名(組內唯一,作 key) */
  file: string;
  /** 歸一化的完整路徑,提示詞快取的鍵(跨目錄唯一) */
  key: string;
  /** <img src>,已按段編碼 */
  src: string;
  /** 另存檔名 */
  download: string;
}

interface GalleryGroup {
  /** 完整目錄名(含字首) */
  folder: string;
  /** 展示用角色名(去字首) */
  name: string;
  images: GalleryImage[];
}

const groups = ref<GalleryGroup[]>([]);
const loading = ref(false);
const error = ref('');
/** 部分目錄讀取失敗的條數:整頁不失敗,但要如實說明少了幾組。 */
const partialFailed = ref(0);
const query = ref('');

/**
 * 靜態路由 /user/images/* 服務端做 decodeURIComponent(users.js createRouteHandler),
 * 故逐段編碼:中文名瀏覽器本會自動編碼,但角色名裡的 # ? 不編碼會被當成 URL 片段/查詢。
 */
function imageSrc(folder: string, file: string): string {
  return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/** 從 bbi_<nameHash>_<swipe>_<promptHash>-<genId>.<ext> 裡取 genId,取不到則回退原檔名。 */
function downloadName(characterName: string, file: string): string {
  const genId = file.match(/-([^-.]+)\.[a-z0-9]+$/i)?.[1];
  return genId ? imageDownloadFileName(file, characterName, genId) : file;
}

/* —— 提示詞:當前聊天直接讀 extra,其餘走側寫 —— */

/**
 * 歸一化路徑 → 提示詞全文。兩個來源合用一張表:
 * - load() 時從**當前聊天**的 extra 預填(零網路開銷,讓本聊天的存量老圖也有提示詞);
 * - 點圖未命中時取側寫 json 回填。
 * 取不到的記 null 並留在表裡,免得反覆點同一張圖反覆打 404。
 */
const promptCache = ref(new Map<string, string | null>());

/** 側寫/extra 裡存的都是 tag 原文,統一在這裡解析成人讀的全文(與卡片同一口徑)。 */
function renderPrompt(rawTag: string, seed: number | null): string {
  const text = formatPromptText(parseImageTagContent(rawTag));
  if (!text) return '';
  return seed === null ? text : `${text}\n\nSeed: ${seed}`;
}

/**
 * 掃當前聊天的 extra,把 path → 提示詞全部收進快取。
 *
 * 只掃當前這一個聊天:跨全庫反查提示詞曾評估過,單個角色的 chats 目錄就能到 GB 級、
 * 且 /api/chats/get 整檔案返回無分頁,掃下去必然卡死。本聊天已在記憶體裡,白拿。
 */
function seedPromptsFromChat(): void {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return;
  const next = new Map(promptCache.value);
  for (const message of chat) {
    const store = readStore(message);
    if (!store) continue;
    for (const bucket of Object.values(store)) {
      for (const list of Object.values(bucket)) {
        for (const entry of list) {
          if (!entry?.path || !entry.prompt) continue;
          next.set(normalizeImagePath(entry.path), renderPrompt(entry.prompt, entry.seed ?? null));
        }
      }
    }
  }
  promptCache.value = next;
}

/**
 * 取側寫 json。走裸 fetch 不帶 headers——靜態路由不需要鑑權頭
 * (與 backends/vibeStore.ts loadVibeData 同款)。
 * 任何失敗(404 / 超時 / 不是 JSON)都返回 null 靜默降級:老圖本來就沒有側寫,
 * 那是預期內的常態,不該報錯也不該攔住燈箱。
 */
async function fetchSidecarPrompt(imagePath: string): Promise<string | null> {
  const sidecar = sidecarPathFor(imagePath);
  if (!sidecar) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
  try {
    const response = await fetch(sidecar, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<BbiImageSidecar>;
    if (!data || typeof data.prompt !== 'string' || !data.prompt) return null;
    return renderPrompt(data.prompt, typeof data.seed === 'number' ? data.seed : null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  partialFailed.value = 0;
  // 重新整理時重掃當前聊天:期間可能又生成了幾張圖,也可能切了聊天
  seedPromptsFromChat();
  try {
    // 只列 /folders 報上來的目錄:/api/images/list 對不存在的目錄會 mkdir,
    // 憑空猜名字會在 user/images 下攢出空資料夾。
    const folders = (await listUserImageFolders()).filter(
      folder => folder.startsWith(FOLDER_PREFIX) && folder !== ARTIST_PREVIEW_FOLDER,
    );
    const settled = await Promise.allSettled(
      folders.map(async folder => ({ folder, files: await listUserImages(folder) })),
    );

    const next: GalleryGroup[] = [];
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') {
        partialFailed.value++;
        console.warn('[虎哩繪] 讀取相簿目錄失敗', folders[i], result.reason);
        return;
      }
      const { folder, files } = result.value;
      if (!files.length) return; // 刪空後的殘留目錄不佔位
      const name = folder.slice(FOLDER_PREFIX.length) || '未命名角色';
      next.push({
        folder,
        name,
        images: files.map(file => ({
          file,
          key: `user/images/${folder}/${file}`,
          src: imageSrc(folder, file),
          download: downloadName(name, file),
        })),
      });
    });

    // 當前聊天角色排最前,其餘按名字排序——剛生成的圖不用翻著找。
    const current = getContext()?.name2?.trim() ?? '';
    const collator = new Intl.Collator('zh-Hans-CN');
    next.sort((a, b) => {
      const rank = Number(b.name === current) - Number(a.name === current);
      return rank || collator.compare(a.name, b.name);
    });
    groups.value = next;
    // ⚠ 暫時停用分組體積統計:作者不滿意當前方案——逐張 HEAD 讀 Content-Length,
    // 請求數隨相簿規模線性增長,進一次相簿就是幾百上千個後臺請求。
    // 體積相關的計算、模板、CSS 與測試全部原樣保留,恢復時解注下面這一行即可。
    // void measureSizes(next);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* —— 體積統計(⚠ 暫時停用:load() 裡的 measureSizes 呼叫已註釋,理由見該處) —— */

/**
 * 歸一化路徑 → 位元組數。**逐張 HEAD 量出來的**。
 *
 * 為什麼只能這樣:`/api/images/list` 只返回檔名,既無 size 也無 mtime
 * (服務端 util.js getImages 只 map 出 dirent.name),沒有任何現成介面報體積。
 * HEAD 走靜態路由 res.sendFile,實測 1~2ms 且無 body——比縮圖本身(相簿直接載入原圖,
 * 一個組就是十幾 MB)便宜得多。
 *
 * 不進 localStorage 快取:檔案可能被外部改動,快取過期沒法感知,而重量一遍也就幾十個
 * HEAD。頁面活著期間按路徑快取即可,重新整理按鈕會重量。
 */
const sizes = ref(new Map<string, number>());
/** 還在量體積的分組數:>0 時總計後面顯示「計算中」,免得把半截數字當成最終值。 */
const measuring = ref(0);

/**
 * 後臺量體積:限併發逐張 HEAD。**不 await、不阻塞首屏**——圖已經能看了,
 * 體積是附加資訊,慢慢填上來即可。
 *
 * 已量過的路徑跳過(重新整理時大部分圖沒變,只有新增的那幾張要量)。
 *
 * 攢批發布而非逐張寫回:groupSize 要遍歷組內全部圖才能算出合計,每量到一張就釋出一次
 * 等於讓每個分組把自己重算 n 遍——幾千張圖時是平方級空轉。攢夠一批再推一次,
 * 「慢慢填上來」的觀感不變。
 */
async function measureSizes(list: GalleryGroup[]): Promise<void> {
  const pending = list.flatMap(group => group.images).filter(image => !sizes.value.has(image.key));
  if (!pending.length) return;
  measuring.value++;
  // 未釋出的增量。釋出時**合併進當前值**而非整份替換:連點兩次重新整理會有兩輪
  // measureSizes 並行,各自持有快照替換會把對方量到的數抹掉。
  const buffered = new Map<string, number>();
  const publish = (): void => {
    if (!buffered.size) return;
    const next = new Map(sizes.value);
    for (const [key, size] of buffered) next.set(key, size);
    buffered.clear();
    sizes.value = next;
  };
  try {
    await mapLimit(pending, REQUEST_CONCURRENCY, async image => {
      const probe = await probeUserImage(image.src);
      // 只記確定的數:探不到(網路錯誤)就留空,由 groupSize 按「還沒量全」處理
      if (probe?.exists && probe.size !== null) {
        buffered.set(image.key, probe.size);
        if (buffered.size >= SIZE_PUBLISH_BATCH) publish();
      }
    });
  } finally {
    publish();
    measuring.value--;
  }
}

/** 一組的體積合計與完整度。量全了才是準數,否則文案要帶「≥」。 */
function groupSize(group: GalleryGroup): { bytes: number; complete: boolean } {
  let bytes = 0;
  let known = 0;
  for (const image of group.images) {
    const size = sizes.value.get(image.key);
    if (size === undefined) continue;
    bytes += size;
    known++;
  }
  return { bytes, complete: known === group.images.length };
}

/** 分組角標上的體積文案;一張都沒量出來時返回空串(不顯示,而非顯示 0 B)。 */
function groupSizeText(group: GalleryGroup): string {
  const { bytes, complete } = groupSize(group);
  if (!bytes) return '';
  const text = formatBytes(bytes);
  return complete ? text : `≥ ${text}`;
}

const totalSizeText = computed(() => {
  let bytes = 0;
  for (const size of sizes.value.values()) bytes += size;
  return bytes ? formatBytes(bytes) : '';
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value.filter(group => group.name.toLowerCase().includes(q));
});

const totalImages = computed(() => groups.value.reduce((n, g) => n + g.images.length, 0));

/* 預設摺疊,僅記錄手動展開的分組。舊 collapsed 列表不能反推哪些組是手動展開的。 */
const EXPANDED_KEY = 'bbi.ui.galleryExpanded.v1';

function loadExpanded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

const expanded = ref<Set<string>>(loadExpanded());

/**
 * 已掛載過內容的分組。**只進不出**——收起不解除安裝,再展開時圖還在,零請求。
 *
 * 摺疊容器改為常駐後,若內容也無條件渲染,一進頁就要掛滿所有角色的圖(預設全摺疊),
 * 比解除安裝更糟;故用它兜底:沒手動展開過的分組一張圖都不渲染,展開後永久留在 DOM 裡。
 */
const mounted = ref<Set<string>>(new Set(expanded.value));

function persistExpanded(next: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
  } catch {
    /* localStorage 不可用時僅本次會話生效 */
  }
}

function toggleFold(folder: string): void {
  const open = !expanded.value.has(folder);
  // 首次展開時才掛內容;之後收起不再解除安裝。
  // 不必分兩幀「先掛內容、下一幀再展開」——.gal-fold-wrap 自頁面載入起就常駐且停在 0fr,
  // 過渡的起點值早已落定,同幀插入內容不影響它從 0fr 過渡到 1fr。
  if (open) mounted.value = new Set(mounted.value).add(folder);

  const next = new Set(expanded.value);
  if (open) next.add(folder);
  else next.delete(folder);
  expanded.value = next;
  persistExpanded(next);
}

/* 已顯示數量僅在本次頁面內保留,收起後再展開無需從第一批重來。 */
const visibleCounts = ref(new Map<string, number>());

function visibleImages(group: GalleryGroup): GalleryImage[] {
  return group.images.slice(0, visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT);
}

function showMore(group: GalleryGroup): void {
  const count = visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT;
  visibleCounts.value.set(group.folder, Math.min(count + PREVIEW_COUNT, group.images.length));
}

/* —— 多選刪除 —— */

/**
 * 選擇模式。獨立開關而非「長按進入」:相簿的主用途是瀏覽,點圖=放大必須是預設行為;
 * 選擇態下點圖改為勾選,兩種語義靠這個開關明確分開,不讓使用者在放大和勾選之間猜。
 */
const selecting = ref(false);
/** 已勾選的圖(歸一化路徑 key,跨分組唯一)。 */
const selected = ref(new Set<string>());
const deleting = ref(false);

const selectedCount = computed(() => selected.value.size);

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  // 退出選擇態一律清空:留著選中項,下次進來會對著一批不記得為何選中的圖按刪除
  if (!selecting.value) selected.value = new Set();
}

function toggleSelected(image: GalleryImage): void {
  const next = new Set(selected.value);
  if (next.has(image.key)) next.delete(image.key);
  else next.add(image.key);
  selected.value = next;
}

/** 本組是否整組選中(空組不算)。 */
function groupAllSelected(group: GalleryGroup): boolean {
  return group.images.length > 0 && group.images.every(image => selected.value.has(image.key));
}

function someSelected(group: GalleryGroup): boolean {
  return !groupAllSelected(group) && group.images.some(image => selected.value.has(image.key));
}

/**
 * 整組全選/取消。**作用於整組而非當前可見的那批**——懶載入只是渲染策略,
 * 使用者說「全選這個角色」指的是這個角色的全部圖片,不該因為沒往下翻而少選。
 */
function toggleGroup(group: GalleryGroup): void {
  const next = new Set(selected.value);
  if (groupAllSelected(group)) group.images.forEach(image => next.delete(image.key));
  else group.images.forEach(image => next.add(image.key));
  selected.value = next;
}

/** 點圖:選擇態勾選,否則放大。 */
function onThumbClick(image: GalleryImage): void {
  if (selecting.value) toggleSelected(image);
  else void open(image);
}

/**
 * 刪除選中的圖。**只刪檔案,不碰聊天記錄**(理由見檔案頂部註釋)。
 *
 * 刪完做三件事:標記缺失(讓本會話裡已開啟的樓層卡片立刻降級,不必等它自己 404)、
 * 就地從列表摘掉(不重新 load,免得把使用者的展開態和已載入批次全重置)、清理體積快取。
 */
async function deleteSelected(): Promise<void> {
  if (!selectedCount.value || deleting.value) return;
  const targets = groups.value
    .flatMap(group => group.images)
    .filter(image => selected.value.has(image.key));
  if (!targets.length) return;

  const ok = await confirmDialog({
    title: `刪除 ${targets.length} 張圖片`,
    text:
      `將從磁碟刪除這 ${targets.length} 張圖片及其提示詞側寫檔案，無法恢復。\n\n` +
      '聊天記錄不會被改動：樓層卡片會顯示「圖片檔案已刪除」並退回可重新生成的狀態。',
    confirmText: '刪除',
    tone: 'danger',
  });
  if (!ok) return;

  deleting.value = true;
  try {
    // 逐張容錯:一張失敗不該中斷其餘的(mapLimit 會 reject 整體,故在回撥裡自己接住)
    const results = await mapLimit(targets, REQUEST_CONCURRENCY, async image => {
      try {
        // 傳 key 而非 src:src 是給 <img> 用的逐段編碼路徑,而刪除介面要的是解碼後的
        // 磁碟路徑(ST /api/images/delete 直接 path.join,不做 decodeURIComponent)。
        // key 與 markImagesMissing / sizes 同一口徑,中文目錄名不會打偏到 404。
        await deleteImageFileOnly(image.key);
        return { key: image.key, ok: true };
      } catch (e) {
        console.warn('[虎哩繪] 刪除圖片失敗', image.key, e);
        return { key: image.key, ok: false };
      }
    });

    const done = new Set(results.filter(r => r.ok).map(r => r.key));
    const failed = results.length - done.size;

    if (done.size) {
      // 已開啟的樓層卡片據此立刻降級(key 本就是歸一化路徑,與 missingImages 同口徑)
      markImagesMissing(done);
      // 就地摘除:不 load(),否則使用者的展開態與已載入批次全被重置
      groups.value = groups.value
        .map(group => ({ ...group, images: group.images.filter(image => !done.has(image.key)) }))
        .filter(group => group.images.length > 0);
      const nextSizes = new Map(sizes.value);
      done.forEach(key => nextSizes.delete(key));
      sizes.value = nextSizes;
    }

    selected.value = new Set([...selected.value].filter(key => !done.has(key)));
    if (!selected.value.size) selecting.value = false;

    if (failed) toastr.error(`${failed} 張刪除失敗，詳情見控制台`, '虎哩繪');
    else toastr.success(`已刪除 ${done.size} 張圖片`, '虎哩繪');
  } finally {
    deleting.value = false;
  }
}

/** 正在取側寫的那張圖(點選後到燈箱開啟之間,給個轉圈別讓人以為沒點上)。 */
const pending = ref('');

/**
 * 點圖:先備好提示詞再開燈箱。
 *
 * 必須**先 await 再 openLightbox**:燈箱是命令式 h() 渲染的一次性元件,
 * props 不是響應式的,晚到的提示詞補不進去。
 */
async function open(image: GalleryImage): Promise<void> {
  let prompt = promptCache.value.get(image.key);
  if (prompt === undefined) {
    pending.value = image.key;
    try {
      prompt = await fetchSidecarPrompt(image.key);
      // null 也要落快取:記住「這張確實沒有」,免得每次點都再打一輪 404
      promptCache.value = new Map(promptCache.value).set(image.key, prompt);
    } finally {
      pending.value = '';
    }
  }
  openLightbox({ src: image.src, filename: image.download, prompt: prompt ?? '' });
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">相簿</h2>
      <button class="gal-icon-btn" type="button" title="重新讀取" :disabled="loading" @click="load">
        <Icon name="refresh" />
      </button>
    </div>
    <hr class="bbi-rule" />

    <!-- 工具條:只搜角色名(檔名是雜湊,搜了沒意義) -->
    <div class="gal-toolbar">
      <input v-model="query" class="bbi-input gal-search" placeholder="搜尋角色名" />
      <button
        class="bbi-btn bbi-btn-sm gal-select-toggle"
        :class="{ 'is-on': selecting }"
        type="button"
        :disabled="!groups.length"
        :title="selecting ? '退出選擇' : '選擇圖片以批次刪除'"
        @click="toggleSelecting"
      >
        <Icon :name="selecting ? 'close' : 'checklist'" />
        {{ selecting ? '退出選擇' : '選擇' }}
      </button>
      <span class="gal-count">
        {{ groups.length }} 位角色 · {{ totalImages }} 張<template v-if="totalSizeText">
          · {{ totalSizeText }}<span v-if="measuring" class="gal-measuring">+</span>
        </template>
      </span>
    </div>

    <!-- 選擇態操作條:緊跟工具條、sticky 吸頂。
         放這裡而非列表末尾:撥出它的「選擇」鈕就在上一行,一按就看見(擺到底部的話,
         角色多時按下去螢幕上什麼都不動,像沒生效);吸頂又保證往下翻多久都還在。 -->
    <div v-if="selecting" class="gal-actionbar">
      <span class="gal-actionbar-count">已選 {{ selectedCount }} 張</span>
      <button
        class="bbi-btn bbi-btn-sm"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="selected = new Set()"
      >
        清空
      </button>
      <button
        class="bbi-btn bbi-btn-sm bbi-btn-danger"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="deleteSelected"
      >
        <Icon name="trash" />
        {{ deleting ? '刪除中…' : '刪除' }}
      </button>
    </div>

    <p v-if="partialFailed" class="gal-warn">
      有 {{ partialFailed }} 個角色目錄讀取失敗，未在下方列出（詳情見控制台）。
    </p>

    <!-- 讀取中 / 出錯 / 空 / 列表 -->
    <div v-if="loading && !groups.length" class="gal-state">
      <Icon name="refresh" :size="26" class="gal-spin" />
      <p class="gal-state-title">正在讀取相簿…</p>
    </div>

    <div v-else-if="error" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">讀取失敗</p>
      <p class="gal-state-hint">{{ error }}</p>
      <button class="bbi-btn bbi-btn-sm" type="button" @click="load"><Icon name="refresh" /> 重試</button>
    </div>

    <div v-else-if="!groups.length" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">還沒有圖片</p>
      <p class="gal-state-hint">在聊天裡生成圖片後，會按角色自動歸類到這裡。</p>
    </div>

    <p v-else-if="!filtered.length" class="gal-state-inline">沒有匹配「{{ query }}」的角色。</p>

    <div v-else class="gal-groups">
      <section
        v-for="group in filtered"
        :key="group.folder"
        class="gal-group"
        :class="{ 'is-collapsed': !expanded.has(group.folder) }"
      >
        <!-- 標題行是「一個容器 + 內部若干獨立控制元件」而非單個大按鈕:選擇態要在這一行裡
             放整組全選的核取方塊,而 <button> 裡不能嵌 <button>/<input>(HTML 非法且
             點選會雙觸發)。故摺疊觸發器單獨是一顆按鈕,核取方塊與它並排。 -->
        <div class="gal-fold-head">
          <label v-if="selecting" class="gal-group-check" :title="`全選${group.name}`">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="groupAllSelected(group)"
              :indeterminate="someSelected(group)"
              :aria-label="`全選${group.name}`"
              @change="toggleGroup(group)"
            />
          </label>
          <button
            class="gal-fold-trigger"
            type="button"
            :aria-expanded="expanded.has(group.folder)"
            :title="expanded.has(group.folder) ? `收起${group.name}` : `展開${group.name}`"
            @click="toggleFold(group.folder)"
          >
            <Icon name="chevron" class="gal-caret" :class="{ 'is-collapsed': !expanded.has(group.folder) }" />
            <span class="gal-name">{{ group.name }}</span>
            <span class="gal-badge">{{ group.images.length }}</span>
            <span v-if="groupSizeText(group)" class="gal-size">{{ groupSizeText(group) }}</span>
          </button>
        </div>

        <!-- 摺疊容器常駐 DOM(grid 1fr→0fr 只把高度歸零),<img> 不解除安裝:
             /user/images 靜態路由 sendFile 不帶 maxAge,預設 Cache-Control: max-age=0,
             重掛一次就是一張圖一個條件請求(Firefox 更是 no-store,整份重下)。
             公網連 ST 時這些往返全壓在延遲上,收起再展開會白屏一拍。同 floor/card.css。 -->
        <div class="gal-fold-wrap" :class="{ 'is-collapsed': !expanded.has(group.folder) }">
          <div class="gal-fold-inner">
            <div v-if="mounted.has(group.folder)" class="gal-fold-body">
              <ul class="gal-grid">
                <li v-for="image in visibleImages(group)" :key="image.file" class="gal-cell">
                  <button
                    class="gal-thumb"
                    :class="{
                      'is-busy': pending === image.key,
                      'is-selectable': selecting,
                      'is-selected': selecting && selected.has(image.key),
                    }"
                    type="button"
                    :title="selecting ? image.file : `放大 ${image.file}`"
                    :aria-pressed="selecting ? selected.has(image.key) : undefined"
                    @click="onThumbClick(image)"
                  >
                    <img class="gal-img" :src="image.src" :alt="`${group.name} 的生成圖`" loading="lazy" />
                    <!-- 勾選角標:只在選擇態出現,選中時填充主色 -->
                    <span v-if="selecting" class="gal-check" aria-hidden="true">
                      <Icon v-if="selected.has(image.key)" name="check" :size="13" />
                    </span>
                  </button>
                </li>
              </ul>
              <button
                v-if="group.images.length > visibleImages(group).length"
                class="bbi-btn bbi-btn-sm gal-more"
                type="button"
                @click="showMore(group)"
              >
                <Icon name="plus" />
                再顯示 {{ Math.min(PREVIEW_COUNT, group.images.length - visibleImages(group).length) }} 張
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

  </section>
</template>

<style scoped>
/* —— 題首右側重新整理 —— */
.gal-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}
.gal-icon-btn:hover:not(:disabled) {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.gal-icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

/* —— 工具條 —— */
.gal-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.gal-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.gal-count {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* 體積還在量:總計後跟一個「+」示意「至少這麼多,還在加」。
   不用轉圈——工具條裡多一個動效太吵,而這個加號靜態也讀得懂。 */
.gal-measuring {
  margin-left: 1px;
  opacity: 0.6;
}

/* 選擇模式開關。開啟時用主色實心,與「正在選」的狀態對齊。 */
.gal-select-toggle {
  flex: 0 0 auto;
}
.gal-select-toggle.is-on {
  border-color: var(--bbi-accent);
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}

.gal-warn {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
  font-size: 12px;
}

/* —— 空/錯/載入態 —— */
.gal-state {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 80px 20px;
  color: var(--bbi-ink-soft);
  text-align: center;
}
.gal-state-title {
  margin: 0;
  font-size: 15px;
  color: var(--bbi-ink);
}
.gal-state-hint {
  margin: 0;
  max-width: 34em;
  font-size: 12.5px;
  word-break: break-word;
}
.gal-state-inline {
  margin: 0;
  padding: 40px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-muted);
}
.gal-spin {
  animation: gal-rotate 0.9s linear infinite;
  color: var(--bbi-accent);
}
@keyframes gal-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gal-spin {
    animation: none;
  }
}

/* —— 分組 —— */
/* —— 分組卡片 ——
   與設定頁 .bbi-sections 同款節奏(gap 12px):每組一張有邊框的卡,
   收起時仍是一條實體標題欄,不會塌成一行浮字。
   與角色頁共用「無框摺疊頭」語彙的差別在於:那邊組內是灰白表單,
   這邊是彩色縮圖,不給圍合就鎮不住。 */
.gal-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gal-group {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  /* 刻意不寫 gap:.gal-fold-wrap 收成 0fr 後 gap 仍然佔位,
     加了邊框就會在卡片底部露出一條死白。間距一律由各自的 padding 給。 */
}

/* 標題行整體可點:左箭頭 + 角色名 + 張數(與角色管理頁同款摺疊語彙)。
   卡片化之後頭部自帶 padding 並撐滿圓角,hover 有底色反饋。
   選擇態下這一行還要放整組全選的核取方塊,故外層是普通 div、摺疊觸發器是內部那顆按鈕
   (<button> 裡嵌 <input type=checkbox> 是非法巢狀,點選會雙觸發)。 */
.gal-fold-head {
  display: flex;
  align-items: center;
  /* 圓角與 hover 底色仍由本層給:它才是撐滿卡片寬度的那一層 */
  border-radius: var(--bbi-radius) var(--bbi-radius) 0 0;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-head:hover {
  background: var(--bbi-surface-2);
}
/* 摺疊觸發器:佔滿標題行剩餘寬度,自己不畫背景(底色在父層,連核取方塊一起變) */
.gal-fold-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 11px 14px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
}
.gal-fold-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}
/* 核取方塊在最左側,與觸發器共享這一行的 hover 底色;
   padding 只給左右,高度靠標題行自身撐開,免得比觸發器矮一截。
   尺寸/配色一律由全域性 .bbi-checkbox 給,這裡只清 margin——
   粉彩主題把 .bbi-checkbox 改成了自繪(背景勾 14px 居中),自己再改小會把勾擠到邊上。 */
.gal-group-check {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  flex: 0 0 auto;
  padding: 0 2px 0 12px;
  cursor: pointer;
}
.gal-group-check .bbi-checkbox {
  margin: 0;
}
/* 有核取方塊時觸發器的左 padding 收窄,免得箭頭被推得太靠右 */
.gal-group-check + .gal-fold-trigger {
  padding-left: 8px;
}
/* 圓角只在兩端瞬時切換,不參與過渡:收起中途的「下兩角正在變圓」會讓 .gal-fold-body
   那條滿寬 border-top 的線頭戳出圓角外(hover 有底色時尤其明顯)。
   展開時立刻恢復直角(0s 無延遲),收起時等高度收完再變圓(0s + --bbi-dur 延遲)。 */
.gal-group.is-collapsed > .gal-fold-head {
  border-radius: var(--bbi-radius);
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-radius 0s var(--bbi-dur);
}
.gal-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    color 0.15s;
}
.gal-caret.is-collapsed {
  transform: rotate(-90deg);
}
.gal-fold-trigger:hover .gal-caret,
.gal-fold-trigger:focus-visible .gal-caret {
  color: var(--bbi-accent);
}
.gal-name {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbi-ink);
  word-break: break-word;
}
.gal-badge {
  flex: 0 0 auto;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
/* 體積:跟在張數角標右邊,不給底色——它是附註不是標籤,壓過角色名就喧賓奪主了。
   margin-left:auto 把它推到行尾,與右側留白對齊。 */
.gal-size {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 8px;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gal-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
@media (prefers-reduced-motion: reduce) {
  .gal-fold-wrap {
    transition: none;
  }
}
.gal-fold-inner {
  min-height: 0;
  overflow: hidden;
}
/* padding 與分隔線都放這一層:它是 inner 的子級,收起時隨 0fr 一併被裁掉,
   不會像掛在 inner 上那樣留下一截撐開的殘高(同 Collapsible.vue)。
   左 padding 12px + .gal-grid 自身 2px = 14px,正好與標題欄箭頭左緣對齊。 */
.gal-fold-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--bbi-line);
}

/* —— 縮圖網格 —— */
.gal-grid {
  list-style: none;
  margin: 0;
  padding: 2px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}
.gal-cell {
  min-width: 0;
}
.gal-thumb {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  cursor: zoom-in;
  overflow: hidden;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.gal-thumb:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.gal-thumb:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
/* 取側寫提示詞的那一小會兒:降透明度示意「在忙」,不改佈局免得網格抖動 */
.gal-thumb.is-busy {
  opacity: 0.55;
  cursor: progress;
}
/* 選擇態:游標改指標(點選不再是放大),選中時主色描邊 + 輕微內縮示意「被拿起」 */
.gal-thumb.is-selectable {
  cursor: pointer;
  position: relative;
}
.gal-thumb.is-selected {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 2px var(--bbi-accent) inset;
}
.gal-thumb.is-selected .gal-img {
  opacity: 0.72;
}
/* 勾選角標:右上角圓形。未選中時是半透明底的空圈(提示「這裡可以點選」),
   選中後填主色顯白勾。 */
.gal-check {
  position: absolute;
  top: 5px;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  border: 1.5px solid var(--bbi-surface);
  border-radius: 50%;
  background: var(--bbi-overlay);
  color: #fff;
}
.gal-thumb.is-selected .gal-check {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
/* 固定 3:4 豎構圖:生圖多為豎版,統一比例讓整格網格對齊,溢位由 cover 裁切 */
.gal-img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}

.gal-more {
  align-self: center;
}

/* —— 選擇態操作條 ——
   緊跟工具條 + sticky 吸頂:撥出它的「選擇」鈕就在上一行,一按就看見;
   往下翻多久它都還在,不用滾回頂部才能刪。
   top 給 calc(-1 * pad):滾動容器是 .bbi-body,它有 --bbi-page-pad 的內邊距,
   滾動視口頂邊落在內邊距處;top:0 會讓操作條停在內邊距下沿、上方露出一條縫
   讓縮圖從那裡滾過去。抵消掉內邊距才貼齊真實頂邊(同 base.css 的 .bbi-modal-head)。 */
.gal-actionbar {
  position: sticky;
  top: calc(-1 * var(--bbi-page-pad));
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  /* 不透明底:下面是縮圖網格,半透明會把圖透上來,數字讀不清 */
  background: var(--bbi-surface);
  box-shadow: 0 6px 18px -14px var(--bbi-overlay);
}
.gal-actionbar-count {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: var(--bbi-ink-soft);
  font-variant-numeric: tabular-nums;
}
/* .bbi-btn-danger 只宣告在 ConfirmDialog 的 scoped 塊裡(base.css 沒有),
   本元件要用就得把 base 與 hover 兩條整份複製過來——只補 hover 的話平時是預設墨色、
   滑鼠一過才變紅,靜態截圖完全看不出問題。 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .gal-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .gal-name {
    font-size: 13px;
  }
}
</style>
