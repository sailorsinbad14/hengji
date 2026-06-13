import { describe, it, expect } from 'vitest';
import { computeFees, feesTotal } from '../src/index';
import type { FeeDefinition, FeeLine } from '../src/index';

const B = 'b1';
const fee = (id: string, calcType: FeeDefinition['calcType'], tiers: Array<[number, number]>): FeeDefinition => ({
  id,
  bookId: B,
  name: id,
  calcType,
  tiers: tiers.map(([threshold, value]) => ({ threshold, value })),
  archived: false,
});
const line = (amount: number, qty: number, feeIds: string[]): FeeLine => ({ amount, qty, feeIds });

describe('computeFees 额外费用公式引擎（C2 Step 4）', () => {
  it('百分比单档：佣金 5% 按适用行金额', () => {
    const r = computeFees([line(10000, 1, ['c']), line(20000, 2, ['c']), line(5000, 1, [])], [fee('c', 'percent', [[0, 5]])]);
    // 适用行 100+200=300 元 → 5% = 15 元；未勾选的 50 元不计
    expect(r).toEqual([{ feeId: 'c', name: 'c', rate: 5, calcType: 'percent', amount: 1500 }]);
    expect(feesTotal(r)).toBe(1500);
  });

  it('阶梯按分组合计跳档：<¥600→5% / ≥¥600→4%', () => {
    const f = fee('c', 'percent', [[0, 5], [60000, 4]]);
    // 分组合计 500 元 < 600 → 5% = 25 元
    expect(computeFees([line(50000, 1, ['c'])], [f])[0]!.amount).toBe(2500);
    // 分组合计 700 元 ≥ 600 → 4% = 28 元（整组按 4%，不是分段）
    expect(computeFees([line(70000, 1, ['c'])], [f])[0]!.amount).toBe(2800);
    // 边界 600 → 命中 ≥600 档 4%
    expect(computeFees([line(60000, 1, ['c'])], [f])[0]!.rate).toBe(4);
  });

  it('固定金额：一次性，与适用行数无关', () => {
    const r = computeFees([line(10000, 1, ['s']), line(20000, 3, ['s'])], [fee('s', 'fixed', [[0, 1000]])]);
    expect(r[0]!.amount).toBe(1000); // ¥10 一次，不随行数翻倍
  });

  it('固定金额阶梯：分组合计 <¥1000 运费 ¥10 / ≥¥1000 包邮 ¥0', () => {
    const f = fee('s', 'fixed', [[0, 1000], [100000, 0]]);
    expect(computeFees([line(50000, 1, ['s'])], [f])[0]!.amount).toBe(1000);
    expect(computeFees([line(120000, 1, ['s'])], [f])[0]!.amount).toBe(0);
  });

  it('按数量：¥2/件 × 适用行数量合计；阶梯按数量定档', () => {
    const f = fee('p', 'perQty', [[0, 200], [10, 150]]); // <10 件 ¥2/件，≥10 件 ¥1.5/件
    // 数量合计 3+2=5 < 10 → ¥2/件 × 5 = ¥10
    expect(computeFees([line(0, 3, ['p']), line(0, 2, ['p'])], [f])[0]!.amount).toBe(1000);
    // 数量合计 12 ≥ 10 → ¥1.5/件 × 12 = ¥18
    expect(computeFees([line(0, 12, ['p'])], [f])[0]!.amount).toBe(1800);
  });

  it('多费用并存 + 行各自勾选不同费用', () => {
    const r = computeFees(
      [line(10000, 1, ['c', 's']), line(20000, 2, ['c'])],
      [fee('c', 'percent', [[0, 5]]), fee('s', 'fixed', [[0, 800]])],
    );
    // c: 适用两行 (100+200)=300 → 5% = 15 元；s: 仅第一行勾，固定 ¥8 一次
    expect(r.map((x) => [x.feeId, x.amount])).toEqual([['c', 1500], ['s', 800]]);
    expect(feesTotal(r)).toBe(2300);
  });

  it('无适用行 / 空档位 → 不产出该费用', () => {
    expect(computeFees([line(10000, 1, [])], [fee('c', 'percent', [[0, 5]])])).toEqual([]);
    expect(computeFees([line(10000, 1, ['c'])], [{ ...fee('c', 'percent', []) }])).toEqual([]);
  });

  it('百分比按行四舍五入后求和（可复算）', () => {
    // 两行各 333 分 × 5% = 16.65 → round 17，两行 = 34
    const r = computeFees([line(333, 1, ['c']), line(333, 1, ['c'])], [fee('c', 'percent', [[0, 5]])]);
    expect(r[0]!.amount).toBe(34);
  });
});
