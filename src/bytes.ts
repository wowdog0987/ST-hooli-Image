/**
 * 位元組數 → 人讀體積。相簿的分組體積與總計共用這一個口徑。
 *
 * 用 1024 進位制、單位寫 KB/MB(而非 KiB/MiB):與資源管理器/Finder 的顯示習慣一致,
 * 使用者拿相簿數字和系統裡看到的對比時不會差一截。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * 格式化為 `624 KB` / `1.5 MB` / `11 MB` 這樣的短串。
 *
 * 小數位按量級給:不足 10 的留一位(1.5 MB 比 2 MB 有資訊量),10 以上抹掉
 * (11.2 MB 的那個 .2 在角標裡只是噪聲)。位元組本身不給小數。
 *
 * 非有限值/負數返回空串,讓呼叫方自己決定顯示什麼——這裡憑空編個 `0 B`
 * 會把「還沒算出來」偽裝成「算出來是空的」。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
