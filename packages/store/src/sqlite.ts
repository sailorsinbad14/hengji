import { DatabaseSync } from 'node:sqlite';
import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Customer, FeeDefinition, InventoryMovement, Order, OrderStatus, PluginDocument, Posting, Product, Purchase, Reconciliation, Settlement, StagingBatch, StagingBatchStatus, StagingRow, StagingRowStatus, Supplier, Transaction } from '@app/core';
import type {
  AccountPatch,
  BookPatch,
  BudgetPatch,
  Clock,
  CustomerPatch,
  FeeDefinitionPatch,
  OrderPatch,
  ProductPatch,
  PurchasePatch,
  Repository,
  StagingBatchPatch,
  StagingRowPatch,
  StoredAccount,
  StoredBook,
  StoredBudget,
  StoredCustomer,
  StoredFeeDefinition,
  StoredInventoryMovement,
  StoredOrder,
  StoredPluginDocument,
  StoredProduct,
  StoredPurchase,
  StoredReconciliation,
  StoredSetting,
  StoredSettlement,
  StoredStagingBatch,
  StoredStagingRow,
  StoredSupplier,
  StoredTransaction,
  SupplierPatch,
  TxnQuery,
} from './types';
import {
  chunk,
  parseTags,
  toAccount,
  toBook,
  toBudget,
  toCustomer,
  toFeeDefinition,
  toInventoryMovement,
  toOrder,
  toOrderLine,
  toPluginDocument,
  toPosting,
  toProduct,
  toPurchase,
  toPurchaseLine,
  toReconciliation,
  toSetting,
  toSettlement,
  toStagingBatch,
  toStagingRow,
  toSupplier,
  toTxn,
} from './schema';
import type {
  AccountRow,
  BookRow,
  BudgetRow,
  CustomerRow,
  FeeDefinitionRow,
  InventoryMovementRow,
  OrderLineRow,
  OrderRow,
  PluginDocumentRow,
  PostingRow,
  ProductRow,
  PurchaseLineRow,
  PurchaseRow,
  ReconciliationRow,
  SettingRow,
  SettlementRow,
  StagingBatchRow,
  StagingRowRow,
  SupplierRow,
  TxnRow,
} from './schema';
import { migrateSync } from './migrations';

const defaultClock: Clock = () => new Date().toISOString();

