import { describe, it, expect } from 'vitest';
import {
  lineTotal,
  orderTotal,
  orderRevenueEntry,
  collectionEntry,
  allocateCustomerPayments,
  agingBuckets,
  outstandingCharges,
  creditPurchaseEntry,
  supplierPaymentEntry,
  purchaseTotal,
  accountBalance,
  isBalanced,
  toMinor,
} from '../src/index';

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe('orderTotal / lineTotal', () => {
  it('整数数量 × 单价', () => {
    expect(lineTotal({ qty: 3, unitPrice: toMinor(12.5) })).toBe(3750);
  });

  it('小数数量四舍五入到整数分', () => {
    // 1.5 × ¥3.33 = ¥4.995 → 499.5 分 → 500
    expect(lineTotal({ qty: 1.5, unitPrice: 333 })).toBe(500);
  });

  it('总额 = 各行之和（逐行取整后相加）', () => {
    const lines = [
      { qty: 2, unitPrice: toMinor(10) },
      { qty: 1.5, unitPrice: 333 },
    ];
    expect(orderTotal(lines)).toBe(2000 + 500);
  });

  it('空订单总额为 0', () => {
    expect(orderTotal([])).toBe(0);
  });

  it('采购单总额逐行取整后相加', () => {
    expect(purchaseTotal([{ qty: 2, unitCost: toMinor(30) }, { qty: 1.5, unitCost: 333 }])).toBe(6000 + 500);
    expect(purchaseTotal([])).toBe(0);
  });
});

describe('orderRevenueEntry（确认收入）', () => {
  it('借应收（资产+）贷营业收入（收入−），平衡', () => {
    const t = orderRevenueEntry(
      { bookId: 'b1', date: '2026-06-10', amount: toMinor(2500), receivableAccountId: 'ar-c1', revenueAccountId: 'rev', payee: '张三' },
      counter(),
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.bookId).toBe('b1');
    expect(t.payee).toBe('张三');
    expect(t.postings.find((p) => p.accountId === 'ar-c1')!.amount).toBe(250000);
    expect(t.postings.find((p) => p.accountId === 'rev')!.amount).toBe(-250000);
  });
});

describe('collectionEntry（收款核销）', () => {
  it('钱从应收转入收款账户，平衡', () => {
    const t = collectionEntry(
      { bookId: 'b1', date: '2026-06-11', amount: toMinor(1000), receivableAccountId: 'ar-c1', assetAccountId: 'wechat' },
      counter(),
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.postings.find((p) => p.accountId === 'wechat')!.amount).toBe(100000);
    expect(t.postings.find((p) => p.accountId === 'ar-c1')!.amount).toBe(-100000);
  });
});

describe('creditPurchaseEntry（赊购入库）', () => {
  it('借库存商品（资产+）贷应付账款（负债+→负），平衡；应付欠款累计为负', () => {
    const gen = counter();
    const t = creditPurchaseEntry(
      { bookId: 'b1', date: '2026-06-10', amount: toMinor(900), payableAccountId: 'ap-s1', inventoryAccountId: 'inv', payee: '五金批发商' },
      gen,
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.postings.find((p) => p.accountId === 'inv')!.amount).toBe(90000); // 库存 +
    expect(t.postings.find((p) => p.accountId === 'ap-s1')!.amount).toBe(-90000); // 应付 −（欠 ¥900）
    expect(accountBalance([t], 'ap-s1')).toBe(-90000);
  });
});

describe('supplierPaymentEntry（付供应商货款）', () => {
  it('钱从付款账户转入应付，冲减欠款，平衡', () => {
    const gen = counter();
    const buy = creditPurchaseEntry(
      { bookId: 'b1', date: '2026-06-10', amount: toMinor(900), payableAccountId: 'ap-s1', inventoryAccountId: 'inv' },
      gen,
    );
    const pay = supplierPaymentEntry(
      { bookId: 'b1', date: '2026-06-11', amount: toMinor(500), payableAccountId: 'ap-s1', assetAccountId: '对公账户' },
      gen,
    );
    expect(isBalanced(pay.postings)).toBe(true);
    expect(pay.postings.find((p) => p.accountId === 'ap-s1')!.amount).toBe(50000); // 应付 +（欠款减）
    expect(pay.postings.find((p) => p.accountId === '对公账户')!.amount).toBe(-50000); // 资产 −
    expect(accountBalance([buy, pay], 'ap-s1')).toBe(-40000); // 还欠 ¥400
  });
});

describe('应收余额 = 应收子科目余额（从分录聚合）', () => {
  it('完成订单后应收=总额；部分收款后应收=余款', () => {
    const gen = counter();
    const rev = orderRevenueEntry(
      { bookId: 'b1', date: '2026-06-10', amount: toMinor(2500), receivableAccountId: 'ar-c1', revenueAccountId: 'rev' },
      gen,
    );
    expect(accountBalance([rev], 'ar-c1')).toBe(250000);

    const collect = collectionEntry(
      { bookId: 'b1', date: '2026-06-11', amount: toMinor(1000), receivableAccountId: 'ar-c1', assetAccountId: 'wechat' },
      gen,
    );
    const txns = [rev, collect];
    expect(accountBalance(txns, 'ar-c1')).toBe(150000); // 还欠 ¥1500
    expect(accountBalance(txns, 'wechat')).toBe(100000); // 已收 ¥1000
    expect(accountBalance(txns, 'rev')).toBe(-250000); // 收入累计 ¥2500（收入科目余额为负）
  });
});

