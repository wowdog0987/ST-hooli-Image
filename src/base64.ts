/**
 * base64 編碼的公共實現。
 *
 * 為什麼必須走 TextEncoder 而不是 `btoa(text)`:btoa 的入參是 latin1 二進位制串,
 * 碼點 > 255 直接拋 InvalidCharacterError —— 提示詞、角色名裡全是中文,
 * 直接 btoa 會在存圖時炸掉。先 UTF-8 編碼成位元組、再逐位元組轉 latin1 才是安全路徑。
 *
 * 分塊拼接是為了防棧溢位:String.fromCharCode(...bytes) 一次性展開幾 MB 的陣列
 * 會超出引數個數上限。
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
