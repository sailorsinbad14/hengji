import Database from '@tauri-apps/plugin-sql';
import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Customer, Order, OrderStatus, Posting, Product, Reconciliation, Settlement, Transaction } from '@app/core';
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
  StoredOrder,
  StoredProduct,
  StoredReconciliation,
  StoredSetting,
  StoredSettlement,
  StoredTransaction,
  TxnQuery,
} from './types';
import {
  chunk,
  parseTags,
  toAccount,
  toBook,
  toBudget,
  toCustomer,
  toOrder,
  toOrderLine,
  toPosting,
  toProduct,
  toReconciliation,
  toSetting,
  toSettlement,
  toTxn,
} from './schema';
import type {
  AccountRow,
  BookRow,
  BudgetRow,
  CustomerRow,
  OrderLineRow,
  OrderRow,
  PostingRow,
  ProductRow,
  ReconciliationRow,
  SettingRow,
  SettlementRow,
  TxnRow,
} from './schema';
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
        'INSERT INTO postings (id, txn_id, account_id, amount, currency, cleared) VALUES ($1, $2, $3, $4, $5, $6)',
        [p.id, txnId, p.accountId, p.amount, p.currency, p.cleared ? 1 : 0],
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

  // ---- 生意：订单 ----
  private async customerBookId(id: string): Promise<string> {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM customers WHERE id = $1 AND deleted = 0',
      [id],
    );
    if (!rows[0]) throw new Error(`客户不存在：${id}`);
    return rows[0].book_id;
  }

  private async insertOrderLines(orderId: string, lines: Order['lines']): Promise<void> {
    for (const l of lines) {
      await this.db.execute(
        'INSERT INTO order_lines (id, order_id, name, qty, unit_price, product_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [l.id, orderId, l.name, l.qty, l.unitPrice, l.productId],
      );
    }
  }

  async addOrder(order: Order): Promise<StoredOrder> {
    if (await this.exists('SELECT 1 FROM orders WHERE id = $1', [order.id])) {
      throw new Error(`订单已存在：${order.id}`);
    }
    await this.assertBook(order.bookId);
    if ((await this.customerBookId(order.customerId)) !== order.bookId) throw new Error('订单客户必须与订单同账本');
    const ts = this.now();
    await this.db.execute(
      `INSERT INTO orders (id, book_id, customer_id, date, status, note, revenue_txn_id, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
      [order.id, order.bookId, order.customerId, order.date, order.status, order.note, order.revenueTxnId, ts, ts],
    );
    await this.insertOrderLines(order.id, order.lines);
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
    await this.db.execute(
      `INSERT INTO products (id, book_id, name, cost_price, sale_price, is_stock, unit, archived, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
      [product.id, product.bookId, product.name, product.costPrice, product.salePrice, product.isStock ? 1 : 0, product.unit, product.archived ? 1 : 0, ts, ts],
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
      'UPDATE products SET name=$1, cost_price=$2, sale_price=$3, is_stock=$4, unit=$5, archived=$6, updated_at=$7 WHERE id=$8',
      [next.name, next.costPrice, next.salePrice, next.isStock ? 1 : 0, next.unit, next.archived ? 1 : 0, next.updatedAt, id],
    );
    return (await this.getProduct(id))!;
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
  // 顺序 autocommit（连接池下裸 BEGIN 会自锁，见上方说明）；批量置位非原子但单用户桌面可接受。
  async setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void> {
    const c = cleared ? 1 : 0;
    for (const id of postingIds) {
      await this.db.execute('UPDATE postings SET cleared = $1 WHERE id = $2', [c, id]);
    }
  }

  async addReconciliation(rec: Reconciliation): Promise<StoredReconciliation> {
    if (await this.exists('SELECT 1 FROM reconciliations WHERE id = $1', [rec.id])) {
      throw new Error(`对账记录已存在：${rec.id}`);
    }
    await this.assertBook(rec.bookId);
    const acc = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM accounts WHERE id = $1 AND deleted = 0',
      [rec.accountId],
    );
    if (!acc[0]) throw new Error(`对账账户不存在：${rec.accountId}`);
    if (acc[0].book_id !== rec.bookId) throw new Error('对账账户必须与对账同账本');
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
