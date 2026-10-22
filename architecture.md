# ST-BaiBai-Image(柏寶繪)架構說明

> 給新聊天的 AI 快速定位程式碼用。先讀本文,再按「任務定位索引」找檔案;深入設計取捨見
> `DESIGN.md`(總設計草案)、`GALLERY-STORAGE-DESIGN.md`(相簿/畫師串預覽圖儲存)與
> `NAI-PRESET-DESIGN.md`(NAI 預設化方案,待定稿)。
> 面向第三方外掛作者的介面文件是 `PUBLIC_API.md`(**對外契約,改介面必須同批改它**)。

## 1. 這是什麼

柏寶繪是 SillyTavern(ST)的第三方生圖擴充套件:

- 新 AI 正文落地後,**獨立**發起一次 LLM 請求,判斷哪些畫面值得畫、產出 danbooru tag,
  把 tag 以 `<bbi_image>...</bbi_image>` 形式插進正文(使用者可手改);
- 樓層裡 tag 位置渲染一張「生圖卡片」,點生成即調用出圖後端(ComfyUI / NovelAI),
  結果圖片落盤到 ST 檔案系統,後設資料存訊息 extra,支援歷史翻頁/重新生成/stale 提示;
- 自帶一個全屏設定視窗(渠道、角色管理、設定),整個 UI 活在 **shadow DOM** 裡,與 ST 樣式隔離;
- 對外開放 `globalThis.STBaiBaiImage`(讀角色庫 / 出圖),讓別的外掛自己決定圖顯示在哪(見 §9)。

技術棧:Vite + Vue 3(script setup)+ TypeScript,Vitest 單測。產物 `dist/index.js` + `dist/index.css`,
manifest.json 的版本號由 `scripts/sync-version.mjs` 在 build 前自動同步(package.json → manifest)。

## 2. 目錄總覽

```
src/
├── index.ts           # 入口:掛載 shadow root、注入 CSS、等 ST 就緒後依次 bind 各子系統
├── App.vue            # 主視窗(遮罩/視窗/導航/分頁),彈窗 Teleport 宿主,移動端抽屜手勢
├── st/                # ★ 與 ST 宿主唯一的接觸面(其餘目錄一律經 getContext 間接用 ST)
│   ├── context.ts     # getContext() 型別封裝;動態取 checkWorldInfo、ST-Prompt-Template
│   ├── imageTagRegex.ts  # 託管兩條正則:<bbi_image> 顯示側→空錨點 div,提示詞側→空串
│   ├── messageEdit.ts # 寫回訊息正文(applyMessageText):身份 CAS + 正文落盤時現算,競態保護
│   ├── keyboard.ts    # shadow 內編輯控制元件方向鍵不冒泡到 ST 全域性快捷鍵
│   ├── clipboard.ts   # 複製到剪貼簿統一入口(失敗 toast;卡片/燈箱/歷史頁共用)
│   ├── images.ts      # /api/images/* 上傳/刪除/列舉封裝(user/images 子目錄歸類;畫師串預覽圖、相簿)
│   │                  # + probeUserImage:HEAD 探存在與體積(三態:在/不在/分不清)
│   ├── imageFile.ts   # 圖片讀取與 canvas 縮放(File→dataURL、makeJpegThumbnail;與網路層分開)
│   └── iconFallback.ts# 注入按鈕的字型圖示兜底(防美化主題清空圖示)
├── state/             # 全域性狀態與持久化
│   ├── settings.ts    # ★ 設定模型 + hydrate/persist/遷移 + 跨外掛共享渠道儲存
│   ├── ui.ts          # 視窗開關/主題/導航/懸浮球;activePage 存 localStorage
│   │                  # (純瀏覽態都走 localStorage:渠道頁籤記憶同理,在 backend/index.vue)
│   ├── history.ts     # 請求歷史(LLM 推理+生圖)模組級記憶體 store,刻意不持久化
│   ├── charTags.ts    # 角色固定外貌庫:本聊天基線(chatMetadata)+ AI 樓層增量(訊息 extra),
│   │                  # 全域性庫經 setGlobalCharTagSource 注入合併;鎖定名攔截 AI changes
│   └── globalCharTags.ts # 全域性角色庫(extensionSettings,跨聊天/跨裝置):僅手動維護的凍結模板,
│                      # AI 永不可寫;提升為全域性/複製回本聊天兩條遷移路徑
├── api/
│   └── client.ts      # LLM 請求:副 API 走 ST 服務端代理 / 跟隨主 API 走 generateRaw
├── autoTag/           # ★ 鏈路 A:自動生 tag(獨立 LLM 請求 → 協議校驗 → 注入正文)
│   ├── runner.ts      # 事件監聽、去重、重試、編排(入口)
│   ├── generationGate.ts # 生成門:把自動 tag 與真實生成配對(GENERATION_STARTED 武裝 → 最終 RENDERED 消費)
│   ├── prompt.ts      # 組裝訊息:破限/角色/人設/世界書/規範/協議/思維鏈/預填充
│   ├── protocol.ts    # 段尾位置 ID、JSON 嚴格解析校驗、tag 注入格式
│   ├── clean.ts       # 歷史/目標正文清洗(共享排除標籤;歷史保留 bbi_image)
│   ├── context.ts     # 世界書啟用(條目級渲染:展宏+EJS)、角色卡、user 人設
│   ├── bookMemory.ts  # 讀「Horae」全域性 API,解析成角色參考塊
│   ├── charAnchors.ts # 角色庫:庫文本注入 → 兜底替換殘留 @佔位符(AI 照抄欄位值,不用佔位符)
│   ├── rebase.ts      # 插入位置重定位:請求時正文 → 落盤時正文(文本 LCS 骨架 + 順延)
│   └── slotPlan.ts    # 單槽重寫提示備註(只重寫第 N 張 + 當前提示詞錨點 + 其餘畫面清單)
├── backends/          # 出圖後端(鏈路 B 的生成端)+ 共享尺寸工具
│   ├── comfyui.ts     # ComfyUI:工作流模板 %佔位符% 渲染、瀏覽器直連/ST 轉發自動回退
│   ├── comfyTemplates.ts # 簡易模式:模板族(checkpoint/flux/anima) + 引數組裝 API JSON(無佔位符)
│   ├── comfyObjectInfo.ts # 拉模型/LoRA/取樣器列表(直連 /object_info,回退 ST 轉發四個端點)
│   ├── comfyWorkflowAssistant.ts # AI 自動定位工作流節點(片段 ID 協議,不複製原文)
│   ├── nai.ts         # NovelAI:引數構造、vibe 編碼/疊加、畫師串前置拼裝、.naiv4vibe 匯入匯出;
│   │                  # 內建只讀畫師串庫 BUILTIN_NAI_ARTISTS(bi_* 字首,不進 settings)
│   ├── naiArtistLib.ts# 畫師串庫管理態純邏輯(搜尋匹配/刪除接位規劃,管理器與面板單刪共用)
│   ├── naiRateLimit.ts# ★ NAI 限流自愈:錯誤分類 + 退避重試 + 全域性冷卻/最小間隔(閘門與後端共用)
│   ├── chatu8Vibe.ts  # 從智繪姬(st-chatu8)只讀匯入 vibe / 提示詞預設
│   │                  # (collect/detect/import 純函式三件套,絕不寫回智繪姬)
│   ├── vibeGroups.ts  # Vibe 分組純邏輯(裝箱 key/歸攏/搜尋/啟用集合判定)
│   └── size.ts        # 畫幅方向歸一 / 尺寸解析 / 按方向取配置(刻意不 import settings)
├── generate.ts        # ★ 一次出圖的共用中段:NAI 閘門 → 按後端分派 → 拿到圖。
│                      # 樓層卡片與公開介面的**唯一**生成路徑(不落盤/不顯示/不埋點)
├── public/            # ★ 開放給第三方外掛的介面(globalThis.STBaiBaiImage,見 §9)
│   ├── types.ts       # 第三方契約 DTO + apiVersion(與 pluginVersion 分開,只增不改不刪)
│   ├── api.ts         # 實現層:深複製出參、錯誤歸一成帶 code 的普通 Error、圖轉 data URL
│   └── register.ts    # 掛 globalThis + ready/changed 事件 + subscribe(凍結 API 物件)
├── floor/             # ★ 鏈路 B:樓層生圖卡片
│   ├── hydrate.ts     # 渲染事件 → 錨點×tag 配對 → 每錨點 attachShadow → Vue 卡片掛載(冪等)
│   ├── Card.vue       # 卡片本體(**純展示層**,執行態在 genState.ts)+ 歷史翻頁
│   ├── genState.ts    # ★ 生成執行態 store(模組級,跨卡片重建存活)——改卡片狀態先讀它
│   ├── genQueue.ts    # NAI 併發閘門 + 節奏等待(ComfyUI 靠服務端佇列,不經過這裡)
│   ├── tagPlanState.ts # 「AI 重寫提示詞」請求執行態 store(模組級,與 genState 分開;
│   │                  # 存 {票據, promise}——關掉彈窗不中斷重寫,重開 await 回同一個接著等)
│   ├── collapseState.ts # 卡片摺疊態模組級 store(按槽位 key 認領;手動摺疊覆蓋預設設定)
│   ├── missingImages.ts # ★ 「檔案已不在」路徑冊(模組級 reactive):相簿刪檔案留下的破指標,
│   │                  # 由卡片 <img> @error → HEAD 確認 404 才落冊(分不清一律不記)
│   ├── Lightbox.vue   # 圖片放大層(含長按儲存的三條約束,改前必讀頂部註釋)
│   ├── lightbox.ts    # 命令式開啟燈箱(掛外掛 shadow root,非卡片 shadow)
│   ├── PromptEditor.vue # 改提示詞的彈窗(結構化欄位,非展示串;自帶 Esc 捕獲)——手改與
│   │                  # 「AI 重寫提示詞」同處一窗
│   ├── promptEditor.ts# 命令式開啟編輯彈窗 + 寫回正文(applyMessageText → 重水合);
│   │                  # 兼管 AI 重寫的託管/續上與落盤後回填(rawTag 要一起重新整理)
│   ├── download.ts    # 另存圖片(卡片右上角 ⋯ 選單與燈箱共用,同源檔案走 <a download>)
│   ├── storage.ts     # 結果儲存:extra 後設資料(swipeId→promptHash→歷史)+ 檔案命名 + 側寫 json(相簿提示詞)
│   ├── upload.ts      # ST /api/files/upload|delete 封裝(不用未公開的 uploadFileAttachment)
│   ├── autoGenerate.ts# 「寫 tag 後自動出圖」標記握手(runner ↔ Card onMounted)
│   ├── actionButton.ts# 樓層「生成生圖 tag」按鈕注入(共用 #chat 觀察器,冪等對賬)
│   ├── chatObserver.ts# ★ `#chat` 的**唯一** MutationObserver(多訂閱者 + rAF 節流)
│   ├── slotHealth.ts  # ★ 卡片體檢判據(純函式):detached / hidden-by-host,順序不可換
│   ├── registry.ts    # 槽位掛載記錄表(chatId|mesid|swipeId|seq → shadow root/vnode)
│   ├── cardStyles.ts  # 構造共享 CSSStyleSheet(theme.css 選擇器改寫到 :host + card.css)
│   └── card.css       # 卡片樣式(取 --bbi-* 令牌,與設定視窗同一套設計語言)
├── pages/             # 主視窗的分頁(登錄檔在 pages/registry.ts)
│   ├── backend/index.vue      # 「渠道」頁:頁籤(webui 已隱藏)+ 各後端面板
│   │   └── panels/            # ComfyUIPanel / NaiPanel / WebUIPanel(隱藏,程式碼保留)/ NaiArtistManager
│   ├── characters/index.vue   # 「角色管理」頁:全域性/本聊天兩區卡片式外貌庫 CRUD + 歷史回滾
│   ├── gallery/index.vue      # 「相簿」頁:按角色名分組瀏覽 user/images/柏宝绘_<角色名>/(放大+看提示詞+另存;多選刪除**只刪檔案不碰聊天記錄**,分組體積逐張 HEAD 量但 ⚠ 已暫時停用)
│   ├── history/index.vue      # 「請求歷史」頁:除錯輔助(LLM 提示詞/響應/生圖元資訊)
│   └── settings/index.vue     # 「設定」頁:渠道管理/自動 tag/提示詞編輯/介面偏好(最大頁)
├── components/       # 通用元件:BbiSelect/BbiCombo/BbiTextarea/Collapsible/ConfirmDialog/FloatingOrb/Icon/ModalMask/NavBar
│                     # (BbiCombo = 可輸入可過濾下拉,與副 API 模型框同互動,選單 Teleport 防裁剪)
├── styles/           # base.css(全域性基礎樣式)、theme.css(主題變數,data-theme 切換)
├── bytes.ts          # 位元組數 → 人讀體積(1024 進位制、單位寫 KB/MB 與資源管理器對齊;非有限值返回空串)
├── pool.ts           # 限併發 map(mapLimit,返回順序=輸入順序);相簿量體積/批次刪圖用
├── menu.ts           # 魔杖選單入口注入(輪詢等懶載入)
├── topbar.ts         # ST 頂欄快速開啟按鈕(受 ui.showTopBar 開關控制)
└── version.ts        # 版本號(__BBI_VERSION__)+ 帶 ver 的資源 URL
└── update.ts         # 更新檢測:遠端 manifest 版本對比 + /api/extensions/update 自動更新
```

## 3. 啟動與掛載(讀 index.ts)

1. `mount()`:在 body 建 `#bbi-app-host`(light DOM,`display:contents`),用 `INHERITED_RESET`
   內聯 `!important` 釘死可繼承排版屬性,切斷 ST 樣式繼承;Vue 應用整體掛進它的 **shadow root**;
   `dist/index.css` 以 `<link>` 注入 shadow root —— 樣式雙向隔離。
