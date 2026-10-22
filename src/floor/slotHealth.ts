/**
 * 卡片「還活著嗎」的判據(純函式,便於單測)。
 *
 * 背景:錨點 `<div data-hooli-slot>` 活在樓層的 `.mes_text` **裡面**,而 ST 自己有好幾條
 * 路徑會整體重寫 `.mes_text`,其中相當一部分**不發任何事件**:
 * - `updateMessageBlock`(script.js) `.mes_text.html(...)`,無事件;
 * - `messageEditCancel` / `messageEditDone` 的 `.mes_text.empty()`;
 * - 右滑生成時 `.mes_text.html('...')`;
 * - 第三方外掛(提示詞模板類)在自己的渲染鉤子裡 `container.html(newContent)`。
 * 純事件驅動的水合對這些一律無感:錨點連同 shadow root 一起被刪,卡片就此消失,
 * 而 genState 是模組級的,在途生成照樣跑完——使用者看到的正是「圖在生成,樓層裡沒介面」。
 *
 * 另一類是**沒被刪、但看不見**:`.mes_text.inline_media { display:none }`(style.css)。
 * 只要本樓 `extra.media` 非空且 `extra.inline_image === false`,ST 就給 `.mes_text`
 * 掛上 `inline_media`,把整段正文(連我們的卡片)一起隱藏。原生出圖擴充套件與打標擴充套件
 * 都會寫這個組合。這種情況錨點在、shadowRoot 在,重掛多少次都沒用。
 *
 * 故判據分兩種,處置也不同:
 * - `detached`:錨點脫離文件 → 重新水合本樓(重建錨點關係並重掛卡片);
 * - `hidden-by-host`:錨點在、但祖先被宿主 CSS 隱藏 → 重掛無用,得解除隱藏。
 */

/** 單個已掛載槽位的體檢結論。 */
export type SlotHealth = 'ok' | 'detached' | 'hidden-by-host';

/**
 * 宿主把 `.mes_text` 整段隱藏時掛的 class(style.css 裡 `display:none`)。
 * 只認這一個:使用者自己寫的美化 CSS 千奇百怪,窮舉不了,靠 host 上的 `display` 兜底
 * (見 pinHostDisplay)。
 */
export const HOST_HIDE_CLASS = 'inline_media';

/**
 * 體檢一個錨點。`host` 傳錨點元素本身(即 shadow root 的宿主)。
 *
 * 注意順序:先判 detached。脫離文件的元素 `closest()` 仍能沿著已斷開的子樹往上走、
 * 也可能真找到帶 class 的 `.mes_text`(整段被 ST 換下來的那份),若先判 hidden
 * 就會把「已經被刪掉的樓」誤報成「被隱藏」,於是既不重掛、又去改一個不在文件裡的
 * 節點的 class,卡片永遠回不來。
 */
export function checkSlotHealth(host: Element | null | undefined): SlotHealth {
  if (!host || !host.isConnected) return 'detached';
  const mesText = host.closest('.mes_text');
  if (mesText?.classList.contains(HOST_HIDE_CLASS)) return 'hidden-by-host';
  return 'ok';
}

/**
 * 從錨點找出它所屬的樓層號(`.mes[mesid]`)。找不到返回 null。
 * 自愈只重掛**受影響的那一樓**,不做全量重建——全量重建會對每條訊息跑
 * parseImageTags + readStore + promptHash,放在 rAF 回撥裡就是真卡頓。
 */
export function floorIdOf(host: Element | null | undefined): number | null {
  const mes = host?.closest('.mes');
  const raw = mes?.getAttribute('mesid');
  // 空串/純空白必須先擋掉:Number('') 與 Number(' ') 都是 0,會把「mesid 缺失的
  // .mes 外殼」當成第 0 樓,於是自愈去重水合一個毫不相干的樓層。
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}
