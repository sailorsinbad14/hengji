import type { Account, Book, InventoryKind, OrderLine, Posting, SettlementDirection, CounterpartyType, OrderStatus } from '@app/core';
import type {
  StoredAccount,
  StoredBook,
  StoredBudget,
  StoredCustomer,
  StoredInventoryMovement,
  StoredOrder,
  StoredProduct,
  StoredSupplier,
  StoredReconciliation,
  StoredSetting,
  StoredSettlement,
  StoredTransaction,
} from './types';

/**
 * 行映射（浏览器安全，无驱动依赖）。
 * 建表与演进见 ./migrations —— node:sqlite 与 tauri-plugin-sql 两实现共用，
 * 保证桌面与测试环境的数据形状完全一致。
 */

export interface BookRow {
  id: string;
  name: string;
  type: string;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface AccountRow {
  id: string;
  book_id: string;
  name: string;
  type: string;
  parent_id: string | null;
  currency: string;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface TxnRow {
  id: string;
  book_id: string;
  date: string;
  payee: string;
  note: string;
  tags: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface PostingRow {
  id: string;
  txn_id: string;
  account_id: string;
  amount: number;
  currency: string;
  cleared: number;
}
export interface BudgetRow {
  id: string;
  book_id: string;
  account_id: string;
  monthly_limit: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface CustomerRow {
  id: string;
  book_id: string;
  name: string;
  phone: string;
  note: string;
  due_days: number;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
/** suppliers 表行（结构同 customers）。 */
export type SupplierRow = CustomerRow;
export interface OrderRow {
  id: string;
  book_id: string;
  customer_id: string;
  date: string;
  currency: string;
  status: string;
  note: string;
  revenue_txn_id: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface OrderLineRow {
  id: string;
  order_id: string;
  name: string;
  qty: number;
  unit_price: number;
  product_id: string | null;
}
export interface ProductRow {
  id: string;
  book_id: string;
  name: string;
  cost_price: number;
  sale_price: number;
  is_stock: number;
  unit: string;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface SettlementRow {
  id: string;
  book_id: string;
  direction: string;
  counterparty_type: string;
  counterparty_id: string;
  order_id: string | null;
  amount: number;
  date: string;
  account_id: string;
  note: string;
  txn_id: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface SettingRow {
  scope: string;
  key: string;
  value: string;
  updated_at: string;
}
export interface ReconciliationRow {
  id: string;
  book_id: string;
  account_id: string;
  statement_balance: number;
  statement_date: string;
  completed_at: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface InventoryMovementRow {
  id: string;
  book_id: string;
  product_id: string;
  date: string;
  kind: string;
  qty: number;
  unit_cost: number;
  order_id: string | null;
  txn_id: string | null;
  note: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}

/** 把数组按 size 切片，避免 `IN (?,?,…)` 占位符超过 SQLite 变量上限（旧版 999/新版 32766）。 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 安全解析 tags JSON：坏数据降级为空数组，避免单行损坏炸掉整个列表查询。 */
export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function toBook(r: BookRow): StoredBook {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Book['type'],
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toAccount(r: AccountRow): StoredAccount {
  return {
    id: r.id,
    bookId: r.book_id,
    name: r.name,
    type: r.type as Account['type'],
    parentId: r.parent_id,
    currency: r.currency,
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toPosting(r: PostingRow): Posting {
  return { id: r.id, txnId: r.txn_id, accountId: r.account_id, amount: r.amount, currency: r.currency, cleared: r.cleared !== 0 };
}

export function toBudget(r: BudgetRow): StoredBudget {
  return {
    id: r.id,
    bookId: r.book_id,
    accountId: r.account_id,
    monthlyLimit: r.monthly_limit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toCustomer(r: CustomerRow): StoredCustomer {
  return {
    id: r.id,
    bookId: r.book_id,
    name: r.name,
    phone: r.phone,
    note: r.note,
    dueDays: r.due_days,
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

/** suppliers 行 → StoredSupplier（结构同 customers）。 */
export function toSupplier(r: SupplierRow): StoredSupplier {
  return {
    id: r.id,
    bookId: r.book_id,
    name: r.name,
    phone: r.phone,
    note: r.note,
    dueDays: r.due_days,
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toOrderLine(r: OrderLineRow): OrderLine {
  return { id: r.id, orderId: r.order_id, name: r.name, qty: r.qty, unitPrice: r.unit_price, productId: r.product_id };
}

export function toProduct(r: ProductRow): StoredProduct {
  return {
    id: r.id,
    bookId: r.book_id,
    name: r.name,
    costPrice: r.cost_price,
    salePrice: r.sale_price,
    isStock: r.is_stock !== 0,
    unit: r.unit,
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toOrder(r: OrderRow, lines: OrderLine[]): StoredOrder {
  return {
    id: r.id,
    bookId: r.book_id,
    customerId: r.customer_id,
    date: r.date,
    currency: r.currency,
    status: r.status as OrderStatus,
    note: r.note,
    revenueTxnId: r.revenue_txn_id,
    lines,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toSettlement(r: SettlementRow): StoredSettlement {
  return {
    id: r.id,
    bookId: r.book_id,
    direction: r.direction as SettlementDirection,
    counterpartyType: r.counterparty_type as CounterpartyType,
    counterpartyId: r.counterparty_id,
    orderId: r.order_id,
    amount: r.amount,
    date: r.date,
    accountId: r.account_id,
    note: r.note,
    txnId: r.txn_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toSetting(r: SettingRow): StoredSetting {
  return { scope: r.scope, key: r.key, value: r.value, updatedAt: r.updated_at };
}

export function toReconciliation(r: ReconciliationRow): StoredReconciliation {
  return {
    id: r.id,
    bookId: r.book_id,
    accountId: r.account_id,
    statementBalance: r.statement_balance,
    statementDate: r.statement_date,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toInventoryMovement(r: InventoryMovementRow): StoredInventoryMovement {
  return {
    id: r.id,
    bookId: r.book_id,
    productId: r.product_id,
    date: r.date,
    kind: r.kind as InventoryKind,
    qty: r.qty,
    unitCost: r.unit_cost,
    orderId: r.order_id,
    txnId: r.txn_id,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toTxn(r: TxnRow, postings: Posting[]): StoredTransaction {
  return {
    id: r.id,
    bookId: r.book_id,
    date: r.date,
    payee: r.payee,
    note: r.note,
    tags: parseTags(r.tags),
    postings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}
