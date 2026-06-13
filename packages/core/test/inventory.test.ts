import { describe, it, expect } from 'vitest';
import { inventoryState, currentAvgCost, issueCost, planInventoryIssue } from '../src/index';
import type { InventoryMovement, IssuePlanLine } from '../src/index';

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

describe('planInventoryIssue 出库/采购拆分（C2 模型重构）', () => {
  const line = (p: Partial<IssuePlanLine> & Pick<IssuePlanLine, 'productId' | 'demand'>): IssuePlanLine => ({
    onHand: 0,
    avgCost: 0,
    purchased: 0,
    ...p,
  });

  it('全部从库存出（无采购）：COGS=数量×均价', () => {
    const plan = planInventoryIssue([line({ productId: 'p1', demand: 10, onHand: 40, avgCost: 8250 })]);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.issues).toEqual([{ productId: 'p1', qty: 10, avgCost: 8250, cogs: 82500 }]);
    expect(plan.inventoryCogs).toBe(82500);
  });

  it('全部由采购覆盖（代采、在手 0）：不出库、inventoryCogs=0', () => {
    const plan = planInventoryIssue([line({ productId: 'p1', demand: 10, onHand: 0, purchased: 10 })]);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.issues).toEqual([]);
    expect(plan.inventoryCogs).toBe(0);
  });

  it('部分库存 + 部分采购拆行（A3）：要 10、在手 3、采 7 → 出 3 走均价', () => {
    // 在手 3 @ 均价 ¥82.50，采购覆盖 7 → 库存只出 demand−purchased = 3
    const plan = planInventoryIssue([line({ productId: 'p1', demand: 10, onHand: 3, avgCost: 8250, purchased: 7 })]);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.issues).toEqual([{ productId: 'p1', qty: 3, avgCost: 8250, cogs: 24750 }]);
    expect(plan.inventoryCogs).toBe(24750);
  });

  it('采购+库存仍不够 → shortfall（拦截整单）：要 10、采 4、在手 3 → 缺 3', () => {
    const plan = planInventoryIssue([line({ productId: 'p1', demand: 10, onHand: 3, avgCost: 8250, purchased: 4 })]);
    expect(plan.shortfalls).toEqual([{ productId: 'p1', missing: 3 }]);
    expect(plan.issues).toEqual([]); // 被拦截的商品不产出库行
    expect(plan.inventoryCogs).toBe(0);
  });

  it('多商品：一个全库存、一个全采购、一个拆行', () => {
    const plan = planInventoryIssue([
      line({ productId: 'a', demand: 5, onHand: 5, avgCost: 1000 }), // 全库存
      line({ productId: 'b', demand: 8, onHand: 0, purchased: 8 }), // 全采购
      line({ productId: 'c', demand: 10, onHand: 6, avgCost: 2000, purchased: 4 }), // 拆：出 6
    ]);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.issues).toEqual([
      { productId: 'a', qty: 5, avgCost: 1000, cogs: 5000 },
      { productId: 'c', qty: 6, avgCost: 2000, cogs: 12000 },
    ]);
    expect(plan.inventoryCogs).toBe(17000);
  });

  it('采购超买（purchased>demand）：库存出 0、不产负数', () => {
    const plan = planInventoryIssue([line({ productId: 'p1', demand: 8, onHand: 5, avgCost: 1000, purchased: 10 })]);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.issues).toEqual([]);
    expect(plan.inventoryCogs).toBe(0);
  });
});
