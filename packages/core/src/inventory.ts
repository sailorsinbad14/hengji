import type { InventoryMovement } from './types';

export interface InventoryState {
  /** 当前在手数量（可为小数，与订单行数量一致） */
  qty: number;
  /** 当前库存总成本（人民币最小单位/分）= Σ in 成本 − Σ out 成本 */
  totalCost: number;
  /** 移动加权均价（分/单位）；qty<=0 时为 0 */
  avgCost: number;
}

/** 流水按时间升序（同日按 id 稳定），保证回放顺序确定。 */
function sortMovements(movements: InventoryMovement[]): InventoryMovement[] {
  return [...movements].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * 回放某商品的出入库流水，得到当前在手数量 + 库存总成本 + 移动加权均价。
 * - in（qty>0）：总成本 += round(qty × 进价)，数量 += qty。
 * - out（qty<0）：总成本 −= round(|qty| × unitCost)，数量 += qty（unitCost 已是出库时点均价）。
 * 库存品的数量/成本不存死值，全由此聚合（ARCHITECTURE「库存」）。
 */
export function inventoryState(movements: InventoryMovement[]): InventoryState {
  let qty = 0;
  let totalCost = 0;
  for (const m of sortMovements(movements)) {
    if (m.qty >= 0) {
      qty += m.qty;
      totalCost += Math.round(m.qty * m.unitCost);
    } else {
      qty += m.qty; // m.qty 为负
      totalCost -= Math.round(-m.qty * m.unitCost);
    }
  }
  if (qty <= 0) {
    // 清空/超卖：均价归 0；残留四舍五入误差不带入后续（在手为 0 即无成本）
    return { qty: Math.max(0, qty), totalCost: qty === 0 ? 0 : totalCost, avgCost: 0 };
  }
  return { qty, totalCost, avgCost: Math.round(totalCost / qty) };
}

/** 当前移动加权均价（分/单位）——供出库结转营业成本时定 out 记录的 unitCost。 */
export function currentAvgCost(movements: InventoryMovement[]): number {
  return inventoryState(movements).avgCost;
}

/** 出库结转的营业成本（分）= 出库数量 × 当前移动加权均价。qtyOut 为正数。 */
export function issueCost(movements: InventoryMovement[], qtyOut: number): number {
  return Math.round(qtyOut * currentAvgCost(movements));
}
