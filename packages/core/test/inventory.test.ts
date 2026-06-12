import { describe, it, expect } from 'vitest';
import { inventoryState, currentAvgCost, issueCost } from '../src/index';
import type { InventoryMovement } from '../src/index';

const B = 'b1';
let n = 0;
const mv = (date: string, qty: number, unitCost: number, kind: 'in' | 'out' = qty >= 0 ? 'in' : 'out'): InventoryMovement => ({
  id: `m${String(++n).padStart(3, '0')}`,
  bookId: B,
  productId: 'p1',
  date,
  kind,
  qty,
  unitCost,
  orderId: null,
  txnId: null,
  note: '',
});

describe('inventory 移动加权均价', () => {
  it('空流水：在手 0、均价 0', () => {
    expect(inventoryState([])).toEqual({ qty: 0, totalCost: 0, avgCost: 0 });
  });

  it('单次进货：均价=进价', () => {
    const st = inventoryState([mv('2026-06-01', 10, 8000)]); // 10 个 @ ¥80
    expect(st).toEqual({ qty: 10, totalCost: 80000, avgCost: 8000 });
  });

  it('两批不同进价 → 移动加权均价', () => {
    // 10 @ ¥80 = ¥800；再 10 @ ¥100 = ¥1000；合计 20 个 ¥1800 → 均价 ¥90
    const ms = [mv('2026-06-01', 10, 8000), mv('2026-06-02', 10, 10000)];
    expect(currentAvgCost(ms)).toBe(9000);
    expect(inventoryState(ms)).toEqual({ qty: 20, totalCost: 180000, avgCost: 9000 });
  });

  it('出库按当前均价结转，不改变剩余均价', () => {
    // 进 20 个均价 ¥90；出 5 个 → 结转成本 5×90=¥450；剩 15 个仍 ¥90
    const base = [mv('2026-06-01', 10, 8000), mv('2026-06-02', 10, 10000)];
    expect(issueCost(base, 5)).toBe(45000); // 出库成本
    const after = inventoryState([...base, mv('2026-06-03', -5, 9000)]);
    expect(after).toEqual({ qty: 15, totalCost: 135000, avgCost: 9000 });
  });

  it('出库后再进货重算均价', () => {
    // 剩 15 @ ¥90 = ¥1350；再进 5 @ ¥120 = ¥600 → 20 个 ¥1950 → 均价 ¥97.5 → round 9750
    const ms = [
      mv('2026-06-01', 10, 8000),
      mv('2026-06-02', 10, 10000),
      mv('2026-06-03', -5, 9000),
      mv('2026-06-04', 5, 12000),
    ];
    const st = inventoryState(ms);
    expect(st.qty).toBe(20);
    expect(st.totalCost).toBe(195000);
    expect(st.avgCost).toBe(9750);
  });

  it('全部出清：在手 0、均价 0、成本 0', () => {
    const ms = [mv('2026-06-01', 10, 8000), mv('2026-06-02', -10, 8000)];
    expect(inventoryState(ms)).toEqual({ qty: 0, totalCost: 0, avgCost: 0 });
  });

  it('回放与录入顺序无关（按 date+id 排序）', () => {
    const ordered = [mv('2026-06-01', 10, 8000), mv('2026-06-02', 10, 10000)];
    const shuffled = [ordered[1]!, ordered[0]!];
    expect(inventoryState(shuffled)).toEqual(inventoryState(ordered));
  });
});