2. `$(() => ...)`:掛載應用、注入魔杖選單入口、按開關同步頂欄按鈕。
3. `hydrateWhenReady()`:輪詢 `window.SillyTavern.getContext`(最多 ~20s),就緒後依次:
   `hydrateSettings()` → `initGlobalCharTags()` → `bindCharTagSync()` →
   `ensureImageTagRegexRegistered()` → `bindAutoTagging()` → `bindFloorHydration()` →
   `bindTagActionButtons()` → `registerPublicInterface()` → `checkForUpdate()`
   (每會話只查一次遠端版本,不阻塞其餘初始化)。
   各 bind 函式均**冪等**(內部 `bound` 標誌),可安全重複呼叫。
   **順序裡有兩處不能動**:`initGlobalCharTags()` 必須在 `bindCharTagSync()` 之前
   (首次重算就要把全域性條目合進派生庫);`registerPublicInterface()` 必須在
   `hydrateSettings()` 之後 —— 設定回灌前 `getBackendStatus()` 讀的是預設值,
   會把明明配好的使用者報成「未配置」,而第三方多半在 ready 事件裡立刻問一次。

新增「啟動時要做的綁定」→ 在 `hydrateWhenReady` 裡加一行,並讓綁定函式冪等。

## 4. 與 ST 宿主的接觸面(st/ 目錄)

**原則:除了 `st/` 目錄,任何模組不得直接摸 ST 內部。** 具體接觸點:

| 接觸點 | 位置 | 說明 |
|---|---|---|
| `SillyTavern.getContext()` | st/context.ts | 唯一上下文入口,ST 未就緒返回 null,呼叫方輪詢/降級 |
| `extensionSettings['baibai_image']` | state/settings.ts | 本外掛設定(全域性,跨裝置同步) |
| `extensionSettings['baibai_api_channels']` | state/settings.ts | 跨「柏寶」外掛共享的副 API 渠道(revision + 廣播事件同步) |
| `extensionSettings.regex` | st/imageTagRegex.ts | 託管兩條正則(固定 id,冪等註冊/覆蓋) |
| `chatMetadata['baibai_image_char_tags']` | state/charTags.ts | 角色庫**本聊天手動基線**;AI 自動變化存各訊息 extra `bbiCharChanges` |
| `extensionSettings['baibai_image_char_global']` | state/globalCharTags.ts | **全域性角色庫**(跨聊天,revision + 廣播事件);僅手動維護,AI changes 按鎖定名丟棄 |
| ST 事件 | 各 bind 處 | `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_DELETED / CHAT_CHANGED` |
| `generateRaw` | api/client.ts | 跟隨主 API 的一次性補全(ST 穩定 API) |
| `getWorldInfoPrompt` / 動態 import `checkWorldInfo` | autoTag/context.ts | 世界書啟用(後者拿條目物件可逐條渲染;取不到自動降級前者) |
| `globalThis.EjsTemplate`(ST-Prompt-Template) | autoTag/context.ts | 世界書條目 EJS 執行(未裝則降級) |
| `globalThis.STBaiBaiBook` | autoTag/bookMemory.ts | Horae角色狀態(apiVersion 1;不可用返回 null 降級) |
| `globalThis.STBaiBaiImage` + window 事件 | public/register.ts | **我們自己掛出去的**公開介面(§9);`st-baibai-image:ready` / `:changed` 派發在 window 上 |
| HTTP 代理 | api/client.ts、backends/comfyui.ts、floor/upload.ts、st/images.ts | `/api/backends/chat-completions/generate`、`/api/backends/chat-completions/status`、`/api/sd/comfy/*`、`/api/files/upload|delete`、`/api/images/upload|delete|folders|list` |
| 擴充套件更新 API | src/update.ts | `GET /api/extensions/discover`(查型別)+ `POST /api/extensions/update`(自動更新);遠端版本讀 GitHub raw manifest.json(8s 超時,失敗靜默) |
| 注入 DOM | menu.ts、topbar.ts、floor/actionButton.ts | 魔杖選單 / 頂欄按鈕 / 樓層按鈕(不進 shadow) |

注意:三處 UI 的隔離層次不同,樣式約定各不一樣 ——
- 設定視窗:整個 Vue 應用掛在一個大 shadow root(`#bbi-app-host`),樣式走 dist/index.css;
- 樓層卡片:每個錨點各自 attachShadow(見 §6),樣式走 cardStyles.ts 的共享 CSSStyleSheet;
- 注入按鈕(魔杖/頂欄/樓層按鈕):純 DOM、無 shadow,樣式直接吃 ST 的。

## 5. 鏈路 A:自動生 tag(autoTag/)

觸發:與 ST 真實生成配對,不信任渲染型別字串 —— `GENERATION_STARTED` 時 `beginGeneration`
(過濾 dryRun/quiet/impersonate,記 chatId+type),最終 `CHARACTER_MESSAGE_RENDERED` 時
`consumeGeneration` 同 run 同聊天才消費並排程 `runForFloor`(setTimeout 0 等 ST 內部同步完,
期間換聊天則作廢)。
**坑:GENERATION_ENDED 不得清 gate**——ST 會在最終 `CHARACTER_MESSAGE_RENDERED` 之前先發
ENDED,清了 gate 自動 tag 就永不觸發(0.1.15 修);只有 `GENERATION_STOPPED`(使用者中斷)/
`CHAT_CHANGED` 才清。runner 內所有跳過路徑都有 `[BBI][AutoTagDebug]` 診斷日誌,排查觸發
問題時看控制台即可定位是哪一步攔的;**手動路徑(樓層按鈕)每條跳過還必須給 toast**——
手動點選是顯式意圖,靜默 return 在使用者那裡就是「按鈕點了沒反應」(0.1.26 修)。

**「誰算可插圖的樓」只有一份判據**:`st/context.ts` 的 `isStoryMessage` /
`isAiStoryMessage`,樓層按鈕的顯隱、runner 的目標閘門、prompt 的歷史取捨共用。判據只看
`is_system && typeof extra.type === 'string'`(ST 只給 narrator/comment/sys 蓋這個戳),
故**被 `/hide` 隱藏的普通樓算劇情樓、照給按鈕照能重新生成**——ST 自己也這麼認
(messageFormatting 對隱藏樓強行把 isSystem 置回 false,我們的錨點正則才在隱藏樓生效)。
舊版 actionButton 另寫一份、直接讀 DOM 的 `is_system` 屬性,隱藏樓一律沒按鈕,而屬性變更
又不在 observer 監聽範圍裡,於是同一條聊天裡「隱藏前渲染過的樓留著按鈕、之後重渲染的樓
沒有按鈕」(0.1.26 修)。同理,「正文裡有沒有 tag」的探測收斂到
`imageTagRegex.hasImageTagTrace`:按鈕層曾只認開標籤、runner 層認開也認閉,正文裡只剩
一個 `</bbi_image>` 的樓就卡成「點了永遠沒反應」。

```
runForFloor(floor, opts)
  1. 過濾:僅 AI 故事樓;已有 <bbi_image> 且非手動 replace 則跳過
  2. 身份去重:chatId\0floor\0swipeId\0textHash → processed Set;手動(manual)繞過
  3. 每樓一個 AbortController:同樓新任務 abort 舊任務;CHAT_CHANGED 全量取消
  4. 裝配上下文:
     - bookMemory.readBookMemory  → Horae角色參考塊(可 null)
     - charAnchors.resolveCharAnchors → 庫文本(純本地渲染,無請求;空庫返回 text=null)
     - prompt.buildAutoTagMessages → 訊息陣列(見下)
  5. 請求:getTagGenChannel() 有指派渠道 → requestCompletion(服務端代理);
     否則 requestViaMainApi(generateRaw)。**每樓只此一次請求** —— 建檔與選圖同屬一次
     推理:先在 changes 裡確立新角色外貌,再在同一次輸出的 tag 裡 @引用它並圍繞它補
     其餘 tag。(舊版另有一次「中文外貌 → 欄位」轉換請求,已刪:Horae的中文 desc 本就
     隨角色參考塊發給主請求,主請求還多了世界書/角色卡/正文佐證,判斷更準。
     渠道設了思考強度時請求體改走 custom 源,見 §7 副 API 渠道。)
  6. 重試迴圈:retryCount 次(請求異常 / 解析拋錯都重試;abort 不消耗;「無畫面」不算失敗)
  7. protocol.parseImagePlan 嚴格校驗(JSON 結構/目標位置 ID/禁含子標籤/size 寬容降級豎屏);
     changes 全程寬容:單條壞只丟這條,絕不連累 images —— 漏一個角色檔案只是它本輪沒錨定,
     為它作廢整次輸出會連圖一起沒有。圖片數按 `minImages～maxImages` 範圍:超上限本地硬截斷,
     少於下限(>0 時)拋錯交給重試迴圈 —— 下限是使用者明確要求,寧可重試也不交殘缺結果。
     每圖可選 `characters`(NAI 4.5/V5 原生多角色提示,≤32 條,name/tag/nl,寬容解析單條壞只丟這條),
     注入時序列化進 `<characters>…</characters>` 子標籤;4.5/V5 下建檔(new)必須帶 nl,否則 runner 拋錯重試
  8. changes 與Horae建檔一起轉成樓層增量 ops(extra 的 bbiCharChanges),不提前落庫
  9. @佔位符兜底替換:applyPositionedCharRefs 把 tag/nl 裡殘留的 @角色名 換成「基線 + 本樓
     ops 重放」後的庫 tag。**建檔(new)全樓生效**——新角色的固定外貌是本樓全程成立的事實;
     **永久變化(set)才按位置門控**,染髮之前的圖片用舊檔。未知佔位符剝除並 toast 告警。
     (v0.1.2 起主路徑已撤:AI 改為直接照抄庫中欄位值,見 §7 角色庫段——多角色多次展開
     會重複外貌導致重疊軀幹,tag 預算也無法執行;applyCharRefs 系函式保留為兜底)
 10. rebase.rebaseImagePositions 把插入位置從「請求開始時的正文」平移到「落盤那一刻的正文」
     (清洗後敘事行按文本 LCS 求骨架,空隙按序號比例配對,整句消失的順延到上一錨點),
     再由 protocol.injectImageTags 在新物理行後插入
     <bbi_image>tag<nl>…</nl><negative>…</negative><size>…</size></bbi_image>
 11. 若 autoGenerate 開:先 markForAutoGenerate 每個新槽位(見鏈路 B 握手)
 12. messageEdit.applyMessageText 寫回(正文 + extra 增量一體)。身份 CAS:聊天/訊息/swipe
     任一變化即放棄;**正文內容不參與比對**——分析期間別的外掛對正文的修改(翻譯、潤色、
     追加狀態列、改寫八股句)全部保留,tag 重定位後照常注入。僅噹噹前正文清洗後一條敘事行
     都不剩、或寫回前發現已存在 bbi_image 時才放棄(build-failed)。
     成功才 recomputeCharTags;失敗撤銷標記;僅 changes 無圖片也走寫回。
```

訊息順序(prompt.ts 固定):破限 system → 角色卡 system → persona system → 世界書 system →
後端規範 system(ComfyUI/NAI 內建 spec,`{{nl}}` 宏按「生成自然語言」開關展開)→ 固定協議
(身份定義 + 輸出契約:一個 `<thinking>` 塊和一個 JSON 物件,JSON 含 images + changes)→ 思維鏈 system → user(角色參考 + 角色庫 + 清洗後的最近 N 個 AI 故事樓及其間 user 樓 + 帶段尾位置 ID 的目標正文)
→ assistant 預填充(`<thinking>`,渠道關閉 prefill 時由 client 丟棄)。

全部可編輯提示詞(破限/規範/思維鏈/預填充)在 `state/settings.ts` 有內建預設常量
(`DEFAULT_*_PROMPT`/`DEFAULT_*_SPEC`),留空回落預設 —— 改預設提示詞內容先看這裡。

⚠ **設定頁只暴露兩對規範/思維鏈:ComfyUI 與 NAI**,後者存在 `naiV5Spec` / `naiV5Thinking`
(鍵名帶 V5 是歷史命名,內容對 4.5 同樣適用,面板標籤已改成不提代數的「NAI 規範/思維鏈」)。
另有 `naiSpec` / `naiThinking` 是 4.5 以下的單串 tag 版本,隨舊模型下線(見 §6 `NAI_MODELS`)
**已無 UI 入口**:可選模型只剩 4.5/V5 → `naiCharPromptsOn` 恆真 → 那兩份永遠走不到。
鍵與常量都刻意保留(不動存量 settings、不動舊模型標識的協議分支與迴歸鎖),
但**改 NAI 規範/思維鏈一律改 `DEFAULT_NAI_V5_*` 那一對**,別去改看著名字更正的那份。

