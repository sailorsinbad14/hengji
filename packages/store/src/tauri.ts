import Database from '@tauri-apps/plugin-sql';
import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Posting, Transaction } from '@app/core';
import type {
  AccountPatch,
  BookPatch,
  BudgetPatch,
  Clock,
  Repository,
  StoredAccount,
  StoredBook,
  StoredBudget,
  StoredTransaction,
  TxnQuery,
} from './types';
import { chunk, parseTags, toAccount, toBook, toBudget, toPosting, toTxn } from './schema';
import type { AccountRow, BookRow, BudgetRow, PostingRow, TxnRow } from './schema';
import { migrate } from './migrations';

const defaultClock: Clock = () => new Date().toISOString();

/**
 * Tauri 桌面实现：经 tauri-plugin-sql（sqlx）访问本地 SQLite 文件。
 * schema 由 ./migrations 版本化管理（load 时自动迁移，含遗留库回填默认账本）；
 * 行映射与 SqliteRepository 共用，占位符用 sqlx 的 $1..$N。
 * 只能在 Tauri runtime 内运行（走 IPC 到 Rust），行为契约由
 * SqliteRepository 的共享契约测试背书（同一 SQL 形状）。
 */
export class TauriSqlRepository implements Repository {
  private constructor(
    private readonly db: Database,
    private readonly now: Clock,
  ) {}

