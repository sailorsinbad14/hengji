import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Customer, InventoryMovement, Order, OrderStatus, Product, Reconciliation, Settlement, Transaction } from '@app/core';
import type {
  AccountPatch,
  BookPatch,
  BudgetPatch,
  Clock,
  CustomerPatch,
  OrderPatch,
  ProductPatch,
  Repository,
  StoredAccount,
  StoredBook,
  StoredBudget,
  StoredCustomer,
  StoredInventoryMovement,
  StoredOrder,
  StoredProduct,
  StoredReconciliation,
  StoredSetting,
  StoredSettlement,
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
  private readonly customers = new Map<string, StoredCustomer>();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly settlements = new Map<string, StoredSettlement>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly settings = new Map<string, StoredSetting>();
  private readonly reconciliations = new Map<string, StoredReconciliation>();
  private readonly inventoryMovements = new Map<string, StoredInventoryMovement>();
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

  // ---- 生意：客户 ----
  private liveBook(bookId: string): StoredBook {
    const b = this.books.get(bookId);
    if (!b || b.deleted) throw new Error(`账本不存在：${bookId}`);
    return b;
  }

  async addCustomer(customer: Customer): Promise<StoredCustomer> {
    if (this.customers.has(customer.id)) throw new Error(`客户已存在：${customer.id}`);
    this.liveBook(customer.bookId);
    const ts = this.now();
    const stored: StoredCustomer = { ...clone(customer), createdAt: ts, updatedAt: ts, deleted: false };
    this.customers.set(customer.id, stored);
    return clone(stored);
  }

  async getCustomer(id: string): Promise<StoredCustomer | null> {
    const c = this.customers.get(id);
    return c && !c.deleted ? clone(c) : null;
  }

  async listCustomers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredCustomer[]> {
    const out: StoredCustomer[] = [];
    for (const c of this.customers.values()) {
      if (c.deleted) continue;
      if (!opts.includeArchived && c.archived) continue;
      if (opts.bookId && c.bookId !== opts.bookId) continue;
      out.push(clone(c));
    }
    return out;
  }

  async updateCustomer(id: string, patch: CustomerPatch): Promise<StoredCustomer> {
    const c = this.customers.get(id);
    if (!c || c.deleted) throw new Error(`客户不存在：${id}`);
    const updated: StoredCustomer = { ...c, ...patch, updatedAt: this.now() };
    this.customers.set(id, updated);
    return clone(updated);
  }

  // ---- 生意：订单 ----
  private liveCustomer(id: string): StoredCustomer {
    const c = this.customers.get(id);
    if (!c || c.deleted) throw new Error(`客户不存在：${id}`);
    return c;
  }

  async addOrder(order: Order): Promise<StoredOrder> {
    if (this.orders.has(order.id)) throw new Error(`订单已存在：${order.id}`);
    this.liveBook(order.bookId);
    const cust = this.liveCustomer(order.customerId);
    if (cust.bookId !== order.bookId) throw new Error('订单客户必须与订单同账本');
    const ts = this.now();
    const stored: StoredOrder = { ...clone(order), createdAt: ts, updatedAt: ts, deleted: false };
    this.orders.set(order.id, stored);
    return clone(stored);
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    const o = this.orders.get(id);
    return o && !o.deleted ? clone(o) : null;
  }

  async listOrders(query: { bookId?: string; customerId?: string; status?: OrderStatus } = {}): Promise<StoredOrder[]> {
    const out: StoredOrder[] = [];
    for (const o of this.orders.values()) {
      if (o.deleted) continue;
      if (query.bookId && o.bookId !== query.bookId) continue;
      if (query.customerId && o.customerId !== query.customerId) continue;
      if (query.status && o.status !== query.status) continue;
      out.push(clone(o));
    }
    return sortByDateDesc(out);
  }

  async updateOrder(id: string, patch: OrderPatch): Promise<StoredOrder> {
    const o = this.orders.get(id);
    if (!o || o.deleted) throw new Error(`订单不存在：${id}`);
    const updated: StoredOrder = { ...o, ...patch, updatedAt: this.now() };
    this.orders.set(id, updated);
    return clone(updated);
  }

  // ---- 生意：收款 ----
  async addSettlement(settlement: Settlement): Promise<StoredSettlement> {
    if (this.settlements.has(settlement.id)) throw new Error(`收款已存在：${settlement.id}`);
    this.liveBook(settlement.bookId);
    if (settlement.counterpartyType === 'customer') {
      const cust = this.liveCustomer(settlement.counterpartyId);
      if (cust.bookId !== settlement.bookId) throw new Error('收款客户必须与收款同账本');
    }
    if (settlement.orderId !== null) {
      const o = this.orders.get(settlement.orderId);
      if (!o || o.deleted) throw new Error(`关联订单不存在：${settlement.orderId}`);
      if (o.bookId !== settlement.bookId) throw new Error('关联订单必须与收款同账本');
    }
    const ts = this.now();
    const stored: StoredSettlement = { ...clone(settlement), createdAt: ts, updatedAt: ts, deleted: false };
    this.settlements.set(settlement.id, stored);
    return clone(stored);
  }

  async listSettlements(
    query: { bookId?: string; orderId?: string; counterpartyId?: string } = {},
  ): Promise<StoredSettlement[]> {
    const out: StoredSettlement[] = [];
    for (const s of this.settlements.values()) {
      if (s.deleted) continue;
      if (query.bookId && s.bookId !== query.bookId) continue;
      if (query.orderId && s.orderId !== query.orderId) continue;
      if (query.counterpartyId && s.counterpartyId !== query.counterpartyId) continue;
      out.push(clone(s));
    }
    return sortByDateDesc(out);
  }

  // ---- 生意：商品 ----
  async addProduct(product: Product): Promise<StoredProduct> {
    if (this.products.has(product.id)) throw new Error(`商品已存在：${product.id}`);
    this.liveBook(product.bookId);
    const ts = this.now();
    const stored: StoredProduct = { ...clone(product), createdAt: ts, updatedAt: ts, deleted: false };
    this.products.set(product.id, stored);
    return clone(stored);
  }

  async getProduct(id: string): Promise<StoredProduct | null> {
    const p = this.products.get(id);
    return p && !p.deleted ? clone(p) : null;
  }

  async listProducts(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredProduct[]> {
    const out: StoredProduct[] = [];
    for (const p of this.products.values()) {
      if (p.deleted) continue;
      if (!opts.includeArchived && p.archived) continue;
      if (opts.bookId && p.bookId !== opts.bookId) continue;
      out.push(clone(p));
    }
    return out;
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<StoredProduct> {
    const p = this.products.get(id);
    if (!p || p.deleted) throw new Error(`商品不存在：${id}`);
    const updated: StoredProduct = { ...p, ...patch, updatedAt: this.now() };
    this.products.set(id, updated);
    return clone(updated);
  }

  // ---- 生意：库存出入库 ----
  async addInventoryMovement(m: InventoryMovement): Promise<StoredInventoryMovement> {
    if (this.inventoryMovements.has(m.id)) throw new Error(`库存流水已存在：${m.id}`);
    this.liveBook(m.bookId);
    const prod = this.products.get(m.productId);
    if (!prod || prod.deleted) throw new Error(`商品不存在：${m.productId}`);
    if (prod.bookId !== m.bookId) throw new Error('库存流水的商品必须与流水同账本');
    const ts = this.now();
    const stored: StoredInventoryMovement = { ...clone(m), createdAt: ts, updatedAt: ts, deleted: false };
    this.inventoryMovements.set(m.id, stored);
    return clone(stored);
  }

  async listInventoryMovements(
    query: { bookId?: string; productId?: string; orderId?: string } = {},
  ): Promise<StoredInventoryMovement[]> {
    const out: StoredInventoryMovement[] = [];
    for (const m of this.inventoryMovements.values()) {
      if (m.deleted) continue;
      if (query.bookId && m.bookId !== query.bookId) continue;
      if (query.productId && m.productId !== query.productId) continue;
      if (query.orderId && m.orderId !== query.orderId) continue;
      out.push(clone(m));
    }
    return sortByDateDesc(out);
  }

  // ---- 设置（KV）----
  async getSetting(scope: string, key: string): Promise<StoredSetting | null> {
    const s = this.settings.get(`${scope} ${key}`);
    return s ? clone(s) : null;
  }

  async setSetting(scope: string, key: string, value: string): Promise<StoredSetting> {
    const stored: StoredSetting = { scope, key, value, updatedAt: this.now() };
    this.settings.set(`${scope} ${key}`, stored);
    return clone(stored);
  }

  async listSettings(scope?: string): Promise<StoredSetting[]> {
    const out: StoredSetting[] = [];
    for (const s of this.settings.values()) {
      if (scope !== undefined && s.scope !== scope) continue;
      out.push(clone(s));
    }
    return out;
  }

  // ---- 月度对账 ----
  async setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void> {
    const idSet = new Set(postingIds);
    for (const t of this.txns.values()) {
      if (t.deleted) continue;
      for (const p of t.postings) {
        if (idSet.has(p.id)) p.cleared = cleared;
      }
    }
  }

  async addReconciliation(rec: Reconciliation): Promise<StoredReconciliation> {
    if (this.reconciliations.has(rec.id)) throw new Error(`对账记录已存在：${rec.id}`);
    this.liveBook(rec.bookId);
    const acc = this.accounts.get(rec.accountId);
    if (!acc || acc.deleted) throw new Error(`对账账户不存在：${rec.accountId}`);
    if (acc.bookId !== rec.bookId) throw new Error('对账账户必须与对账同账本');
    const ts = this.now();
    const stored: StoredReconciliation = { ...clone(rec), createdAt: ts, updatedAt: ts, deleted: false };
    this.reconciliations.set(rec.id, stored);
    return clone(stored);
  }

  async listReconciliations(query: { bookId?: string; accountId?: string } = {}): Promise<StoredReconciliation[]> {
    const out: StoredReconciliation[] = [];
    for (const r of this.reconciliations.values()) {
      if (r.deleted) continue;
      if (query.bookId && r.bookId !== query.bookId) continue;
      if (query.accountId && r.accountId !== query.accountId) continue;
      out.push(clone(r));
    }
    // 倒序：最近完成在前（completedAt DESC，再 id DESC tie-break）
    out.sort((a, b) => (a.completedAt !== b.completedAt ? (a.completedAt < b.completedAt ? 1 : -1) : a.id < b.id ? 1 : -1));
    return out;
  }
}

/** 倒序：date DESC，再 createdAt DESC，再 id DESC——与 SQLite 实现一致、稳定。 */
function sortByDateDesc<T extends { date: string; createdAt: string; id: string }>(arr: T[]): T[] {
  return arr.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
