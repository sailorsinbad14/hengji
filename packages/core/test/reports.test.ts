import { describe, it, expect, beforeEach } from 'vitest';
import { expandEntry, accountBalance, netWorth, incomeExpense, balancesByCurrency, convertAmount, dailyTotals } from '../src/index';
import type { Account, ConvertCtx, Transaction } from '../src/index';

const B = 'b1';

const accounts: Account[] = [
  { id: 'bank', bookId: B, name: '招行卡', type: 'asset', parentId: null, currency: 'CNY', archived: false },
  { id: 'alipay', bookId: B, name: '支付宝', type: 'asset', parentId: null, currency: 'CNY', archived: false },
  { id: 'invest', bookId: B, name: '投资账户', type: 'asset', parentId: null, currency: 'CNY', archived: false },
  { id: 'card', bookId: B, name: '信用卡', type: 'liability', parentId: null, currency: 'CNY', archived: false },
  { id: 'food', bookId: B, name: '餐饮', type: 'expense', parentId: null, currency: 'CNY', archived: false },
  { id: 'supply', bookId: B, name: '进货成本', type: 'expense', parentId: null, currency: 'CNY', archived: false },
  { id: 'salary', bookId: B, name: '工资', type: 'income', parentId: null, currency: 'CNY', archived: false },
  { id: 'sales', bookId: B, name: '营业收入', type: 'income', parentId: null, currency: 'CNY', archived: false },
];

function build(): Transaction[] {
  let n = 0;
  const gen = (): string => `id${++n}`;
  return [
    expandEntry({ kind: 'income', bookId: B, date: '2026-05-01', amount: 500000, accountId: 'bank', categoryId: 'salary' }, gen),
    expandEntry({ kind: 'expense', bookId: B, date: '2026-05-03', amount: 3000, accountId: 'bank', categoryId: 'food' }, gen),
    expandEntry({ kind: 'transfer', bookId: B, date: '2026-05-05', amount: 100000, fromAccountId: 'bank', toAccountId: 'alipay' }, gen),
    expandEntry({ kind: 'income', bookId: B, date: '2026-06-02', amount: 200000, accountId: 'alipay', categoryId: 'sales', tags: ['business'] }, gen),
    expandEntry({ kind: 'expense', bookId: B, date: '2026-06-03', amount: 80000, accountId: 'card', categoryId: 'supply', tags: ['business'] }, gen),
    expandEntry({ kind: 'transfer', bookId: B, date: '2026-05-10', amount: 100000, fromAccountId: 'bank', toAccountId: 'invest' }, gen),
  ];
}