## 6. 鏈路 B:樓層卡片與出圖(floor/ + backends/)

**顯示原理(st/imageTagRegex.ts)**:託管正則 `bbi-image-tag-slot`(markdownOnly)把
`<bbi_image>…</bbi_image>` 在顯示路徑替換成空錨點 `<div data-bbi-slot=""></div>`;
`bbi-image-tag-hide`(promptOnly)在提示詞路徑替換成空串 —— tag 永不進 DOM、永不進提示詞。

**placement 必須含 3(SLASH_COMMAND)**:顯示側 placement 由 `script.js` 的 `getRegexPlacement`
按訊息型別派發 —— 使用者樓 1、AI 樓 2,而 **`extra.type==='narrator'` 的旁白樓是 3**。
`/narrator`、`/sys` 造出的樓是 `is_system:false` + `extra.type:'narrator'`,於是
`isAiStoryMessage` **認它是劇情樓**、自動 tag 會往裡寫 tag;只寫 `[1,2]` 時錨點正則整條不命中,
tag 原文被 DOMPurify 剝殼後當正文顯示出來(使用者直接看見一串 danbooru tag),且沒有錨點 = 沒有卡片
—— 「tag 永不進 DOM」在這一類樓上是破的。提示詞側 ST 只用 1/2,hide 規則帶上 3 是無操作,
但兩條規則 placement 保持一致更好推理(replaceString 是空串,多覆蓋一個 placement 無副作用)。

**水合(hydrate.ts)**:渲染事件(CHARACTER/USER_MESSAGE_RENDERED、MESSAGE_UPDATED、MESSAGE_SWIPED)→
定位 `.mes[mesid] .mes_text` → `parseImageTags(message.mes)` 與 DOM 錨點**按序配對** →
每個錨點 `attachShadow` 後 `render(h(Card,...), shadowRoot)`,記錄進 `SlotRegistry`(key = chatId|mesid|swipeId|seq)。
重水合前先 `render(null, container)` 顯式解除安裝,全程冪等。MESSAGE_DELETED / CHAT_CHANGED 全量重建。
事件後的水合走 `scheduleHydration`:setTimeout 0 先水合一次、~100ms 後再查一次——其他 ST 監聽器
可能在事件後替換 `.mes_text`(晚班時錨點未變只走 props patch,零重建);換聊天則作廢。

**自愈層(hydrate.ts 的 healSlots + floor/chatObserver.ts)—— 事件驅動兜不住的那一半**:
錨點活在 `.mes_text` **裡面**,而 ST 自己有好幾條重寫 `.mes_text` 的路徑**不發任何事件**:
`updateMessageBlock` 的 `.mes_text.html(...)`(script.js:1988)、`messageEditCancel/Done` 的
`.empty()`、右滑生成時的 `.mes_text.html('...')`;第三方(提示詞模板類)也會在自己的渲染鉤子裡
`container.html(newContent)`。這些路徑把錨點連同 shadow root 一起刪掉,純事件驅動的水合完全無感
—— 而 genState 是模組級的,在途生成照樣跑完。使用者報的**「圖在生成,樓層裡看不到介面」**就是它。
相鄰的Horae沒這毛病不是因為更結實,是它的宿主掛在 `.mes_text` **外面**當兄弟節點,
`.html()`/`.empty()` 只清 innerHTML;而本外掛的卡片必須落在 tag 的行內位置(多 tag 樓層按位置
分別成圖),搬不出去 —— 同一條約束當初也否掉了官方 `extra.media` 方案(見 §6)。故自愈是
位置約束下的唯一解。判據抽在 `floor/slotHealth.ts`(純函式,倉裡沒 jsdom,靠鴨子型別假節點單測):
- `detached`(錨點脫離文件)→ 只重水合**受影響的那一樓**(按樓去重);
- `hidden-by-host`(錨點在、但祖先 `.mes_text` 帶 `inline_media` = ST 的 `display:none`)
  → **只 console.warn,不強改**。那條隱藏是 ST 有意為之(`extra.inline_image===false` 的語義
  就是「這樓只看圖不看正文」),強行解除會把人家特意藏起來的正文一併翻出來;且行內樣式釘上就
  撤不掉(ST 之後按 extra 重算 class,管不到我們寫的 style),正是「改不了又一直在生效」的暗格。
- 順序不可換:脫離文件的元素 `closest()` 仍會沿**已斷開的子樹**往上走、可能真找到帶
  `inline_media` 的那份 `.mes_text`;先判 hidden 就會把「已被刪掉的樓」誤診成「只是被藏了」,
  於是不重掛、只去改一個不在文件裡的節點,卡片永遠回不來(slotHealth.test.ts 鎖了這條)。

**`#chat` 觀察器只有一個(floor/chatObserver.ts)**:樓層按鈕對賬與卡片自愈盯的是同一棵樹、
同樣的 `childList+subtree`,故合成一個多訂閱者的觀察器。**這也是「加自愈會不會常駐卡頓」的答案**:
不會 —— 開銷在瀏覽器收集 MutationRecord 那一側,而這筆錢從樓層按鈕上線那天起就在付了,
新增訂閱者的邊際成本只是回撥裡多跑一個函式。約束:訂閱者回調必須是**便宜的對賬**
(healSlots 是 O(已掛載卡片數),每張只做 `isConnected` 屬性讀 + 一次 `closest()`,
只有真發現異常才碰 DOM);**絕不在回撥裡跑 `hydrateVisible`** —— 那會對每條訊息跑
`parseImageTags`+`readStore`+`promptHash`,那才是真卡頓。**只訂閱 childList,不訂閱 attributes**:
否則自愈/主題寫屬性的動作會反過來喚醒自己,變成自激迴圈。

**卡片為什麼在 shadow DOM 裡**:樓層活在 ST 的 light DOM,ST 全域性樣式與使用者裝的美化主題
會直接改到卡片上。每個錨點各自 `attachShadow` → 樣式雙向隔離(與 index.ts 主視窗同構,
只是從「一個大 host」變成「每槽位一個小 host」)。兩點注意:
- **可繼承屬性**(font/color/line-height…)仍穿透 shadow 邊界 → `CARD_INHERITED_RESET` 在 host 上釘死;
- **自定義屬性**也穿透 → 故 `theme.css` 的 `data-theme='st'` 仍能取到宿主 `--SmartTheme*`。
  樣式經 `adoptedStyleSheets` 共享**同一個** CSSStyleSheet 物件(cardStyles.ts),N 張卡零重複。
  設定頁 0.1.9 起移除「樓層卡片主題」選擇項(卡片無邊框化後恆跟隨 ST 主題),但
  `settings.ui.cardTheme` 欄位與 hydrate 的讀取保留 —— 舊使用者已設的值繼續生效,別當死程式碼刪。

**卡片狀態機(Card.vue + genState.ts)**:
- **執行態**(genState.ts 的模組級 reactive Map,key 同上):`queued / generating / error`
  —— **必須放在元件外**。差分水合下同錨點卡片是 props patch 不重掛,但錨點一旦被 ST 重渲染
  重建,元件照樣整體重建;reconcileGen 也因此從 onMounted 挪到 `watch(hash, immediate)`
  (舊版重掛式水合裡 onMounted 必跑,差分下不一定)。執行態若存元件 ref,一被重建就清零 →
  兄弟卡片的「生成中…」集體消失並退回 pending(標記已消費不會重跑)。這是歷史 bug 的根因。
- **票據(token)不可省**:key 只認槽位,不認「第幾次任務」。同槽位可先後跑多個任務
  (取消後重繪、reconcile 後重來),舊任務遲到的回撥必須憑 token 認領 ——
  否則 A 被 abort 後以非 AbortError 失敗(HTTP 500/429 與 abort 撞車)會把**正在跑的 B**
  標成 error。`failGen/clearGen/setGenPhase/setQueueAhead` 全部要 token;
  落盤前還要 `isCurrentGen` 自檢,別把舊任務的圖寫進 extra。
- **槽位消失要剪枝**:`reconcileGen` 只能由掛載著的卡片觸發,而使用者刪 tag / swipe 到
  tag 更少的一版時槽位整個沒了,記錄會永久留存並被日後同 key 的新卡片誤認領。
  `hydrateMessage` 調 `pruneGenSlots(…, tags.length)` 只刪 `seq >= tag 數` 的越界槽位
  —— **不能連在途兄弟一起清**,那等於把本次重構修掉的 bug 換個形式復現(有單測鎖定)。
- **派生態**(props 算出):`ready`(有本提示詞歷史)/ `stale`(僅有舊提示詞結果)/ `pending`。
- 圖片展示**刻意不看執行態**:失敗/重繪中都繼續顯示上一張,避免「點重繪失敗 → 圖憑空消失」。
- onMounted:先 `reconcileGen`(hash 變了作廢舊任務),再消費 autoGenerate 標記自動開跑;
  **標記一律先消費再判斷該不該跑**——留著它會在日後同槽位重現(如使用者刪掉舊圖)時被新卡片
  誤認領,憑空開跑一次使用者沒點過的生成。判定抽成 `autoGenerate.ts` 的 `shouldAutoGenerate`
  純函式(Card.vue 無單測:倉裡沒裝 jsdom,vitest 跑 node 環境,留在元件裡鎖不住)。
  `'auto'` 放過 `pending` 與 **`stale`**:stale 的語義正是「tag 變了、當前提示詞還沒有圖」,
  恰恰該出圖——舊版只放 pending,導致樓層「重新生成 tag」在已出過圖的樓層上靜默失效
  (新 tag 寫進去了、卡片卻停在舊圖),多 tag 樓層更怪:有舊圖的槽位被攔、純新增的照跑。
  `'force'`(使用者點「應用並重新生成」)無條件跑——來回改回舊提示詞時該桶可能已有歷史。
- generate():輸入就地取值存 `job`(在途時元件很可能已銷燬,再讀 props 不可靠)→ 定種子 →
  調 `generate.ts` 的 `generateImage`(閘門與後端分派都在裡面)→ `saveImageResult` 落盤 →
  清執行態 → `hydrateMessage`。
  **燈箱回撥同理**:燈箱掛外掛 shadow root、活得比卡片長,樓層座標必須快照後傳參
  (`removeEntry(target, at)`),不能在回撥裡讀 props。

**出圖中段抽在 `src/generate.ts`(卡片與公開介面共用)**:一次出圖被切成三段——
前(登記執行態/校驗引數)、**中(閘門 → 後端分派 → 拿到圖)**、後(落盤/顯示/埋點)。
公開介面要的恰恰是掐頭去尾的中段:第三方自己決定圖顯示在哪。
- **閘門不可繞過,這是抽出它的首要理由**:直接調 `generateNaiImage` 會跑在 genQueue 閘門與
  naiRateLimit 全域性節奏之外,0.2.0 整版的限流自愈當場失效——第三方併發呼叫是常態,
  繞過去的症狀是使用者 NAI 賬號吃一串密集 429,而使用者只會認為柏寶繪壞了。故兩條路共用本函式,
  `release` 包在 `finally` 裡(`generate.test.ts` 鎖「拋錯也要還槽」)。
- `backendStatus()` 是「能不能出圖」的**唯一判據**:卡片按鈕的 `configured`、公開介面的
  `not_configured` 同源,避免「卡片能點、出圖才報錯」。
- **埋點刻意留給呼叫方**:一條歷史記錄的「成功」判據各家不同——樓層卡片要等落盤成功才算成,
  還要把「圖拿到了卻因任務被取代而丟棄」記成已取消;本模組只知道請求本身的成敗,
  替呼叫方下結論會把那兩種情形謊報成成功。故 `decideSeed` 單獨匯出,呼叫方先定種子再傳進來。

**併發是後端屬性,不是全域性設定**:
- **ComfyUI 一次性全發**:`POST /prompt` 拿到 `prompt_id` 即入**服務端**佇列,輪詢各查各的
  `history/{id}`,ComfyUI 自己順序執行。客戶端再加佇列純屬多餘。輪詢期間查 `/queue` 上報
  排隊位置(`onQueue`),卡片顯示「排隊中(前面 N 個)」而非一律「生成中」。
- **NAI 要閘門**(genQueue.ts,`settings.nai.concurrency`,預設 1):`generate-image` 是阻塞式
  POST、服務端不排隊,併發壓過去吃 429。
- **取消必須分流**(comfyui.ts 的 `cancelPrompt`):任務在排隊 → `POST /queue {delete:[id]}`;
  正在執行 → `POST /interrupt`(帶 prompt_id)。**無腦 /interrupt 會打斷正在跑的別的任務**
  ——舊實現如此,併發下必現。有單測鎖定這兩條路徑。

