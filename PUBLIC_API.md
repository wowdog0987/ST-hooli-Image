# 柏寶繪公開介面（API v1）

本文面向 SillyTavern 外掛、指令碼和預設作者。柏寶繪把兩件事開放給外部呼叫：

1. **讀角色庫** —— 拿到柏寶繪已記錄的角色和可直接出圖的 tag
2. **調生圖** —— 讓柏寶繪出一張圖，**圖顯示在哪裡由你決定**

入口只有一個 JavaScript 全域性物件：`globalThis.STBaiBaiImage`。

## 這個介面解決什麼

柏寶繪自己的圖是畫在**樓層正文**裡的（訊息下方的卡片）。有些外掛不想要這種呈現——想畫在側邊欄、畫在自己的彈窗裡、畫完直接當立繪用。這個介面給的就是這個：柏寶繪負責出圖（後端配置、併發閘門、限流退避、落盤歸檔全都複用），你負責顯示。

**生成的圖不會進入任何聊天記錄。** 它不出現在樓層正文裡，不佔樓層卡片，也不寫 `message.extra`。預設只會存進柏寶繪相簿（見 `save`）。

## 相容約定

- `apiVersion` 當前固定為 `1`。它是**公開資料結構**的版本，與外掛自身的 `pluginVersion` 分開——後者天天漲，前者不漲。請按 `apiVersion` 判相容，不要去解析 `pluginVersion` 的語義。
- 結構只增不改不刪：新增可選欄位是安全的；改欄位含義或刪欄位一律會升 `apiVersion`。
- 所有返回值都是**普通可克隆物件**的深複製：不含函式、不含 Vue 響應式代理、不含類例項。你怎麼改返回值都不會影響柏寶繪。
- 樓層編號統一使用 SillyTavern 的零基 `mesid`。
- **錯誤請按 `error.code` 分支判斷**，不要匹配 `message` 文案（中文、會隨版本改），也不要用 `instanceof`（跨外掛 bundle 邊界一律失效）。

## 等待介面就緒

外掛載入順序不固定，兩條路都要寫：

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) {
    callback(globalThis.STBaiBaiImage);
    return;
  }
  window.addEventListener(
    'st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage),
    { once: true },
  );
}
```

就緒後可檢查能力：

```js
const api = globalThis.STBaiBaiImage;

console.log(api.apiVersion);     // 1
console.log(api.pluginVersion);  // 柏寶繪外掛版本
console.log(api.capabilities);
// { globalApi: true, characterLibrary: true, generate: true, saveToGallery: true, events: true }
```

## 讀角色庫

```js
const list = globalThis.STBaiBaiImage.getCharacters();

for (const character of list.characters) {
  console.log(character.name, character.tag);
}
```

返回結構：

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  revision: 7,          // 角色庫每變一次 +1，拿它做快取失效
  floor: null,          // 快照對應的樓層；null = 當前
  characters: [
    {
      name: "阿黛爾",
      // 可直接拿去出圖的完整 tag 串 —— 推薦直接用這個
      tag: "1girl, short silver hair, blue eyes, pale skin, slender, scar on left eyebrow, black coat",
      // 分欄位版本（要自己挑著用時才需要）
      fields: {
        fandom: "",     // 同人身份
        sex: "1girl",
        hair: "short silver hair",
        eyes: "blue eyes",
        skin: "pale skin",
        body: "slender",
        extra: "scar on left eyebrow",  // 標誌特徵
        outfit: "black coat",
      },
      nl: "a girl with short silver hair",  // 自然語言外貌（可空）
      source: "ai",        // 'manual' 使用者手寫 | 'ai' AI 在劇情裡建的檔 | 'book' 從Horae同步
      scope: "chat",       // 'chat' 本聊天檔案 | 'global' 全域性角色庫（跨聊天）
      desc: "銀色短髮",     // 建檔時那句「為什麼長這樣」（多為空串）
    },
  ],
}
```

`tag` 是按固定順序（同人身份→性別→頭髮→眼睛→膚色→體型→標誌特徵→著裝）拼好的，與柏寶繪自己出圖用的串**完全一致**。不建議自己從 `fields` 拼——老條目可能只有整串原文，那條回落邏輯在 `tag` 裡已經處理過了。

