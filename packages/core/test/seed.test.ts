import { describe, it, expect } from 'vitest';
import { defaultChartFor } from '../src/index';

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe('defaultChartFor', () => {
  it('personal：纯个人科目，无生意元素', () => {
    const acc = defaultChartFor('personal', 'bk1', counter());
    expect(acc.length).toBe(16);
    expect(new Set(acc.map((a) => a.id)).size).toBe(16);
    expect(acc.every((a) => a.bookId === 'bk1' && a.currency === 'CNY')).toBe(true);
    expect(acc.some((a) => a.name === '营业收入')).toBe(false);
    expect(acc.some((a) => a.name === '进货成本')).toBe(false);
    expect(acc.some((a) => a.name === '期初余额' && a.type === 'equity')).toBe(true);
  });

  it('business：经营科目齐备', () => {
    const acc = defaultChartFor('business', 'bk2', counter());
    const names = acc.map((a) => a.name);
    expect(names).toContain('对公账户');
    expect(names).toContain('营业收入');
    expect(names).toContain('进货成本');
    expect(names).toContain('运费杂费');
    expect(acc.find((a) => a.name === '应收账款')!.type).toBe('asset');
    expect(acc.every((a) => a.bookId === 'bk2')).toBe(true);
  });

  it('investment：投资账户 + 投资盈亏 + 期初余额', () => {
    const acc = defaultChartFor('investment', 'bk3', counter());
    expect(acc.length).toBe(3);
    expect(acc.find((a) => a.name === '投资账户')!.type).toBe('asset');
    expect(acc.find((a) => a.name === '投资盈亏')!.type).toBe('income');
    expect(acc.find((a) => a.name === '期初余额')!.type).toBe('equity');
  });

  it('支持自定义币种', () => {
    const acc = defaultChartFor('personal', 'bk1', counter(), 'USD');
    expect(acc.every((a) => a.currency === 'USD')).toBe(true);
  });
});
