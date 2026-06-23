import { TauriDb } from './tauri-bridge';
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
import { migrate } from './migrations';

const defaultClock: Clock = () => new Date().toISOString();

/** 一条带参数的 SQL，用于 db.batch 把多条写打包进一把事务。 */
type Stmt = { sql: string; params: unknown[] };

/**
 * Tauri 桌面实现：经自写 rusqlite + SQLCipher 桥（./tauri-bridge → Rust db_* 命令）访问本地库。
 * schema 由 ./migrations 版本化管理（load 时自动迁移，含遗留库回填默认账本）；
 * 行映射与 SqliteRepository 共用，占位符 $1..$N 由 Rust 侧翻成 ?N。
 * 只能在 Tauri runtime 内运行（走 IPC 到 Rust），行为契约由
 * SqliteRepository 的共享契约测试背书（同一 SQL 形状）。
 */
export class TauriSqlRepository implements Repository {
  private constructor(
    private readonly db: TauriDb,
    private readonly now: Clock,
  ) {}

  /**
   * 打开（或创建）本地 SQLite、自动迁移 schema。path 形如 'sqlite:heng.db'，相对应用配置目录。
   * `encrypted=true`：库已加密，Rust 用已解锁 DEK（须先 unlock）开 SQLCipher 密文库；否则开明文。
   * WAL/外键/busy_timeout 由 Rust 侧 db_open 设置。
   */
  static async load(
    path = 'sqlite:heng.db',
    opts: { now?: Clock; encrypted?: boolean } = {},
  ): Promise<TauriSqlRepository> {
    const db = await TauriDb.open(path, opts.encrypted ?? false);
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

  // 多写原子性（1b）：自写桥是单连接，多条写经 db.batch 包进一把 BEGIN/COMMIT（要么全成、
  // 要么全不写），修掉旧 tauri-plugin-sql 连接池下放弃事务、崩溃可能留半截交易的老债。

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
      `INSERT INTO accounts (id, book_id, name, type, parent_id, currency, global, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
      [
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
      // 全局账户对所有账本可见；其余仅本账本
      cond.push(`(global = 1 OR book_id = $${params.length})`);
    }
    const rows = await this.db.select<AccountRow[]>(`SELECT * FROM accounts WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toAccount);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount> {
    const cur = await this.getAccount(id);
    if (!cur) throw new Error(`账户不存在：${id}`);
    const next: StoredAccount = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE accounts SET name=$1, type=$2, parent_id=$3, currency=$4, global=$5, archived=$6, updated_at=$7 WHERE id=$8',
      [next.name, next.type, next.parentId, next.currency, next.global ? 1 : 0, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getAccount(id))!;
  }