**NAI 限流自愈(backends/naiRateLimit.ts)**:閘門只管「同時幾個」,管不了「多快一個」。
release 後立刻 `pump()`,下一個任務在同一 tick 就發出去;而錯誤是**按槽位隔離**的,於是被
限流時會打出一串密集失敗(429 → release → 立刻再來 → 429),那正是最像濫用的形狀。
策略層收口在一處,時間戳全可注入(故不用假時鐘就能單測):
- **錯誤分類**(`shouldRetryNai`):408/429/5xx(除 501)與 fetch 的 `TypeError` 才重試;
  400/401/402 這類配置錯誤、以及自家的校驗/解析錯誤立刻拋。**不分類的話,一個填錯的 key
  會被退避重試放大成四倍請求量**。取消(AbortError)一律不重試。
- **退避重試**(`runNaiWithRetry`,共 4 次嘗試):指數退避 + 50%–100% 抖動(多張卡不會同時
  醒來又撞一起),`Retry-After` 當**下界**、單次等待夾到 60s。只包「發請求 + 解包」那一段
  ——拼引數、讀 vibe 資料是一次性的,重跑會白費功夫並重復彈 vibe 警告。
- **全域性冷卻**:429 除了讓當前請求退避,還給**整個閘門**上冷卻(`noteNaiRateLimited`,
  預設 15s 或按 `Retry-After`,**只延後不提前**)。`acquireNaiSlot` 取槽後迴圈等完
  `naiPacingDelayMs()` 才返回 —— 迴圈是因為等待期間別的槽位可能又把冷卻推後了。
- **最小間隔** 1500ms:給「出圖耗時撐不出間隔」的場合兜底(小圖/低步數/快速失敗重發)。
- 兩條紀律:節奏等待**持槽進行**(否則上限內的 N 個任務會一起等完同一段再一起發,節流形同
  虛設);等待期間被取消**必須還槽**(漏一格就永久少一格併發,漏滿就再也發不出請求)。
- 卡片要看得見退避(`GenRecord.retry` → 「請求受限,稍後第 N/M 次重試…」)。否則「生成中…」
  一動不動幾十秒,使用者以為卡死了再點一次,白白多壓一個請求。
- `encodeVibeImage` 同樣帶重試,並由 NaiPanel 取閘門槽位(`encodeVibeGated`)——它也是一次
  真實 NAI 請求,不然「一邊出圖一邊編碼」在賬號上就是兩條併發。`testNaiConnection`
  **刻意不進閘門**:診斷按鈕多半是在被限流時點的,攔住它只會讓人沒法排查。

**手動編輯提示詞(PromptEditor.vue + promptEditor.ts)**:提示詞的**唯一真源是正文裡的 tag 原文**
(不在 extra、不在 store),故「編輯提示詞」本質是一次正文寫回:序列化新 tag →
`replaceImageTagAt` 原位替換第 seq 條 → `applyMessageText` → 重水合。新 tag 換出新 promptHash,
老圖自動落進 stale 桶(卡片已有「舊提示詞」角標與提示行),故「應用」無需任何額外落地邏輯。
四條要點:
- **序列化只有一份**(`st/imageTagRegex.ts` 的 `serializeImageTag`,`injectImageTags` 也調它)。
  兩處漂移 = 「解析出的欄位」與「落進正文的原文」對不上,而 promptHash 吃的是原文,
  表現為「什麼都沒改卻全變 stale」。同理「改動檢測」按**欄位值**比對,不比對序列化結果:
  解析是容忍式的、序列化是規範式的,非規範的手寫 tag 開啟再原樣儲存,原文會變。
- **子標籤字面量必須攔**(`containsTagMarkup`,與 AI 側共用 `FORBIDDEN_SUBTAG`):查詢正則
  非貪婪,內容裡混進一個 `</bbi_image>` 會讓 tag 提前截斷、**後半截漏進 DOM 與提示詞**。
- **不可編輯 Card.vue 的 `promptText`**:那是帶「角色: 」「Negative: 」字首的展示串,
  不可逆解析。編輯結構化五欄位,沒給編輯的也原樣帶回,否則會靜默吃掉 characters。
- 彈窗掛**外掛** shadow root(同燈箱),活得比卡片長 → 樓層座標全部開窗時快照;
  身份 CAS 攔不住「tag 數變了」,故寫回前自己按 `rawTag` 核對 seq 還指向同一條。
- ⚠ stale 態只顯示**一張**(`latestStaleEntry` 返回單條,且 `pageable` 要求
  `history.length > 1`,翻頁器整個不出現)。舊提示詞下有 N 張時改提示詞 → 只剩最新一張可見
  (檔案與指標都沒刪,改回原樣即全部找回)。彈窗裡據此給了明確提示。

**「AI 重寫提示詞」(入口在編輯彈窗裡;runner.ts 的 `requestSlotTag` + slotPlan.ts)**:與「重繪」
的區別——重繪用**同一條提示詞**再出一張,這裡是讓 AI 重讀本樓正文、**重寫這一條 tag 的內容**。
畫的還是原來那個瞬間,只是提示詞寫得更準、更全。這條紀律的落點是寫回側
硬按 seq 原位替換、**模型返回的 position 壓根不參與寫回**,所以「換不換畫面」實際只由
`buildSlotTaskNote` 的措辭決定——舊版那句「另選一個與它們明顯不同的瞬間」正是讓按鈕
(寫著"重寫提示詞")與模型收到的指令(其實是"換個畫面")對不上的根因。
分析與寫回都只圍著一個槽位轉,不碰本樓其它 tag 與圖片:
- 分析基底是 `stripImageTags(整樓)`(AI 不該把 tag 當正文),並靠 `buildSlotTaskNote` 把**該槽位
  當前的提示詞原樣喂回去當錨點**(不截斷:不給全文,模型只能從正文猜這張畫的是哪個瞬間,
  猜偏就又成了換畫面);其餘槽位摘要仍然帶上,但用途是「別搶它們的畫面」而非「別選中它們」;
- 強制 `min=max=1`(build 的規則文案與 `parseImagePlan` 校驗要同時覆蓋,只改一處自相矛盾);
- 庫文本取 `charTagsBeforeFloor(floor + 1)`（含本樓已落檔增量),否則 AI 會把首輪建檔的角色
  當新人重寫;**本次 AI 的 changes 一律丟棄**(首輪全量分析已為整樓建檔,重複應用只會汙染歷史);
- 寫回是 `replaceImageTagAt` 原位替換第 seq 條(同 PromptEditor),寫前按 `rawTag` 核對 seq
  還指著同一條;成功後 `markForAutoGenerate(..., 'force')` 讓本槽位自動按新提示詞出圖,
  舊圖落進該槽位 stale 桶,其餘槽位走差量水合、圖片零重建;
- **入口在提示詞編輯彈窗裡,不是獨立按鈕**:手改與 AI 改是同一件事的兩種手段,放一起使用者
  才能「讓 AI 寫一版 → 看著不順手就手動接著改」。三條約束(使用者明確要求)及其落點:
  - **彈窗不自動關**——點一下就閃退像是崩了。跑完只回填輸入框 + 面上給一行說明;
  - **仍然直接落盤**——落盤與出圖是 runner 乾的,與彈窗無關,關不關窗都照做;
  - **關窗不中斷、重開能續上**——請求交給 `floor/tagPlanState.ts` 的 `runTagPlan` 託管,
    生命週期歸 store 不歸彈窗;重開時 `awaitTagPlan(key)` 取回**同一個在途 promise** 接著等
    (存的是 {票據, promise} 而非布林,就是為了這個)。收尾後從**當前正文**重讀第 seq 條,
    同時重新整理 `content`(回填草稿)與 `rawTag`(否則使用者接著點「應用」會撞上「這條 tag 已被
    改動」——而改動它的正是我們自己)。
  - ⚠ **解除安裝後絕不能再 render**(`closed` 閘門,0.3.0 開發期踩過的真實迴歸):重寫活得比彈窗長,
    它的收尾回撥必然在關窗之後才到,而 `paint()` 是無條件 `render(...)` 的。關鍵在於
    **容器 `remove()` 了並不等於看不見**——`ModalMask` 把內容 `<Teleport>` 到 `modalHost`,
    往脫檔容器裡渲一次,彈窗就原地復活貼回螢幕;復活的還是**全新例項**(`closing` 的 watch
    沒有 `immediate`,頂著 `closing=true` 掛載也不會自行隱藏),而 `requestClose` / `onApply`
    又都在 `closing` 上早退 → 叉、取消、應用**全部點不動,窗再也關不掉**。
    故 `paint()` 首行 `if (closed) return;`,且 `closed = true` 必須排在 `render(null)` **之前**
    (兩者之間插進一次遲到的 paint,解除安裝掉的就是它剛掛上的新例項,等於白關)。
- 卡片這邊仍然顯示「AI 重寫提示詞…」遮罩並留取消鈕:關了彈窗重寫照跑,沒有這個口子
  就只剩一張悄悄變化的圖、沒處叫停。展示態讀 `isTagPlanning`,取消走 `cancelFloorTags`
  (與全量分析共用「每樓一把」的在途鎖)。
  ※ 想**換一個畫面**(而不是重寫同一畫面的提示詞)走的是另一個入口:ST ⋯ 選單裡的
  調色盤按鈕(`floor/actionButton.ts` → `requestFloorTags({replace})`),整樓重新分析。

**卡片摺疊(collapseState.ts + Card.vue)**:摺疊態是「臨時遮蔽」性質的 UI 態,不是資料——
存模組級 store、**不寫 message.extra**(每次摺疊都 saveChat 落盤,代價與語義都不合適),重新整理後
回落設定項 `settings.ui.autoCollapseImages`(「樓層圖片預設摺疊」)。與 genState 同理必須放
元件外:swipe/編輯/ST 重渲染都會重掛卡片,放元件 ref 裡使用者摺好的圖會自己彈開;key 與
genState 同構(chatId|messageId|swipeId|seq),重建後按 key 認領。手動摺疊/展開過的槽位
覆蓋預設值(`isCollapsed` 取 `Map ?? 預設`);不主動清理(一個槽位只佔一個布林,舊聊天殘留
可忽略,切回來還在反而是期望行為)。摺疊時卡片收成一條細條,生成中/出錯在條上直接給狀態,
整條點選展開。

**卡片版面(card.css)**:卡片是**聊天內嵌**元素,不是獨立面板——每多一畫素都在推散正文。
故頭部與底部按「一行的高度」定死:頭部 `4px padding + 26px 按鈕 = 34px`,底部摺疊入口
`5/6px padding + 22px` 一行。**所有按鈕同一條基線**:`.bbi-btn` 高 26,`.bbi-btn--icon`
必須 `width == height == 26` 且圖示統一 15px —— 只寫 width 不寫 height 時,圖示按鈕會
比文字按鈕矮一截,同一行裡一眼看得出參差(歷史 bug)。圖示本身也要光學對齊:
`trash/copy/download` 的墨跡範圍須接近,否則畫素尺寸相同仍顯大小不一。
操作分工:**頭部只放「對當前這張圖」的操作**(下載/刪除/重繪),提示詞的操作(複製)
跟著提示詞放進展開區——展開區裡的複製按鈕**絕對定位**,並排 flex 會讓它隨長文本高度飄到中間。

**圖片放大與長按儲存(Lightbox.vue)**:ST 原生燈箱夠不著——入口 `.mes_img` 只是 class,
`expandMessageMedia` 讀 `chat[mesid].extra.media[data-index]` 且模組私有未匯出;走官方
`extra.media` 會把圖掛到 `.mes_media_wrapper`(`.mes_text` 的兄弟),脫離 tag 行內位置。故自建。
**長按儲存靠三條約束**(改前務必讀 Lightbox.vue 頂部註釋):只監聽 `click` 不攔 touch;
不加 `user-select:none`/`-webkit-touch-callout:none`;顯式 `touch-action:auto` 抵消 ST 的
`body{touch-action:none}`(css/mobile-styles.css:251)。燈箱掛**外掛** shadow root 並 Teleport
到 `modalHost`(需要 `--bbi-*` 變數),不能掛卡片自己的 shadow——會被 `.mes_text` 的層疊上下文裁掉。

**儲存(floor/storage.ts)**,三層:
- 新圖片二進位制 → ST 檔案系統 `user/images/柏宝绘_<角色名>/bbi_<角色名雜湊>_<swipeId>_<promptHash>-<genId>.<ext>`
  (角色名優先取訊息發言者,其次取當前聊天角色名,空值回退「未命名角色」;
  `st/images.ts` 上傳時由服務端清洗目錄名,檔名保留 promptHash 穩定雜湊);
- 後設資料 → `message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }`
  (歷史時間正序,卡片翻頁;`slotSeq` 隔離同樓多 tag)。
- 側寫(sidecar)→ `user/files/<與圖片同名>.json`,存 tag 原文 + seed,**只為相簿服務**:
  相簿跨全部聊天按目錄列圖,而提示詞只在某一個聊天的 extra 裡,掃全庫 JSONL 反查不可行
  (單角色 chats 目錄可達 GB 級、`/api/chats/get` 整檔案返回無分頁)。
  檔名由 `sidecarFileName` 純函式從圖片名推出,不維護索引(`/api/files/upload` 原樣落盤只校驗不清洗)。
  json 進不了 `user/images`(上傳介面的 format 必須是媒體副檔名),故落 `user/files`。
  **寫失敗只 warn 不拋** —— 圖已存好,不能因附屬 json 丟圖;老圖沒有側寫屬正常。
