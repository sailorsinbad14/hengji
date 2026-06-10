import Database from '@tauri-apps/plugin-sql';
import { assertBalanced } from '@app/core';
import type { Account, Budget, Posting, Transaction } from '@app/core';
import type {
  AccountPatch,
  BudgetPatch,
  Clock,
  Repository,
  StoredAccount,
  StoredBudget,
  StoredTransaction,
  TxnQuery,
} from './types';
import { SCHEMA, toAccount, toBudget, toPosting, toTxn } from './schema';
import type { AccountRow, BudgetRow, PostingRow, TxnRow } from './schema';

const defaultClock: Clock = () => new Date().toISOString();

/**
 * Tauri 桌面实现：经 tauri-plugin-sql（sqlx）访问本地 SQLite 文件。
 * 与 SqliteRepository 共用 schema 与行映射（./schema），占位符用 sqlx 的 $1..$N。
 * 只能在 Tauri runtime 内运行（走 IPC 到 Rust），因此无 Node 单测——
 * 行为契约由 SqliteRepository 的共享契约测试背书（同一 SQL 形状）。
 */
export class TauriSqlRepository implements Repository {
  private constructor(
    private readonly db: Database,
    private readonly now: Clock,
  ) {}

  /** 打开（或创建）本地 SQLite 并确保 schema。path 形如 'sqlite:heng.db'，相对应用配置目录。 */
  static async load(path = 'sqlite:heng.db', opts: { now?: Clock } = {}): Promise<TauriSqlRepository> {
    const db = await Database.load(path);
    // PRAGMA journal_mode 会返回一行结果，必须走 select；foreign_keys 同样用 select 以保持一致
    await db.select('PRAGMA journal_mode = WAL');
    await db.select('PRAGMA foreign_keys = ON');
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(stmt);
    }
    return new TauriSqlRepository(db, opts.now ?? defaultClock);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async tx(fn: () => Promise<void>): Promise<void> {
    await this.db.execute('BEGIN');
    try {
      await fn();
      await this.db.execute('COMMIT');
    } catch (e) {
      await this.db.execute('ROLLBACK');
      throw e;
    }
  }

  private async exists(sql: string, params: unknown[]): Promise<boolean> {
    const rows = await this.db.select<unknown[]>(sql, params);
    return rows.length > 0;
  }

  // ---- accounts ----
  async addAccount(account: Account): Promise<StoredAccount> {
    if (await this.exists('SELECT 1 FROM accounts WHERE id = $1', [account.id])) {
      throw new Error(`账户已存在：${account.id}`);
    }
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO accounts (id, name, type, parent_id, currency, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
      [account.id, account.name, account.type, account.parentId, account.currency, account.archived ? 1 : 0, ts, ts],
    );
    return (await this.getAccount(account.id))!;
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const rows = await this.db.select<AccountRow[]>('SELECT * FROM accounts WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async listAccounts(opts: { includeArchived?: boolean } = {}): Promise<StoredAccount[]> {
    const sql = opts.includeArchived
      ? 'SELECT * FROM accounts WHERE deleted = 0'
      : 'SELECT * FROM accounts WHERE deleted = 0 AND archived = 0';
    const rows = await this.db.select<AccountRow[]>(sql);
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
  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (await this.exists('SELECT 1 FROM transactions WHERE id = $1', [txn.id])) {
      throw new Error(`交易已存在：${txn.id}`);
    }
    assertBalanced(txn.postings);
    const ts = this.now();
    await this.tx(async () => {
      await this.db.execute(
        `INSERT INTO transactions (id, date, payee, note, tags, created_at, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
        [txn.id, txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, ts],
      );
      await this.insertPostings(txn.id, txn.postings);
    });
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
    const sql = `SELECT t.* FROM transactions t WHERE ${cond.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC`;
    let rows = await this.db.select<TxnRow[]>(sql, params);
    if (query.tag) {
      const tag = query.tag;
      rows = rows.filter((r) => (JSON.parse(r.tags) as string[]).includes(tag));
    }
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const postingRows = await this.db.select<PostingRow[]>(
      `SELECT * FROM postings WHERE txn_id IN (${placeholders})`,
      ids,
    );
    const byTxn = new Map<string, Posting[]>();
    for (const pr of postingRows) {
      const arr = byTxn.get(pr.txn_id) ?? [];
      arr.push(toPosting(pr));
      byTxn.set(pr.txn_id, arr);
    }
    return rows.map((r) => toTxn(r, byTxn.get(r.id) ?? []));
  }

  async updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction> {
    if (!(await this.exists('SELECT 1 FROM transactions WHERE id = $1 AND deleted = 0', [id]))) {
      throw new Error(`交易不存在：${id}`);
    }
    assertBalanced(txn.postings);
    const ts = this.now();
    await this.tx(async () => {
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
    });
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
    const ts = this.now();
    await this.db.execute(
      'INSERT INTO budgets (id, account_id, monthly_limit, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, 0)',
      [budget.id, budget.accountId, budget.monthlyLimit, ts, ts],
    );
    return (await this.getBudget(budget.id))!;
  }

  async listBudgets(): Promise<StoredBudget[]> {
    const rows = await this.db.select<BudgetRow[]>('SELECT * FROM budgets WHERE deleted = 0');
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
