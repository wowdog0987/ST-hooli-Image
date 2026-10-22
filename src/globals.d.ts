declare global {
  // ST 在全域性掛載了這些依賴,這裡只宣告外掛實際使用到的最小型別。
  const $: any;
  const _: any;
  const toastr: any;
  const __BBI_VERSION__: string;
}

export {};
