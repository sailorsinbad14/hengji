import type { OrderLine, Transaction } from './types';
import { expandEntry } from './ledger';

/**
 * 生意单据 → 复式分录（纯函数，账户由调用方解析后注入 id）。
 * B 期两笔自动分录都复用 expandEntry：确认收入 = income，收款核销 = transfer。
 */

/** 单行金额（最小单位）：数量 × 单价，四舍五入到整数分以守住「金额=整数分」不变式。 */
export function lineTotal(line: Pick<OrderLine, 'qty' | 'unitPrice'>): number {
  return Math.round(line.qty * line.unitPrice);
}

/** 订单总额（最小单位）= 各行金额之和。 */
export function orderTotal(lines: ReadonlyArray<Pick<OrderLine, 'qty' | 'unitPrice'>>): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

interface EntryOpts {
  bookId: string;
  date: string;
  /** 正数最小单位 */
  amount: number;
  payee?: string;
  note?: string;
  currency?: string;
}

/**
 * 订单完成 → 确认收入（赊销）：借 应收账款/客户（资产+），贷 营业收入（收入−）。
 * income 展开：accountId=应收子科目，categoryId=营业收入科目。
 */
export function orderRevenueEntry(
  opts: EntryOpts & { receivableAccountId: string; revenueAccountId: string },
  genId: () => string,
): Transaction {
  return expandEntry(
    {
      kind: 'income',
      bookId: opts.bookId,
      date: opts.date,
      amount: opts.amount,
      accountId: opts.receivableAccountId,
      categoryId: opts.revenueAccountId,
      payee: opts.payee,
      note: opts.note,
      currency: opts.currency,
    },
    genId,
  );
}

/**
 * 收款核销：钱从 应收账款/客户（资产）转入收款资产账户（微信商户/对公账户…）。
 * transfer 展开：fromAccountId=应收子科目，toAccountId=收款账户。净资产不变，只是应收转为现金。
 */
export function collectionEntry(
  opts: EntryOpts & { receivableAccountId: string; assetAccountId: string },
  genId: () => string,
): Transaction {
  return expandEntry(
    {
      kind: 'transfer',
      bookId: opts.bookId,
      date: opts.date,
      amount: opts.amount,
      fromAccountId: opts.receivableAccountId,
      toAccountId: opts.assetAccountId,
      payee: opts.payee,
      note: opts.note,
      currency: opts.currency,
    },
    genId,
  );
}

/**
 * 赊购入库（C2 应付）：借 库存商品（资产+），贷 应付账款/供应商（负债+，欠款增）。
 * transfer 展开：fromAccountId=应付子科目，toAccountId=库存商品。负债账户余额为负，欠得越多越负。
 */
export function creditPurchaseEntry(
  opts: EntryOpts & { payableAccountId: string; inventoryAccountId: string },
  genId: () => string,
): Transaction {
  return expandEntry(
    {
      kind: 'transfer',
      bookId: opts.bookId,
      date: opts.date,
      amount: opts.amount,
      fromAccountId: opts.payableAccountId,
      toAccountId: opts.inventoryAccountId,
      payee: opts.payee,
      note: opts.note,
      currency: opts.currency,
    },
    genId,
  );
}

/**
 * 付供应商货款：钱从付款资产账户转入 应付账款/供应商（冲减欠款）。
 * transfer 展开：fromAccountId=付款资产账户，toAccountId=应付子科目。净资产不变，应付转为现金流出。
 */
export function supplierPaymentEntry(
  opts: EntryOpts & { payableAccountId: string; assetAccountId: string },
  genId: () => string,
): Transaction {
  return expandEntry(
    {
      kind: 'transfer',
      bookId: opts.bookId,
      date: opts.date,
      amount: opts.amount,
      fromAccountId: opts.assetAccountId,
      toAccountId: opts.payableAccountId,
      payee: opts.payee,
      note: opts.note,
      currency: opts.currency,
    },
    genId,
  );
}

/** 单个订单的收款状态。 */
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid';

export interface OrderAllocation {
  orderId: string;
  total: number;
  /** FIFO 摊到本单的已收金额（最小单位） */
  collected: number;
  status: OrderPaymentStatus;
}

