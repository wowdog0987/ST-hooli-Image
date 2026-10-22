import { openPanel } from '@/state/ui';

const MENU_ITEM_ID = 'bbi-menu-item';

/**
 * 往 ST 的 #extensionsMenu(魔杖選單)末尾註入"虎哩繪"入口。
 * 選單是懶載入的,用輪詢等它出現;注入一次即可。
 */
export function injectMenuButton() {
  const tryInject = () => {
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) return false;
    if ($(`#${MENU_ITEM_ID}`).length > 0) return true;

    const $item = $(`
      <div class="extension_container interactable" tabindex="0">
        <a id="${MENU_ITEM_ID}" class="list-group-item" href="#" title="虎哩繪">
          <i class="fa-solid fa-palette"></i>
          <span>虎哩繪</span>
        </a>
      </div>
    `);

    $item.on('click', (e: { preventDefault: () => void }) => {
      e.preventDefault();
      openPanel();
      // 點選後收起魔杖選單,貼合原生行為
      $('#extensionsMenu').hide();
    });

    $menu.append($item);
    return true;
  };

  if (tryInject()) return;
  const timer = setInterval(() => {
    if (tryInject()) clearInterval(timer);
  }, 500);
}
