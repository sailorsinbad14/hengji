import { DatabaseSync } from 'node:sqlite';
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
 * SQLite 实现（Node 端，基于内置 node:sqlite）。
 * 与 InMemoryRepository 遵循同一 Repository 契约；schema 与行映射见 ./schema（与 Tauri 实现共用）。
 * 同步驱动包成 async 接口，与桌面端 tauri-plugin-sql 实现形状一致。
 */
export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;
  private readonly now: Clock;

  constructor(path = ':memory:', opts: { now?: Clock } = {}) {
    this.now = opts.now ?? defaultClock;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- accounts ----
  async addAccount(account: Account): Promise<StoredAccount> {
    if (this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account.id)) {
      throw new Error(`账户已存在：${account.id}`);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, type, parent_id, currency, archived, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(account.id, account.name, account.type, account.parentId, account.currency, account.archived ? 1 : 0, ts, ts);
    return (await this.getAccount(account.id))!;
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ? AND deleted = 0').get(id) as
      | AccountRow
      | undefined;
    return r ? toAccount(r) : null;
  }

  async listAccounts(opts: { includeArchived?: boolean } = {}): Promise<StoredAccount[]> {
    const sql = opts.includeArchived
      ? 'SELECT * FROM accounts WHERE deleted = 0'
      : 'SELECT * FROM accounts WHERE deleted = 0 AND archived = 0';
    const rows = this.db.prepare(sql).all() as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount> {
    const cur = await this.getAccount(id);
    if (!cur) throw new Error(`账户不存在：${id}`);
    const next: StoredAccount = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE accounts SET name=?, type=?, parent_id=?, currency=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.type, next.parentId, next.currency, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getAccount(id))!;
  }

  // ---- transactions ----
  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (this.db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(txn.id)) {
      throw new Error(`交易已存在：${txn.id}`);
    }
    assertBalanced(txn.postings);
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO transactions (id, date, payee, note, tags, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(txn.id, txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, ts);
      this.insertPostings(txn.id, txn.postings);
    });
    return (await this.getTransaction(txn.id))!;
  }

  private insertPostings(txnId: string, postings: Posting[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO postings (id, txn_id, account_id, amount, currency) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of postings) {
      stmt.run(p.id, txnId, p.accountId, p.amount, p.currency);
    }
  }

  async getTransaction(id: string): Promise<StoredTransaction | null> {
    const r = this.db.prepare('SELECT * FROM transactions WHERE id = ? AND deleted = 0').get(id) as
      | TxnRow
      | undefined;
    if (!r) return null;
    const postings = (
      this.db.prepare('SELECT * FROM postings WHERE txn_id = ?').all(id) as unknown as PostingRow[]
    ).map(toPosting);
    return toTxn(r, postings);
  }

  async listTransactions(query: TxnQuery = {}): Promise<StoredTransaction[]> {
    const cond: string[] = ['t.deleted = 0'];
    const params: Array<string | number> = [];
    if (query.from) {
      cond.push('t.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      cond.push('t.date <= ?');
      params.push(query.to);
    }
    if (query.accountId) {
      cond.push('EXISTS (SELECT 1 FROM postings p WHERE p.txn_id = t.id AND p.account_id = ?)');
      params.push(query.accountId);
    }
    const sql = `SELECT t.* FROM transactions t WHERE ${cond.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC`;
    let rows = this.db.prepare(sql).all(...params) as unknown as TxnRow[];
    // tag 在 JS 侧过滤（tags 存为 JSON 文本），避免依赖 SQLite 的 json_each
    if (query.tag) {
      const tag = query.tag;
      rows = rows.filter((r) => (JSON.parse(r.tags) as string[]).includes(tag));
    }
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const postingRows = this.db
      .prepare(`SELECT * FROM postings WHERE txn_id IN (${placeholders})`)
      .all(...ids) as unknown as PostingRow[];
    const byTxn = new Map<string, Posting[]>();
    for (const pr of postingRows) {
      const arr = byTxn.get(pr.txn_id) ?? [];
      arr.push(toPosting(pr));
      byTxn.set(pr.txn_id, arr);
    }
    return rows.map((r) => toTxn(r, byTxn.get(r.id) ?? []));
  }

  async updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction> {
    const existing = this.db.prepare('SELECT * FROM transactions WHERE id = ? AND deleted = 0').get(id) as
      | TxnRow
      | undefined;
    if (!existing) throw new Error(`交易不存在：${id}`);
    assertBalanced(txn.postings);
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(`UPDATE transactions SET date=?, payee=?, note=?, tags=?, updated_at=? WHERE id=?`)
        .run(txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, id);
      this.db.prepare('DELETE FROM postings WHERE txn_id = ?').run(id);
      this.insertPostings(id, txn.postings);
    });
    return (await this.getTransaction(id))!;
  }

  async softDeleteTransaction(id: string): Promise<void> {
    if (!this.db.prepare('SELECT 1 FROM transactions WHERE id = ? AND deleted = 0').get(id)) {
      throw new Error(`交易不存在：${id}`);
    }
    this.db.prepare('UPDATE transactions SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  // ---- budgets ----
  async addBudget(budget: Budget): Promise<StoredBudget> {
    if (this.db.prepare('SELECT 1 FROM budgets WHERE id = ?').get(budget.id)) {
      throw new Error(`预算已存在：${budget.id}`);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO budgets (id, account_id, monthly_limit, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(budget.id, budget.accountId, budget.monthlyLimit, ts, ts);
    return (await this.getBudget(budget.id))!;
  }

  async listBudgets(): Promise<StoredBudget[]> {
    const rows = this.db.prepare('SELECT * FROM budgets WHERE deleted = 0').all() as unknown as BudgetRow[];
    return rows.map(toBudget);
  }

  async updateBudget(id: string, patch: BudgetPatch): Promise<StoredBudget> {
    const cur = await this.getBudget(id);
    if (!cur) throw new Error(`预算不存在：${id}`);
    const next: StoredBudget = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE budgets SET account_id=?, monthly_limit=?, updated_at=? WHERE id=?`)
      .run(next.accountId, next.monthlyLimit, next.updatedAt, id);
    return (await this.getBudget(id))!;
  }

  async removeBudget(id: string): Promise<void> {
    if (!this.db.prepare('SELECT 1 FROM budgets WHERE id = ? AND deleted = 0').get(id)) {
      throw new Error(`预算不存在：${id}`);
    }
    this.db.prepare('UPDATE budgets SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  private async getBudget(id: string): Promise<StoredBudget | null> {
    const r = this.db.prepare('SELECT * FROM budgets WHERE id = ? AND deleted = 0').get(id) as BudgetRow | undefined;
    return r ? toBudget(r) : null;
  }
}
