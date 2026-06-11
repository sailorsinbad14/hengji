import type { Account, Book, Budget, Customer, Order, OrderStatus, Settlement, Transaction } from '@app/core';

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
}
