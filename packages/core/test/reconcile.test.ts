import { describe, it, expect } from 'vitest';
import { clearedBalance, reconcileDifference } from '../src/index';
import type { Transaction } from '../src/index';

const B = 'b1';

function txn(id: string, postings: Array<{ acc: string; amt: number; cleared?: boolean }>): Transaction {
  return {
    id,
    bookId: B,
    date: '2026-06-01',
    payee: '',
    note: '',
    tags: [],
    postings: postings.map((p, i) => ({
      id: `${id}-${i}`,
      txnId: id,
      accountId: p.acc,
      amount: p.amt,
      currency: 'CNY',
      cleared: p.cleared,
    })),
  };
}

describe('reconcile', () => {
  const txns: Transaction[] = [
    // 工资入账 5000，已核销
    txn('t1', [{ acc: 'bank', amt: 500000, cleared: true }, { acc: 'salary', amt: -500000 }]),
    // 支出 30，已核销
    txn('t2', [{ acc: 'bank', amt: -3000, cleared: true }, { acc: 'food', amt: 3000 }]),
    // 支出 88，未核销
    txn('t3', [{ acc: 'bank', amt: -8800 }, { acc: 'food', amt: 8800 }]),
  ];

  it('clearedBalance 只累计已核销分录（按 posting 粒度）', () => {
    expect(clearedBalance(txns, 'bank')).toBe(497000); // 500000 − 3000（未核销的 8800 不计）
    // food 的两条腿都没勾（对账的是 bank 账户，只勾 bank 腿）→ 0
    expect(clearedBalance(txns, 'food')).toBe(0);
  });

  it('clearedBalance 无已核销时为 0', () => {
    expect(clearedBalance([txn('x', [{ acc: 'cash', amt: 100 }, { acc: 'y', amt: -100 }])], 'cash')).toBe(0);
  });

  it('reconcileDifference = 对账单余额 − 已勾选合计', () => {
    expect(reconcileDifference(497000, 497000)).toBe(0); // 账实相符
    expect(reconcileDifference(488200, 497000)).toBe(-8800); // 漏勾一笔 88 支出 → 负差
    expect(reconcileDifference(500000, 497000)).toBe(3000); // 多了 30 → 正差
  });
});