- 寫回用 CAS 迴圈(`mutateStore`,引用比對 + `saveChat`);儲存順序:先檔案後指標 / 刪時先指標後文件。
- 舊 `user/files` 圖片不遷移、不刪除,按原路徑顯示;刪除舊記錄僅移除指標,只對 `user/images` 圖片呼叫檔案刪除介面(連同它的側寫)。
- **相簿刪圖是另一條路**(`deleteImageFileOnly`):沒有指標可摘——相簿按**目錄**列圖,指標散在
  各個聊天的 extra 裡,兩者之間沒有反向索引,而掃全庫反查不可行(同側寫那條的實測資料)。
  故它**只刪檔案+側寫、不碰任何聊天記錄**,必然留下破指標,由卡片側執行時降級兜底(見下)。

**破指標降級(floor/missingImages.ts + Card.vue)**:模組級 `reactive(Set)` 記「已確認不在的路徑」。
- **必須放元件外**:卡片生命週期由水合決定(任一兄弟槽位出圖就重建整樓),
  標記若在元件 ref 裡,重建後破圖原地復活。同 `genState.ts` / `collapseState.ts`。
- **必須先確認再落冊**:`<img>` 的 `error` 分不清「檔案沒了」和「網斷了/500」,
  故 `confirmImageMissing` 補一次 HEAD(`st/images.ts` 的 `probeUserImage`),
  只有服務端明確 404 才記;分不清(返回 `null`)一律不記,破圖佔位留著下次重掛自然重試。
  把掉線記成刪除,使用者網一抖就滿屏「檔案已刪除」且重新整理前好不了。
- **不寫回 extra**:那要 `saveChat()`,而「檔案沒了」是磁碟的客觀狀態不是聊天資料,
  且使用者完全可能把檔案恢復回來。會話內記住即可。
- 卡片一律用 `liveHistory`/`liveStale`(過濾掉已確認缺失的)算 phase、翻頁器、張數:
  不過濾則翻頁器多出翻得到卻是空的格子、摺疊條張數虛高;刪光則退回 pending 給出「生成圖片」
  入口(而非頂著 ready 顯示破圖、連重新生成都點不了),並加一行「圖片檔案已刪除」說明。
- 路徑歸一化(`normalizeImagePath`)是**讀寫兩側唯一口徑**:extra 存的是服務端原樣返回的
  未編碼中文路徑,相簿拼的是逐段 `encodeURIComponent` 的,前導斜槓也有無不定;
  兩套寫法不對賬,相簿刪完圖卡片照樣顯示破圖。刪除入口(`deleteImageFileOnly`)同樣先走
  這一歸一化再發請求——ST 的 `/api/images/delete`、`/api/files/delete` 都是把 `body.path`
  直接 `path.join` 到根目錄、**不做 URL 解碼**,編碼路徑傳過去只會 404。

**出圖後端(backends/)**:
- `comfyui.ts`:兩種互斥模式在 `generateComfyImage` 裡分叉,匯合點是「拿到可提交 JSON」:
  - **custom**:API 格式工作流模板,支援 `%prompt% %negative_prompt% %seed% %nl% %width% %height%`
    佔位符(不支援即報錯);
  - **simple**(comfyTemplates.ts):選模型/LoRA + 填引數,按架構模板族組裝 JSON,**無佔位符**。
    模板族刻意收斂為 checkpoint 系 / Flux / Anima(Qwen 鏈路),新架構 = 加一條模板資料 + 一個組裝分支;
    正向 = 固定正面 + (nl 優先 || tag),負面 = 固定負面 + AI 動態負面(Flux 無真實負面輸入,恆空)。
  請求通道自動選擇 —— **瀏覽器直連優先,僅網路級失敗(CORS/拒連)回退 ST 服務端轉發**;
  排隊拿到 prompt_id 後輪詢失敗不重發(避免重複生圖)。
  入參型別是收窄後的 `ComfyRunConn`(url + 單套預設的 mode/workflow/simple + 橫豎尺寸),
  **不認整個 `ComfyUISettings`**——後端層只該知道「這一次出圖用什麼」,不該知道使用者存了幾套。
- `comfyObjectInfo.ts`:簡易模式的候選列表。直連 `GET /object_info` 一次拿全(含 LoRA/CLIP);
  回退 ST 轉發只有 `/api/sd/comfy/models|samplers|schedulers|vaes`(服務端摘 object_info 欄位,
  **沒有 loras/clips 端點**),轉發通道下這兩組降級為手輸。session 級快取,「重新整理」強制重拉。
- `nai.ts`:協議與官方一致(瀏覽器直連,url 可指第三方相容站,自動補 `/ai` 字首);v4 系走
  `v4_prompt` 結構 + vibe 編碼快取;NAI3 直接發參考原圖;質量詞/負面詞按模型給預設值,
  渠道頁可見可覆蓋(存空串 = 跟隨模型官方詞);正向拼裝順序為
  **畫師串 → 畫面 tag → 質量詞**(畫師串來自庫,見 §7);
  `.naiv4vibe` 匯入匯出與官方互通。
  **NAI 4.5/V5 走「Base + 原生 Character Prompts」分支**:謂詞是 `naiSupportsCharacterPrompts`
  (= `isNai45 || isNai5`),`v4_prompt` 結構裡 `char_captions` 填來自協議的 characters
  (每角色一條,庫數量 tag `1girl→girl` 降級、tag+**英文** nl 拼一條 caption,負面側給空 caption 佔位)。
  ⚠ 邊界在 **4.5** 而不是 V5,也不是整個 v4 系:`char_captions` 所在欄位本就叫 `v4_prompt`,
  這套結構是 V4 時代的協議、V5 只是繼承,而自然語言是 **4.5 才引入**的(原版 NAI4 只吃 tag)。
  曾按 `isNai5` 卡過,導致 4.5 明明支援卻一條角色提示都發不出去,角色外貌全糊進 Base
  (`nai.test.ts` 有迴歸鎖)。nl 一律寫**英文**:生圖模型讀英文自然語言更可靠,中文還要多花
  幾倍 token(4.5 的 base + 全部 character prompts 合計約 512 T5 token)。**角色名是唯一例外**:
  characters[].name / changes[].name 與 tag/nl 裡出現的角色名必須逐字保持原文(中文名寫
  中文,不音譯不意譯)——外掛按名字逐字匹配庫條目做替換,名字對不上檔案/正文錨定就斷。
  **真正的 V5 專屬差異只有三處**:`params_version: 4`、取樣器限子集(列表隨模型過濾,面板同步)、
  varietyBoost 無效(`skipCfgAboveSigma` 對 V5 返回 null,4.5 用 magic 58)。
  **Vibe 對 V5 同樣可用**:`vibeModelKey` 已含 v5full/v5curated 鍵,V5 走與 v4 系相同的編碼
  快取分支(`reference_image_multiple_cached` 無條件初始化);僅**非 NAI 家族模型**才不支援。
  正向串在 4.5/V5 且帶 nl 時拼成 `tags. nl`(句點分隔)。
  **可選模型只有 4.5 與 V5 四條**(`NAI_MODELS`,同時是 `normalizeNai` 的白名單):4.5 以下
  已下線,存量配置裡的舊模型會被**改寫**成 `naiDefaults().model`(5-full)並打一條
  `console.warn` —— 畫風、Anlas 消耗與 vibe 編碼 key 都會跟著變,這是有意接受的代價
  (`settings.naiModelRetire.test.ts` 鎖住「在列的不動、下線的必留痕」)。
  ⚠ `NaiModel` 型別比 `NAI_MODELS` 寬,`isNai3` / 原版 NAI4 的協議分支也都還在:留著是為了
  不動迴歸鎖,也留一條回退餘地。**它們從 UI 已不可達**,別再按「這分支還活著」去推斷產品行為。
- `chatu8Vibe.ts`:只讀智繪姬的 extension_settings + IndexedDB,逐條匯入 vibe(內容指紋去重、讀取超時、遷移進度)。
  另有提示詞預設三件套(collectChatu8ArtistRefs / detectChatu8Artists / importArtistsFromChatu8):
  讀 `yushe` 表 + `yusheid_novelai` 當前選中,每條預設三個欄位按**位置對應**遷移——
  前置固定正向(fixedPrompt)→ 畫師串(正向最前)、後置固定正向(fixedPrompt_end)→ 正面質量詞
  (正向最後)、固定負向(negativePrompt)→ 負面提示詞,且負向非空時把**當前模型官方基線**烤在
  前面(智繪姬口徑 = 官方 UCP + 使用者負向;空則留空走回落鏈,基線跟隨模型)。**同名即同一配方**:
  內容不同 → 覆蓋更新(舊版遷移把正向整體塞進畫師串的條目,重導即修好)、完全相同 → 跳過;
  active 預設對映到目標 id 由呼叫方決定是否選中。結果逐條帶 plans(state: import/overwrite/skip
  + 目標 id + 落盤值),純函式不落盤;UI 在 NaiPanel「從智繪姬遷移」摺疊區:入口常駐,
  點開彈窗算一次預覽(徽標:將匯入/將覆蓋/已存在),確認後 push/覆蓋 + 可選切換。
- `vibeStore.ts`:Vibe 原圖/編碼正文與縮圖分檔案存 ST `user/files`，檔案儲存不可用時回退本機 IndexedDB。
  `extensionSettings['baibai_image']` 只留路徑、模型鍵、指紋等小型索引，禁止再放 Base64。

## 7. 狀態與持久化

- **settings(全域性,跨裝置)**:`state/settings.ts`。import 階段以預設值建 reactive;
  ST 就緒後 `hydrateSettings()` 從 `extension_settings['baibai_image']` 載入
  (**normalize 逐欄位容錯 + 存量遷移**,如 resolution→橫豎兩格、webui 隱藏遷移);
  `ready` 守門標誌防預設值覆蓋伺服器設定;deep watch → 防抖 `saveSettingsDebounced()`。
  訂閱者用 `onSettingsReady(cb)` 等 hydrate 完成(如 ui.ts 回灌主題)。
- **ComfyUI 工作流庫**:`settings.comfyui.workflows`(`ComfyWorkflowPreset[]`)+ `activeWorkflowId`。
  - 一條預設 = 名字 + `mode`(custom/simple 互斥)+ 工作流 JSON + `simple` 引數 + `naturalLanguage` + 橫豎尺寸。
    這些跟著工作流走而非留在渠道級,因為它們是**底模的屬性**(Illustrious 要短 tag + 832×1216,
    Flux 要自然語言 + 1024 方圖);留在渠道級的話每次切工作流還得手改兩處。
    `url` 反過來仍是渠道級(一臺伺服器跑所有工作流)。
    兩模式的欄位都常駐(切模式不丟另一邊的配置),只是出圖時只生效一邊;
    存量預設沒有 mode/simple 欄位,normalize 補 `custom` + 簡易預設值。
  - **不變式:`workflows` 恆非空**。`comfyDefaults()` 出生即帶一條空預設(只用一套的人感覺不到「庫」的存在),
    `normalizeComfyUI()` 收尾再兜一次;`activeWorkflowId` 懸空時回落第一條。
    消費方一律走 `activeComfyPreset()` / `effectiveComfyConn()`,不直接摸陣列,故無需到處判空。
  - **存量遷移**:老配置的平鋪 `workflow` / `naturalLanguage` 加渠道級橫豎尺寸,由 `foldLegacyWorkflow()`
    原樣折成第一條「預設工作流」(口徑同 `foldLegacyNegative` / `migrateSize`:使用者特意設過的值絕不被預設值頂掉);
    `workflow` 為空串也照樣建這一條。靠欄位有無判斷,無 schemaVersion。
  - 工作流 JSON 隨設定整體進 `settings.json`(單套數 KB–數十 KB)。刻意**沒有**像 Vibe 那樣搬去 `user/files`:
    量級差兩個數量級。若日後設定儲存變慢,這裡是第一嫌疑人。