describe('allocateCustomerPayments（按单归属 + FIFO 顺延）', () => {
  const o = (id: string, total: number, date: string) => ({ id, total, date });
  // 未指定 orderId 的整笔收款（等价旧的「累计已收」FIFO 行为）
  const pool = (amount: number) => [{ orderId: null, amount }];

  it('未收：collected=0 全部 unpaid，应收=总额', () => {
    const r = allocateCustomerPayments([o('a', 10000, '2026-06-01')], pool(0));
    expect(r.allocations[0]!.status).toBe('unpaid');
    expect(r.receivable).toBe(10000);
    expect(r.prepaid).toBe(0);
  });

  it('部分收：单笔收一半 → partial，应收=余款', () => {
    const r = allocateCustomerPayments([o('a', 10000, '2026-06-01')], pool(8000));
    expect(r.allocations[0]).toMatchObject({ collected: 8000, status: 'partial' });
    expect(r.receivable).toBe(2000);
  });

  it('已收清：收满 → paid', () => {
    const r = allocateCustomerPayments([o('a', 10000, '2026-06-01')], pool(10000));
    expect(r.allocations[0]!.status).toBe('paid');
    expect(r.receivable).toBe(0);
    expect(r.prepaid).toBe(0);
  });

  it('多收：收款 > 总额 → 全部 paid + 预收 credit', () => {
    const r = allocateCustomerPayments([o('a', 10000, '2026-06-01')], pool(12000));
    expect(r.allocations[0]!.status).toBe('paid');
    expect(r.receivable).toBe(0);
    expect(r.prepaid).toBe(2000);
  });

  it('未指定收款按 FIFO 顺延：先还最早的单，多付滚到后续单', () => {
    // 两单 ¥100 + ¥50，未指定共收 ¥120 → 早单还清(100)、晚单部分(20)、欠 30
    const r = allocateCustomerPayments([o('late', 5000, '2026-06-05'), o('early', 10000, '2026-06-01')], pool(12000));
    const early = r.allocations.find((a) => a.orderId === 'early')!;
    const late = r.allocations.find((a) => a.orderId === 'late')!;
    expect(early).toMatchObject({ collected: 10000, status: 'paid' });
    expect(late).toMatchObject({ collected: 2000, status: 'partial' });
    expect(r.receivable).toBe(3000);
    expect(r.allocations.map((a) => a.orderId)).toEqual(['early', 'late']);
  });

  it('收款按订单归属：指定单收款只记到该单，不串到别的单（复现用户 bug）', () => {
    // early ¥100（先开、未收）、late ¥50（后开）。只在 late 上收 ¥50。
    const orders = [o('early', 10000, '2026-06-01'), o('late', 5000, '2026-06-05')];
    const r = allocateCustomerPayments(orders, [{ orderId: 'late', amount: 5000 }]);
    expect(r.allocations.find((a) => a.orderId === 'late')).toMatchObject({ collected: 5000, status: 'paid' });
    // 关键：early 不应被这笔串走，仍 unpaid 欠 ¥100（旧 FIFO 会把钱记到 early）
    expect(r.allocations.find((a) => a.orderId === 'early')).toMatchObject({ collected: 0, status: 'unpaid' });
    expect(r.receivable).toBe(10000);
    expect(r.prepaid).toBe(0);
  });

  it('指定单多付：超出部分顺延到别单（FIFO），再剩才是预收', () => {
    // early ¥100、late ¥50。在 late 上收 ¥130（超 late 本身 ¥80）→ late 收清，余 80 顺延 early。
    const orders = [o('early', 10000, '2026-06-01'), o('late', 5000, '2026-06-05')];
    const r = allocateCustomerPayments(orders, [{ orderId: 'late', amount: 13000 }]);
    expect(r.allocations.find((a) => a.orderId === 'late')).toMatchObject({ collected: 5000, status: 'paid' });
    expect(r.allocations.find((a) => a.orderId === 'early')).toMatchObject({ collected: 8000, status: 'partial' });
    expect(r.receivable).toBe(2000); // early 还欠 20
    expect(r.prepaid).toBe(0);
  });
});

describe('agingBuckets（应收账龄分桶）', () => {
  it('按账龄归入 0–30 / 31–60 / 61–90 / 90+ 桶（含边界）', () => {
    const r = agingBuckets([
      { amount: 100, days: 0 },
      { amount: 200, days: 30 }, // 边界 → 0–30
      { amount: 400, days: 31 }, // → 31–60
      { amount: 800, days: 90 }, // 边界 → 61–90
      { amount: 1600, days: 91 }, // → 90+
    ]);
    expect(r.d0_30).toBe(300);
    expect(r.d31_60).toBe(400);
    expect(r.d61_90).toBe(800);
    expect(r.over90).toBe(1600);
    expect(r.total).toBe(3100);
  });

  it('空列表全 0', () => {
    expect(agingBuckets([])).toEqual({ d0_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 });
  });
});

describe('outstandingCharges（应付 FIFO 摊还）', () => {
  it('还款按时间序顺延抵掉最早赊欠，返回仍欠的', () => {
    const charges = [{ amount: 5000, date: '2026-06-05' }, { amount: 10000, date: '2026-06-01' }];
    // 还 ¥120 → 先抵早单(100 清)、晚单部分(20)，仍欠晚单 30
    expect(outstandingCharges(charges, 12000)).toEqual([{ amount: 3000, date: '2026-06-05' }]);
    expect(outstandingCharges(charges, 0)).toEqual([{ amount: 10000, date: '2026-06-01' }, { amount: 5000, date: '2026-06-05' }]);
    expect(outstandingCharges(charges, 15000)).toEqual([]); // 全清
    expect(outstandingCharges(charges, 20000)).toEqual([]); // 超额（预付）也算清
  });
});
