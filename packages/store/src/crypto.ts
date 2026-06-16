import { invoke } from '@tauri-apps/api/core';

/**
 * 本地加密命令的 JS 封装（仅桌面 / Tauri runtime 有效）。
 * 对接 Rust 的 crypto 命令（src-tauri/src/crypto.rs）。DEK 全程只在 Rust 侧，这里只传口令 / 布尔。
 * 失败时 invoke 会 reject —— set/unlock/change/remove 抛 {@link CryptoError}（含三类分流），
 * security_status/lock 抛字符串。
 */

/** 失败分流（与 Rust FailClass 对齐）。UI 据此分屏。 */
export type FailClass = 'WrongPassword' | 'Corrupt' | 'ChipUnavailable' | 'Internal';

/** 三态状态行判定输入。 */
export interface SecurityStatus {
  /** 信封是否存在（已加密；含信封损坏的「已加密但坏」态——此时 scheme 为 null）。 */
  encrypted: boolean;
  /** 封装方案，本期只有 'tpm-pcp'；信封损坏时为 null。 */
  scheme: string | null;
  /** 能否打开安全芯片提供程序（解锁前的健康 ping）。 */
  tpm_available: boolean;
}

/** 跨 IPC 的加密错误：粗分类 + 原始 HRESULT（供细化）+ 文案。 */
export interface CryptoError {
  class: FailClass;
  code: number;
  message: string;
}

/** 是否长得像 CryptoError（invoke reject 出来的是普通对象，需窄化）。 */
export function isCryptoError(e: unknown): e is CryptoError {
  return typeof e === 'object' && e !== null && 'class' in e && 'message' in e;
}

export const securityStatus = (): Promise<SecurityStatus> => invoke('security_status');
export const setPassword = (password: string): Promise<void> => invoke('set_password', { password });
export const unlock = (password: string): Promise<void> => invoke('unlock', { password });
export const changePassword = (oldPassword: string, newPassword: string): Promise<void> =>
  invoke('change_password', { oldPassword, newPassword });
export const removePassword = (password: string): Promise<void> => invoke('remove_password', { password });
export const lock = (): Promise<void> => invoke('lock');
