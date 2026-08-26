import { bitable } from '@lark-base-open/js-sdk';

export type ToastType = 'success' | 'warning' | 'error' | 'info';

/**
 * 统一 toast：SDK 的 ShowToastOptions 字段是 `message`（见 ShowToastOptions 类型）。
 * 统一封装 + try/catch，避免提示被静默吞掉。
 */
export function toast(message: string, toastType: ToastType = 'info'): void {
  try {
    bitable.ui.showToast({ message, toastType: toastType as any });
  } catch (e) {
    // toast 失败不应影响主流程，仅记录
    console.error('[toast] 调用失败:', e);
  }
}
