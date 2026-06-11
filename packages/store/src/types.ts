import type { Account, Book, Budget, Customer, Order, OrderStatus, Product, Reconciliation, Settlement, Transaction } from '@app/core';

/** 每条记录都带的同步元数据，为将来的云同步预留。 */
export interface SyncMeta {
  createdAt: string;
  updatedAt: string;
  /** 软删除：保留行、标记删除，便于同步与撤销 */
  deleted: boolean;
}

export type StoredBook = Book & SyncMeta;
export type StoredAccount = Account & SyncMeta;
export type StoredTransaction = Transaction & SyncMeta;
export type StoredBudget = Budget & SyncMeta;
export type StoredCustomer = Customer & SyncMeta;
export type StoredOrder = Order & SyncMeta;
export type StoredSettlement = Settlement & SyncMeta;
export type StoredProduct = Product & SyncMeta;
export type StoredReconciliation = Reconciliation & SyncMeta;

/**
 * 通用设置项（KV）。scope = 'app' 为应用级，或某账本 id 为账本级。
 * value 为字符串，语义由读取方解释（枚举直接存字面值、复杂值存 JSON）。
 * 记账口径/对账周期/多币种汇率表等共用此表，避免逐功能建表。
 */
export interface StoredSetting {
  scope: string;
  key: string;
  value: string;
  updatedAt: string;
}

/** 时钟注入：返回 ISO 时间戳；默认实现用 Date，测试注入确定性时钟。 */
export type Clock = () => string;

export interface BookPatch {
  name?: string;
  archived?: boolean;
}

export interface AccountPatch {
  name?: string;
  type?: Account['type'];
  parentId?: string | null;
  currency?: string;
  archived?: boolean;
}

export interface BudgetPatch {
  accountId?: string;
  monthlyLimit?: number;
}

export interface CustomerPatch {
  name?: string;
  phone?: string;
  note?: string;
  dueDays?: number;
  archived?: boolean;
}

/** B 期订单创建后行不可改（改 = 取消重建）；只允许改状态/备注/收入分录关联。 */
export interface OrderPatch {
  status?: OrderStatus;
  note?: string;
  revenueTxnId?: string | null;
}

export interface ProductPatch {
  name?: string;
  costPrice?: number;
  salePrice?: number;
  isStock?: boolean;
  unit?: string;
  archived?: boolean;
}

export interface TxnQuery {
  /** 仅该账本的交易 */
  bookId?: string;
  /** 闭区间起始日期 YYYY-MM-DD */
  from?: string;
  /** 闭区间结束日期 */
  to?: string;
  /** 仅含该标签的交易 */
  tag?: string;
  /** 仅含触及该账户的交易 */
  accountId?: string;
}

/**
 * 平台无关的持久层接口。InMemory / node:sqlite / tauri-plugin-sql 三个实现
 * 遵循同一契约；UI 只依赖此接口。
 *
 * 多账本约束（实现负责校验）：
 * - 账户必须挂在已存在的账本上；
 * - 一笔交易的全部分录账户必须与交易同账本（禁止跨账本分录）；
 * - 交易不可移动到其他账本；预算科目必须与预算同账本。
 */
export interface Repository {
  addBook(book: Book): Promise<StoredBook>;
  getBook(id: string): Promise<StoredBook | null>;
  listBooks(opts?: { includeArchived?: boolean }): Promise<StoredBook[]>;
  updateBook(id: string, patch: BookPatch): Promise<StoredBook>;

  addAccount(account: Account): Promise<StoredAccount>;
  getAccount(id: string): Promise<StoredAccount | null>;
  listAccounts(opts?: { includeArchived?: boolean; bookId?: string }): Promise<StoredAccount[]>;
  updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount>;

  addTransaction(txn: Transaction): Promise<StoredTransaction>;
  getTransaction(id: string): Promise<StoredTransaction | null>;
  listTransactions(query?: TxnQuery): Promise<StoredTransaction[]>;
  updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction>;
  softDeleteTransaction(id: string): Promise<void>;

  addBudget(budget: Budget): Promise<StoredBudget>;
  listBudgets(query?: { bookId?: string }): Promise<StoredBudget[]>;
  updateBudget(id: string, patch: BudgetPatch): Promise<StoredBudget>;
  removeBudget(id: string): Promise<void>;

  // 生意（v0.2 B 期）：客户 / 订单 / 收款。约束（实现负责校验）：
  // - 客户/订单/收款必须挂在已存在的账本上；
  // - 订单的客户、收款的客户/关联订单必须与单据同账本。
  addCustomer(customer: Customer): Promise<StoredCustomer>;
  getCustomer(id: string): Promise<StoredCustomer | null>;
  listCustomers(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredCustomer[]>;
  updateCustomer(id: string, patch: CustomerPatch): Promise<StoredCustomer>;

  addOrder(order: Order): Promise<StoredOrder>;
  getOrder(id: string): Promise<StoredOrder | null>;
  listOrders(query?: { bookId?: string; customerId?: string; status?: OrderStatus }): Promise<StoredOrder[]>;
  updateOrder(id: string, patch: OrderPatch): Promise<StoredOrder>;

  addSettlement(settlement: Settlement): Promise<StoredSettlement>;
  listSettlements(query?: { bookId?: string; orderId?: string; counterpartyId?: string }): Promise<StoredSettlement[]>;

  addProduct(product: Product): Promise<StoredProduct>;
  getProduct(id: string): Promise<StoredProduct | null>;
  listProducts(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredProduct[]>;
  updateProduct(id: string, patch: ProductPatch): Promise<StoredProduct>;

  // 通用设置（KV）：scope='app' 或账本 id。setSetting 为 upsert（同 scope+key 覆盖）。
  getSetting(scope: string, key: string): Promise<StoredSetting | null>;
  setSetting(scope: string, key: string, value: string): Promise<StoredSetting>;
  listSettings(scope?: string): Promise<StoredSetting[]>;

  // 月度对账：标记分录已核销 + 记录完成的对账会话。补录/改/删纠错复用现有交易 CRUD。
  // setPostingsCleared 直接按 posting id 批量置位（完成对账时写入勾选状态全集）。
  setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void>;
  addReconciliation(rec: Reconciliation): Promise<StoredReconciliation>;
  listReconciliations(query?: { bookId?: string; accountId?: string }): Promise<StoredReconciliation[]>;
}
