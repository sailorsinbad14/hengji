import { describe, it, expect } from 'vitest';
import { expandEntry, isBalanced, assertBalanced, balanceOf, toMinor } from '../src/index';

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

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
