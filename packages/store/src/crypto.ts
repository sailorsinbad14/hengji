import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

/**
 * 本地加密命令的 JS 封装（仅桌面 / Tauri runtime 有效）。
 * 对接 Rust 的 crypto 命令（src-tauri/src/crypto.rs）。DEK 全程只在 Rust 侧，这里只传口令 / 布尔。
 * 失败时 invoke 会 reject —— set/unlock/change/remove 抛 {@link CryptoError}（含三类分流），
 * security_status/lock 抛字符串。
 */

/** 失败分流（与 Rust FailClass 对齐）。UI 据此分屏。 */
export type FailClass = 'WrongPassword' | 'Locked' | 'Corrupt' | 'ChipUnavailable' | 'Internal';

/** 三态状态行判定输入 + 备份新鲜度（4a）。 */
export interface SecurityStatus {
  /** 信封是否存在（已加密；含信封损坏的「已加密但坏」态——此时 scheme 为 null）。 */
  encrypted: boolean;
  /** 封装方案，本期只有 'tpm-pcp'；信封损坏时为 null。 */
  scheme: string | null;
  /** 能否打开安全芯片提供程序（解锁前的健康 ping）。 */
  tpm_available: boolean;
  /** 上次明文备份时间（unix 秒）/ 路径；null = 从未备份。 */
  last_backup_unix: number | null;
  last_backup_path: string | null;
}

/** export_backup 成功回传。 */
export interface BackupInfo {
  path: string;
  unix: number;
  rows: number;
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

/** 弹原生「另存为」对话框选备份保存路径；用户取消返回 null。 */
export const pickBackupPath = (defaultName: string): Promise<string | null> =>
  save({
    title: '导出未加密备份',
    defaultPath: defaultName,
    filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
  });

/** 导出明文备份到 destPath（实际解密+写文件在 Rust 内完成）。 */
export const exportBackup = (destPath: string): Promise<BackupInfo> => invoke('export_backup', { destPath });

/**
 * 用户主动清空全部本地数据（设置里「清空数据」）。加密时须传**正确口令**（Rust 解封验证，错则 reject WrongPassword）；
 * 未加密时 password 省略。删信封+TPM 钥匙+库。之后调用方应重开全新空明文库。
 */
export const wipeData = (password?: string): Promise<void> => invoke('wipe_data', { password: password ?? null });