### 讀歷史某一樓的角色檔案

角色檔案會隨劇情演進（AI 在某樓給角色換了髮色）。要為**歷史某一樓**出圖，就得用那一樓當時的檔案，否則會把後來的變更也畫進去：

```js
// 第 42 樓**之前**的角色庫快照（不含該樓）
const atFloor = globalThis.STBaiBaiImage.getCharacters({ floor: 42 });
```

## 出圖前先問後端

```js
const status = globalThis.STBaiBaiImage.getBackendStatus();

if (!status.configured) {
  toastr.warning(status.reason);   // reason 是人話，可直接展示給使用者
  return;
}
```

返回結構：

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  backend: "nai",              // 'nai' | 'comfyui'
  configured: true,
  model: "nai-diffusion-4-5-full",  // NAI 是模型名；ComfyUI 是當前工作流預設名
  supportsCharacters: true,    // 當前後端支不支援多角色提示
  reason: "",                  // configured=false 時的原因；已就緒為空串
}
```

> **不含服務地址與 API Key。** 這兩樣永遠不會出現在任何公開返回值裡。

`supportsCharacters` 只看模型，與配沒配齊無關——你可以在使用者還沒填 Key 時就知道該不該準備 `characters`。**ComfyUI 恆為 `false`**。

## 調生圖

```js
const api = globalThis.STBaiBaiImage;

const result = await api.generate({
  prompt: '1girl, silver hair, moonlight, night sky',
  nl: 'a girl standing under the moonlight',
  size: 'portrait',
});

myPanel.querySelector('img').src = result.dataUrl;   // 想顯示在哪就顯示在哪
```

### 請求引數

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `prompt` | `string` | **必填**，正向 danbooru 短 tag。空串拋 `invalid_args` |
| `nl` | `string?` | 自然語言描述 |
| `negative` | `string?` | 本畫面動態負面。**只對 ComfyUI 生效**；NAI 的負面取使用者渠道配置 |
| `characters` | `PublicCharacterPrompt[]?` | 多角色提示，見下 |
| `size` | `'portrait' \| 'landscape'?` | 畫幅方向，預設 `'portrait'`。具體畫素取使用者在渠道頁配的尺寸 |
| `seed` | `number?` | 指定種子（正整數）。省略 = 按使用者設定決定 |
| `save` | `boolean?` | 落盤進柏寶繪相簿，**預設 `true`** |
| `character` | `string?` | 落盤歸到哪個角色名下（相簿分組名）。省略 = 當前聊天的角色名 |

### 返回值

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  dataUrl: "data:image/png;base64,...",   // 可直接 <img src>
  format: "png",
  path: "/user/images/柏宝绘_阿黛爾/bbi_....png",  // 落盤路徑；save=false 或落盤失敗為 null
  seed: 3847562910,       // 本次實際使用的種子；想復現就把它填回 seed
  backend: "nai",
  charactersApplied: true,
}
```

圖是 **data URL** 而不是 blob URL：blob 要配對 `revokeObjectURL`，你忘了就洩漏、我們替你 revoke 又會讓你的 `<img>` 突然變空白。代價是字串比較大，用完別長期留在記憶體裡。

### 關於 `save`

- `true`（預設）：圖存進 `user/images/柏宝绘_<character>/`，並寫一份同名側寫 json 記下提示詞和種子。於是使用者能在**柏寶繪相簿頁**裡按角色分組看到它、連提示詞一起。
- `false`：只返回 `dataUrl`，不碰磁碟。適合「預覽一下就丟」。

落盤**失敗不會拋錯**——圖已經在 `dataUrl` 裡了，不能因為存不進相簿就讓你連圖都拿不到。這種情況 `path` 是 `null`。

### 多角色（NAI 4.5 / V5）

```js
const status = api.getBackendStatus();
const library = api.getCharacters().characters;

const result = await api.generate({
  prompt: '2girls, cafe, afternoon light',
  characters: status.supportsCharacters
    ? library.slice(0, 2).map(c => ({ name: c.name, tag: c.tag, nl: c.nl }))
    : [],
});

if (!result.charactersApplied) {
  console.log('當前後端不支援多角色，這次只用了 prompt');
}
```

