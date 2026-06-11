import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Transaction } from '@app/core';
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

const defaultClock: Clock = () => new Date().toISOString();

/** 深拷贝，隔离 store 内部状态与调用方（DTO 均为 JSON 安全的纯数据）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * 内存实现：用于测试与浏览器演示。语义与 SQLite/Tauri 实现保持一致：
 * - 写入交易时强制借贷平衡 + 同账本校验（分录账户必须与交易同账本）
 * - 软删除（deleted 标记），读取默认排除
 * - 读写边界深拷贝
 */
export class InMemoryRepository implements Repository {
  private readonly books = new Map<string, StoredBook>();
  private readonly accounts = new Map<string, StoredAccount>();
  private readonly txns = new Map<string, StoredTransaction>();
  private readonly budgets = new Map<string, StoredBudget>();
  private readonly now: Clock;

  constructor(opts: { now?: Clock } = {}) {
    this.now = opts.now ?? defaultClock;
  }

  // ---- books ----
  async addBook(book: Book): Promise<StoredBook> {
    if (this.books.has(book.id)) throw new Error(`账本已存在：${book.id}`);
    const ts = this.now();
    const stored: StoredBook = { ...clone(book), createdAt: ts, updatedAt: ts, deleted: false };
    this.books.set(book.id, stored);
    return clone(stored);
  }

  async getBook(id: string): Promise<StoredBook | null> {
    const b = this.books.get(id);
    return b && !b.deleted ? clone(b) : null;
  }

  async listBooks(opts: { includeArchived?: boolean } = {}): Promise<StoredBook[]> {
    const out: StoredBook[] = [];
    for (const b of this.books.values()) {
      if (b.deleted) continue;
      if (!opts.includeArchived && b.archived) continue;
      out.push(clone(b));
    }
    return out;
  }

  async updateBook(id: string, patch: BookPatch): Promise<StoredBook> {
    const b = this.books.get(id);
    if (!b || b.deleted) throw new Error(`账本不存在：${id}`);
    const updated: StoredBook = { ...b, ...patch, updatedAt: this.now() };
    this.books.set(id, updated);
    return clone(updated);
  }

  // ---- accounts ----
  async addAccount(account: Account): Promise<StoredAccount> {
    if (this.accounts.has(account.id)) {
      throw new Error(`账户已存在：${account.id}`);
    }
    const book = this.books.get(account.bookId);
    if (!book || book.deleted) throw new Error(`账本不存在：${account.bookId}`);
    const ts = this.now();
    const stored: StoredAccount = { ...clone(account), createdAt: ts, updatedAt: ts, deleted: false };
    this.accounts.set(account.id, stored);
    return clone(stored);
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const a = this.accounts.get(id);
    return a && !a.deleted ? clone(a) : null;
  }

  async listAccounts(opts: { includeArchived?: boolean; bookId?: string } = {}): Promise<StoredAccount[]> {
    const out: StoredAccount[] = [];
    for (const a of this.accounts.values()) {
      if (a.deleted) continue;
      if (!opts.includeArchived && a.archived) continue;
      if (opts.bookId && a.bookId !== opts.bookId) continue;
      out.push(clone(a));
    }
    return out;
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount> {
    const a = this.accounts.get(id);
    if (!a || a.deleted) throw new Error(`账户不存在：${id}`);
    const updated: StoredAccount = { ...a, ...patch, updatedAt: this.now() };
    this.accounts.set(id, updated);
    return clone(updated);
  }

  // ---- transactions ----
  private assertSameBook(txn: Transaction): void {
    for (const p of txn.postings) {
      const acc = this.accounts.get(p.accountId);
      if (!acc || acc.deleted) throw new Error(`分录引用的账户不存在：${p.accountId}`);
      if (acc.bookId !== txn.bookId) {
        throw new Error(`禁止跨账本分录：账户 ${acc.name} 属于其他账本`);
      }
    }
  }

  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (this.txns.has(txn.id)) throw new Error(`交易已存在：${txn.id}`);
    assertBalanced(txn.postings);
    this.assertSameBook(txn);
    const ts = this.now();
    const stored: StoredTransaction = { ...clone(txn), createdAt: ts, updatedAt: ts, deleted: false };
    this.txns.set(txn.id, stored);
    return clone(stored);
  }

  async getTransaction(id: string): Promise<StoredTransaction | null> {
    const t = this.txns.get(id);
    return t && !t.deleted ? clone(t) : null;
  }

  async listTransactions(query: TxnQuery = {}): Promise<StoredTransaction[]> {
    const out: StoredTransaction[] = [];
    for (const t of this.txns.values()) {
      if (t.deleted) continue;
      if (query.bookId && t.bookId !== query.bookId) continue;
      if (query.from && t.date < query.from) continue;
      if (query.to && t.date > query.to) continue;
      if (query.tag && !t.tags.includes(query.tag)) continue;
      if (query.accountId && !t.postings.some((p) => p.accountId === query.accountId)) continue;
      out.push(clone(t));
    }
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // 终极 tie-break，三实现一致、稳定
    });
    return out;
  }

  async updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction> {
    const existing = this.txns.get(id);
    if (!existing || existing.deleted) throw new Error(`交易不存在：${id}`);
    if (txn.bookId !== existing.bookId) throw new Error('交易不可移动到其他账本');
    assertBalanced(txn.postings);
    this.assertSameBook(txn);
    const updated: StoredTransaction = {
      ...clone(txn),
      id, // 保持 id 稳定
      createdAt: existing.createdAt,
      updatedAt: this.now(),
      deleted: false,
    };
    this.txns.set(id, updated);
    return clone(updated);
  }

  async softDeleteTransaction(id: string): Promise<void> {
    const t = this.txns.get(id);
    if (!t || t.deleted) throw new Error(`交易不存在：${id}`);
    this.txns.set(id, { ...t, deleted: true, updatedAt: this.now() });
  }

  // ---- budgets ----
  async addBudget(budget: Budget): Promise<StoredBudget> {
    if (this.budgets.has(budget.id)) throw new Error(`预算已存在：${budget.id}`);
    const acc = this.accounts.get(budget.accountId);
    if (!acc || acc.deleted) throw new Error(`预算科目不存在：${budget.accountId}`);
    if (acc.bookId !== budget.bookId) throw new Error('预算科目必须与预算同账本');
    const ts = this.now();
    const stored: StoredBudget = { ...clone(budget), createdAt: ts, updatedAt: ts, deleted: false };
    this.budgets.set(budget.id, stored);
    return clone(stored);
  }

  async listBudgets(query: { bookId?: string } = {}): Promise<StoredBudget[]> {
    const out: StoredBudget[] = [];
    for (const b of this.budgets.values()) {
      if (b.deleted) continue;
      if (query.bookId && b.bookId !== query.bookId) continue;
      out.push(clone(b));
    }
    return out;
  }

  async updateBudget(id: string, patch: BudgetPatch): Promise<StoredBudget> {
    const b = this.budgets.get(id);
    if (!b || b.deleted) throw new Error(`预算不存在：${id}`);
    const updated: StoredBudget = { ...b, ...patch, updatedAt: this.now() };
    this.budgets.set(id, updated);
    return clone(updated);
  }

  async removeBudget(id: string): Promise<void> {
    const b = this.budgets.get(id);
    if (!b || b.deleted) throw new Error(`预算不存在：${id}`);
    this.budgets.set(id, { ...b, deleted: true, updatedAt: this.now() });
  }
}