describe('reports', () => {
  let txns: Transaction[];
  beforeEach(() => {
    txns = build();
  });

  it('accountBalance 汇总单账户', () => {
    expect(accountBalance(txns, 'bank')).toBe(297000); // 500000 -3000 -100000 -100000
    expect(accountBalance(txns, 'alipay')).toBe(300000); // 100000 + 200000
    expect(accountBalance(txns, 'invest')).toBe(100000);
    expect(accountBalance(txns, 'card')).toBe(-80000);
  });

  it('netWorth = 资产 + 负债（有符号）', () => {
    expect(netWorth(txns, accounts)).toBe(617000); // 297000 + 300000 + 100000 - 80000
  });

  it('incomeExpense 全期', () => {
    expect(incomeExpense(txns, accounts)).toEqual({ income: 700000, expense: 83000, net: 617000 });
  });

  it('incomeExpense 按 business 标签过滤', () => {
    expect(incomeExpense(txns, accounts, { tag: 'business' })).toEqual({ income: 200000, expense: 80000, net: 120000 });
  });

  it('incomeExpense 按时间区间（仅 5 月）', () => {
    expect(incomeExpense(txns, accounts, { period: { from: '2026-05-01', to: '2026-05-31' } })).toEqual({
      income: 500000,
      expense: 3000,
      net: 497000,
    });
  });

  describe('incomeExpense 收付实现制（basis: cash）', () => {
    // 赊销→回款场景：6 月完成订单确认收入 ¥2500（借应收 贷营业收入），同月仅回款 ¥1000。
    const ar: Account = { id: 'ar', bookId: B, name: '应收账款/张三', type: 'asset', parentId: null, currency: 'CNY', archived: false };
    function bizTxns(): Transaction[] {
      let n = 0;
      const gen = (): string => `c${++n}`;
      return [
        // 完成订单：借应收 250000 / 贷营业收入 250000
        { id: 'rev', bookId: B, date: '2026-06-05', payee: '张三', note: '', tags: [], postings: [
          { id: gen(), txnId: 'rev', accountId: 'ar', amount: 250000, currency: 'CNY' },
          { id: gen(), txnId: 'rev', accountId: 'sales', amount: -250000, currency: 'CNY' },
        ] },
        // 回款 100000：借银行 / 贷应收
        { id: 'col', bookId: B, date: '2026-06-08', payee: '张三', note: '', tags: [], postings: [
          { id: gen(), txnId: 'col', accountId: 'bank', amount: 100000, currency: 'CNY' },
          { id: gen(), txnId: 'col', accountId: 'ar', amount: -100000, currency: 'CNY' },
        ] },
      ];
    }
    const accts = [...accounts, ar];
    const period = { from: '2026-06-01', to: '2026-06-30' };

    it('权责发生制：确认即收入（全额 250000）', () => {
      expect(incomeExpense(bizTxns(), accts, { period, basis: 'accrual' }).income).toBe(250000);
    });

    it('收付实现制：只算实收（100000），需传应收科目 id', () => {
      const ie = incomeExpense(bizTxns(), accts, { period, basis: 'cash', receivableAccountIds: ['ar'] });
      expect(ie.income).toBe(100000); // 250000 − ΔAR(250000−100000=150000)
    });

    it('收付实现制不传应收 id 时退化为权责（无 AR 可抵）', () => {
      expect(incomeExpense(bizTxns(), accts, { period, basis: 'cash' }).income).toBe(250000);
    });

    it('预收（先收款后开单）：收款当期即计为实收', () => {
      let n = 0;
      const gen = (): string => `p${++n}`;
      const prepay: Transaction[] = [
        // 先收款 80000：借银行 / 贷应收（AR 转负 = 预收）
        { id: 'pre', bookId: B, date: '2026-06-02', payee: '李四', note: '', tags: [], postings: [
          { id: gen(), txnId: 'pre', accountId: 'bank', amount: 80000, currency: 'CNY' },
          { id: gen(), txnId: 'pre', accountId: 'ar', amount: -80000, currency: 'CNY' },
        ] },
      ];
      const ie = incomeExpense(prepay, accts, { period, basis: 'cash', receivableAccountIds: ['ar'] });
      expect(ie.income).toBe(80000); // 0 − ΔAR(−80000) = 80000
    });
  });

  describe('多币种折算', () => {
    const ctx: ConvertCtx = { rates: { USD: 7.1, CNY: 1 }, scales: { USD: 2, CNY: 2 }, display: 'CNY' };

    it('convertAmount：原币 → 展示币（同 scale 按汇率乘，展示币自身=1）', () => {
      expect(convertAmount(100000, 'USD', ctx)).toBe(710000); // $1000 → ¥7100
      expect(convertAmount(500000, 'CNY', ctx)).toBe(500000); // 展示币不折
      expect(convertAmount(100000, 'JPY', ctx)).toBe(100000); // 缺汇率按 1 兜底
    });

    it('convertAmount：展示币种非 CNY（除以展示币 rate）', () => {
      const usd: ConvertCtx = {
        rates: { USD: 7.1, BTC: 400000, CNY: 1 },
        scales: { USD: 2, BTC: 8, CNY: 2 },
        display: 'USD',
      };
      expect(convertAmount(710000, 'CNY', usd)).toBe(100000); // ¥7100 → $1000（÷7.1）
      expect(convertAmount(200000, 'USD', usd)).toBe(200000); // 展示币自身不折
      expect(convertAmount(5_000_000, 'BTC', usd)).toBe(281_690); // 0.05 BTC ×(400000/7.1)×10^(2−8)
    });

    it('convertAmount：跨小数位（BTC 8 位 / JPY 0 位 → CNY 2 位）', () => {
      const ctx2: ConvertCtx = {
        rates: { BTC: 400000, JPY: 0.05, CNY: 1 },
        scales: { BTC: 8, JPY: 0, CNY: 2 },
        display: 'CNY',
      };
      // 0.05 BTC = 5,000,000 minor(scale8) → 0.05×400000=¥20,000 = 2,000,000 minor(scale2)
      expect(convertAmount(5_000_000, 'BTC', ctx2)).toBe(2_000_000);
      // ¥10000 日元 = 10000 minor(scale0) → 10000×0.05=¥500 = 50,000 minor(scale2)
      expect(convertAmount(10_000, 'JPY', ctx2)).toBe(50_000);
    });

    // CNY 银行 ¥5000 + USD 账户 $1000 两个资产账户
    const mc: Account[] = [
      { id: 'cny', bookId: B, name: '招行卡', type: 'asset', parentId: null, currency: 'CNY', archived: false },
      { id: 'usd', bookId: B, name: '美元账户', type: 'asset', parentId: null, currency: 'USD', archived: false },
      { id: 'eq', bookId: B, name: '期初余额', type: 'equity', parentId: null, currency: 'CNY', archived: false },
    ];
    function mcTxns(): Transaction[] {
      let n = 0;
      const g = (): string => `m${++n}`;
      return [
        { id: 'o1', bookId: B, date: '2026-06-01', payee: '', note: '', tags: [], postings: [
          { id: g(), txnId: 'o1', accountId: 'cny', amount: 500000, currency: 'CNY' },
          { id: g(), txnId: 'o1', accountId: 'eq', amount: -500000, currency: 'CNY' },
        ] },
        { id: 'o2', bookId: B, date: '2026-06-01', payee: '', note: '', tags: [], postings: [
          { id: g(), txnId: 'o2', accountId: 'usd', amount: 100000, currency: 'USD' },
          { id: g(), txnId: 'o2', accountId: 'eq', amount: -100000, currency: 'USD' },
        ] },
      ];
    }

    it('balancesByCurrency：按币种分组原币小计', () => {
      const m = balancesByCurrency(mcTxns(), mc);
      expect(m.get('CNY')).toBe(500000); // ¥5000
      expect(m.get('USD')).toBe(100000); // $1000
    });

    it('netWorth 传 convert：折算到展示币种求和', () => {
      const nw = netWorth(mcTxns(), mc, ctx);
      expect(nw).toBe(500000 + 710000); // ¥5000 + ($1000×7.1)=¥7100 → ¥12100
    });

    it('netWorth 不传 convert：原样相加（向后兼容，单币种正确）', () => {
      const cnyOnly = mcTxns().filter((t) => t.id === 'o1');
      expect(netWorth(cnyOnly, mc)).toBe(500000);
    });
  });

  describe('dailyTotals', () => {
    it('按日聚合：转账不影响收支但计入笔数', () => {
      const m = dailyTotals(txns, accounts, '2026-05');
      expect(m.size).toBe(4);
      expect(m.get('2026-05-01')).toEqual({ income: 500000, expense: 0, net: 500000, count: 1 });
      expect(m.get('2026-05-03')).toEqual({ income: 0, expense: 3000, net: -3000, count: 1 });
      expect(m.get('2026-05-05')).toEqual({ income: 0, expense: 0, net: 0, count: 1 }); // bank→alipay 转账
      expect(m.get('2026-05-10')).toEqual({ income: 0, expense: 0, net: 0, count: 1 }); // bank→invest 转账
    });

    it('按日聚合：另一月份独立计算', () => {
      const m = dailyTotals(txns, accounts, '2026-06');
      expect(m.size).toBe(2);
      expect(m.get('2026-06-02')).toEqual({ income: 200000, expense: 0, net: 200000, count: 1 });
      expect(m.get('2026-06-03')).toEqual({ income: 0, expense: 80000, net: -80000, count: 1 });
    });

    it('空月/无交易返回空 Map', () => {
      expect(dailyTotals(txns, accounts, '2026-07').size).toBe(0);
      expect(dailyTotals([], accounts, '2026-05').size).toBe(0);
    });

    it('月份精确匹配：非规范前缀（2026-1 / 2026）不会错配其他月', () => {
      let n = 0;
      const gen = (): string => `dt${++n}`;
      const t2 = [
        expandEntry({ kind: 'expense', bookId: B, date: '2026-10-05', amount: 10000, accountId: 'bank', categoryId: 'food' }, gen),
        expandEntry({ kind: 'expense', bookId: B, date: '2026-01-05', amount: 20000, accountId: 'bank', categoryId: 'food' }, gen),
      ];
      expect(dailyTotals(t2, accounts, '2026-1').size).toBe(0);
      expect(dailyTotals(t2, accounts, '2026').size).toBe(0);
      expect(dailyTotals(t2, accounts, '2026-01').get('2026-01-05')?.expense).toBe(20000);
      expect(dailyTotals(t2, accounts, '2026-10').get('2026-10-05')?.expense).toBe(10000);
    });

    it('同日多笔累加，不覆盖', () => {
      let n = 0;
      const gen = (): string => `sd${++n}`;
      const sameDay = [
        expandEntry({ kind: 'income', bookId: B, date: '2026-06-15', amount: 100000, accountId: 'bank', categoryId: 'salary' }, gen),
        expandEntry({ kind: 'expense', bookId: B, date: '2026-06-15', amount: 30000, accountId: 'bank', categoryId: 'food' }, gen),
      ];
      expect(dailyTotals(sameDay, accounts, '2026-06').get('2026-06-15')).toEqual({
        income: 100000,
        expense: 30000,
        net: 70000,
        count: 2,
      });
    });
  });
});
