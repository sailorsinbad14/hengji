/**
 * schema 版本化迁移（浏览器安全，无驱动依赖）。
 * 版本号存 SQLite 的 PRAGMA user_version：v0=空库或遗留库，每跑完一版 +1。
 * - m1：v0.1 基线（accounts/transactions/postings/budgets）。对已有遗留库全部
 *   CREATE IF NOT EXISTS，幂等跳过。
 * - m2：多账本（books 表 + 全表 book_id 列）；遗留数据自动回填到固定 id 'default'
 *   的「我的账本」（personal）。空库不产生账本（由应用首启创建）。
 * - m3：生意 B 期（customers/orders/order_lines/settlements）；纯新增表，不动既有数据。
 * - m4：商品主数据 C1（products 表 + order_lines.product_id 列）；纯新增。
 * - m5：去掉 settlements.method 列（收款账户即渠道，方式冗余）。
 * - m6：通用设置表 settings（scope+key 主键，value 字符串）；app/账本级共用，纯新增。
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

// m3：生意系统 B 期（customers / orders / order_lines / settlements）。纯新增表，
// 不触碰既有数据；个人/投资账本不产生这些表的行。
const M3: string[] = [
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    due_days INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    revenue_txn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS order_lines (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    name TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    counterparty_type TEXT NOT NULL,
    counterparty_id TEXT NOT NULL,
    order_id TEXT,
    amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    method TEXT NOT NULL,
    account_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    txn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_customers_book ON customers(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_settlements_book ON settlements(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_settlements_order ON settlements(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_settlements_counterparty ON settlements(counterparty_id)`,
];

// m4：商品主数据 C1 期（products 表 + order_lines.product_id 列）。纯新增，order_lines
// 既有行 product_id 默认 NULL（= 自由文本行）。
const M4: string[] = [
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cost_price INTEGER NOT NULL DEFAULT 0,
    sale_price INTEGER NOT NULL DEFAULT 0,
    is_stock INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `ALTER TABLE order_lines ADD COLUMN product_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_products_book ON products(book_id)`,
];

// m5：去掉 settlements.method 列——收款账户(account_id)即渠道，"方式"字段冗余。
// 需 SQLite 3.35+（Node 24 内置 / sqlx 均满足）；method 无索引/约束，DROP 安全。
const M5: string[] = [`ALTER TABLE settlements DROP COLUMN method`];

// m6：通用设置表（KV）。scope='app' 或账本 id；(scope,key) 主键即 upsert 依据。
// 无软删除——设置是覆盖语义，删除即清空 value 或删行。纯新增表。
const M6: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  )`,
];

export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [M1, M2, M3, M4, M5, M6];

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