  /** 打开（或创建）本地 SQLite、自动迁移 schema。path 形如 'sqlite:heng.db'，相对应用配置目录。 */
  static async load(path = 'sqlite:heng.db', opts: { now?: Clock } = {}): Promise<TauriSqlRepository> {
    const db = await Database.load(path);
    // PRAGMA journal_mode 会返回一行结果，必须走 select
    await db.select('PRAGMA journal_mode = WAL');
    await db.select('PRAGMA foreign_keys = ON');
    await db.select('PRAGMA busy_timeout = 5000');
    await migrate({
      run: async (sql) => {
        await db.execute(sql);
      },
      getVersion: async () => {
        const rows = await db.select<Array<{ user_version: number }>>('PRAGMA user_version');
        return rows[0]?.user_version ?? 0;
      },
      setVersion: async (v) => {
        await db.execute(`PRAGMA user_version = ${v}`);
      },
    });
    return new TauriSqlRepository(db, opts.now ?? defaultClock);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // 注：tauri-plugin-sql 底层是 sqlx 连接池（多连接）。裸 BEGIN/COMMIT 会被池分发到
  // 不同连接，导致开 BEGIN 的连接留下未提交写事务、锁死整库（SQLITE_BUSY: database is
  // locked）。因此多写操作改为顺序 autocommit——单用户桌面串行写，不会自锁。
  // 已知限制：一笔交易的多条写非原子；进程在两条写之间崩溃的极端情况下可能留下不完整交易。
  // 后续若 plugin 支持单连接事务、或迁移到自管 Rust SQL 层，再恢复跨语句原子性。

  private async exists(sql: string, params: unknown[]): Promise<boolean> {
    const rows = await this.db.select<unknown[]>(sql, params);
    return rows.length > 0;
  }

  // ---- books ----
  async addBook(book: Book): Promise<StoredBook> {
    if (await this.exists('SELECT 1 FROM books WHERE id = $1', [book.id])) {
      throw new Error(`账本已存在：${book.id}`);
    }
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO books (id, name, type, archived, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [book.id, book.name, book.type, book.archived ? 1 : 0, ts, ts],
    );
    return (await this.getBook(book.id))!;
  }

  async getBook(id: string): Promise<StoredBook | null> {
    const rows = await this.db.select<BookRow[]>('SELECT * FROM books WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toBook(rows[0]) : null;
  }

  async listBooks(opts: { includeArchived?: boolean } = {}): Promise<StoredBook[]> {
    const sql = opts.includeArchived
      ? 'SELECT * FROM books WHERE deleted = 0'
      : 'SELECT * FROM books WHERE deleted = 0 AND archived = 0';
    const rows = await this.db.select<BookRow[]>(sql);
    return rows.map(toBook);
  }

  async updateBook(id: string, patch: BookPatch): Promise<StoredBook> {
    const cur = await this.getBook(id);
    if (!cur) throw new Error(`账本不存在：${id}`);
    const next: StoredBook = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute('UPDATE books SET name=$1, archived=$2, updated_at=$3 WHERE id=$4', [
      next.name,
      next.archived ? 1 : 0,
      next.updatedAt,
      id,
    ]);
    return (await this.getBook(id))!;
  }

  // ---- accounts ----
  async addAccount(account: Account): Promise<StoredAccount> {
    if (await this.exists('SELECT 1 FROM accounts WHERE id = $1', [account.id])) {
      throw new Error(`账户已存在：${account.id}`);
    }
    if (!(await this.exists('SELECT 1 FROM books WHERE id = $1 AND deleted = 0', [account.bookId]))) {
      throw new Error(`账本不存在：${account.bookId}`);
    }
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO accounts (id, book_id, name, type, parent_id, currency, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
      [
        account.id,
        account.bookId,
        account.name,
        account.type,
        account.parentId,
        account.currency,
        account.archived ? 1 : 0,
        ts,
        ts,
      ],
    );
    return (await this.getAccount(account.id))!;
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const rows = await this.db.select<AccountRow[]>('SELECT * FROM accounts WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async listAccounts(opts: { includeArchived?: boolean; bookId?: string } = {}): Promise<StoredAccount[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      params.push(opts.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<AccountRow[]>(`SELECT * FROM accounts WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toAccount);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount> {
    const cur = await this.getAccount(id);
    if (!cur) throw new Error(`账户不存在：${id}`);
    const next: StoredAccount = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE accounts SET name=$1, type=$2, parent_id=$3, currency=$4, archived=$5, updated_at=$6 WHERE id=$7',
      [next.name, next.type, next.parentId, next.currency, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getAccount(id))!;
  }

  // ---- transactions ----
  private async assertSameBook(txn: Transaction): Promise<void> {
    const ids = [...new Set(txn.postings.map((p) => p.accountId))];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this.db.select<Array<{ id: string; book_id: string }>>(
      `SELECT id, book_id FROM accounts WHERE id IN (${placeholders}) AND deleted = 0`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r.book_id] as const));
    for (const id of ids) {
      const bookId = byId.get(id);
      if (bookId === undefined) throw new Error(`分录引用的账户不存在：${id}`);
      if (bookId !== txn.bookId) throw new Error(`禁止跨账本分录：账户 ${id} 属于其他账本`);
    }
  }

  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (await this.exists('SELECT 1 FROM transactions WHERE id = $1', [txn.id])) {
      throw new Error(`交易已存在：${txn.id}`);
    }
    assertBalanced(txn.postings);
    await this.assertSameBook(txn);
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO transactions (id, book_id, date, payee, note, tags, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
      [txn.id, txn.bookId, txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, ts],
    );
    await this.insertPostings(txn.id, txn.postings);
    return (await this.getTransaction(txn.id))!;
  }

  private async insertPostings(txnId: string, postings: Posting[]): Promise<void> {
    for (const p of postings) {
      await this.db.execute(
        'INSERT INTO postings (id, txn_id, account_id, amount, currency) VALUES ($1, $2, $3, $4, $5)',
        [p.id, txnId, p.accountId, p.amount, p.currency],
      );
    }
  }

  async getTransaction(id: string): Promise<StoredTransaction | null> {
    const rows = await this.db.select<TxnRow[]>('SELECT * FROM transactions WHERE id = $1 AND deleted = 0', [id]);
    const head = rows[0];
    if (!head) return null;
    const postings = await this.db.select<PostingRow[]>('SELECT * FROM postings WHERE txn_id = $1', [id]);
    return toTxn(head, postings.map(toPosting));
  }

