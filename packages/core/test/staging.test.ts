import { describe, it, expect } from 'vitest';
import { expandEntry, stagingRowToEntry } from '@app/core';
import type { StagingPostDecision } from '@app/core';

/** 源账户＝整批选定的全局账户（如支付宝）。 */
const SRC = 'acc-alipay';
const row = { amountMinor: 12300, date: '2026-06-10', payee: '某商户', note: '午餐' };
const counter = (): (() => string) => {
  let n = 0;
  return () => `id${++n}`;
};

/** 经 expandEntry 展开后取两腿（accountId+符号金额），验证方向与账户落点。 */
function postingsOf(decision: StagingPostDecision): Array<{ accountId: string; amount: number }> {
  const txn = expandEntry(stagingRowToEntry(row, decision, SRC), counter());
  return txn.postings.map((p) => ({ accountId: p.accountId, amount: p.amount }));
}

describe('stagingRowToEntry', () => {
  it('income：钱进源账户（借源账户 / 贷分类收入）', () => {
    expect(postingsOf({ kind: 'income', bookId: 'b1', accountId: 'cat-salary' })).toEqual([
      { accountId: SRC, amount: 12300 },
      { accountId: 'cat-salary', amount: -12300 },
    ]);
  });

  it('expense：钱出源账户（借分类支出 / 贷源账户）', () => {
    expect(postingsOf({ kind: 'expense', bookId: 'b1', accountId: 'cat-food' })).toEqual([
      { accountId: 'cat-food', amount: 12300 },
      { accountId: SRC, amount: -12300 },
    ]);
  });

  it('transfer-out：源账户 → 对手账户', () => {
    expect(postingsOf({ kind: 'transfer-out', bookId: 'b1', accountId: 'acc-bank' })).toEqual([
      { accountId: 'acc-bank', amount: 12300 },
      { accountId: SRC, amount: -12300 },
    ]);
  });

  it('transfer-in：对手账户 → 源账户', () => {
    expect(postingsOf({ kind: 'transfer-in', bookId: 'b1', accountId: 'acc-bank' })).toEqual([
      { accountId: SRC, amount: 12300 },
      { accountId: 'acc-bank', amount: -12300 },
    ]);
  });

  it('携带交易元数据 + 恒平衡', () => {
    const txn = expandEntry(stagingRowToEntry(row, { kind: 'expense', bookId: 'bk', accountId: 'c' }, SRC), counter());
    expect([txn.bookId, txn.date, txn.payee, txn.note]).toEqual(['bk', '2026-06-10', '某商户', '午餐']);
    expect(txn.postings.reduce((s, p) => s + p.amount, 0)).toBe(0);
  });

  it('对手腿账户等于源账户 → 抛错（防一腿自抵的空交易）', () => {
    expect(() => stagingRowToEntry(row, { kind: 'transfer-out', bookId: 'b1', accountId: SRC }, SRC)).toThrow();
    expect(() => stagingRowToEntry(row, { kind: 'income', bookId: 'b1', accountId: SRC }, SRC)).toThrow();
  });

  it('未指派账本 / 对手腿账户（草稿未复核）→ 抛错（不静默产废交易）', () => {
    expect(() => stagingRowToEntry(row, { kind: 'expense', bookId: '', accountId: 'cat' }, SRC)).toThrow();
    expect(() => stagingRowToEntry(row, { kind: 'expense', bookId: 'b1', accountId: '' }, SRC)).toThrow();
  });
});
