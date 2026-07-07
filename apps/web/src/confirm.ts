import { confirmNative } from '@app/store/dialog';
import { isDesktop } from './db';

/**
 * 外发/破坏性操作确认：桌面走 tauri 原生 `ask()`（`window.confirm` 在 WebView2 是 no-op、会静默放行——
 * 真机实测：AI 认列/语音上云、清除 Key 等在无弹窗下直接执行），浏览器 demo 退回 `window.confirm`。
 * 返回 true=用户确认继续。
 *
 * 注：本包装器目前只覆盖增量4（AI 认列/语音/AI 卡）的确认点；全 app 其余 `window.confirm`
 * （安全清空/移除密码/删交易/取消订单等，含已发布代码）同样受 no-op 影响，留另一分支统一整改。
 */
export const confirmAsk = (message: string): Promise<boolean> =>
  isDesktop ? confirmNative(message) : Promise.resolve(window.confirm(message));