export interface CustomerLedger {
  /** 各已完成订单的收款分摊（按下单先后） */
  allocations: OrderAllocation[];
  /** 客户欠你（净额，≥0） */
  receivable: number;
  /** 你欠客户 / 预收（净额，≥0）——多付的钱，可抵后续订单 */
  prepaid: number;
}

/** 一笔收款：orderId 指定它收的是哪张单（null = 未指定，走 FIFO 顺延）。 */
export interface CustomerPayment {
  orderId: string | null;
  /** 正数最小单位 */
  amount: number;
}

/**
 * 把客户的收款按「单据归属」摊到其已完成订单，再算净应收/预收：
 * 1) 指定了 orderId 的收款先记到该单（封顶到单据总额，超出进余款池）；
 * 2) 未指定的收款 + 各单多付的余款，按下单先后（FIFO）顺延补到仍欠款的单；
 * 3) 全部补满后还剩，即客户预收（credit）。
 * 这样在某张单上记的收款只算到那张单，不会串到别的单（除非确有多付才顺延）。
 * @param orders 该客户的已完成订单（id + total 最小单位 + date）
 * @param payments 该客户的收款明细（带 orderId）；金额负数按 0 处理
 */
export function allocateCustomerPayments(
  orders: ReadonlyArray<{ id: string; total: number; date: string }>,
  payments: ReadonlyArray<CustomerPayment>,
): CustomerLedger {
  const sorted = [...orders].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const orderIds = new Set(sorted.map((o) => o.id));

  // 1) 归集指定收款；未指定 / 指向不存在订单的，进 FIFO 池
  const targeted = new Map<string, number>();
  let pool = 0;
  for (const p of payments) {
    const amt = Math.max(0, p.amount);
    if (p.orderId !== null && orderIds.has(p.orderId)) {
      targeted.set(p.orderId, (targeted.get(p.orderId) ?? 0) + amt);
    } else {
      pool += amt;
    }
  }

  // 2) 每单先吃自己被指定的收款（封顶），超出部分汇入 FIFO 池
  const collectedBy = new Map<string, number>();
  for (const o of sorted) {
    const direct = targeted.get(o.id) ?? 0;
    collectedBy.set(o.id, Math.min(direct, o.total));
    if (direct > o.total) pool += direct - o.total;
  }

  // 3) 池子按下单先后补到仍欠款的单
  for (const o of sorted) {
    if (pool <= 0) break;
    const cur = collectedBy.get(o.id)!;
    const need = o.total - cur;
    if (need <= 0) continue;
    const add = Math.min(pool, need);
    collectedBy.set(o.id, cur + add);
    pool -= add;
  }

  const allocations: OrderAllocation[] = sorted.map((o) => {
    const collected = collectedBy.get(o.id)!;
    const status: OrderPaymentStatus = collected <= 0 ? 'unpaid' : collected < o.total ? 'partial' : 'paid';
    return { orderId: o.id, total: o.total, collected, status };
  });
  const totalOrdered = sorted.reduce((s, o) => s + o.total, 0);
  const totalPaid = payments.reduce((s, p) => s + Math.max(0, p.amount), 0);
  return {
    allocations,
    receivable: Math.max(0, totalOrdered - totalPaid),
    prepaid: Math.max(0, totalPaid - totalOrdered),
  };
}

/** 应收账龄分桶（金额单位由调用方统一，如已折算到展示币种的最小单位）。 */
export interface AgingBuckets {
  /** 0–30 天 */
  d0_30: number;
  /** 31–60 天 */
  d31_60: number;
  /** 61–90 天 */
  d61_90: number;
  /** 90 天以上 */
  over90: number;
  /** 合计 */
  total: number;
}

/**
 * 应收账龄分桶：按每笔欠款的账龄（自开票/下单日起的天数）归入 0–30 / 31–60 / 61–90 / 90+ 桶。
 * 边界归入较小桶：30→0–30、60→31–60、90→61–90、91→90+。金额单位需调用方统一（混合币种应先折算）。
 */
export function agingBuckets(items: ReadonlyArray<{ amount: number; days: number }>): AgingBuckets {
  const b: AgingBuckets = { d0_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const { amount, days } of items) {
    if (days <= 30) b.d0_30 += amount;
    else if (days <= 60) b.d31_60 += amount;
    else if (days <= 90) b.d61_90 += amount;
    else b.over90 += amount;
    b.total += amount;
  }
  return b;
}