  async listTransactions(query: TxnQuery = {}): Promise<StoredTransaction[]> {
    const cond: string[] = ['t.deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`t.book_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      cond.push(`t.date >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      cond.push(`t.date <= $${params.length}`);
    }
    if (query.accountId) {
      params.push(query.accountId);
      cond.push(`EXISTS (SELECT 1 FROM postings p WHERE p.txn_id = t.id AND p.account_id = $${params.length})`);
    }
    const sql = `SELECT t.* FROM transactions t WHERE ${cond.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC, t.id DESC`;
    let rows = await this.db.select<TxnRow[]>(sql, params);
    if (query.tag) {
      const tag = query.tag;
      rows = rows.filter((r) => parseTags(r.tags).includes(tag));
    }
    if (rows.length === 0) return [];
    const byTxn = new Map<string, Posting[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map((_, i) => `$${i + 1}`).join(', ');
      const postingRows = await this.db.select<PostingRow[]>(
        `SELECT * FROM postings WHERE txn_id IN (${placeholders})`,
        batch,
      );
      for (const pr of postingRows) {
        const arr = byTxn.get(pr.txn_id) ?? [];
        arr.push(toPosting(pr));
        byTxn.set(pr.txn_id, arr);
      }
    }
    return rows.map((r) => toTxn(r, byTxn.get(r.id) ?? []));
  }

  async updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction> {
    const rows = await this.db.select<TxnRow[]>('SELECT * FROM transactions WHERE id = $1 AND deleted = 0', [id]);
    const existing = rows[0];
    if (!existing) throw new Error(`交易不存在：${id}`);
    if (txn.bookId !== existing.book_id) throw new Error('交易不可移动到其他账本');
    assertBalanced(txn.postings);
    await this.assertSameBook(txn);
    const ts = this.now();
    await this.db.execute('UPDATE transactions SET date=$1, payee=$2, note=$3, tags=$4, updated_at=$5 WHERE id=$6', [
      txn.date,
      txn.payee,
      txn.note,
      JSON.stringify(txn.tags),
      ts,
      id,
    ]);
    await this.db.execute('DELETE FROM postings WHERE txn_id = $1', [id]);
    await this.insertPostings(id, txn.postings);
    return (await this.getTransaction(id))!;
  }

  async softDeleteTransaction(id: string): Promise<void> {
    if (!(await this.exists('SELECT 1 FROM transactions WHERE id = $1 AND deleted = 0', [id]))) {
      throw new Error(`交易不存在：${id}`);
    }
    await this.db.execute('UPDATE transactions SET deleted = 1, updated_at = $1 WHERE id = $2', [this.now(), id]);
  }

  // ---- budgets ----
  async addBudget(budget: Budget): Promise<StoredBudget> {
    if (await this.exists('SELECT 1 FROM budgets WHERE id = $1', [budget.id])) {
      throw new Error(`预算已存在：${budget.id}`);
    }
    const acc = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM accounts WHERE id = $1 AND deleted = 0',
      [budget.accountId],
    );
    if (!acc[0]) throw new Error(`预算科目不存在：${budget.accountId}`);
    if (acc[0].book_id !== budget.bookId) throw new Error('预算科目必须与预算同账本');
    const ts = this.now();
    await this.db.execute(
      'INSERT INTO budgets (id, book_id, account_id, monthly_limit, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, $6, 0)',
      [budget.id, budget.bookId, budget.accountId, budget.monthlyLimit, ts, ts],
    );
    return (await this.getBudget(budget.id))!;
  }

  async listBudgets(query: { bookId?: string } = {}): Promise<StoredBudget[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<BudgetRow[]>(`SELECT * FROM budgets WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toBudget);
  }

  async updateBudget(id: string, patch: BudgetPatch): Promise<StoredBudget> {
    const cur = await this.getBudget(id);
    if (!cur) throw new Error(`预算不存在：${id}`);
    const next: StoredBudget = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute('UPDATE budgets SET account_id=$1, monthly_limit=$2, updated_at=$3 WHERE id=$4', [
      next.accountId,
      next.monthlyLimit,
      next.updatedAt,
      id,
    ]);
    return (await this.getBudget(id))!;
  }

  async removeBudget(id: string): Promise<void> {
    if (!(await this.exists('SELECT 1 FROM budgets WHERE id = $1 AND deleted = 0', [id]))) {
      throw new Error(`预算不存在：${id}`);
    }
    await this.db.execute('UPDATE budgets SET deleted = 1, updated_at = $1 WHERE id = $2', [this.now(), id]);
  }

  private async getBudget(id: string): Promise<StoredBudget | null> {
    const rows = await this.db.select<BudgetRow[]>('SELECT * FROM budgets WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toBudget(rows[0]) : null;
  }
}
