/**
 * 限併發的 map。相簿按批發 HEAD 探體積、批次刪圖時都要用:
 * 一個角色目錄幾十張圖,`Promise.all` 一把梭會把幾十個請求同時壓給 ST,
 * 公網連線下先把自己的聊天卡住。
 */

/**
 * 併發不超過 limit 地對映,**返回順序與輸入一致**(不是完成順序)。
 *
 * `fn` 丟擲會讓整體 reject(標準 Promise.all 語義),但已啟動的其餘任務不會被叫停——
 * 故批次刪除這類「要容忍單條失敗」的場景,請在 `fn` 內部自行 try/catch 並返回結果物件,
 * 不要依賴本函式做部分失敗處理。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (!items.length) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  // 每個 worker 自取下一個未領的下標:比切片分組更均衡(慢任務不會拖住整片)
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
