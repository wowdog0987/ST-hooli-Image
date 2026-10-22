/**
 * 把已落盤的生圖結果另存到本地。
 *
 * 圖片是**同源真實檔案**(/user/files/bbi_*.png),故 `<a download>` 直接可用,
 * 不必先 fetch 成 blob——省一次全尺寸傳輸,也避開 blob URL 的生命週期管理。
 *
 * 兩個容易踩的點:
 * - `<a>` 必須先掛進 document 再點:部分瀏覽器忽略未入文件節點上的合成點選;
 * - 移動端 Safari 不認 download 屬性,會退化成「新標籤開啟」——此時使用者仍可長按儲存,
 *   屬可接受降級(卡片與燈箱都另有長按儲存路徑,見 Lightbox.vue 頂部註釋)。
 */
export function saveImageFile(src: string, filename?: string): void {
  if (!src) return;
  const link = document.createElement('a');
  link.href = src;
  link.download = filename || src.split('/').pop() || 'hooli-image.png';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function imageDownloadFileName(
  src: string,
  characterName: string,
  generationId: string,
): string {
  const name = characterName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'image';
  const extension = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1] || 'png';
  return `bbi_${name}_${generationId}.${extension}`;
}
