/**
 * 不依賴 Web Crypto 的 UUID v4:ST 常在非安全上下文(http)下執行,
 * 那裡 crypto.randomUUID 會直接拋錯,而 vibe 快取鍵/檔名的隨機段
 * 只是防撞,不需要密碼學強度——Math.random 足夠。
 */
export function randomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
