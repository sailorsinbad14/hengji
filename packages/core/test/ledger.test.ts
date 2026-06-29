import { describe, it, expect } from 'vitest';
import { expandEntry, forexEntry, isBalanced, assertBalanced, balanceOf, reversalEntry, toMinor } from '../src/index';
import type { Transaction } from '../src/index';

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe('reversalEntry 红冲（增量2 撤销）', () => {
  it('逐腿取反、原交易不动、平衡、新 id/日期、不带 cleared', () => {
    const gen = counter(); // src 与 rev 共用一个计数器，id 不撞
    const src = expandEntry(
      { kind: 'transfer', bookId: 'b1', date: '2026-05-05', amount: 50000, fromAccountId: 'ar', toAccountId: 'bank' },
      gen,
    );
    // 模拟原交易某腿已对账
    src.postings[0]!.cleared = true;
    const rev = reversalEntry(src, { date: '2026-06-29', payee: '客户', note: '冲销收款' }, gen);
    expect(isBalanced(rev.postings)).toBe(true);
    expect(rev.id).not.toBe(src.id);
    expect(rev.date).toBe('2026-06-29'); // 落撤销当期，不回改历史
    expect(rev.bookId).toBe('b1');
    // 每条腿金额恰为原腿相反数（按账户配对）
    for (const sp of src.postings) {
      const rp = rev.postings.find((p) => p.accountId === sp.accountId)!;
      expect(rp.amount).toBe(-sp.amount);
      expect(rp.cleared).toBeUndefined(); // 冲正未对账
    }
  });

  it('多币种逐腿取反仍按币种平衡（豁免求和=0）', () => {
    const src = forexEntry(
      { bookId: 'b1', date: '2026-05-05', fromAccountId: 'usd', fromAmount: 10000, fromCurrency: 'USD', toAccountId: 'cny', toAmount: 72000, toCurrency: 'CNY' },
      counter(),
    );
    const rev: Transaction = reversalEntry(src, { date: '2026-06-29' }, counter());
    expect(isBalanced(rev.postings)).toBe(true);
    expect(rev.postings.find((p) => p.accountId === 'usd')!.amount).toBe(10000); // 原 -10000 → +10000
    expect(rev.postings.find((p) => p.accountId === 'cny')!.amount).toBe(-72000);
  });
});

describe('expandEntry', () => {
  it('expense: 费用科目 +amount，资产账户 -amount，且平衡', () => {
    const t = expandEntry(
      { kind: 'expense', bookId: 'b1', date: '2026-05-03', amount: toMinor(30), accountId: 'bank', categoryId: 'food' },
      counter(),
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.postings).toHaveLength(2);
    expect(t.bookId).toBe('b1');
    expect(t.postings.find((p) => p.accountId === 'food')!.amount).toBe(3000);
    expect(t.postings.find((p) => p.accountId === 'bank')!.amount).toBe(-3000);
  });

  it('income: 资产账户 +amount，收入科目 -amount', () => {
    const t = expandEntry(
      { kind: 'income', bookId: 'b1', date: '2026-05-01', amount: toMinor(5000), accountId: 'bank', categoryId: 'salary' },
      counter(),
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.postings.find((p) => p.accountId === 'bank')!.amount).toBe(500000);
    expect(t.postings.find((p) => p.accountId === 'salary')!.amount).toBe(-500000);
  });

  it('transfer: 转入 +amount，转出 -amount', () => {
    const t = expandEntry(
      { kind: 'transfer', bookId: 'b1', date: '2026-05-05', amount: toMinor(1000), fromAccountId: 'bank', toAccountId: 'alipay' },
      counter(),
    );
    expect(isBalanced(t.postings)).toBe(true);
    expect(t.postings.find((p) => p.accountId === 'alipay')!.amount).toBe(100000);
    expect(t.postings.find((p) => p.accountId === 'bank')!.amount).toBe(-100000);
  });

  it('分配唯一 id，并透传 payee/note/tags', () => {
    const t = expandEntry(
      {
        kind: 'expense',
        bookId: 'b1',
        date: '2026-05-03',
        amount: 3000,
        accountId: 'bank',
        categoryId: 'food',
        payee: '麦当劳',
        note: '午餐',
        tags: ['daily'],
      },
      counter(),
    );
    expect(t.id).toBe('id1');
    expect(t.postings.map((p) => p.id)).toEqual(['id2', 'id3']);
    expect(t.postings.every((p) => p.txnId === 'id1')).toBe(true);
    expect(t.payee).toBe('麦当劳');
    expect(t.tags).toEqual(['daily']);
  });

  it('拒绝非整数金额', () => {
    expect(() =>
      expandEntry(
        { kind: 'expense', bookId: 'b1', date: '2026-05-03', amount: 30.5, accountId: 'bank', categoryId: 'food' },
        counter(),
      ),
    ).toThrow();
  });

  it('拒绝非正数金额', () => {
    expect(() =>
      expandEntry(
        { kind: 'expense', bookId: 'b1', date: '2026-05-03', amount: 0, accountId: 'bank', categoryId: 'food' },
        counter(),
      ),
    ).toThrow();
    expect(() =>
      expandEntry(
        { kind: 'expense', bookId: 'b1', date: '2026-05-03', amount: -100, accountId: 'bank', categoryId: 'food' },
        counter(),
      ),
    ).toThrow();
  });
});

