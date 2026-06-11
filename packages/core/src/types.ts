/**
 * 复式记账领域类型（平台无关、无 I/O）。
 *
 * 约定（beancount 风格的有符号记账）：
 * - 金额一律用「整数最小单位」（CNY 即「分」），杜绝浮点误差。
 * - 每笔交易的所有 posting 金额之和恒为 0（借贷平衡）。
 * - 账户余额 = 该账户所有 posting 金额之和。
 *   资产/费用余额通常为正，负债/收入/权益通常为负。
 *
 * 多账本（v0.2）：
 * - Book 是顶层容器（个人/生意/投资，可各建多个）；
 *   账户/交易/预算全部挂 bookId，一笔交易的所有分录必须属于同一账本。
 */

export type BookType = 'personal' | 'business' | 'investment';

export interface Book {
  id: string;
  name: string;
  type: BookType;
  archived: boolean;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: string;
  bookId: string;
  name: string;
  type: AccountType;
  /** 层级科目；顶层为 null */
  parentId: string | null;
  /** ISO 4217；MVP 单一本位币 'CNY' */
  currency: string;
  archived: boolean;
}

/** 有符号的整数最小单位（如 CNY 的「分」）。 */
export type Minor = number;

export interface Posting {
  id: string;
  txnId: string;
  accountId: string;
  /** 有符号最小单位；同一交易下所有 posting 之和 === 0 */
  amount: Minor;
  currency: string;
}

export interface Transaction {
  id: string;
  bookId: string;
  /** 记账日期 YYYY-MM-DD */
  date: string;
  payee: string;
  note: string;
  /** 维度标签（自由扩展；生意/个人之分已由账本承担） */
  tags: string[];
  postings: Posting[];
}

export interface Budget {
  id: string;
  bookId: string;
  /** 预算针对的科目（通常是费用科目） */
  accountId: string;
  /** 每月限额（minor units） */
  monthlyLimit: number;
}

/**
 * 生意系统（v0.2 B 期）：客户 / 订单 / 收款。
 * 业务单据是操作层，财务动作（订单完成确认收入、收款核销）自动生成平衡分录进复式内核，
 * 报表/应收余额从分录聚合——不另立平行账。见 ARCHITECTURE.md「多账本与生意系统」。
 */

export interface Customer {
  id: string;
  bookId: string;
  name: string;
  phone: string;
  note: string;
  /** 默认账期天数；到期日 = 订单日期 + dueDays。0 = 货到付款/即时 */
  dueDays: number;
  archived: boolean;
}

/** 待采购 / 待发货 / 已发货 / 已完成 / 已取消。B 期仅用 待发货→已完成/已取消；其余留 C 期代采。 */
export type OrderStatus = 'pending_purchase' | 'pending_ship' | 'shipped' | 'completed' | 'cancelled';

export interface OrderLine {
  id: string;
  orderId: string;
  /** 自由文本商品名（B 期；商品主数据留 C 期） */
  name: string;
  /** 数量（可含小数，如按重量计） */
  qty: number;
  /** 单价（最小单位/分） */
  unitPrice: Minor;
}

export interface Order {
  id: string;
  bookId: string;
  customerId: string;
  /** 下单日期 YYYY-MM-DD */
  date: string;
  status: OrderStatus;
  note: string;
  /** 已完成时生成的收入确认分录 id；未完成为 null */
  revenueTxnId: string | null;
  lines: OrderLine[];
}

export type SettlementMethod = 'wechat' | 'alipay' | 'bank' | 'cash' | 'other';
/** in = 收款（来自客户）；out = 付款（给供应商，C 期）。 */
export type SettlementDirection = 'in' | 'out';
export type CounterpartyType = 'customer' | 'supplier';

export interface Settlement {
  id: string;
  bookId: string;
  direction: SettlementDirection;
  counterpartyType: CounterpartyType;
  /** customerId（B 期）/ supplierId（C 期） */
  counterpartyId: string;
  /** 可选关联单据 */
  orderId: string | null;
  /** 正数最小单位 */
  amount: Minor;
  date: string;
  method: SettlementMethod;
  /** 收/付款使用的资产账户（微信商户/对公账户/现金…） */
  accountId: string;
  note: string;
  /** 生成的核销分录 id */
  txnId: string | null;
}