  // ---- transactions ----
  private async assertSameBook(txn: Transaction): Promise<void> {
    const ids = [...new Set(txn.postings.map((p) => p.accountId))];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this.db.select<Array<{ id: string; book_id: string; global: number }>>(
      `SELECT id, book_id, global FROM accounts WHERE id IN (${placeholders}) AND deleted = 0`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) throw new Error(`分录引用的账户不存在：${id}`);
      // 全局账户可被任何账本的交易引用；账本账户必须与交易同账本
      if (row.global === 0 && row.book_id !== txn.bookId) throw new Error(`禁止跨账本分录：账户 ${id} 属于其他账本`);
    }
  }

  async addTransaction(txn: Transaction): Promise<StoredTransaction> {
    if (await this.exists('SELECT 1 FROM transactions WHERE id = $1', [txn.id])) {
      throw new Error(`交易已存在：${txn.id}`);
    }
    assertBalanced(txn.postings);
    await this.assertSameBook(txn);
    const ts = this.now();
    await this.db.batch([
      {
        sql: `INSERT INTO transactions (id, book_id, date, payee, note, tags, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
        params: [txn.id, txn.bookId, txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, ts],
      },
      ...this.postingStmts(txn.id, txn.postings),
    ]);
    return (await this.getTransaction(txn.id))!;
  }

  private postingStmts(txnId: string, postings: Posting[]): Stmt[] {
    return postings.map((p) => ({
      sql: 'INSERT INTO postings (id, txn_id, account_id, amount, currency, cleared) VALUES ($1, $2, $3, $4, $5, $6)',
      params: [p.id, txnId, p.accountId, p.amount, p.currency, p.cleared ? 1 : 0],
    }));
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
    await this.db.batch([
      {
        sql: 'UPDATE transactions SET date=$1, payee=$2, note=$3, tags=$4, updated_at=$5 WHERE id=$6',
        params: [txn.date, txn.payee, txn.note, JSON.stringify(txn.tags), ts, id],
      },
      { sql: 'DELETE FROM postings WHERE txn_id = $1', params: [id] },
      ...this.postingStmts(id, txn.postings),
    ]);
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

  // ---- 生意：客户 ----
  private async assertBook(bookId: string): Promise<void> {
    if (!(await this.exists('SELECT 1 FROM books WHERE id = $1 AND deleted = 0', [bookId]))) {
      throw new Error(`账本不存在：${bookId}`);
    }
  }

  async addCustomer(customer: Customer): Promise<StoredCustomer> {
    if (await this.exists('SELECT 1 FROM customers WHERE id = $1', [customer.id])) {
      throw new Error(`客户已存在：${customer.id}`);
    }
    await this.assertBook(customer.bookId);
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO customers (id, book_id, name, phone, note, due_days, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
      [customer.id, customer.bookId, customer.name, customer.phone, customer.note, customer.dueDays, customer.archived ? 1 : 0, ts, ts],
    );
    return (await this.getCustomer(customer.id))!;
  }

  async getCustomer(id: string): Promise<StoredCustomer | null> {
    const rows = await this.db.select<CustomerRow[]>('SELECT * FROM customers WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async listCustomers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredCustomer[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      params.push(opts.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<CustomerRow[]>(`SELECT * FROM customers WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toCustomer);
  }

  async updateCustomer(id: string, patch: CustomerPatch): Promise<StoredCustomer> {
    const cur = await this.getCustomer(id);
    if (!cur) throw new Error(`客户不存在：${id}`);
    const next: StoredCustomer = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE customers SET name=$1, phone=$2, note=$3, due_days=$4, archived=$5, updated_at=$6 WHERE id=$7',
      [next.name, next.phone, next.note, next.dueDays, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getCustomer(id))!;
  }

  // ---- 生意：供应商（C2 应付）----
  async addSupplier(supplier: Supplier): Promise<StoredSupplier> {
    if (await this.exists('SELECT 1 FROM suppliers WHERE id = $1', [supplier.id])) {
      throw new Error(`供应商已存在：${supplier.id}`);
    }
    await this.assertBook(supplier.bookId);
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO suppliers (id, book_id, name, phone, note, due_days, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
      [supplier.id, supplier.bookId, supplier.name, supplier.phone, supplier.note, supplier.dueDays, supplier.archived ? 1 : 0, ts, ts],
    );
    return (await this.getSupplier(supplier.id))!;
  }

  async getSupplier(id: string): Promise<StoredSupplier | null> {
    const rows = await this.db.select<SupplierRow[]>('SELECT * FROM suppliers WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  async listSuppliers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredSupplier[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      params.push(opts.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<SupplierRow[]>(`SELECT * FROM suppliers WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toSupplier);
  }

  async updateSupplier(id: string, patch: SupplierPatch): Promise<StoredSupplier> {
    const cur = await this.getSupplier(id);
    if (!cur) throw new Error(`供应商不存在：${id}`);
    const next: StoredSupplier = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE suppliers SET name=$1, phone=$2, note=$3, due_days=$4, archived=$5, updated_at=$6 WHERE id=$7',
      [next.name, next.phone, next.note, next.dueDays, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getSupplier(id))!;
  }

  // ---- 生意：订单 ----
  private async customerBookId(id: string): Promise<string> {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM customers WHERE id = $1 AND deleted = 0',
      [id],
    );
    if (!rows[0]) throw new Error(`客户不存在：${id}`);
    return rows[0].book_id;
  }

  private async supplierBookId(id: string): Promise<string> {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM suppliers WHERE id = $1 AND deleted = 0',
      [id],
    );
    if (!rows[0]) throw new Error(`供应商不存在：${id}`);
    return rows[0].book_id;
  }

  private orderLineStmts(orderId: string, lines: Order['lines']): Stmt[] {
    return lines.map((l) => ({
      sql: 'INSERT INTO order_lines (id, order_id, name, qty, unit_price, product_id, fee_ids) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      params: [l.id, orderId, l.name, l.qty, l.unitPrice, l.productId, JSON.stringify(l.feeIds ?? [])],
    }));
  }

  async addOrder(order: Order): Promise<StoredOrder> {
    if (await this.exists('SELECT 1 FROM orders WHERE id = $1', [order.id])) {
      throw new Error(`订单已存在：${order.id}`);
    }
    await this.assertBook(order.bookId);
    if ((await this.customerBookId(order.customerId)) !== order.bookId) throw new Error('订单客户必须与订单同账本');
    const ts = this.now();
    await this.db.batch([
      {
        sql: `INSERT INTO orders (id, book_id, customer_id, date, currency, status, note, revenue_txn_id, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
        params: [order.id, order.bookId, order.customerId, order.date, order.currency, order.status, order.note, order.revenueTxnId, ts, ts],
      },
      ...this.orderLineStmts(order.id, order.lines),
    ]);
    return (await this.getOrder(order.id))!;
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    const rows = await this.db.select<OrderRow[]>('SELECT * FROM orders WHERE id = $1 AND deleted = 0', [id]);
    const head = rows[0];
    if (!head) return null;
    const lineRows = await this.db.select<OrderLineRow[]>(
      'SELECT * FROM order_lines WHERE order_id = $1 ORDER BY rowid',
      [id],
    );
    return toOrder(head, lineRows.map(toOrderLine));
  }

  async listOrders(query: { bookId?: string; customerId?: string; status?: OrderStatus } = {}): Promise<StoredOrder[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.customerId) {
      params.push(query.customerId);
      cond.push(`customer_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      cond.push(`status = $${params.length}`);
    }
    const rows = await this.db.select<OrderRow[]>(
      `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`,
      params,
    );
    if (rows.length === 0) return [];
    const byOrder = new Map<string, OrderLineRow[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map((_, i) => `$${i + 1}`).join(', ');
      const lineRows = await this.db.select<OrderLineRow[]>(
        `SELECT * FROM order_lines WHERE order_id IN (${placeholders}) ORDER BY rowid`,
        batch,
      );
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
    await this.db.execute('UPDATE orders SET status=$1, note=$2, revenue_txn_id=$3, updated_at=$4 WHERE id=$5', [
      next.status,
      next.note,
      next.revenueTxnId,
      next.updatedAt,
      id,
    ]);
    return (await this.getOrder(id))!;
  }

  // ---- 生意：收款 ----
  async addSettlement(settlement: Settlement): Promise<StoredSettlement> {
    if (await this.exists('SELECT 1 FROM settlements WHERE id = $1', [settlement.id])) {
      throw new Error(`收款已存在：${settlement.id}`);
    }
    await this.assertBook(settlement.bookId);
    if (settlement.counterpartyType === 'customer') {
      if ((await this.customerBookId(settlement.counterpartyId)) !== settlement.bookId) {
        throw new Error('收款客户必须与收款同账本');
      }
    } else if (settlement.counterpartyType === 'supplier') {
      if ((await this.supplierBookId(settlement.counterpartyId)) !== settlement.bookId) {
        throw new Error('付款供应商必须与付款同账本');
      }
    }
    if (settlement.orderId !== null) {
      const rows = await this.db.select<Array<{ book_id: string }>>(
        'SELECT book_id FROM orders WHERE id = $1 AND deleted = 0',
        [settlement.orderId],
      );
      if (!rows[0]) throw new Error(`关联订单不存在：${settlement.orderId}`);
      if (rows[0].book_id !== settlement.bookId) throw new Error('关联订单必须与收款同账本');
    }
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO settlements (id, book_id, direction, counterparty_type, counterparty_id, order_id, amount, date, account_id, note, txn_id, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0)`,
      [
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
      ],
    );
    return (await this.getSettlement(settlement.id))!;
  }

  private async getSettlement(id: string): Promise<StoredSettlement | null> {
    const rows = await this.db.select<SettlementRow[]>('SELECT * FROM settlements WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toSettlement(rows[0]) : null;
  }

  async listSettlements(
    query: { bookId?: string; orderId?: string; counterpartyId?: string } = {},
  ): Promise<StoredSettlement[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.orderId) {
      params.push(query.orderId);
      cond.push(`order_id = $${params.length}`);
    }
    if (query.counterpartyId) {
      params.push(query.counterpartyId);
      cond.push(`counterparty_id = $${params.length}`);
    }
    const rows = await this.db.select<SettlementRow[]>(
      `SELECT * FROM settlements WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`,
      params,
    );
    return rows.map(toSettlement);
  }

  // ---- 生意：商品 ----
  async addProduct(product: Product): Promise<StoredProduct> {
    if (await this.exists('SELECT 1 FROM products WHERE id = $1', [product.id])) {
      throw new Error(`商品已存在：${product.id}`);
    }
    await this.assertBook(product.bookId);
    const ts = this.now();
    // is_stock/dropship 为死列（C2 模型重构后不读），靠 DEFAULT 0 兜底，INSERT 不再写入。
    await this.db.execute(
      `INSERT INTO products (id, book_id, name, cost_price, sale_price, quote_only, unit, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
      [product.id, product.bookId, product.name, product.costPrice, product.salePrice, product.quoteOnly ? 1 : 0, product.unit, product.archived ? 1 : 0, ts, ts],
    );
    return (await this.getProduct(product.id))!;
  }

  async getProduct(id: string): Promise<StoredProduct | null> {
    const rows = await this.db.select<ProductRow[]>('SELECT * FROM products WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async listProducts(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredProduct[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      params.push(opts.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<ProductRow[]>(`SELECT * FROM products WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toProduct);
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<StoredProduct> {
    const cur = await this.getProduct(id);
    if (!cur) throw new Error(`商品不存在：${id}`);
    const next: StoredProduct = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE products SET name=$1, cost_price=$2, sale_price=$3, quote_only=$4, unit=$5, archived=$6, updated_at=$7 WHERE id=$8',
      [next.name, next.costPrice, next.salePrice, next.quoteOnly ? 1 : 0, next.unit, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getProduct(id))!;
  }

  // ---- 生意：额外费用定义（C2 Step 4）----
  async addFeeDefinition(fee: FeeDefinition): Promise<StoredFeeDefinition> {
    if (await this.exists('SELECT 1 FROM fee_definitions WHERE id = $1', [fee.id])) throw new Error(`费用定义已存在：${fee.id}`);
    await this.assertBook(fee.bookId);
    const ts = this.now();
    await this.db.execute(
      'INSERT INTO fee_definitions (id, book_id, name, calc_type, tiers, archived, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)',
      [fee.id, fee.bookId, fee.name, fee.calcType, JSON.stringify(fee.tiers), fee.archived ? 1 : 0, ts, ts],
    );
    return (await this.getFeeDefinition(fee.id))!;
  }

  private async getFeeDefinition(id: string): Promise<StoredFeeDefinition | null> {
    const rows = await this.db.select<FeeDefinitionRow[]>('SELECT * FROM fee_definitions WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toFeeDefinition(rows[0]) : null;
  }

  async listFeeDefinitions(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredFeeDefinition[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (!opts.includeArchived) cond.push('archived = 0');
    if (opts.bookId) {
      params.push(opts.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    const rows = await this.db.select<FeeDefinitionRow[]>(`SELECT * FROM fee_definitions WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toFeeDefinition);
  }

  async updateFeeDefinition(id: string, patch: FeeDefinitionPatch): Promise<StoredFeeDefinition> {
    const cur = await this.getFeeDefinition(id);
    if (!cur) throw new Error(`费用定义不存在：${id}`);
    const next: StoredFeeDefinition = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE fee_definitions SET name=$1, calc_type=$2, tiers=$3, archived=$4, updated_at=$5 WHERE id=$6',
      [next.name, next.calcType, JSON.stringify(next.tiers), next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getFeeDefinition(id))!;
  }

  // ---- 插件单据实例（插件地基 Step 1）----
  async addPluginDocument(doc: PluginDocument): Promise<StoredPluginDocument> {
    if (await this.exists('SELECT 1 FROM plugin_documents WHERE id = $1', [doc.id])) throw new Error(`插件单据已存在：${doc.id}`);
    await this.assertBook(doc.bookId);
    const ts = this.now();
    await this.db.execute(
      'INSERT INTO plugin_documents (id, book_id, plugin_id, doc_type, data, txn_ids, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)',
      [doc.id, doc.bookId, doc.pluginId, doc.docType, JSON.stringify(doc.data), JSON.stringify(doc.txnIds), ts, ts],
    );
    return (await this.getPluginDocument(doc.id))!;
  }

  async getPluginDocument(id: string): Promise<StoredPluginDocument | null> {
    const rows = await this.db.select<PluginDocumentRow[]>('SELECT * FROM plugin_documents WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toPluginDocument(rows[0]) : null;
  }

  async listPluginDocuments(query: { bookId?: string; pluginId?: string; docType?: string } = {}): Promise<StoredPluginDocument[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.pluginId) {
      params.push(query.pluginId);
      cond.push(`plugin_id = $${params.length}`);
    }
    if (query.docType) {
      params.push(query.docType);
      cond.push(`doc_type = $${params.length}`);
    }
    const rows = await this.db.select<PluginDocumentRow[]>(`SELECT * FROM plugin_documents WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toPluginDocument);
  }

  async removePluginDocument(id: string): Promise<void> {
    const cur = await this.getPluginDocument(id);
    if (!cur) throw new Error(`插件单据不存在：${id}`);
    await this.db.execute('UPDATE plugin_documents SET deleted = 1, updated_at = $1 WHERE id = $2', [this.now(), id]);
  }

  // ---- 导入复核台脊梁（账单导入 增量1·②）----
  private async assertStagingBatch(id: string): Promise<void> {
    if (!(await this.exists('SELECT 1 FROM staging_batches WHERE id = $1 AND deleted = 0', [id]))) {
      throw new Error(`导入批次不存在：${id}`);
    }
  }

  private async getStagingBatch(id: string): Promise<StoredStagingBatch | null> {
    const rows = await this.db.select<StagingBatchRow[]>('SELECT * FROM staging_batches WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toStagingBatch(rows[0]) : null;
  }

  private async getStagingRow(id: string): Promise<StoredStagingRow | null> {
    const rows = await this.db.select<StagingRowRow[]>('SELECT * FROM staging_rows WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] ? toStagingRow(rows[0]) : null;
  }

  async addStagingBatch(batch: StagingBatch): Promise<StoredStagingBatch> {
    if (await this.exists('SELECT 1 FROM staging_batches WHERE id = $1', [batch.id])) throw new Error(`导入批次已存在：${batch.id}`);
    const ts = this.now();
    await this.db.execute(
      'INSERT INTO staging_batches (id, source, account_id, label, status, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)',
      [batch.id, batch.source, batch.accountId, batch.label, batch.status, ts, ts],
    );
    return (await this.getStagingBatch(batch.id))!;
  }

  async addStagingRows(rows: StagingRow[]): Promise<StoredStagingRow[]> {
    if (rows.length === 0) return [];
    // 批量前置校验（批次存在 + id 不重复，含同批入参自撞），再一把事务写入——半截不写、三实现行为一致
    const seen = new Set<string>();
    for (const r of rows) {
      await this.assertStagingBatch(r.batchId);
      if (seen.has(r.id) || (await this.exists('SELECT 1 FROM staging_rows WHERE id = $1', [r.id]))) throw new Error(`导入草稿行已存在：${r.id}`);
      seen.add(r.id);
    }
    const ts = this.now();
    await this.db.batch(
      rows.map((r) => ({
        sql: `INSERT INTO staging_rows (id, batch_id, biz_no, date, datetime, amount_minor, direction, payee, counterparty_account, note, accounting_type, suggestion, assigned_book_id, assigned_account_id, status, txn_id, created_at, updated_at, deleted)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 0)`,
        params: [r.id, r.batchId, r.bizNo, r.date, r.datetime, r.amountMinor, r.direction, r.payee, r.counterpartyAccount, r.note, r.accountingType, r.suggestion, r.assignedBookId, r.assignedAccountId, r.status, r.txnId, ts, ts],
      })),
    );
    const out: StoredStagingRow[] = [];
    for (const r of rows) out.push((await this.getStagingRow(r.id))!);
    return out;
  }

  async listStagingBatches(query: { status?: StagingBatchStatus } = {}): Promise<StoredStagingBatch[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      cond.push(`status = $${params.length}`);
    }
    const rows = await this.db.select<StagingBatchRow[]>(`SELECT * FROM staging_batches WHERE ${cond.join(' AND ')}`, params);
    return rows.map(toStagingBatch);
  }

  async listStagingRows(query: { batchId?: string; status?: StagingRowStatus; bizNos?: string[] } = {}): Promise<StoredStagingRow[]> {
    const base = ['deleted = 0'];
    const baseParams: unknown[] = [];
    if (query.batchId) {
      baseParams.push(query.batchId);
      base.push(`batch_id = $${baseParams.length}`);
    }
    if (query.status) {
      baseParams.push(query.status);
      base.push(`status = $${baseParams.length}`);
    }
    if (query.bizNos) {
      if (query.bizNos.length === 0) return [];
      // 分片避免 IN 占位符超 SQLite 变量上限
      const out: StoredStagingRow[] = [];
      for (const part of chunk(query.bizNos, 500)) {
        const params = [...baseParams];
        const ph = part
          .map((b) => {
            params.push(b);
            return `$${params.length}`;
          })
          .join(', ');
        const rows = await this.db.select<StagingRowRow[]>(`SELECT * FROM staging_rows WHERE ${base.join(' AND ')} AND biz_no IN (${ph})`, params);
        out.push(...rows.map(toStagingRow));
      }
      return out;
    }
    const rows = await this.db.select<StagingRowRow[]>(`SELECT * FROM staging_rows WHERE ${base.join(' AND ')}`, baseParams);
    return rows.map(toStagingRow);
  }

  async updateStagingBatch(id: string, patch: StagingBatchPatch): Promise<StoredStagingBatch> {
    const cur = await this.getStagingBatch(id);
    if (!cur) throw new Error(`导入批次不存在：${id}`);
    const next: StoredStagingBatch = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute('UPDATE staging_batches SET label=$1, status=$2, updated_at=$3 WHERE id=$4', [next.label, next.status, next.updatedAt, id]);
    return (await this.getStagingBatch(id))!;
  }

  async updateStagingRow(id: string, patch: StagingRowPatch): Promise<StoredStagingRow> {
    const cur = await this.getStagingRow(id);
    if (!cur) throw new Error(`导入草稿行不存在：${id}`);
    const next: StoredStagingRow = { ...cur, ...patch, updatedAt: this.now() };
    await this.db.execute(
      'UPDATE staging_rows SET assigned_book_id=$1, assigned_account_id=$2, suggestion=$3, status=$4, txn_id=$5, updated_at=$6 WHERE id=$7',
      [next.assignedBookId, next.assignedAccountId, next.suggestion, next.status, next.txnId, next.updatedAt, id],
    );
    return (await this.getStagingRow(id))!;
  }

  // ---- 生意：代采采购单（C2d）----
  private purchaseLineStmts(purchaseId: string, lines: Purchase['lines']): Stmt[] {
    return lines.map((l) => ({
      sql: 'INSERT INTO purchase_lines (id, purchase_id, name, qty, unit_cost, product_id) VALUES ($1, $2, $3, $4, $5, $6)',
      params: [l.id, purchaseId, l.name, l.qty, l.unitCost, l.productId],
    }));
  }

  async addPurchase(purchase: Purchase): Promise<StoredPurchase> {
    if (await this.exists('SELECT 1 FROM purchases WHERE id = $1', [purchase.id])) {
      throw new Error(`采购单已存在：${purchase.id}`);
    }
    await this.assertBook(purchase.bookId);
    // 草稿态（supplierId='' / 开单自动生成）暂无供应商，跳过供应商校验；确认时再补并校验。
    if (purchase.supplierId !== '' && (await this.supplierBookId(purchase.supplierId)) !== purchase.bookId) {
      throw new Error('采购单供应商必须与采购单同账本');
    }
    // dropship 关联订单（校验同账本）；stock/expense 无订单（orderId=null）。
    if (purchase.orderId) {
      const orows = await this.db.select<Array<{ book_id: string }>>('SELECT book_id FROM orders WHERE id = $1 AND deleted = 0', [purchase.orderId]);
      if (!orows[0]) throw new Error(`关联订单不存在：${purchase.orderId}`);
      if (orows[0].book_id !== purchase.bookId) throw new Error('关联订单必须与采购单同账本');
    }
    const ts = this.now();
    await this.db.batch([
      {
        sql: `INSERT INTO purchases (id, book_id, supplier_id, kind, order_id, dest_account_id, date, pay_mode, note, txn_id, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0)`,
        params: [purchase.id, purchase.bookId, purchase.supplierId, purchase.kind, purchase.orderId ?? '', purchase.destAccountId, purchase.date, purchase.payMode, purchase.note, purchase.txnId, ts, ts],
      },
      ...this.purchaseLineStmts(purchase.id, purchase.lines),
    ]);
    return (await this.getPurchase(purchase.id))!;
  }

  async getPurchase(id: string): Promise<StoredPurchase | null> {
    const rows = await this.db.select<PurchaseRow[]>('SELECT * FROM purchases WHERE id = $1 AND deleted = 0', [id]);
    const head = rows[0];
    if (!head) return null;
    const lineRows = await this.db.select<PurchaseLineRow[]>('SELECT * FROM purchase_lines WHERE purchase_id = $1 ORDER BY rowid', [id]);
    return toPurchase(head, lineRows.map(toPurchaseLine));
  }

  async listPurchases(query: { bookId?: string; orderId?: string; supplierId?: string } = {}): Promise<StoredPurchase[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.orderId) {
      params.push(query.orderId);
      cond.push(`order_id = $${params.length}`);
    }
    if (query.supplierId) {
      params.push(query.supplierId);
      cond.push(`supplier_id = $${params.length}`);
    }
    const rows = await this.db.select<PurchaseRow[]>(
      `SELECT * FROM purchases WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`,
      params,
    );
    if (rows.length === 0) return [];
    const byPurchase = new Map<string, PurchaseLineRow[]>();
    for (const batch of chunk(rows.map((r) => r.id), 500)) {
      const placeholders = batch.map((_, i) => `$${i + 1}`).join(', ');
      const lineRows = await this.db.select<PurchaseLineRow[]>(
        `SELECT * FROM purchase_lines WHERE purchase_id IN (${placeholders}) ORDER BY rowid`,
        batch,
      );
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
    if (patch.supplierId !== undefined && patch.supplierId !== '' && (await this.supplierBookId(patch.supplierId)) !== cur.bookId) {
      throw new Error('采购单供应商必须与采购单同账本');
    }
    const ts = this.now();
    const stmts: Stmt[] = [
      {
        sql: 'UPDATE purchases SET supplier_id=$1, date=$2, pay_mode=$3, note=$4, txn_id=$5, updated_at=$6 WHERE id=$7',
        params: [next.supplierId, next.date, next.payMode, next.note, next.txnId, ts, id],
      },
    ];
    if (patch.lines !== undefined) {
      stmts.push({ sql: 'DELETE FROM purchase_lines WHERE purchase_id = $1', params: [id] });
      stmts.push(...this.purchaseLineStmts(id, patch.lines));
    }
    await this.db.batch(stmts);
    return (await this.getPurchase(id))!;
  }

  async removePurchase(id: string): Promise<void> {
    if (!(await this.exists('SELECT 1 FROM purchases WHERE id = $1 AND deleted = 0', [id]))) {
      throw new Error(`采购单不存在：${id}`);
    }
    await this.db.execute('UPDATE purchases SET deleted = 1, updated_at = $1 WHERE id = $2', [this.now(), id]);
  }

  // ---- 生意：库存出入库 ----
  async addInventoryMovement(m: InventoryMovement): Promise<StoredInventoryMovement> {
    if (await this.exists('SELECT 1 FROM inventory_movements WHERE id = $1', [m.id])) {
      throw new Error(`库存流水已存在：${m.id}`);
    }
    await this.assertBook(m.bookId);
    const rows = await this.db.select<{ book_id: string }[]>('SELECT book_id FROM products WHERE id = $1 AND deleted = 0', [m.productId]);
    if (!rows[0]) throw new Error(`商品不存在：${m.productId}`);
    if (rows[0].book_id !== m.bookId) throw new Error('库存流水的商品必须与流水同账本');
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO inventory_movements (id, book_id, product_id, date, kind, qty, unit_cost, order_id, txn_id, note, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0)`,
      [m.id, m.bookId, m.productId, m.date, m.kind, m.qty, m.unitCost, m.orderId, m.txnId, m.note, ts, ts],
    );
    const out = await this.db.select<InventoryMovementRow[]>('SELECT * FROM inventory_movements WHERE id = $1', [m.id]);
    return toInventoryMovement(out[0]!);
  }

  async listInventoryMovements(
    query: { bookId?: string; productId?: string; orderId?: string } = {},
  ): Promise<StoredInventoryMovement[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.productId) {
      params.push(query.productId);
      cond.push(`product_id = $${params.length}`);
    }
    if (query.orderId) {
      params.push(query.orderId);
      cond.push(`order_id = $${params.length}`);
    }
    const rows = await this.db.select<InventoryMovementRow[]>(
      `SELECT * FROM inventory_movements WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`,
      params,
    );
    return rows.map(toInventoryMovement);
  }

  // ---- 设置（KV）----
  async getSetting(scope: string, key: string): Promise<StoredSetting | null> {
    const rows = await this.db.select<SettingRow[]>('SELECT * FROM settings WHERE scope = $1 AND key = $2', [scope, key]);
    return rows[0] ? toSetting(rows[0]) : null;
  }

  async setSetting(scope: string, key: string, value: string): Promise<StoredSetting> {
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO settings (scope, key, value, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [scope, key, value, ts],
    );
    return (await this.getSetting(scope, key))!;
  }

  async listSettings(scope?: string): Promise<StoredSetting[]> {
    const rows =
      scope === undefined
        ? await this.db.select<SettingRow[]>('SELECT * FROM settings')
        : await this.db.select<SettingRow[]>('SELECT * FROM settings WHERE scope = $1', [scope]);
    return rows.map(toSetting);
  }

  // ---- 月度对账 ----
  async setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void> {
    if (postingIds.length === 0) return;
    const c = cleared ? 1 : 0;
    await this.db.batch(
      postingIds.map((id) => ({ sql: 'UPDATE postings SET cleared = $1 WHERE id = $2', params: [c, id] })),
    );
  }

  async addReconciliation(rec: Reconciliation): Promise<StoredReconciliation> {
    if (await this.exists('SELECT 1 FROM reconciliations WHERE id = $1', [rec.id])) {
      throw new Error(`对账记录已存在：${rec.id}`);
    }
    await this.assertBook(rec.bookId);
    const acc = await this.db.select<Array<{ book_id: string; global: number }>>(
      'SELECT book_id, global FROM accounts WHERE id = $1 AND deleted = 0',
      [rec.accountId],
    );
    if (!acc[0]) throw new Error(`对账账户不存在：${rec.accountId}`);
    // 全局账户跨账本对账；账本账户须与对账同账本
    if (acc[0].global === 0 && acc[0].book_id !== rec.bookId) throw new Error('对账账户必须与对账同账本');
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO reconciliations (id, book_id, account_id, statement_balance, statement_date, completed_at, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
      [rec.id, rec.bookId, rec.accountId, rec.statementBalance, rec.statementDate, rec.completedAt, ts, ts],
    );
    return (await this.getReconciliation(rec.id))!;
  }

  private async getReconciliation(id: string): Promise<StoredReconciliation | null> {
    const rows = await this.db.select<ReconciliationRow[]>(
      'SELECT * FROM reconciliations WHERE id = $1 AND deleted = 0',
      [id],
    );
    return rows[0] ? toReconciliation(rows[0]) : null;
  }

  async listReconciliations(query: { bookId?: string; accountId?: string } = {}): Promise<StoredReconciliation[]> {
    const cond = ['deleted = 0'];
    const params: unknown[] = [];
    if (query.bookId) {
      params.push(query.bookId);
      cond.push(`book_id = $${params.length}`);
    }
    if (query.accountId) {
      params.push(query.accountId);
      cond.push(`account_id = $${params.length}`);
    }
    const rows = await this.db.select<ReconciliationRow[]>(
      `SELECT * FROM reconciliations WHERE ${cond.join(' AND ')} ORDER BY completed_at DESC, id DESC`,
      params,
    );
    return rows.map(toReconciliation);
  }
}