`charactersApplied` 明說這次到底用上了沒有。柏寶繪**刻意不降級**把角色拼進 `prompt`——那會畫出多份軀幹重疊的圖。要畫多角色，請先看 `supportsCharacters`。

### 進度與取消

```js
const controller = new AbortController();

const result = await api.generate(
  { prompt: '1girl' },
  {
    signal: controller.signal,
    onProgress: p => {
      // 'queued' 在柏寶繪的 NAI 併發閘門裡排隊
      // 'generating' 請求已發出，後端正在畫
      // 'queued-remote' 在 ComfyUI 服務端佇列裡（p.ahead 為前面還有幾個）
      // 'retrying' 被限流了，正在退避重試（p.attempt / p.max）
      // 'saving' 圖已拿到，正在落盤
      console.log(p.phase, p.ahead, p.attempt, p.max);
    },
  },
);

// 取消：generate 會拋 code='aborted'
controller.abort();
```

`onProgress` 拋錯只會被記進 console，不影響生成。

### 錯誤處理

```js
try {
  await api.generate({ prompt: '1girl' });
} catch (error) {
  switch (error.code) {
    case 'aborted':        break;                        // 你自己取消的
    case 'not_configured': toastr.warning(error.message); break;  // 使用者沒配好後端
    case 'invalid_args':   console.error(error.message);  break;  // 你傳錯了
    case 'rate_limited':   toastr.warning('被限流了，稍後再試'); break;
    case 'backend_error':  toastr.error(error.message);   break;
  }
}
```

`rate_limited` 與 `backend_error` 分開，是因為處置方式不同：前者該等一會兒再來（柏寶繪的自動退避重試已經用盡了），後者是配置/網路問題，立刻重來也是同樣的錯。

### 不要繞過這個介面

柏寶繪內部的 NAI 請求全部走一道**併發閘門 + 全域性節奏**（429 冷卻、相鄰請求最小間隔、指數退避重試）。這個介面把閘門包在裡面了。如果你繞過它直接打 NAI 的 `generate-image`，使用者的賬號會吃一串密集 429——而使用者只會認為是柏寶繪壞了。

## 訂閱角色庫變更

```js
const unsubscribe = globalThis.STBaiBaiImage.subscribe(notice => {
  console.log(notice.type);      // 'ready' | 'changed'
  console.log(notice.revision);  // 與 getCharacters().revision 同源
  console.log(notice.chatId);
  refreshMyCharacterPicker();
});

// 不需要時記得退訂
unsubscribe();
```

切聊天、刪樓、滑動、使用者手動改檔案、AI 在劇情裡建檔——凡是角色庫變了都會通知。同一批變更會攢成一條，不會刷屏。

也可以直接監聽 DOM 事件（內容與 `subscribe` 的回撥引數相同）：

```js
window.addEventListener('st-baibai-image:ready', e => console.log(e.detail));
window.addEventListener('st-baibai-image:changed', e => console.log(e.detail));
```

## 完整示例

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) return callback(globalThis.STBaiBaiImage);
  window.addEventListener('st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage), { once: true });
}

useBaiBaiImage(async api => {
  if (api.apiVersion !== 1) {
    console.warn('柏寶繪介面版本不匹配', api.apiVersion);
    return;
  }

  const status = api.getBackendStatus();
  if (!status.configured) {
    toastr.warning(`柏寶繪未就緒：${status.reason}`);
    return;
  }

  const heroine = api.getCharacters().characters.find(c => c.name === '阿黛爾');
  if (!heroine) return;

  try {
    const result = await api.generate({
      prompt: `${heroine.tag}, cafe, afternoon light`,
      nl: heroine.nl,
      size: 'landscape',
      character: heroine.name,   // 落盤歸到「柏宝绘_阿黛爾」目錄下
    });
    document.querySelector('#my-portrait').src = result.dataUrl;
  } catch (error) {
    if (error.code !== 'aborted') toastr.error(error.message, '出圖失敗');
  }
});
```

## 介面一覽

```ts
interface STBaiBaiImageApi {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  getCharacters(options?: { floor?: number }): PublicCharacterList;
  getBackendStatus(): PublicBackendStatus;
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>;
  subscribe(listener: (notice: PublicChangeNotice) => void): () => void;
}
```

完整型別定義見外掛原始碼 `src/public/types.ts`。