- **NAI 接入點庫**:`settings.nai.endpoints`(`NaiEndpoint[]`)+ `activeEndpointId`。
  一條接入點 = 名字 + 介面地址 + 該站的 API Key,**僅此三項**。起因是「公益站換著用」:
  同一套出圖引數要在多個出口之間切,故模型/取樣器/尺寸/vibe/畫師串/併發一概留在渠道級 ——
  換站不該逼人把引數重配一遍。key 隨條目走而非渠道級共用一份,因為各站各有各的 key。
  - **不變式:`endpoints` 恆非空,且恆含內建官方那條**(`OFFICIAL_NAI_ENDPOINT_ID = 'nep_official'`,
    url 恆為 `NAI_OFFICIAL_URL`)。`activeEndpointId` 懸空時回落 `[0]`。這三條**與工作流庫同側、
    與畫師串庫相反**:地址是必需品(空了直接出不了圖),回落只是換個出口且出錯會當場報連線失敗,
    不像畫師串回落那樣靜默改變每張圖的樣子。
  - **官方條只讀**:UI 禁掉改名/改址/刪除,`normalizeNaiEndpoint` 遇 `nep_official` 一律重建成內建值
    (手改 settings.json 也拗不過);只有 key 保留 —— 內建的是地址與名字,不是別人的金鑰。
    要用官方映象就點「複製」得到一條普通條目,那條隨便改。
  - **存量遷移**(`migrateNaiEndpoints`,靠欄位有無判斷,無 schemaVersion):老配置的平鋪
    `url`/`key` 收成第一條。url 為空或就是官方地址(絕大多數)→ key 直接折進官方那條,不多出重複行;
    是第三方站 → 建一條「我的接入點」放**首位**並保持選中,官方條**追加在後**(官方排前面會把
    使用者正在用的出口擠到第二行,看起來像被換掉了)。老欄位 `nai.url`/`nai.key` **原樣留著只為回滾**,
    出圖鏈路一律不讀。`settings.naiEndpointMigration.test.ts` 鎖住全部上述口徑。
  - 消費方一律走 `activeNaiEndpoint()` / `effectiveNai()`(= 渠道級全部引數 + 當前接入點的 url/key),
    不直接摸陣列。`backends/nai.ts` 三個入口(`testNaiConnection` / `generateNaiImage` /
    `encodeVibeImage`)簽名不變,吃的就是這個窄化結果 —— 同 `effectiveComfyConn()` 的理由。
    ⚠ 漏走一處的症狀很隱蔽:那處會用上存量 `nai.url`/`nai.key`,老使用者仍然是通的,
    只有切到第二個接入點的人才會發現某個功能還在往老地址發。
  - ⚠ `backendStatus().reason` **刻意不帶接入點名字**:它經 `getBackendStatus()` 原樣遞給第三方,
    而名字是使用者自己敲的 —— 有人就拿站點域名當名字,帶上等於把地址漏進公開返回值
    (`public/api.ts` 的白名單正是為擋這個)。面板自己的 toast 標題不受此限,那是本地 UI。
- **NAI 畫師串庫**:`settings.nai.artistPresets`(`NaiArtistPreset[]`)+ `activeArtistId`。
  一條配方 = 名字 + 畫師串(prompt,拼在正向提示詞**最前面**) + 可選綁定的正面質量詞(quality)
  + 可選綁定的負面提示詞(negative);綁定值留空 = 跟隨渠道級 → 模型官方詞(三級回落,見
  `backends/nai.ts` 的 `naiQualityTags` / `naiUndesiredContent`)。拼裝順序:畫師串 → 畫面 tag →
  質量詞(畫師串放最前是因為它定整幅畫的基調,NAI 對靠前 tag 權重更高;切換畫師串時
  三個欄位一起生效——一套配方即一套完整畫風搭配)。
  - **不按模型分表**(與質量詞/負面詞相反):官方質量詞是**模型的屬性**,切模型必須跟著換;
    畫師串是**使用者自己的配方**,跨模型複用才是常態,故做成可增刪的庫而非 `Record<model, …>`。
  - **與工作流庫刻意相反的三處**:①`artistPresets` **允許為空**(工作流恆非空);
    ②`naiDefaults()` **不播種**任何一條(工作流出生即帶一條);③`activeArtistId` 懸空時
    `normalizeNai` **清成空串**而非回落 `[0]`。根因是必需品與可選項的差別:不給工作流就
    出不了圖,不給畫師串只是不加畫風;回落 `[0]` 會在使用者刪掉當前條目後**靜默套上一套
    他沒選過的畫風**,而下拉顯示的正是那一條(看起來就是自己設的),幾乎無法排查。
    有單測鎖定這條對照(`settings.naiArtistMigration.test.ts`)。
  - 空串是「不使用」的哨兵。preset id 恆為 `art_*` 形狀(normalize 保證非空),故空串不會
    與任何 id 相撞,無需像 `vibeGroups` 的 `g:` 那樣裝箱(那裡組名由使用者輸入、會撞名)。
    清成空串也讓 `activeArtistId ∈ {'', 庫中已有 id}` 成為不變式,面板無需再判懸空。
  - 消費方兩條路:面板走 `activeNaiArtist()`(讀全域性 settings,返回 `NaiArtistPreset | null`,
    刻意只讀——在 computed 裡被呼叫);拼裝走 `backends/nai.ts` 的 `naiArtistPrompt(nai)`
    (純函式、吃 NaiSettings,可單測)。**刻意不共用一份**:settings.ts 已 import nai.ts 的
    `naiDefaultUndesired`,反向加值依賴會成執行時環。
  - ⚠ `fullPositivePrompt` 在 `buildNaiParameters`(v4_prompt 來源)與 `generateNaiImage`
    的頂層 `input` 處**各調一次**,兩處必須同源。拼裝改動一律留在函式內部——在某個呼叫點
    單獨加料會讓 NAI3(讀 input)與 NAI4/4.5(讀 v4_prompt)拿到不同提示詞,且只在 NAI3
    上暴露(現有測試全是 4.5 模型,一個都不會紅)。有同源斷言鎖定。
  - **內建只讀庫**:`BUILTIN_NAI_ARTISTS`(backends/nai.ts,id 恆為 `bi_*` 字首,與使用者
    `art_*` 永不撞)隨外掛版本更新、**不進 settings**(否則預設值凍在使用者設定裡,升級不跟進)。
    新裝預設選中第一條(見 naiDefaults);老使用者 activeArtistId 存 settings,不受影響。
    只讀:面板/管理器不給改名刪除,自定義只能「複製」成使用者條目再改 —— 這是內建條唯一的
    自定義路徑。要下線內建條至少留一個版本:正選中它的使用者會走「id 懸空 → 清成不使用」,
    畫風靜默變掉,需慎重。
  - **預覽圖**:`NaiArtistPreset.previewPath` 可選(老資料無此鍵,空 = 管理器顯示佔位)。
    管理器上傳時壓成最長邊 512 的 jpeg,落 `user/images/柏宝绘_画师串/<條目id>.jpg`
    (st/images.ts 的 `/api/images/*`,路徑記條目上、不維護額外索引)。換圖同名覆蓋不攢孤兒;
    刪條目 best-effort 連帶刪檔案(刪不掉不阻塞刪條目);**複製條目不帶走 previewPath** ——
    兩條目共指一個檔案,刪一邊另一邊破圖。
  - **管理器彈窗**(NaiArtistManager.vue):面板下拉只管高頻切換,低頻管理(搜尋/預覽圖/
    勾選批次刪除/逐條編輯複製刪除)在管理器。純邏輯在 naiArtistLib.ts:`matchArtist` 按
    名字 + 畫師串內容搜尋(綁定的正/負面詞不參與——匹配面鋪得越廣誤傷越多)、
    `planArtistRemoval` 規劃刪除與 activeId 接位(口徑與面板單刪一致:當前項被刪接位到
    原位置那條,刪空回 `''`,**不**回落 [0])。互動:點卡片主體 = 啟用,再點當前條 = 停用;
    勾選框只服務批次刪除;內建條無勾選框、只讀。「複製」是內建條唯一下自定義入口。
  - **存量遷移**:純加法,無老欄位可折。老配置 hydrate 後得空庫 + 空 id,正向提示詞輸出
    與上線前逐位元組一致。
- **Vibe 大檔案**:
  - `extensionSettings['baibai_image'].nai.vibes`:僅存 `NaiVibe` 小型索引，不存原圖、縮圖 dataURL 或編碼正文;
  - `user/files/bbi-vibe-*.json`:原圖與各模型編碼正文;
  - `user/files/bbi-vibe-thumb-*`:列表縮圖;
  - IndexedDB `baibai_image_vibes`:ST 檔案寫入失敗時的本機回退，不跨裝置同步。
- **舊版 Vibe 自動修復**:`hydrateSettings()` 在 normalize 前直接掃描舊條目，按順序逐條落盤;
  每條成功後立即原地替換並釋放該條 Base64，不等整庫完成。全部成功後只儲存一次輕量設定。
  首次升級可能需要等待搬遷，重新整理後恢復正常;若某條檔案與 IndexedDB 都寫失敗，則保留原條目並報錯，
  已成功條目不會退回大物件，下次重新整理繼續重試。
- **智繪姬遷移**:`chatu8Vibe.ts` 順序讀取並立即呼叫 `vibeStore.ts` 落盤，不在記憶體或設定中積累整庫大物件;
  匯入項預設不啟用，避免生成時一次讀取全部 Vibe 正文。
- **Vibe 強度唯一口徑**:一律走 `vibeStore.ts` 的 `clampVibeStrength`(夾 0–1,認不出數回落
  預設 0.6)。曾有四份各自為政的實現,其中三份寫作 `Number(v)`——`Number(null)`/
  `Number('')` 都是 0,「欄位缺失」被靜默判成「強度 0」,vibe 掛了卻沒效果,極難排查。
  只認真數字和可解析字串;面板數字框 step="any" 自由填值,夾取後回寫 input
  (防「填 5 被夾到 1、框裡卻留著 5」的騙人顯示)。
- **Vibe 分組**:`NaiVibe.group` 是扁平字串(空串 = 未分組),無獨立 groups 陣列——組只是
  「一起啟用/一起摺疊」的標籤,沒有自身屬性,改名/刪組都是對成員 group 欄位的批次賦值,
  不會產生懸空引用。`backends/vibeGroups.ts` 純邏輯:組名一律 `g:` 字首裝箱(防與
  「未分組/新建」哨兵撞名)、`groupVibes` 歸攏 + 搜尋、`isGroupActive` 啟用集合判定
  (等於組內全部成員才生效,搜尋期間仍按全量成員算)。出圖只看每條 enabled,
  組的批次動作本質是對成員 enabled 的批次賦值,不引入第二套真相。
  智繪姬遷移時若舊名帶「組名 · 原名」字首(`planPrefixGroups`),還原成分組並去掉字首。
- **副 API 渠道(跨外掛共享)**:真身存 `extensionSettings['baibai_api_channels']`(帶 revision),
  本外掛設定裡只是映象;寫入後廣播 `st-baibai-api-channels:changed`,他端監聽重讀。
  與柏寶書共用,任一端增刪改即時同步。
  - **思考強度**(`ApiChannel.reasoningEffort`,空串 = auto = 不發引數,老渠道零變化):ST
    代理對 openai 源的 `reasoning_effort` 卡**模型名白名單**(OPENAI_REASONING_EFFORT_MODELS),
    模型名對不上就靜默丟棄、還照樣返回 200 —— 使用者設了卻看不出來。故非空時整條請求改走
    custom 源(api/client.ts 的 `buildRequestBody`,純函式有單測):`custom_include_body` 由
    服務端直接 merge 進上游請求體,不過白名單。兩個坑已規避:custom 源**不讀 proxy_password**,
    key 靠 `custom_include_headers` 注入 Authorization;`custom_include_*` 是 YAML 字串且
    解析失敗會靜默忽略,一律 JSON.stringify 生成(key 裡帶 `:` `#` 等會炸 YAML)。取值不做
    白名單校驗原樣透傳(各家詞彙不統一)。⚠ 跨外掛:Horae ≤ 當前版本的 normalizeChannel
    是「逐欄位重建物件」,在書裡新增/編輯/測試渠道會回寫共享儲存、**抹掉本欄位**(繪獨有),
    等書那邊補同名欄位後風險消失。
- **排除設定(跨外掛共享)**:真身存 `extensionSettings['baibai_exclude_settings']`(帶 revision),
  映象在 `settings.excludes`(四張名單:excludedChars / excludedWorldNames /
  excludedWorldInfoPatterns / customStripTags);協議與渠道同構(指紋防迴環 + revision 取 max),
  事件 `st-baibai-exclude-settings:changed`。與柏寶書共用同一份名單、同一套匹配口徑:
  排除角色 → 自動 tag 全流程停用(樓層按鈕也在下一次對賬時撤掉);整本/條目名排除 → 副 API 世界書過濾
  (autoTag/excludes.ts);清洗標籤 → 掃描/正文清洗整塊刪除(autoTag/clean.ts)。
  共享儲存建立時播種預設條目名規則 `\[mvu[\s\S]*?\]`(只發一次,刪了不補回)。
