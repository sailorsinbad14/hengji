/**
 * schema 版本化迁移（浏览器安全，无驱动依赖）。
 * 版本号存 SQLite 的 PRAGMA user_version：v0=空库或遗留库，每跑完一版 +1。
 * - m1：v0.1 基线（accounts/transactions/postings/budgets）。对已有遗留库全部
 *   CREATE IF NOT EXISTS，幂等跳过。
 * - m2：多账本（books 表 + 全表 book_id 列）；遗留数据自动回填到固定 id 'default'
 *   的「我的账本」（personal）。空库不产生账本（由应用首启创建）。
 */

export interface SqlRunner {
  run(sql: string): Promise<void>;
  getVersion(): Promise<number>;
  setVersion(v: number): Promise<void>;
}

const M1: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    currency TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    payee TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS postings (
    id TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    FOREIGN KEY (txn_id) REFERENCES transactions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_postings_txn ON postings(txn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`,
  `CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    monthly_limit INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
];

const M2: string[] = [
  `CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `ALTER TABLE accounts ADD COLUMN book_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE transactions ADD COLUMN book_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE budgets ADD COLUMN book_id TEXT NOT NULL DEFAULT ''`,
  // 遗留数据回填：只要有任何待回填数据（账户/交易/预算任一非空）就建默认账本，
  // 与下方三条 UPDATE 的回填判据保持一致，避免「有交易/预算但无账户」的边界库
  // 把数据回填到一个不存在的 'default' 账本（悬空 book_id）。
  `INSERT INTO books (id, name, type, archived, created_at, updated_at, deleted)
     SELECT 'default', '我的账本', 'personal', 0, datetime('now'), datetime('now'), 0
     WHERE (EXISTS (SELECT 1 FROM accounts)
            OR EXISTS (SELECT 1 FROM transactions)
            OR EXISTS (SELECT 1 FROM budgets))
       AND NOT EXISTS (SELECT 1 FROM books WHERE id = 'default')`,
  `UPDATE accounts SET book_id = 'default' WHERE book_id = ''`,
  `UPDATE transactions SET book_id = 'default' WHERE book_id = ''`,
  `UPDATE budgets SET book_id = 'default' WHERE book_id = ''`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_book ON accounts(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_book ON transactions(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_budgets_book ON budgets(book_id)`,
];

export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [M1, M2];

export async function migrate(r: SqlRunner): Promise<void> {
  const v = await r.getVersion();
  for (let i = v; i < MIGRATIONS.length; i++) {
    await r.run('BEGIN');
    try {
      for (const stmt of MIGRATIONS[i]!) await r.run(stmt);
      await r.setVersion(i + 1);
      await r.run('COMMIT');
    } catch (e) {
      await r.run('ROLLBACK');
      throw e;
    }
  }
}

export interface SyncSqlRunner {
  run(sql: string): void;
  getVersion(): number;
  setVersion(v: number): void;
}

/** 同步驱动（node:sqlite）专用：构造函数内即可完成迁移，避免 async 微任务时序问题。 */
export function migrateSync(r: SyncSqlRunner): void {
  const v = r.getVersion();
  for (let i = v; i < MIGRATIONS.length; i++) {
    r.run('BEGIN');
    try {
      for (const stmt of MIGRATIONS[i]!) r.run(stmt);
      r.setVersion(i + 1);
      r.run('COMMIT');
    } catch (e) {
      r.run('ROLLBACK');
      throw e;
    }
  }
}
