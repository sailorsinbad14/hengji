import { assertBalanced } from '@app/core';
import type { Account, Book, Budget, Customer, FeeDefinition, InventoryMovement, Order, OrderStatus, PluginDocument, Product, Purchase, Reconciliation, Settlement, StagingBatch, StagingBatchStatus, StagingRow, StagingRowStatus, Supplier, Transaction } from '@app/core';
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
  private readonly suppliers = new Map<string, StoredSupplier>();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly settlements = new Map<string, StoredSettlement>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly feeDefinitions = new Map<string, StoredFeeDefinition>();
  private readonly purchases = new Map<string, StoredPurchase>();
  private readonly settings = new Map<string, StoredSetting>();
  private readonly reconciliations = new Map<string, StoredReconciliation>();
  private readonly inventoryMovements = new Map<string, StoredInventoryMovement>();
  private readonly pluginDocuments = new Map<string, StoredPluginDocument>();
  private readonly stagingBatches = new Map<string, StoredStagingBatch>();
  private readonly stagingRows = new Map<string, StoredStagingRow>();
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
      // 全局账户对所有账本可见；其余仅本账本
      if (opts.bookId && !a.global && a.bookId !== opts.bookId) continue;
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
      // 全局账户可被任何账本的交易引用；账本账户必须与交易同账本
      if (!acc.global && acc.bookId !== txn.bookId) {
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

  // ---- 生意：供应商（C2 应付）----
  async addSupplier(supplier: Supplier): Promise<StoredSupplier> {
    if (this.suppliers.has(supplier.id)) throw new Error(`供应商已存在：${supplier.id}`);
    this.liveBook(supplier.bookId);
    const ts = this.now();
    const stored: StoredSupplier = { ...clone(supplier), createdAt: ts, updatedAt: ts, deleted: false };
    this.suppliers.set(supplier.id, stored);
    return clone(stored);
  }

  async getSupplier(id: string): Promise<StoredSupplier | null> {
    const s = this.suppliers.get(id);
    return s && !s.deleted ? clone(s) : null;
  }

  async listSuppliers(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredSupplier[]> {
    const out: StoredSupplier[] = [];
    for (const s of this.suppliers.values()) {
      if (s.deleted) continue;
      if (!opts.includeArchived && s.archived) continue;
      if (opts.bookId && s.bookId !== opts.bookId) continue;
      out.push(clone(s));
    }
    return out;
  }

  async updateSupplier(id: string, patch: SupplierPatch): Promise<StoredSupplier> {
    const s = this.suppliers.get(id);
    if (!s || s.deleted) throw new Error(`供应商不存在：${id}`);
    const updated: StoredSupplier = { ...s, ...patch, updatedAt: this.now() };
    this.suppliers.set(id, updated);
    return clone(updated);
  }

  // ---- 生意：订单 ----
  private liveCustomer(id: string): StoredCustomer {
    const c = this.customers.get(id);
    if (!c || c.deleted) throw new Error(`客户不存在：${id}`);
    return c;
  }

  private liveSupplier(id: string): StoredSupplier {
    const s = this.suppliers.get(id);
    if (!s || s.deleted) throw new Error(`供应商不存在：${id}`);
    return s;
  }

  async addOrder(order: Order): Promise<StoredOrder> {
    if (this.orders.has(order.id)) throw new Error(`订单已存在：${order.id}`);
    this.liveBook(order.bookId);
    const cust = this.liveCustomer(order.customerId);
    if (cust.bookId !== order.bookId) throw new Error('订单客户必须与订单同账本');
    const ts = this.now();
    const stored: StoredOrder = { ...clone(order), createdAt: ts, updatedAt: ts, deleted: false };
    // 归一化 feeIds 为数组（与 SQLite 实现 toOrderLine 一致，缺省 → []）
    stored.lines = stored.lines.map((l) => ({ ...l, feeIds: l.feeIds ?? [] }));
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
    } else if (settlement.counterpartyType === 'supplier') {
      const sup = this.liveSupplier(settlement.counterpartyId);
      if (sup.bookId !== settlement.bookId) throw new Error('付款供应商必须与付款同账本');
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

  // ---- 生意：代采采购单（C2d）----
  async addPurchase(purchase: Purchase): Promise<StoredPurchase> {
    if (this.purchases.has(purchase.id)) throw new Error(`采购单已存在：${purchase.id}`);
    this.liveBook(purchase.bookId);
    // 草稿态（supplierId='' / 开单自动生成）暂无供应商，跳过供应商校验；确认时再补并校验。
    if (purchase.supplierId !== '') {
      const sup = this.liveSupplier(purchase.supplierId);
      if (sup.bookId !== purchase.bookId) throw new Error('采购单供应商必须与采购单同账本');
    }
    // dropship 关联订单（校验同账本）；stock/expense 无订单（orderId=null）。
    if (purchase.orderId) {
      const o = this.orders.get(purchase.orderId);
      if (!o || o.deleted) throw new Error(`关联订单不存在：${purchase.orderId}`);
      if (o.bookId !== purchase.bookId) throw new Error('关联订单必须与采购单同账本');
    }
    const ts = this.now();
    const stored: StoredPurchase = { ...clone(purchase), createdAt: ts, updatedAt: ts, deleted: false };
    this.purchases.set(purchase.id, stored);
    return clone(stored);
  }

  async getPurchase(id: string): Promise<StoredPurchase | null> {
    const p = this.purchases.get(id);
    return p && !p.deleted ? clone(p) : null;
  }

  async listPurchases(query: { bookId?: string; orderId?: string; supplierId?: string } = {}): Promise<StoredPurchase[]> {
    const out: StoredPurchase[] = [];
    for (const p of this.purchases.values()) {
      if (p.deleted) continue;
      if (query.bookId && p.bookId !== query.bookId) continue;
      if (query.orderId && p.orderId !== query.orderId) continue;
      if (query.supplierId && p.supplierId !== query.supplierId) continue;
      out.push(clone(p));
    }
    return sortByDateDesc(out);
  }

  async updatePurchase(id: string, patch: PurchasePatch): Promise<StoredPurchase> {
    const p = this.purchases.get(id);
    if (!p || p.deleted) throw new Error(`采购单不存在：${id}`);
    // 确认时补供应商：校验同账本（草稿原本 supplierId=''）
    if (patch.supplierId !== undefined && patch.supplierId !== '') {
      const sup = this.liveSupplier(patch.supplierId);
      if (sup.bookId !== p.bookId) throw new Error('采购单供应商必须与采购单同账本');
    }
    const updated: StoredPurchase = { ...p, ...clone(patch), updatedAt: this.now() };
    this.purchases.set(id, updated);
    return clone(updated);
  }

  async removePurchase(id: string): Promise<void> {
    const p = this.purchases.get(id);
    if (!p || p.deleted) throw new Error(`采购单不存在：${id}`);
    this.purchases.set(id, { ...p, deleted: true, updatedAt: this.now() });
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

  // ---- 生意：额外费用定义（C2 Step 4）----
  async addFeeDefinition(fee: FeeDefinition): Promise<StoredFeeDefinition> {
    if (this.feeDefinitions.has(fee.id)) throw new Error(`费用定义已存在：${fee.id}`);
    this.liveBook(fee.bookId);
    const ts = this.now();
    const stored: StoredFeeDefinition = { ...clone(fee), createdAt: ts, updatedAt: ts, deleted: false };
    this.feeDefinitions.set(fee.id, stored);
    return clone(stored);
  }

  async listFeeDefinitions(opts: { bookId?: string; includeArchived?: boolean } = {}): Promise<StoredFeeDefinition[]> {
    const out: StoredFeeDefinition[] = [];
    for (const f of this.feeDefinitions.values()) {
      if (f.deleted) continue;
      if (!opts.includeArchived && f.archived) continue;
      if (opts.bookId && f.bookId !== opts.bookId) continue;
      out.push(clone(f));
    }
    return out;
  }

  async updateFeeDefinition(id: string, patch: FeeDefinitionPatch): Promise<StoredFeeDefinition> {
    const f = this.feeDefinitions.get(id);
    if (!f || f.deleted) throw new Error(`费用定义不存在：${id}`);
    const updated: StoredFeeDefinition = { ...f, ...clone(patch), updatedAt: this.now() };
    this.feeDefinitions.set(id, updated);
    return clone(updated);
  }

  // ---- 插件单据实例（插件地基 Step 1）----
  async addPluginDocument(doc: PluginDocument): Promise<StoredPluginDocument> {
    if (this.pluginDocuments.has(doc.id)) throw new Error(`插件单据已存在：${doc.id}`);
    this.liveBook(doc.bookId);
    const ts = this.now();
    const stored: StoredPluginDocument = { ...clone(doc), createdAt: ts, updatedAt: ts, deleted: false };
    this.pluginDocuments.set(doc.id, stored);
    return clone(stored);
  }

  async listPluginDocuments(query: { bookId?: string; pluginId?: string; docType?: string } = {}): Promise<StoredPluginDocument[]> {
    const out: StoredPluginDocument[] = [];
    for (const d of this.pluginDocuments.values()) {
      if (d.deleted) continue;
      if (query.bookId && d.bookId !== query.bookId) continue;
      if (query.pluginId && d.pluginId !== query.pluginId) continue;
      if (query.docType && d.docType !== query.docType) continue;
      out.push(clone(d));
    }
    return out;
  }

  async getPluginDocument(id: string): Promise<StoredPluginDocument | null> {
    const d = this.pluginDocuments.get(id);
    return d && !d.deleted ? clone(d) : null;
  }

  async removePluginDocument(id: string): Promise<void> {
    const d = this.pluginDocuments.get(id);
    if (!d || d.deleted) throw new Error(`插件单据不存在：${id}`);
    this.pluginDocuments.set(id, { ...d, deleted: true, updatedAt: this.now() });
  }

  // ---- 导入复核台脊梁（账单导入 增量1·②）----
  private liveStagingBatch(id: string): StoredStagingBatch {
    const b = this.stagingBatches.get(id);
    if (!b || b.deleted) throw new Error(`导入批次不存在：${id}`);
    return b;
  }

  async addStagingBatch(batch: StagingBatch): Promise<StoredStagingBatch> {
    if (this.stagingBatches.has(batch.id)) throw new Error(`导入批次已存在：${batch.id}`);
    const ts = this.now();
    const stored: StoredStagingBatch = { ...clone(batch), createdAt: ts, updatedAt: ts, deleted: false };
    this.stagingBatches.set(batch.id, stored);
    return clone(stored);
  }

  async addStagingRows(rows: StagingRow[]): Promise<StoredStagingRow[]> {
    // 先全量校验（批次存在 + id 不重复，含同批入参自撞），再写——避免半截写入、三实现行为一致
    const seen = new Set<string>();
    for (const r of rows) {
      this.liveStagingBatch(r.batchId);
      if (seen.has(r.id) || this.stagingRows.has(r.id)) throw new Error(`导入草稿行已存在：${r.id}`);
      seen.add(r.id);
    }
    const ts = this.now();
    const out: StoredStagingRow[] = [];
    for (const r of rows) {
      const stored: StoredStagingRow = { ...clone(r), createdAt: ts, updatedAt: ts, deleted: false };
      this.stagingRows.set(r.id, stored);
      out.push(clone(stored));
    }
    return out;
  }

  async listStagingBatches(query: { status?: StagingBatchStatus } = {}): Promise<StoredStagingBatch[]> {
    const out: StoredStagingBatch[] = [];
    for (const b of this.stagingBatches.values()) {
      if (b.deleted) continue;
      if (query.status && b.status !== query.status) continue;
      out.push(clone(b));
    }
    return out;
  }

  async listStagingRows(query: { batchId?: string; status?: StagingRowStatus; bizNos?: string[] } = {}): Promise<StoredStagingRow[]> {
    const bizSet = query.bizNos ? new Set(query.bizNos) : null;
    const out: StoredStagingRow[] = [];
    for (const r of this.stagingRows.values()) {
      if (r.deleted) continue;
      if (query.batchId && r.batchId !== query.batchId) continue;
      if (query.status && r.status !== query.status) continue;
      if (bizSet && !bizSet.has(r.bizNo)) continue;
      out.push(clone(r));
    }
    return out;
  }

  async updateStagingBatch(id: string, patch: StagingBatchPatch): Promise<StoredStagingBatch> {
    const b = this.stagingBatches.get(id);
    if (!b || b.deleted) throw new Error(`导入批次不存在：${id}`);
    const updated: StoredStagingBatch = { ...b, ...clone(patch), updatedAt: this.now() };
    this.stagingBatches.set(id, updated);
    return clone(updated);
  }

  async updateStagingRow(id: string, patch: StagingRowPatch): Promise<StoredStagingRow> {
    const r = this.stagingRows.get(id);
    if (!r || r.deleted) throw new Error(`导入草稿行不存在：${id}`);
    const updated: StoredStagingRow = { ...r, ...clone(patch), updatedAt: this.now() };
    this.stagingRows.set(id, updated);
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
    // 全局账户跨账本对账；账本账户须与对账同账本
    if (!acc.global && acc.bookId !== rec.bookId) throw new Error('对账账户必须与对账同账本');
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