- **ui(本機 + 同步)**:視窗開關/當前頁(activePage 存 localStorage)是純本機態;
  主題/導航/懸浮球/樓層圖片預設摺疊(autoCollapseImages)屬真設定,寫入 `settings.ui` 走跨裝置同步。
  相簿分組預設摺疊,僅將手動展開的目錄名存入本機 `bbi.ui.galleryExpanded.v1`;
  舊 `galleryCollapsed.v1` 不反推展開態,未記錄的新目錄預設收起。`v-if` + Transition
  使圖片僅在展開時掛載、收起動畫結束後解除安裝,保留原生 `loading="lazy"`。
  每組首次顯示 24 張,之後每次最多追加 24 張;追加數量僅本頁面內保留,重新整理頁面後重置,
  同頁面內收起再展開保留進度。目錄/檔名仍全量讀取,不影響角色搜尋和總數統計。
  **多選刪除**:獨立的「選擇」開關(不做長按進入——瀏覽是主用途,點圖=放大必須是預設行為),
  分組頭的核取方塊選的是**整組**而非當前渲染的那批(懶載入只是渲染策略)。刪除逐張容錯
  (單張失敗不中斷其餘,失敗的留在列表裡且仍勾著),刪完 `markImagesMissing` 讓已開啟的
  樓層卡片立刻降級,並**就地**從列表摘掉而非重新 `load()`(否則展開態與已載入批次全被重置)。
  **分組體積(⚠ 暫時停用)**:原方案逐張 HEAD 讀 `Content-Length`——`/api/images/list`
  只返回檔名(服務端 `util.js getImages` 只 map 出 `dirent.name`),既無 size 也無 mtime,
  只能一張張問(靜態路由 `res.sendFile`,實測 1~2ms 且無 body,比相簿直接載入原圖當縮圖
  便宜得多)。**作者不滿意這一方案(請求數隨相簿規模線性增長),`index.vue` 的 `load()` 中
  `measureSizes` 呼叫已註釋**,計算/模板/CSS/測試原樣保留,恢復時解注即可;`probeUserImage`
  仍供 `missingImages.ts` 的 404 確認使用。原設計:後臺限併發(`src/pool.ts` 的 `mapLimit`,
  6 路——ST 單程序,壓太狠會卡住使用者自己的聊天)且不阻塞首屏;量不到的**不計入**而非當 0
  累加,未量全的文案帶「≥」;返回三態(`exists:true` / `exists:false` / `null`=分不清),
  `null` 讓網路抖動不會被當成刪除。
- **charTags(三層真源:全域性庫 + 本聊天手動基線 + AI 樓層增量)**:
  - **全域性庫**:存 `extensionSettings['baibai_image_char_global']`(globalCharTags.ts,
    協議同共享渠道:revision + 指紋 + 廣播事件),跨聊天/跨裝置。定位是**凍結模板**:
    只由使用者手動增刪改或「提升為全域性」寫入,不記 history;AI 的 changes 對鎖定名
    (全域性獨有、本聊天無同名條目的角色)一律丟棄——重放(applyCharTagOps)與
    @替換(applyPositionedCharRefs)雙側攔截,runner 寫樓層增量前也先濾一遍;
    庫文本裡鎖定條目帶 [locked] 標記,提示詞宣告其不可變。本聊天手動建同名條目
    即覆蓋全域性並解鎖(「複製到本聊天」按鈕走的就是這條);「提升為全域性」把當前生效值
    快照進全域性後刪本聊天副本、清同名樓層 ops,由全域性接管。
  - **本聊天手動基線**:存 `chatMetadata['baibai_image_char_tags']`,手動編輯/回滾/舊版快照落這裡,
    不隨樓層刪除。
  - **AI 樓層增量**:自動建檔與 changes 寫進目標訊息 `extra['bbiCharChanges']`
    (CharTagFloorDelta: v/swipe/ops;op 分 new/set 兩種),與正文同一 CAS 寫回成功才落盤,
    樓層/swipe 刪除時自然失效(增量帶 swipe 匹配)。
  - `charTagLib` 只是響應式派生快取:合併種子(本聊天優先,全域性補同名空缺,
    mergeCharTagSeed)+ 按樓層物理順序重放增量(deriveCharTags,帶鎖定名過濾);
    `charTagsBeforeFloor(floor)` 取樓層時刻快照;MESSAGE_DELETED/MESSAGE_SWIPED 後重算。
  - 手動編輯/刪除 = 使用者接管:detachFromExistingFloors 清掉該角色在舊樓層裡的同名操作
    (壓進手動基線),之後新樓層仍可繼續被 AI 變更。
  - 建檔與後續維護都歸主請求(changes 的 field="new"/欄位更新),與選圖同屬一次推理;
    外貌按欄位(fandom/sex/hair/eyes/skin/body/extra/outfit)記錄,拼接順序即最終 tag,
    fandom(同人身份 tag,character name (copyright name))拼在首位;舊整串以 raw 相容。
    建檔必須帶 hair 與 eyes(二次元身份錨點),缺任一項該條丟棄。
    同人身份 tag 必須寫進檔案:判定為同人的角色,field:"new" 建檔時寫 fields.fandom;
    已建檔但缺 fandom 的用 field:"fandom" 的 changes 補檔;畫圖時從檔案照抄放首位。
    原創角色不寫 fandom。ComfyUI 側不照抄 fandom(括號轉義規則不同,身份 tag 仍按
    comfy 規範現場判定並轉義)。
    Horae的中文外貌隨角色參考塊發給主請求作依據;角色管理頁另有「按Horae最新外貌
    生成」按鈕(generateCharTags),那是使用者主動點的一次性轉換,不在自動流程裡。
  - AI 引用走**直接照抄**(v0.1.2 起):提示詞要求把庫中欄位值一字不改寫進 tag/nl(庫裡寫
    long black hair 就寫 long black hair),不用 @角色名 佔位符。撤回原因:同一角色被引用
    多次時逐次展開,一張圖裡出現多份完整外貌 + 多個 1boy,模型據此畫出重疊軀幹;且
    「40 tag 以內」的預算無法執行(AI 數 @小雪 是 1 個,展開成 6 個);庫髒資料也會被
    無條件放大。庫文本本就在同一上下文裡,照抄可見文本比憑記憶複述可靠。
    applyCharRefs 系函式保留為兜底:模型偶發寫出 @名字 時仍會被替換,不至於把字面量
    送進生圖。同一角色的固定外貌一張圖裡只寫一遍,再次提到用簡短指代承接。
    名字一致性寫進提示詞:首次建檔的 name = 角色卡/世界書/Horae/正文裡的原名(中文名寫
    中文);已建檔角色的引用(含 nl 裡的名字) = 檔案名,逐字相同,禁止音譯/變體——
    外掛所有錨定與替換都按名字精確匹配,名字不一致即斷鏈。**作用域限定在有檔案(或本次
    建檔)的角色**:這套規則的全部目的是保護逐字匹配,一次性角色不參與任何匹配,不受此約束。
    頁面提供歷史檢視與逐條回滾(建檔記錄回滾 = 刪條目)。
  - **建檔資格 ≠ 入畫資格(0.2.3,僅 4.5/V5 路徑)**:兩者掛**互相正交**的謂詞——
    進不進庫看「有名 + 有設定/持續參與」(規則未變);佔不佔 `characters[]` 看**本圖取景框內
    是否可見**,與檔案無關。故一次性無名角色照常入畫,拿一條**僅本圖有效**的 Character
    Prompt(name = 正文指稱原詞,外貌一次性補全),不建檔、不寫 changes、不進庫。
    起因:實跑中模型把「一次性無名路人不建」讀成「無名者不能入畫」,連續放棄了核心互動
    另一方是無名對手的全部瞬間,改挑能把他裁出鏡頭的景別。根因不是「規範少一種狀態」,
    而是**造名單的謂詞寫錯了**——思維鏈第一層 B 只清點「有名有姓」,那人從未上冊,下游
    規則根本看不見他。修法是統一謂詞(清點「誰在場」)+ 逐人標註三類身份
    (【已建檔】/【本次建檔】/【一次性】),第三種狀態由三條正交定義自然推出,不作為例外授權。
    配套必須同批改,缺一處那人就在某一環被判死刑:第一層 B 名單與身份標註、第二層槽位塊
    (塊名允許正文指稱、**固定外貌槽給【一次性】留合法填法**——舊口徑「照抄庫中/剛建檔的
    欄位」是唯一來源,無名者在這個槽位上無路可走)、第三層自查「二選一 → 三選一」、
    C 段服裝時間線排除【一次性】(否則給一次性對手維護跨圖服裝賬本,反過來誘發建檔)。
    **選圖與描述分開**:任務協議要求優先表現玩家主角和主要角色的表情、狀態、行動及關係,
    主要角色不等於所有已建檔角色,也不要求玩家每張出現。NAI 的 E 段先定主體與核心互動,
    再取景;不損失畫面內容時優先排除無關在場者,必要的無名互動物件或人群照常保留,
    不以有無名字/檔案給候選加減分。B 段清點名單不是入畫名單,槽位與自查按本圖可見
    範圍書寫,不能把鏡頭外的人補進 Base。
    **入畫後的落位才看可數性**:正文當作個體的(對手、店主)給角色塊,當作一團的(人群、
    士兵們)留 Base,拿不準按一團。此規則只管已選入鏡頭的人,不是鼓勵加入路人或人群。
    **禁止為一次性角色編人名**:`name` 雖不發給 NAI(見 §6 characterCaption),卻會隨
    `<characters>` 序列化進正文,而 cleanHistoryText 保留 bbi_image → 下一樓原樣讀回;
    一個假人名與真檔案在回灌文本裡無法區分,會被下一樓誤判為正式角色而建檔。
    同批修掉的還有**人數口徑**:Base 人數 = 取景框內可見人數(不是場景在場人數),不得
    因缺檔裁掉核心互動參與者,但允許排除無關在場者。舊口徑只說「必須與正文一致」,模型於是自創
    「鏡頭外存在合理」的旁註來自我說服。規範示例也一併改掉:舊例 Base 寫 `2girls` 卻只給
    一條 Character Prompt,恰好演示了「另一個人沒有落位」這一反面行為。
    ⚠ 這是純提示詞改動,`prompt.test.ts` 鎖的是**措辭**不是行為,能否真的修好只能實跑驗證。

## 8. 貫穿全專案的約定

- **降級優先**:任何宿主能力取不到(Horae/EJS/checkWorldInfo/渠道)→ 返回 null/空串,不阻斷主流程;
- **冪等**:所有 bind*/inject*/ensure* 可重複呼叫;水合/按鈕注入都靠內部標誌或 DOM 檢查;
- **CAS 寫回**:改正文(messageEdit)、改 extra(storage)都先比對基準再落盤,失敗放棄;
  正文的基準只含**身份**(聊天/訊息/swipe),內容差異由 autoTag/rebase.ts 重定位而非放棄——
  與別的改正文外掛共存的關鍵;
- **abort 貫通**:AbortController 從 runner 一路傳到 fetch/輪詢(comfyui 的 abortableDelay);
- **純函式可測**:解析/協議/引數構造均為純函式,配 `*.test.ts`(vitest,與被測檔案同目錄)。
  改協議/後端引數時跑 `pnpm test` 保底;
- **渠道二選一**:`getTagGenChannel()` 有指派 → 副 API(服務端代理);否則跟隨主 API(generateRaw)。
- **隨機段一律走 `randomUuid()`**(src/randomUuid.ts):ST 常在非安全上下文(http)下執行,
  那裡 `crypto.randomUUID` 直接拋錯;vibe 快取鍵/檔名隨機段只是防撞,不需要密碼學強度。
- **文本轉 base64 一律走 `utf8ToBase64()`**(src/base64.ts):`btoa` 的入參是 latin1 二進位制串,
  碼點 > 255 直接拋 InvalidCharacterError —— 提示詞、角色名全是中文,直接 btoa 會當場炸。
  必須先 `TextEncoder` 編碼成位元組再逐位元組轉(且分塊拼接防棧溢位)。

## 9. 公開介面:開放給第三方外掛(public/)

`globalThis.STBaiBaiImage`(0.2.5 起,`apiVersion: 1`)。對外文件是倉根的 **`PUBLIC_API.md`**
—— 那是寫給第三方作者看的,**改介面必須同批改它**,否則第三方照著舊文件寫出來的程式碼會靜默錯。
形制照抄隔壁柏寶書(`globalThis.STBaiBaiBook`,本外掛自己就是它的消費方):第三方學一套約定即可。

開三件事:`getCharacters()` 讀角色庫、`getBackendStatus()` 問後端就緒、`generate()` 出圖,
外加 `subscribe()` 與 `st-baibai-image:ready` / `:changed` 兩個 window 事件。
**生成的圖不進任何聊天記錄**:不佔樓層、不寫 extra,第三方自己決定顯示在哪
(動機就是這個——柏寶繪自己的圖畫在樓層正文裡,有的外掛想畫在側邊欄/自己的彈窗裡)。

分層:`types.ts` 只有契約 DTO,`api.ts` 是實現層(跨邊界的髒活全在這),`register.ts` 管掛載與事件。

**五條紀律,每條都對應一類真會咬人的問題**:
- **一切出去的資料深複製**(`clonePublic`)。`charTagLib.entries` 是 Vue reactive 陣列,
  原樣遞出去 = 把角色庫的寫許可權一起給了:輕則被下一次 `recomputeCharTags()` 靜默沖掉
  (使用者看見「我改的東西又沒了」),重則 reactive 代理進了對方的響應式系統兩邊互相觸發。
  `capabilities` 是 getter、每次返回新副本;通知也給**每個訂閱者各一份**
  (否則第一個訂閱者改壞 detail,後面的全遭殃,有單測鎖)。
- **後端狀態按白名單出**,不是「整個 status 遞出去再刪敏感欄位」——後者日後往內部結構加欄位時
  會靜默洩漏。`settings.nai.key` 與各後端 url **永不出現在任何公開返回值裡**
  (`api.test.ts` 直接 dump JSON 斷言不含 key/域名/埠)。`history` 同理刻意不給:
  給出去就刪不掉了(刪欄位要升 apiVersion)。