/**
 * SQLite 实现（Node 端，基于内置 node:sqlite）。
 * schema 由 ./migrations 版本化管理（构造时自动迁移，含遗留库回填默认账本）。
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
    migrateSync({
      run: (sql) => {
        this.db.exec(sql);
      },
      getVersion: () => (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      setVersion: (v) => {
        this.db.exec(`PRAGMA user_version = ${v}`);
      },
    });
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

  // ---- books ----
  async addBook(book: Book): Promise<StoredBook> {
    if (this.db.prepare('SELECT 1 FROM books WHERE id = ?').get(book.id)) {
      throw new Error(`账本已存在：${book.id}`);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO books (id, name, type, archived, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(book.id, book.name, book.type, book.archived ? 1 : 0, ts, ts);
    return (await this.getBook(book.id))!;
  }

  async getBook(id: string): Promise<StoredBook | null> {
    const r = this.db.prepare('SELECT * FROM books WHERE id = ? AND deleted = 0').get(id) as BookRow | undefined;
    return r ? toBook(r) : null;
  }

  async listBooks(opts: { includeArchived?: boolean } = {}): Promise<StoredBook[]> {
    const sql = opts.includeArchived
      ? 'SELECT * FROM books WHERE deleted = 0'
      : 'SELECT * FROM books WHERE deleted = 0 AND archived = 0';
    const rows = this.db.prepare(sql).all() as unknown as BookRow[];
    return rows.map(toBook);
  }

  async updateBook(id: string, patch: BookPatch): Promise<StoredBook> {
    const cur = await this.getBook(id);
    if (!cur) throw new Error(`账本不存在：${id}`);
    const next: StoredBook = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE books SET name=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getBook(id))!;
  }

  // ---- accounts ----
  async addAccount(account: Account): Promise<StoredAccount> {
    if (this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account.id)) {
      throw new Error(`账户已存在：${account.id}`);
    }
    if (!this.db.prepare('SELECT 1 FROM books WHERE id = ? AND deleted = 0').get(account.bookId)) {
      throw new Error(`账本不存在：${account.bookId}`);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, book_id, name, type, parent_id, currency, global, archived, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        account.id,
        account.bookId,
        account.name,
        account.type,
        account.parentId,
        account.currency,
        account.global ? 1 : 0,
        account.archived ? 1 : 0,
        ts,
        ts,
      );
    return (await this.getAccount(account.id))!;
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ? AND deleted = 0').get(id) as
      | AccountRow
      | undefined;
    return r ? toAccount(r) : null;
  }

  async listAccounts(opts: { includeArchived?: boolean; bookId?: string } = {}): Promise<StoredAccount[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      // 全局账户对所有账本可见；其余仅本账本
      cond.push('(global = 1 OR book_id = ?)');
      params.push(opts.bookId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM accounts WHERE ${cond.join(' AND ')}`)
      .all(...params) as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount> {
    const cur = await this.getAccount(id);
    if (!cur) throw new Error(`账户不存在：${id}`);
    const next: StoredAccount = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE accounts SET name=?, type=?, parent_id=?, currency=?, global=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.type, next.parentId, next.currency, next.global ? 1 : 0, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getAccount(id))!;
  }

  // ---- transactions ----
  private assertSameBook(txn: Transaction): void {
    const ids = [...new Set(txn.postings.map((p) => p.accountId))];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id, book_id, global FROM accounts WHERE id IN (${placeholders}) AND deleted = 0`)
      .all(...ids) as unknown as Array<{ id: string; book_id: string; global: number }>;
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) throw new Error(`分录引用的账户不存在：${id}`);
      // 全局账户可被任何账本的交易引用；账本账户必须与交易同账本
      if (row.global === 0 && row.book_id !== txn.bookId) throw new Error(`禁止跨账本分录：账户 ${id} 属于其他账本`);
    }
  }

  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (this.db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(txn.id)) {
      throw new Error(`交易已存在：${txn.id}`);
    }
    assertBalanced(txn.postings);
    this.assertSameBook(txn);
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO transactions (id, book_id, date, payee, note, tags, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(txn.id, txn.bookId, txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, ts);
      this.insertPostings(txn.id, txn.postings);
    });
    return (await this.getTransaction(txn.id))!;
  }

  private insertPostings(txnId: string, postings: Posting[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO postings (id, txn_id, account_id, amount, currency, cleared) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const p of postings) {
      stmt.run(p.id, txnId, p.accountId, p.amount, p.currency, p.cleared ? 1 : 0);
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
    if (query.bookId) {
      cond.push('t.book_id = ?');
      params.push(query.bookId);
    }
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
    const sql = `SELECT t.* FROM transactions t WHERE ${cond.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC, t.id DESC`;
    let rows = this.db.prepare(sql).all(...params) as unknown as TxnRow[];
    if (query.tag) {
      const tag = query.tag;
      rows = rows.filter((r) => parseTags(r.tags).includes(tag));
    }
    if (rows.length === 0) return [];
    const byTxn = new Map<string, Posting[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map(() => '?').join(', ');
      const postingRows = this.db
        .prepare(`SELECT * FROM postings WHERE txn_id IN (${placeholders})`)
        .all(...batch) as unknown as PostingRow[];
      for (const pr of postingRows) {
        const arr = byTxn.get(pr.txn_id) ?? [];
        arr.push(toPosting(pr));
        byTxn.set(pr.txn_id, arr);
      }
    }
    return rows.map((r) => toTxn(r, byTxn.get(r.id) ?? []));
  }

  async updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction> {
    const existing = this.db.prepare('SELECT * FROM transactions WHERE id = ? AND deleted = 0').get(id) as
      | TxnRow
      | undefined;
    if (!existing) throw new Error(`交易不存在：${id}`);
    if (txn.bookId !== existing.book_id) throw new Error('交易不可移动到其他账本');
    assertBalanced(txn.postings);
    this.assertSameBook(txn);
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
    const acc = this.db
      .prepare('SELECT book_id FROM accounts WHERE id = ? AND deleted = 0')
      .get(budget.accountId) as { book_id: string } | undefined;
    if (!acc) throw new Error(`预算科目不存在：${budget.accountId}`);
    if (acc.book_id !== budget.bookId) throw new Error('预算科目必须与预算同账本');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO budgets (id, book_id, account_id, monthly_limit, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(budget.id, budget.bookId, budget.accountId, budget.monthlyLimit, ts, ts);
    return (await this.getBudget(budget.id))!;
  }

  async listBudgets(query: { bookId?: string } = {}): Promise<StoredBudget[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM budgets WHERE ${cond.join(' AND ')}`)
      .all(...params) as unknown as BudgetRow[];
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

  // ---- 生意：客户 ----
  private assertBook(bookId: string): void {
    if (!this.db.prepare('SELECT 1 FROM books WHERE id = ? AND deleted = 0').get(bookId)) {
      throw new Error(`账本不存在：${bookId}`);
    }
  }

  async addCustomer(customer: Customer): Promise<StoredCustomer> {
    if (this.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customer.id)) {
      throw new Error(`客户已存在：${customer.id}`);
    }
    this.assertBook(customer.bookId);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO customers (id, book_id, name, phone, note, due_days, archived, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        customer.id,
        customer.bookId,
        customer.name,
        customer.phone,
        customer.note,
        customer.dueDays,
        customer.archived ? 1 : 0,
        ts,
        ts,
      );
    return (await this.getCustomer(customer.id))!;
  }

  async getCustomer(id: string): Promise<StoredCustomer | null> {
    const r = this.db.prepare('SELECT * FROM customers WHERE id = ? AND deleted = 0').get(id) as
      | CustomerRow
      | undefined;
    return r ? toCustomer(r) : null;
  }

  async listCustomers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredCustomer[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      cond.push('book_id = ?');
      params.push(opts.bookId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM customers WHERE ${cond.join(' AND ')}`)
      .all(...params) as unknown as CustomerRow[];
    return rows.map(toCustomer);
  }

  async updateCustomer(id: string, patch: CustomerPatch): Promise<StoredCustomer> {
    const cur = await this.getCustomer(id);
    if (!cur) throw new Error(`客户不存在：${id}`);
    const next: StoredCustomer = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE customers SET name=?, phone=?, note=?, due_days=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.phone, next.note, next.dueDays, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getCustomer(id))!;
  }

  // ---- 生意：供应商（C2 应付）----
  async addSupplier(supplier: Supplier): Promise<StoredSupplier> {
    if (this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplier.id)) {
      throw new Error(`供应商已存在：${supplier.id}`);
    }
    this.assertBook(supplier.bookId);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO suppliers (id, book_id, name, phone, note, due_days, archived, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(supplier.id, supplier.bookId, supplier.name, supplier.phone, supplier.note, supplier.dueDays, supplier.archived ? 1 : 0, ts, ts);
    return (await this.getSupplier(supplier.id))!;
  }

  async getSupplier(id: string): Promise<StoredSupplier | null> {
    const r = this.db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted = 0').get(id) as SupplierRow | undefined;
    return r ? toSupplier(r) : null;
  }

  async listSuppliers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredSupplier[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      cond.push('book_id = ?');
      params.push(opts.bookId);
    }
    const rows = this.db.prepare(`SELECT * FROM suppliers WHERE ${cond.join(' AND ')}`).all(...params) as unknown as SupplierRow[];
    return rows.map(toSupplier);
  }

  async updateSupplier(id: string, patch: SupplierPatch): Promise<StoredSupplier> {
    const cur = await this.getSupplier(id);
    if (!cur) throw new Error(`供应商不存在：${id}`);
    const next: StoredSupplier = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE suppliers SET name=?, phone=?, note=?, due_days=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.phone, next.note, next.dueDays, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getSupplier(id))!;
  }

  // ---- 生意：订单 ----
  private customerBookId(id: string): string {
    const r = this.db.prepare('SELECT book_id FROM customers WHERE id = ? AND deleted = 0').get(id) as
      | { book_id: string }
      | undefined;
    if (!r) throw new Error(`客户不存在：${id}`);
    return r.book_id;
  }

  private supplierBookId(id: string): string {
    const r = this.db.prepare('SELECT book_id FROM suppliers WHERE id = ? AND deleted = 0').get(id) as
      | { book_id: string }
      | undefined;
    if (!r) throw new Error(`供应商不存在：${id}`);
    return r.book_id;
  }

  private insertOrderLines(orderId: string, lines: Order['lines']): void {
    const stmt = this.db.prepare(
      `INSERT INTO order_lines (id, order_id, name, qty, unit_price, product_id, fee_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) stmt.run(l.id, orderId, l.name, l.qty, l.unitPrice, l.productId, JSON.stringify(l.feeIds ?? []));
  }

  async addOrder(order: Order): Promise<StoredOrder> {
    if (this.db.prepare('SELECT 1 FROM orders WHERE id = ?').get(order.id)) {
      throw new Error(`订单已存在：${order.id}`);
    }
    this.assertBook(order.bookId);
    if (this.customerBookId(order.customerId) !== order.bookId) throw new Error('订单客户必须与订单同账本');
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO orders (id, book_id, customer_id, date, currency, status, note, revenue_txn_id, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(order.id, order.bookId, order.customerId, order.date, order.currency, order.status, order.note, order.revenueTxnId, ts, ts);
      this.insertOrderLines(order.id, order.lines);
    });
    return (await this.getOrder(order.id))!;
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ? AND deleted = 0').get(id) as OrderRow | undefined;
    if (!r) return null;
    const lines = (
      this.db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY rowid').all(id) as unknown as OrderLineRow[]
    ).map(toOrderLine);
    return toOrder(r, lines);
  }

  async listOrders(query: { bookId?: string; customerId?: string; status?: OrderStatus } = {}): Promise<StoredOrder[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.customerId) {
      cond.push('customer_id = ?');
      params.push(query.customerId);
    }
    if (query.status) {
      cond.push('status = ?');
      params.push(query.status);
    }
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`)
      .all(...params) as unknown as OrderRow[];
    if (rows.length === 0) return [];
    const byOrder = new Map<string, OrderLineRow[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map(() => '?').join(', ');
      const lineRows = this.db
        .prepare(`SELECT * FROM order_lines WHERE order_id IN (${placeholders}) ORDER BY rowid`)
        .all(...batch) as unknown as OrderLineRow[];
      for (const lr of lineRows) {
        const arr = byOrder.get(lr.order_id) ?? [];
        arr.push(lr);
        byOrder.set(lr.order_id, arr);
      }
    }
    return rows.map((r) => toOrder(r, (byOrder.get(r.id) ?? []).map(toOrderLine)));
  }

  async updateOrder(id: string, patch: OrderPatch): Promise<StoredOrder> {
    const cur = await this.getOrder(id);
    if (!cur) throw new Error(`订单不存在：${id}`);
    const next: StoredOrder = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE orders SET status=?, note=?, revenue_txn_id=?, updated_at=? WHERE id=?`)
      .run(next.status, next.note, next.revenueTxnId, next.updatedAt, id);
    return (await this.getOrder(id))!;
  }

  // ---- 生意：收款 ----
  async addSettlement(settlement: Settlement): Promise<StoredSettlement> {
    if (this.db.prepare('SELECT 1 FROM settlements WHERE id = ?').get(settlement.id)) {
      throw new Error(`收款已存在：${settlement.id}`);
    }
    this.assertBook(settlement.bookId);
    if (settlement.counterpartyType === 'customer') {
      if (this.customerBookId(settlement.counterpartyId) !== settlement.bookId) {
        throw new Error('收款客户必须与收款同账本');
      }
    } else if (settlement.counterpartyType === 'supplier') {
      if (this.supplierBookId(settlement.counterpartyId) !== settlement.bookId) {
        throw new Error('付款供应商必须与付款同账本');
      }
    }
    if (settlement.orderId !== null) {
      const o = this.db.prepare('SELECT book_id FROM orders WHERE id = ? AND deleted = 0').get(settlement.orderId) as
        | { book_id: string }
        | undefined;
      if (!o) throw new Error(`关联订单不存在：${settlement.orderId}`);
      if (o.book_id !== settlement.bookId) throw new Error('关联订单必须与收款同账本');
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO settlements (id, book_id, direction, counterparty_type, counterparty_id, order_id, amount, date, account_id, note, txn_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        settlement.id,
        settlement.bookId,
        settlement.direction,
        settlement.counterpartyType,
        settlement.counterpartyId,
        settlement.orderId,
        settlement.amount,
        settlement.date,
        settlement.accountId,
        settlement.note,
        settlement.txnId,
        ts,
        ts,
      );
    return (await this.getSettlement(settlement.id))!;
  }

  private async getSettlement(id: string): Promise<StoredSettlement | null> {
    const r = this.db.prepare('SELECT * FROM settlements WHERE id = ? AND deleted = 0').get(id) as
      | SettlementRow
      | undefined;
    return r ? toSettlement(r) : null;
  }

  async listSettlements(
    query: { bookId?: string; orderId?: string; counterpartyId?: string } = {},
  ): Promise<StoredSettlement[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.orderId) {
      cond.push('order_id = ?');
      params.push(query.orderId);
    }
    if (query.counterpartyId) {
      cond.push('counterparty_id = ?');
      params.push(query.counterpartyId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM settlements WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`)
      .all(...params) as unknown as SettlementRow[];
    return rows.map(toSettlement);
  }

  // ---- 生意：商品 ----
  async addProduct(product: Product): Promise<StoredProduct> {
    if (this.db.prepare('SELECT 1 FROM products WHERE id = ?').get(product.id)) {
      throw new Error(`商品已存在：${product.id}`);
    }
    this.assertBook(product.bookId);
    const ts = this.now();
    // is_stock/dropship 为死列（C2 模型重构后不读），靠 DEFAULT 0 兜底，INSERT 不再写入。
    this.db
      .prepare(
        `INSERT INTO products (id, book_id, name, cost_price, sale_price, quote_only, unit, archived, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        product.id,
        product.bookId,
        product.name,
        product.costPrice,
        product.salePrice,
        product.quoteOnly ? 1 : 0,
        product.unit,
        product.archived ? 1 : 0,
        ts,
        ts,
      );
    return (await this.getProduct(product.id))!;
  }

  async getProduct(id: string): Promise<StoredProduct | null> {
    const r = this.db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id) as ProductRow | undefined;
    return r ? toProduct(r) : null;
  }

  async listProducts(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredProduct[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      cond.push('book_id = ?');
      params.push(opts.bookId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM products WHERE ${cond.join(' AND ')}`)
      .all(...params) as unknown as ProductRow[];
    return rows.map(toProduct);
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<StoredProduct> {
    const cur = await this.getProduct(id);
    if (!cur) throw new Error(`商品不存在：${id}`);
    const next: StoredProduct = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE products SET name=?, cost_price=?, sale_price=?, quote_only=?, unit=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.costPrice, next.salePrice, next.quoteOnly ? 1 : 0, next.unit, next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getProduct(id))!;
  }

  // ---- 生意：额外费用定义（C2 Step 4）----
  async addFeeDefinition(fee: FeeDefinition): Promise<StoredFeeDefinition> {
    if (this.db.prepare('SELECT 1 FROM fee_definitions WHERE id = ?').get(fee.id)) throw new Error(`费用定义已存在：${fee.id}`);
    this.assertBook(fee.bookId);
    const ts = this.now();
    this.db
      .prepare(`INSERT INTO fee_definitions (id, book_id, name, calc_type, tiers, archived, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(fee.id, fee.bookId, fee.name, fee.calcType, JSON.stringify(fee.tiers), fee.archived ? 1 : 0, ts, ts);
    return (await this.getFeeDefinition(fee.id))!;
  }

  private async getFeeDefinition(id: string): Promise<StoredFeeDefinition | null> {
    const r = this.db.prepare('SELECT * FROM fee_definitions WHERE id = ? AND deleted = 0').get(id) as FeeDefinitionRow | undefined;
    return r ? toFeeDefinition(r) : null;
  }

  async listFeeDefinitions(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredFeeDefinition[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      cond.push('book_id = ?');
      params.push(opts.bookId);
    }
    const rows = this.db.prepare(`SELECT * FROM fee_definitions WHERE ${cond.join(' AND ')}`).all(...params) as unknown as FeeDefinitionRow[];
    return rows.map(toFeeDefinition);
  }

  async updateFeeDefinition(id: string, patch: FeeDefinitionPatch): Promise<StoredFeeDefinition> {
    const cur = await this.getFeeDefinition(id);
    if (!cur) throw new Error(`费用定义不存在：${id}`);
    const next: StoredFeeDefinition = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE fee_definitions SET name=?, calc_type=?, tiers=?, archived=?, updated_at=? WHERE id=?`)
      .run(next.name, next.calcType, JSON.stringify(next.tiers), next.archived ? 1 : 0, next.updatedAt, id);
    return (await this.getFeeDefinition(id))!;
  }

  // ---- 插件单据实例（插件地基 Step 1）----
  async addPluginDocument(doc: PluginDocument): Promise<StoredPluginDocument> {
    if (this.db.prepare('SELECT 1 FROM plugin_documents WHERE id = ?').get(doc.id)) throw new Error(`插件单据已存在：${doc.id}`);
    this.assertBook(doc.bookId);
    const ts = this.now();
    this.db
      .prepare(`INSERT INTO plugin_documents (id, book_id, plugin_id, doc_type, data, txn_ids, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(doc.id, doc.bookId, doc.pluginId, doc.docType, JSON.stringify(doc.data), JSON.stringify(doc.txnIds), ts, ts);
    return (await this.getPluginDocument(doc.id))!;
  }

  async getPluginDocument(id: string): Promise<StoredPluginDocument | null> {
    const r = this.db.prepare('SELECT * FROM plugin_documents WHERE id = ? AND deleted = 0').get(id) as PluginDocumentRow | undefined;
    return r ? toPluginDocument(r) : null;
  }

  async listPluginDocuments(query: { bookId?: string; pluginId?: string; docType?: string } = {}): Promise<StoredPluginDocument[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.pluginId) {
      cond.push('plugin_id = ?');
      params.push(query.pluginId);
    }
    if (query.docType) {
      cond.push('doc_type = ?');
      params.push(query.docType);
    }
    const rows = this.db.prepare(`SELECT * FROM plugin_documents WHERE ${cond.join(' AND ')}`).all(...params) as unknown as PluginDocumentRow[];
    return rows.map(toPluginDocument);
  }

  async removePluginDocument(id: string): Promise<void> {
    const cur = await this.getPluginDocument(id);
    if (!cur) throw new Error(`插件单据不存在：${id}`);
    this.db.prepare('UPDATE plugin_documents SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  // ---- 导入复核台脊梁（账单导入 增量1·②）----
  private assertStagingBatch(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM staging_batches WHERE id = ? AND deleted = 0').get(id)) {
      throw new Error(`导入批次不存在：${id}`);
    }
  }

  private async getStagingBatch(id: string): Promise<StoredStagingBatch | null> {
    const r = this.db.prepare('SELECT * FROM staging_batches WHERE id = ? AND deleted = 0').get(id) as StagingBatchRow | undefined;
    return r ? toStagingBatch(r) : null;
  }

  private async getStagingRow(id: string): Promise<StoredStagingRow | null> {
    const r = this.db.prepare('SELECT * FROM staging_rows WHERE id = ? AND deleted = 0').get(id) as StagingRowRow | undefined;
    return r ? toStagingRow(r) : null;
  }

  async addStagingBatch(batch: StagingBatch): Promise<StoredStagingBatch> {
    if (this.db.prepare('SELECT 1 FROM staging_batches WHERE id = ?').get(batch.id)) throw new Error(`导入批次已存在：${batch.id}`);
    const ts = this.now();
    this.db
      .prepare(`INSERT INTO staging_batches (id, source, account_id, label, status, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(batch.id, batch.source, batch.accountId, batch.label, batch.status, ts, ts);
    return (await this.getStagingBatch(batch.id))!;
  }

  async addStagingRows(rows: StagingRow[]): Promise<StoredStagingRow[]> {
    if (rows.length === 0) return [];
    const ts = this.now();
    this.tx(() => {
      const seen = new Set<string>();
      const stmt = this.db.prepare(
        `INSERT INTO staging_rows (id, batch_id, biz_no, date, datetime, amount_minor, direction, payee, counterparty_account, note, accounting_type, suggestion, assigned_book_id, assigned_account_id, status, txn_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      );
      for (const r of rows) {
        this.assertStagingBatch(r.batchId);
        // 同批自撞 seen + 库内已存在——任一即整批回滚（不依赖 tx 内 read-your-writes，三实现一致）
        if (seen.has(r.id) || this.db.prepare('SELECT 1 FROM staging_rows WHERE id = ?').get(r.id)) throw new Error(`导入草稿行已存在：${r.id}`);
        seen.add(r.id);
        stmt.run(r.id, r.batchId, r.bizNo, r.date, r.datetime, r.amountMinor, r.direction, r.payee, r.counterpartyAccount, r.note, r.accountingType, r.suggestion, r.assignedBookId, r.assignedAccountId, r.status, r.txnId, ts, ts);
      }
    });
    const out: StoredStagingRow[] = [];
    for (const r of rows) out.push((await this.getStagingRow(r.id))!);
    return out;
  }

  async listStagingBatches(query: { status?: StagingBatchStatus } = {}): Promise<StoredStagingBatch[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.status) {
      cond.push('status = ?');
      params.push(query.status);
    }
    const rows = this.db.prepare(`SELECT * FROM staging_batches WHERE ${cond.join(' AND ')}`).all(...params) as unknown as StagingBatchRow[];
    return rows.map(toStagingBatch);
  }

  async listStagingRows(query: { batchId?: string; status?: StagingRowStatus; bizNos?: string[] } = {}): Promise<StoredStagingRow[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.batchId) {
      cond.push('batch_id = ?');
      params.push(query.batchId);
    }
    if (query.status) {
      cond.push('status = ?');
      params.push(query.status);
    }
    if (query.bizNos) {
      if (query.bizNos.length === 0) return [];
      // 分片避免 IN 占位符超 SQLite 变量上限
      const out: StoredStagingRow[] = [];
      for (const part of chunk(query.bizNos, 500)) {
        const ph = part.map(() => '?').join(', ');
        const rows = this.db.prepare(`SELECT * FROM staging_rows WHERE ${cond.join(' AND ')} AND biz_no IN (${ph})`).all(...params, ...part) as unknown as StagingRowRow[];
        out.push(...rows.map(toStagingRow));
      }
      return out;
    }
    const rows = this.db.prepare(`SELECT * FROM staging_rows WHERE ${cond.join(' AND ')}`).all(...params) as unknown as StagingRowRow[];
    return rows.map(toStagingRow);
  }

  async updateStagingBatch(id: string, patch: StagingBatchPatch): Promise<StoredStagingBatch> {
    const cur = await this.getStagingBatch(id);
    if (!cur) throw new Error(`导入批次不存在：${id}`);
    const next: StoredStagingBatch = { ...cur, ...patch, updatedAt: this.now() };
    this.db.prepare(`UPDATE staging_batches SET label=?, status=?, updated_at=? WHERE id=?`).run(next.label, next.status, next.updatedAt, id);
    return (await this.getStagingBatch(id))!;
  }

  async updateStagingRow(id: string, patch: StagingRowPatch): Promise<StoredStagingRow> {
    const cur = await this.getStagingRow(id);
    if (!cur) throw new Error(`导入草稿行不存在：${id}`);
    const next: StoredStagingRow = { ...cur, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE staging_rows SET assigned_book_id=?, assigned_account_id=?, suggestion=?, status=?, txn_id=?, updated_at=? WHERE id=?`)
      .run(next.assignedBookId, next.assignedAccountId, next.suggestion, next.status, next.txnId, next.updatedAt, id);
    return (await this.getStagingRow(id))!;
  }

  // ---- 生意：代采采购单（C2d）----
  private insertPurchaseLines(purchaseId: string, lines: Purchase['lines']): void {
    const stmt = this.db.prepare(`INSERT INTO purchase_lines (id, purchase_id, name, qty, unit_cost, product_id) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const l of lines) stmt.run(l.id, purchaseId, l.name, l.qty, l.unitCost, l.productId);
  }

  async addPurchase(purchase: Purchase): Promise<StoredPurchase> {
    if (this.db.prepare('SELECT 1 FROM purchases WHERE id = ?').get(purchase.id)) {
      throw new Error(`采购单已存在：${purchase.id}`);
    }
    this.assertBook(purchase.bookId);
    // 草稿态（supplierId='' / 开单自动生成）暂无供应商，跳过供应商校验；确认时再补并校验。
    if (purchase.supplierId !== '' && this.supplierBookId(purchase.supplierId) !== purchase.bookId) {
      throw new Error('采购单供应商必须与采购单同账本');
    }
    // dropship 关联订单（校验同账本）；stock/expense 无订单（orderId=null）。
    if (purchase.orderId) {
      const o = this.db.prepare('SELECT book_id FROM orders WHERE id = ? AND deleted = 0').get(purchase.orderId) as { book_id: string } | undefined;
      if (!o) throw new Error(`关联订单不存在：${purchase.orderId}`);
      if (o.book_id !== purchase.bookId) throw new Error('关联订单必须与采购单同账本');
    }
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO purchases (id, book_id, supplier_id, kind, order_id, dest_account_id, date, pay_mode, note, txn_id, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(purchase.id, purchase.bookId, purchase.supplierId, purchase.kind, purchase.orderId ?? '', purchase.destAccountId, purchase.date, purchase.payMode, purchase.note, purchase.txnId, ts, ts);
      this.insertPurchaseLines(purchase.id, purchase.lines);
    });
    return (await this.getPurchase(purchase.id))!;
  }

  async getPurchase(id: string): Promise<StoredPurchase | null> {
    const r = this.db.prepare('SELECT * FROM purchases WHERE id = ? AND deleted = 0').get(id) as PurchaseRow | undefined;
    if (!r) return null;
    const lines = (this.db.prepare('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY rowid').all(id) as unknown as PurchaseLineRow[]).map(toPurchaseLine);
    return toPurchase(r, lines);
  }

  async listPurchases(query: { bookId?: string; orderId?: string; supplierId?: string } = {}): Promise<StoredPurchase[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.orderId) {
      cond.push('order_id = ?');
      params.push(query.orderId);
    }
    if (query.supplierId) {
      cond.push('supplier_id = ?');
      params.push(query.supplierId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM purchases WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`)
      .all(...params) as unknown as PurchaseRow[];
    if (rows.length === 0) return [];
    const byPurchase = new Map<string, PurchaseLineRow[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map(() => '?').join(', ');
      const lineRows = this.db
        .prepare(`SELECT * FROM purchase_lines WHERE purchase_id IN (${placeholders}) ORDER BY rowid`)
        .all(...batch) as unknown as PurchaseLineRow[];
      for (const lr of lineRows) {
        const arr = byPurchase.get(lr.purchase_id) ?? [];
        arr.push(lr);
        byPurchase.set(lr.purchase_id, arr);
      }
    }
    return rows.map((r) => toPurchase(r, (byPurchase.get(r.id) ?? []).map(toPurchaseLine)));
  }

  async updatePurchase(id: string, patch: PurchasePatch): Promise<StoredPurchase> {
    const cur = await this.getPurchase(id);
    if (!cur) throw new Error(`采购单不存在：${id}`);
    const next = { ...cur, ...patch };
    // 确认时补供应商：校验同账本（草稿原本 supplierId=''）
    if (patch.supplierId !== undefined && patch.supplierId !== '' && this.supplierBookId(patch.supplierId) !== cur.bookId) {
      throw new Error('采购单供应商必须与采购单同账本');
    }
    const ts = this.now();
    this.tx(() => {
      this.db
        .prepare(`UPDATE purchases SET supplier_id=?, date=?, pay_mode=?, note=?, txn_id=?, updated_at=? WHERE id=?`)
        .run(next.supplierId, next.date, next.payMode, next.note, next.txnId, ts, id);
      if (patch.lines !== undefined) {
        this.db.prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').run(id);
        this.insertPurchaseLines(id, patch.lines);
      }
    });
    return (await this.getPurchase(id))!;
  }

  async removePurchase(id: string): Promise<void> {
    const cur = this.db.prepare('SELECT 1 FROM purchases WHERE id = ? AND deleted = 0').get(id);
    if (!cur) throw new Error(`采购单不存在：${id}`);
    this.db.prepare('UPDATE purchases SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  // ---- 生意：库存出入库 ----
  async addInventoryMovement(m: InventoryMovement): Promise<StoredInventoryMovement> {
    if (this.db.prepare('SELECT 1 FROM inventory_movements WHERE id = ?').get(m.id)) {
      throw new Error(`库存流水已存在：${m.id}`);
    }
    this.assertBook(m.bookId);
    const p = this.db.prepare('SELECT book_id FROM products WHERE id = ? AND deleted = 0').get(m.productId) as
      | { book_id: string }
      | undefined;
    if (!p) throw new Error(`商品不存在：${m.productId}`);
    if (p.book_id !== m.bookId) throw new Error('库存流水的商品必须与流水同账本');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO inventory_movements (id, book_id, product_id, date, kind, qty, unit_cost, order_id, txn_id, note, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(m.id, m.bookId, m.productId, m.date, m.kind, m.qty, m.unitCost, m.orderId, m.txnId, m.note, ts, ts);
    const r = this.db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(m.id) as InventoryMovementRow | undefined;
    return toInventoryMovement(r!);
  }

  async listInventoryMovements(
    query: { bookId?: string; productId?: string; orderId?: string } = {},
  ): Promise<StoredInventoryMovement[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.productId) {
      cond.push('product_id = ?');
      params.push(query.productId);
    }
    if (query.orderId) {
      cond.push('order_id = ?');
      params.push(query.orderId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM inventory_movements WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`)
      .all(...params) as unknown as InventoryMovementRow[];
    return rows.map(toInventoryMovement);
  }

  // ---- 设置（KV）----
  async getSetting(scope: string, key: string): Promise<StoredSetting | null> {
    const r = this.db
      .prepare('SELECT * FROM settings WHERE scope = ? AND key = ?')
      .get(scope, key) as SettingRow | undefined;
    return r ? toSetting(r) : null;
  }

  async setSetting(scope: string, key: string, value: string): Promise<StoredSetting> {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(scope, key, value, ts);
    return (await this.getSetting(scope, key))!;
  }

  async listSettings(scope?: string): Promise<StoredSetting[]> {
    const rows = (
      scope === undefined
        ? this.db.prepare('SELECT * FROM settings').all()
        : this.db.prepare('SELECT * FROM settings WHERE scope = ?').all(scope)
    ) as unknown as SettingRow[];
    return rows.map(toSetting);
  }

  // ---- 月度对账 ----
  async setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void> {
    if (postingIds.length === 0) return;
    const stmt = this.db.prepare('UPDATE postings SET cleared = ? WHERE id = ?');
    const c = cleared ? 1 : 0;
    this.tx(() => {
      for (const id of postingIds) stmt.run(c, id);
    });
  }

  async addReconciliation(rec: Reconciliation): Promise<StoredReconciliation> {
    if (this.db.prepare('SELECT 1 FROM reconciliations WHERE id = ?').get(rec.id)) {
      throw new Error(`对账记录已存在：${rec.id}`);
    }
    this.assertBook(rec.bookId);
    const acc = this.db
      .prepare('SELECT book_id, global FROM accounts WHERE id = ? AND deleted = 0')
      .get(rec.accountId) as { book_id: string; global: number } | undefined;
    if (!acc) throw new Error(`对账账户不存在：${rec.accountId}`);
    // 全局账户跨账本对账；账本账户须与对账同账本
    if (acc.global === 0 && acc.book_id !== rec.bookId) throw new Error('对账账户必须与对账同账本');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO reconciliations (id, book_id, account_id, statement_balance, statement_date, completed_at, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(rec.id, rec.bookId, rec.accountId, rec.statementBalance, rec.statementDate, rec.completedAt, ts, ts);
    return (await this.getReconciliation(rec.id))!;
  }

  private async getReconciliation(id: string): Promise<StoredReconciliation | null> {
    const r = this.db.prepare('SELECT * FROM reconciliations WHERE id = ? AND deleted = 0').get(id) as
      | ReconciliationRow
      | undefined;
    return r ? toReconciliation(r) : null;
  }

  async listReconciliations(query: { bookId?: string; accountId?: string } = {}): Promise<StoredReconciliation[]> {
    const cond = ['deleted = 0'];
    const params: string[] = [];
    if (query.bookId) {
      cond.push('book_id = ?');
      params.push(query.bookId);
    }
    if (query.accountId) {
      cond.push('account_id = ?');
      params.push(query.accountId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM reconciliations WHERE ${cond.join(' AND ')} ORDER BY completed_at DESC, id DESC`)
      .all(...params) as unknown as ReconciliationRow[];
    return rows.map(toReconciliation);
  }
}
