import { describe, it, expect } from 'vitest';
import { matchStatement } from '@app/core';
import type { LedgerItem, StatementItem } from '@app/core';

const L = (id: string, amount: number, date: string): LedgerItem => ({ id, amount, date });
const S = (signedAmount: number, date: string): StatementItem => ({ signedAmount, date });

describe('matchStatement（自动对账勾对）', () => {
  it('金额同口径 + 日期窗口内 → 命中', () => {
    const r = matchStatement([S(13000, '2026-06-20')], [L('p1', 13000, '2026-06-20')]);
    expect(r.rowMatch).toEqual(['p1']);
    expect(r.matchedIds).toEqual(['p1']);
    expect(r.unmatchedIndexes).toEqual([]);
  });

  it('日期超窗口 → 不命中（落漏记）', () => {
    const r = matchStatement([S(13000, '2026-06-20')], [L('p1', 13000, '2026-06-12')], 3);
    expect(r.rowMatch).toEqual([null]);
    expect(r.unmatchedIndexes).toEqual([0]);
  });

  it('符号区分：+45 不配 −45（防收入误配同额支出）', () => {
    const r = matchStatement([S(4500, '2026-06-20')], [L('p1', -4500, '2026-06-20')]);
    expect(r.rowMatch).toEqual([null]);
  });

  it('一对一 + 就近：两笔同额各配各、分录不被重复占用', () => {
    const items = [S(-4500, '2026-06-20'), S(-4500, '2026-06-21')];
    const ledger = [L('a', -4500, '2026-06-21'), L('b', -4500, '2026-06-20')];
    const r = matchStatement(items, ledger);
    expect(r.rowMatch).toEqual(['b', 'a']); // item0(20号)就近配 b、item1(21号)配 a
    expect(r.matchedIds.sort()).toEqual(['a', 'b']);
  });

  it('账单多于账内分录 → 多出的算漏记', () => {
    const r = matchStatement([S(-4500, '2026-06-20'), S(-4500, '2026-06-20')], [L('a', -4500, '2026-06-20')]);
    expect(r.rowMatch).toEqual(['a', null]);
    expect(r.unmatchedIndexes).toEqual([1]);
  });
});