describe('balance helpers', () => {
  it('balanceOf 求和', () => {
    expect(balanceOf([])).toBe(0);
  });

  it('assertBalanced 对未平衡 postings 抛错', () => {
    expect(() =>
      assertBalanced([
        { id: 'p1', txnId: 't1', accountId: 'a', amount: 100, currency: 'CNY' },
        { id: 'p2', txnId: 't1', accountId: 'b', amount: -50, currency: 'CNY' },
      ]),
    ).toThrow();
  });

  it('多币种换汇：两条原币腿豁免求和=0（−$1000 / +¥6800）', () => {
    const forex = [
      { id: 'p1', txnId: 't1', accountId: 'usd', amount: -100000, currency: 'USD' },
      { id: 'p2', txnId: 't1', accountId: 'cny', amount: 680000, currency: 'CNY' },
    ];
    expect(isBalanced(forex)).toBe(true);
    expect(() => assertBalanced(forex)).not.toThrow();
  });

  it('同币种仍须平衡：单币种未平衡照样抛', () => {
    const bad = [
      { id: 'p1', txnId: 't1', accountId: 'usd1', amount: -100000, currency: 'USD' },
      { id: 'p2', txnId: 't1', accountId: 'usd2', amount: 90000, currency: 'USD' },
    ];
    expect(isBalanced(bad)).toBe(false);
    expect(() => assertBalanced(bad)).toThrow();
  });
});

describe('forexEntry（换汇 / 跨币转账）', () => {
  const base = {
    bookId: 'b1',
    date: '2026-06-11',
    fromAccountId: 'usd',
    fromAmount: toMinor(1000),
    fromCurrency: 'USD',
    toAccountId: 'cny',
    toAmount: toMinor(6800),
    toCurrency: 'CNY',
  };

  it('两条原币腿：汇出 −$1000 / 到账 +¥6800，多币种豁免平衡', () => {
    const t = forexEntry(base, counter());
    expect(t.postings).toHaveLength(2);
    expect(t.postings.find((p) => p.accountId === 'usd')).toMatchObject({ amount: -100000, currency: 'USD' });
    expect(t.postings.find((p) => p.accountId === 'cny')).toMatchObject({ amount: 680000, currency: 'CNY' });
    expect(isBalanced(t.postings)).toBe(true); // 多币种豁免
    expect(t.postings.every((p) => p.txnId === t.id)).toBe(true);
  });

  it('拒绝同币种（应走普通转账）/ 同账户 / 非正金额', () => {
    expect(() => forexEntry({ ...base, toCurrency: 'USD' }, counter())).toThrow(/同币种/);
    expect(() => forexEntry({ ...base, toAccountId: 'usd' }, counter())).toThrow(/不能相同/);
    expect(() => forexEntry({ ...base, fromAmount: 0 }, counter())).toThrow();
    expect(() => forexEntry({ ...base, toAmount: -1 }, counter())).toThrow();
  });
});