- **錯誤歸一成帶 `code` 的普通 Error**(`toPublicError`)。`NaiError`/`ComfyUIError`/`DOMException`
  的 instanceof 跨 bundle 必然失效(兩份建構函式),第三方只能匹配中文文案。故統一掛
  `aborted / not_configured / invalid_args / rate_limited / backend_error`。
  取消判定看 `name === 'AbortError'` 而非 instanceof:abort 多半由第三方**自己的**
  AbortController 觸發,那個 DOMException 來自它的 realm。
  `rate_limited` 與 `backend_error` 分開是因為處置方式不同(前者該等,後者重來也一樣錯)。
- **圖一律轉 data URL**。ComfyUI 直連返回 blob: URL 要配對 `revokeObjectURL`:第三方忘了就洩漏,
  我們替它 revoke 它的 `<img>` 就變空白。原始 blob 在 `finally` 裡撕掉。
- **不降級、不猜**:ComfyUI 不支援 `characters`(全鏈路不讀該欄位),回報 `charactersApplied: false`
  而**不**把角色拼進 prompt —— 那正是 0.2.3 修掉的重疊軀幹問題。第三方的 `onProgress`
  拋錯只記 console,不連累生成。

**`apiVersion` 與 `pluginVersion` 分開**:前者是公開資料結構的版本(固定 1),後者天天漲。
結構**只增不改不刪** —— 加可選欄位安全,改含義或刪欄位一律升 apiVersion。

**落盤(`save`,預設 `true`)**:外部圖照常進相簿,走 `storage.ts` 的 `saveExternalImage`
→ `user/images/柏宝绘_<角色名>/` + 同名側寫 json(與樓層圖同一套目錄與檔名規則,
相簿據此分組並讀出提示詞)。側寫存的是 **tag 原文**(`serializeImageTag`,含 `<bbi_image>` 殼)
而非展示文本,否則相簿反解析出一團糊在一起的裸 tag。**落盤失敗只 warn 不拋**:圖已經在
`dataUrl` 裡了,因為存不進相簿就讓第三方連圖都拿不到是本末倒置(`path` 返回 null 讓它看得出來)。
⚠ 檔名必須過 `sidecarPathFor` 的正則,否則相簿壓根不去請求側寫——症狀是**圖在、提示詞空白、
且沒有任何報錯**(`storage.test.ts` 把上傳用的真實檔名喂回 `sidecarPathFor` 鎖這條)。

**變更通知**:`register.ts` 只 `watch(() => charTagLib.entries, …, {deep:true})` —— 角色庫是
**響應式派生結果**,一律 watch 它本身,不去逐個訂閱那些**導致**它變的事件(切聊天/刪樓/滑動/
手動改檔/AI 建檔),漏訂一個就是一類靜默不通知。同一批變更用 `queueMicrotask` 攢成一條
(否則一次重算能刷出十幾條一樣的通知,每條都可能引第三方做一次全量重新整理)。

**註冊時機**:必須排在 `hydrateSettings()` 之後(見 §3)。`registerPublicInterface()` 冪等,
API 物件 `Object.freeze`,一個外掛改不動下一個外掛拿到的東西。

## 10. 任務定位索引(改需求先查這裡)

| 想改什麼 | 去哪個檔案 |
|---|---|
| 啟動流程 / 新子系統掛載 | src/index.ts |
| 開放/修改第三方介面 | src/public/(types 契約 + api 實現 + register 掛載)+ **PUBLIC_API.md 必須同批改**;結構只增不改不刪,改含義要升 apiVersion |
| 出圖鏈路中段(閘門 / 後端分派 / 就緒判據) | src/generate.ts(卡片與公開介面共用;**繞過它就繞過了 NAI 閘門**) |
| 設定項(新增欄位/預設值/遷移) | src/state/settings.ts(型別 + defaults + normalize 三處) |
| 設定視窗 UI | src/pages/settings/index.vue |
| 提示詞內建預設(破限/規範/思維鏈/預填充) | src/state/settings.ts 的 `DEFAULT_*` 常量(NAI 那對是 `DEFAULT_NAI_V5_*`) |
| 自動 tag 觸發條件 / 去重 / 重試 | src/autoTag/runner.ts + generationGate.ts(生成門配對) |
| 發給 LLM 的訊息組裝(順序/內容) | src/autoTag/prompt.ts(NAI 一律走 DEFAULT_NAI_V5_SPEC:Base+Character 雙提示) |
| LLM 輸出協議(JSON 形狀/位置 ID/tag 格式) | src/autoTag/protocol.ts |
| 世界書/角色卡/persona 裝配 | src/autoTag/context.ts |
| Horae狀態讀取 | src/autoTag/bookMemory.ts |
| 角色庫 v3(基線+樓層增量/changes ops/@佔位符兜底/歷史回滾) | src/autoTag/charAnchors.ts + src/state/charTags.ts + src/autoTag/runner.ts |
| Vibe 分組 / 搜尋 / 啟用集合判定 | src/backends/vibeGroups.ts(純邏輯)+ NaiPanel.vue(互動) |
| 副 API 請求(代理/SSE/超時/測試) | src/api/client.ts |
| 思考強度(渠道彈窗 + custom 源請求體) | src/state/settings.ts 的 `ApiChannel.reasoningEffort` + api/client.ts 的 `buildRequestBody`(UI 在 settings/index.vue) |
| 跟隨主 API | src/api/client.ts 的 requestViaMainApi |
| ComfyUI 工作流 / 出圖 / 通道回退 | src/backends/comfyui.ts |
| ComfyUI 簡易模式(模板組裝/校驗) | src/backends/comfyTemplates.ts(UI 在 ComfyUIPanel.vue) |
| ComfyUI 模型/LoRA 列表拉取 | src/backends/comfyObjectInfo.ts |
| ComfyUI 工作流庫(多套儲存/切換) | src/state/settings.ts 的 `ComfyWorkflowPreset` + `activeComfyPreset` / `effectiveComfyConn`(UI 在 ComfyUIPanel.vue) |
| 工作流 AI 自動配置(節點定位) | src/backends/comfyWorkflowAssistant.ts(+ 面板按鈕在 ComfyUIPanel.vue) |
| NAI 引數 / vibe / .naiv4vibe / 智繪姬提示詞預設匯入 | src/backends/nai.ts + vibeStore.ts + chatu8Vibe.ts(NaiPanel 提供 UI) |
| NAI 接入點庫(多站地址+金鑰切換) | src/state/settings.ts 的 `NaiEndpoint` + `activeNaiEndpoint` / `effectiveNai`(內建官方條 `nep_official` 只讀,UI 在 NaiPanel.vue「配置」區) |
| NAI 畫師串庫(多套儲存/切換/拼在最前) | src/state/settings.ts 的 `NaiArtistPreset` + `activeNaiArtist`(拼裝在 backends/nai.ts 的 `naiArtistPrompt` / `fullPositivePrompt`,UI 在 NaiPanel.vue) |
| 畫師串庫管理器(搜尋/預覽圖/批次刪除) | src/pages/backend/panels/NaiArtistManager.vue(純邏輯在 backends/naiArtistLib.ts;內建只讀庫在 backends/nai.ts 的 `BUILTIN_NAI_ARTISTS`) |
| 畫師串預覽圖(user/images 上傳/刪除) | src/st/images.ts + imageFile.ts(資料夾常量 `ARTIST_PREVIEW_FOLDER`) |
| 相簿頁(按角色名分組列圖) | src/pages/gallery/index.vue(目錄/檔案列舉在 st/images.ts 的 `listUserImageFolders` / `listUserImages`) |
| 相簿多選刪除 / 分組體積(體積**已暫時停用**,程式碼保留待恢復) | src/pages/gallery/index.vue + src/floor/storage.ts 的 `deleteImageFileOnly`(只刪檔案不碰聊天記錄)+ st/images.ts 的 `probeUserImage`(HEAD 三態返回;現供 404 確認,原亦量體積)+ src/pool.ts / src/bytes.ts |
| 圖被刪後卡片不顯示破圖 | src/floor/missingImages.ts(模組級 reactive 冊,HEAD 確認 404 才落冊)+ Card.vue 的 `liveHistory` / `liveStale` / `@error` |
| 相簿點圖看提示詞 | src/floor/storage.ts 的 `sidecarFileName` / `sidecarPathFor`(存圖時寫側寫)+ gallery/index.vue(當前聊天讀 extra、其餘取側寫;展示口徑 `formatPromptText`) |
| 畫幅方向 / 尺寸解析 | src/backends/size.ts(刻意不依賴 settings) |
| 樓層卡片顯示 / 水合 / 狀態機 | src/floor/hydrate.ts + Card.vue |
| 手動編輯生圖提示詞(卡片 ⋯ 鉛筆) | src/floor/PromptEditor.vue + promptEditor.ts(序列化在 st/imageTagRegex.ts) |
| 「AI 重寫提示詞」(只重寫某一槽位的提示詞,畫的仍是原來那個瞬間) | src/autoTag/runner.ts 的 `requestSlotTag` + src/autoTag/slotPlan.ts;入口在編輯彈窗(PromptEditor.vue + promptEditor.ts);執行態與「關窗不中斷/重開續上」src/floor/tagPlanState.ts |
| 寫 tag 後自動出圖的握手 / 判定 | src/floor/autoGenerate.ts 的 `shouldAutoGenerate`(純函式,Card 無單測) |
| 卡片摺疊(預設摺疊 / 手動摺疊態) | src/floor/collapseState.ts + Card.vue(預設值 = settings.ui.autoCollapseImages) |
| 卡片「生成中」狀態 / 取消 / 併發 | src/floor/genState.ts(執行態)+ genQueue.ts(NAI 閘門與節奏等待) |
| NAI 429 / 重試 / 退避 / 全域性冷卻 | src/backends/naiRateLimit.ts(策略與節奏狀態唯一口徑;genQueue 取槽後等待,nai.ts 包住請求) |
| 圖片放大 / 長按儲存 / 儲存刪除按鈕 | src/floor/Lightbox.vue + lightbox.ts(另存走 download.ts) |
| 卡片版面 / 按鈕尺寸基線 / 卡片主題 | src/floor/card.css + cardStyles.ts(令牌來自 styles/theme.css) |
| 結果儲存 / 檔案命名 / CAS | src/floor/storage.ts + src/st/images.ts(外部圖落盤走同文件的 `saveExternalImage`,與樓層圖共用目錄/檔名/側寫規則) |
| 顯示/提示詞兩側的正則 | src/st/imageTagRegex.ts(提示詞展示全文口徑 `formatPromptText`,卡片與相簿共用) |
| 樓層按鈕 / 頂欄按鈕 / 魔杖入口 | src/floor/actionButton.ts / src/topbar.ts / src/menu.ts |
| 正文寫回(含競態) | src/st/messageEdit.ts |
| 請求歷史(LLM/生圖,記憶體不持久化) | src/state/history.ts(store)+ src/pages/history/index.vue(頁面)+ src/api/client.ts 埋點 |
| 複製到剪貼簿 | src/st/clipboard.ts 的 copyText |
| 主視窗 UI(遮罩/導航/動畫/抽屜) | src/App.vue + state/ui.ts + components/ |
| 主題 | src/styles/theme.css + state/ui.ts 的 THEMES |
| 圖示 | src/components/Icon.vue(新增圖示 + PATHS) |
| 新增頁面 | src/pages/<id>/index.vue + pages/registry.ts 註冊 + Icon.vue 加圖示 |
| 版本號 | package.json(build 自動同步到 manifest.json;更新對比源 = 遠端 GitHub manifest.json 的 version) |
| 更新檢測 / 自動更新 | src/update.ts(紅點/按鈕在 NavBar.vue + settings/index.vue;僅 `isNewer` 有單測) |

## 11. 測試與構建

```bash
pnpm test        # vitest 單測(與原始碼同目錄 *.test.ts)
pnpm typecheck   # vue-tsc
pnpm build       # 產物 dist/(build 前自動 sync manifest 版本)
```

單測重點覆蓋:autoTag 的協議解析/提示片語裝(快照)、backends 的引數構造與工作流渲染、
floor 的儲存結構/自動生成標記/執行態與閘門(genState/genQueue 的 token 認領、剪枝、併發)、
size 歸一化、公開介面(`public/*.test.ts` + `generate.test.ts`:深複製不外洩、
key/url 不出現在返回值裡、錯誤 code 歸一、閘門拋錯也還槽)。UI 層(Vue 元件)無測試。

**vitest 跑的是 node 環境,倉裡沒裝 jsdom**:沒有 `window`、沒有 `document`。要測「瀏覽器裡
才有」的東西就得自己造替身——如 `register.test.ts` 用 `vi.stubGlobal('window', new EventTarget())`
(且必須**在 import 被測模組之前**建好,否則模組拿到的還是那個不存在的 window);
slotHealth 那類 DOM 判據則靠鴨子型別假節點。這也是 Card.vue 等元件邏輯要往純函數裡抽的原因
(`shouldAutoGenerate`、`slotHealth`),留在元件裡就鎖不住。
