import { ask } from '@tauri-apps/plugin-dialog';

/**
 * 桌面原生确认框（异步，返回 true=用户确认）。
 *
 * 为什么不用 `window.confirm`：Tauri v2 + WebView2 桌面构建里 `window.confirm` 是 no-op
 * ——不弹框、直接返回 `true`，会**静默绕过**「外发前逐次确认」等确认闸（真机实测：AI 认列/语音
 * 上云在无弹窗下直接完成）。`tauri-plugin-dialog` 的 `ask()` 走原生对话框、真弹真等。
 *
 * 仅桌面可用（浏览器无 `__TAURI__`）——调用方须先 `isDesktop` 门控，浏览器分支退回 `window.confirm`。
 */
export const confirmNative = (message: string): Promise<boolean> =>
  ask(message, { title: '衡记', kind: 'warning', okLabel: '确定', cancelLabel: '取消' });
