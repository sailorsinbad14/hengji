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
