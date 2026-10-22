import { getContext } from '@/st/context';

/**
 * ST 檔案儲存（user/files）的上傳/刪除封裝。
 *
 * 不依賴 ST 內部 uploadFileAttachment（chats.js:274 未暴露給第三方擴充套件，
 * 且失敗時吞錯返回 undefined 並彈 toastr）——這裡用完全等價的
 * POST /api/files/upload 自實現，可拿到狀態碼與響應體，錯誤由呼叫方呈現。
 */

export class FileStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FileStoreError';
  }
}

async function postFile(endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new FileStoreError('SillyTavern 上下文不可用');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/** 上傳 base64 檔案，返回可訪問的相對路徑（/user/files/...）。失敗拋錯。 */
export async function uploadBase64File(name: string, base64: string): Promise<string> {
  const { ok, status, text } = await postFile('/api/files/upload', { name, data: base64 });
  if (!ok) {
    throw new FileStoreError(`檔案上傳失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`, status);
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* 響應不是 JSON，落到下方統一報錯 */
  }
  if (!path) throw new FileStoreError('檔案上傳失敗：服務端未返回路徑');
  return path;
}

/** 上傳圖片。 */
export function uploadImageFile(name: string, base64: string): Promise<string> {
  return uploadBase64File(name, base64);
}

/** 刪除已上傳檔案。返回 false 表示檔案本就不存在（無需清理）。 */
export async function deleteUploadedFile(path: string): Promise<boolean> {
  const { ok, status, text } = await postFile('/api/files/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new FileStoreError(`檔案刪除失敗 (${status})${text ? `：${text.slice(0, 300)}` : ''}`, status);
}

/** 刪除已上傳圖片。 */
export function deleteImageFile(path: string): Promise<boolean> {
  return deleteUploadedFile(path);
}
