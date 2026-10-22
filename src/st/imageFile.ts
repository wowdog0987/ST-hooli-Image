/**
 * 圖片檔案的讀取與縮放(DOM 側小工具,與網路層 st/images.ts 分開)。
 *
 * NaiPanel 的 vibe 縮圖與畫師串預覽圖共用:canvas 重繪成 jpeg,
 * 既壓體積也把 png/webp/gif 統一成靜態 jpeg(gif 動圖會丟掉動效,預覽圖不在意)。
 */

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('讀取圖片失敗'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = src;
  });
}

/** 把 dataURL 圖片縮到最長邊 maxEdge 以內,重編碼為 jpeg dataURL。 */
export async function makeJpegThumbnail(
  dataUrl: string,
  maxEdge: number,
  quality = 0.8,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
