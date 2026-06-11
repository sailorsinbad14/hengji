import { describe, it, expect } from 'vitest';
import { expandEntry, budgetUsage } from '../src/index';
import type { Budget } from '../src/index';

const B = 'b1';

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe('budgetUsage', () => {
  it('按月按分类统计已用/限额/超支，跨月不混入', () => {
    const gen = counter();
    const txns = [
      expandEntry({ kind: 'expense', bookId: B, date: '2026-06-03', amount: 30000, accountId: 'bank', categoryId: 'food' }, gen),
      expandEntry({ kind: 'expense', bookId: B, date: '2026-06-15', amount: 25000, accountId: 'bank', categoryId: 'food' }, gen),
      expandEntry({ kind: 'expense', bookId: B, date: '2026-06-10', amount: 20000, accountId: 'bank', categoryId: 'shopping' }, gen),
      expandEntry({ kind: 'expense', bookId: B, date: '2026-05-20', amount: 99999, accountId: 'bank', categoryId: 'food' }, gen), // 5 月，不计入 6 月
    ];
    const budgets: Budget[] = [
      { id: 'b1', bookId: B, accountId: 'food', monthlyLimit: 50000 },
      { id: 'b2', bookId: B, accountId: 'shopping', monthlyLimit: 100000 },
    ];
    const lines = budgetUsage(txns, budgets, '2026-06');
    expect(lines.find((l) => l.accountId === 'food')).toEqual({
      accountId: 'food',
      limit: 50000,
      spent: 55000,
      remaining: -5000,
      over: true,
    });
    expect(lines.find((l) => l.accountId === 'shopping')).toEqual({
      accountId: 'shopping',
      limit: 100000,
      spent: 20000,
      remaining: 80000,
      over: false,
    });
  });

  it('无消费的预算 spent=0', () => {
    const budgets: Budget[] = [{ id: 'b1', bookId: B, accountId: 'food', monthlyLimit: 50000 }];
    expect(budgetUsage([], budgets, '2026-06')[0]).toEqual({
      accountId: 'food',
      limit: 50000,
      spent: 0,
      remaining: 50000,
      over: false,
    });
  });

  it('月份精确匹配：非规范前缀（2026-1 / 2026）不会错配其他月', () => {
    const gen = counter();
    const txns = [
      expandEntry({ kind: 'expense', bookId: B, date: '2026-10-05', amount: 10000, accountId: 'bank', categoryId: 'food' }, gen),
      expandEntry({ kind: 'expense', bookId: B, date: '2026-01-05', amount: 20000, accountId: 'bank', categoryId: 'food' }, gen),
    ];
    const budgets: Budget[] = [{ id: 'b1', bookId: B, accountId: 'food', monthlyLimit: 50000 }];
    // 旧 startsWith 实现下 '2026-1' 会错配 2026-10、'2026' 会匹配全年
    expect(budgetUsage(txns, budgets, '2026-1')[0]!.spent).toBe(0);
    expect(budgetUsage(txns, budgets, '2026')[0]!.spent).toBe(0);
    // 规范 'YYYY-MM' 精确命中
    expect(budgetUsage(txns, budgets, '2026-01')[0]!.spent).toBe(20000);
    expect(budgetUsage(txns, budgets, '2026-10')[0]!.spent).toBe(10000);
  });
});
