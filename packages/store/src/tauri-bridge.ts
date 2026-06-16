import { invoke } from '@tauri-apps/api/core';

/**
 * 自写 rusqlite + SQLCipher 桥的 JS adapter（替代 @tauri-apps/plugin-sql 的 Database）。
 * 形状与原 Database 对齐（select/execute/close + 新增 batch），让 TauriSqlRepository 的 SQL 全不动。
 * 经 IPC 调 Rust 的 db_* 命令。占位符 `$N` 仍由 Rust 侧翻成 `?N`。
 */
export class TauriDb {
  /**
   * 打开本地库。`encrypted=true` 时 Rust 用**已解锁的 DEK**（Crypto state，须先 unlock）开 SQLCipher 密文库；
   * DEK 绝不跨 IPC，故这里只传布尔、不传钥匙。`encrypted=false`＝明文库。
   */
  static async open(path: string, encrypted = false): Promise<TauriDb> {
    await invoke('db_open', { path, encrypted });
    return new TauriDb();
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return invoke<T>('db_select', { sql, params });
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await invoke('db_execute', { sql, params });
  }

  /** 多条写在一把事务里（原子）。 */
  async batch(stmts: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    await invoke('db_batch', { stmts: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  }

  async close(): Promise<void> {
    await invoke('db_close');
  }
}
