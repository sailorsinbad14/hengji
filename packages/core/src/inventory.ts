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

/**
 * 末端约束（账单导入 增量2 撤销）：待软删的 movement 必须是该商品时间线的**末尾后缀**——其后无任何
 * 保留的 movement。满足时撤销＝回放回到这些流水发生前（移动加权下补偿/重放/理想三者退化为同一值、无均价漂移）；
 * 不满足必须拒绝、引导用盘点 adjust 纠错（撤中间笔会让后续出库的冻结成本与重算值脱钩，见 ARCHITECTURE「库存」）。
 * @param productMovements 该商品全部未软删流水（任意顺序，内部按 date+id 升序回放）
 * @param removeIds 本次要软删的 movement id 集合
 */
export function removalIsTail(productMovements: InventoryMovement[], removeIds: ReadonlySet<string>): boolean {
  const sorted = sortMovements(productMovements);
  let firstRemoved = Infinity;
  let lastSurviving = -1;
  sorted.forEach((m, i) => {
    if (removeIds.has(m.id)) firstRemoved = Math.min(firstRemoved, i);
    else lastSurviving = Math.max(lastSurviving, i);
  });
  if (firstRemoved === Infinity) return true; // 无命中（无可删）→ 平凡安全
  return lastSurviving < firstRemoved; // 所有保留的都排在第一个待删之前＝待删是连续末尾后缀
}

/** 出库结转的营业成本（分）= 出库数量 × 当前移动加权均价。qtyOut 为正数。 */
export function issueCost(movements: InventoryMovement[], qtyOut: number): number {
  return Math.round(qtyOut * currentAvgCost(movements));
}

/** 完成订单时，某商品的履约参数（C2 模型重构）。 */
export interface IssuePlanLine {
  productId: string;
  /** 本单对该商品的需求数量 */
  demand: number;
  /** 当前在手数量 */
  onHand: number;
  /** 当前移动加权均价（分/单位） */
  avgCost: number;
  /** 已由本单「确认采购」覆盖的数量（代采，即采即出，不过库存池） */
  purchased: number;
}

/** 某商品库存出库一行。 */
export interface IssueLine {
  productId: string;
  /** 从库存出库的数量（正数） */
  qty: number;
  avgCost: number;
  /** 出库成本（分）= round(qty × avgCost） */
  cogs: number;
}

export interface IssuePlan {
  /** 各商品的库存出库（结转营业成本 + 记 out 流水用） */
  issues: IssueLine[];
  /** 库存出库成本合计（分） */
  inventoryCogs: number;
  /** 无法履约的缺口：采购未覆盖、库存也不够的部分（>0 即不能完成） */
  shortfalls: Array<{ productId: string; missing: number }>;
}

/**
 * 拆分订单完成时各商品的成本来源（C2 模型重构核心，纯函数）：
 * 商品需求 = 已采购（代采，成本经「代采在途」结转）+ 从库存出库。
 * - 库存出库数 = max(0, demand − purchased)；其成本按移动加权均价结转。
 * - 若库存出库数 > 在手，则差额计入 shortfalls（采购也没覆盖、库存又不够）——调用方据此拦截整单。
 * 代采部分的成本（= 该单已确认采购总额）由调用方从「代采在途」单独结转，不在此计入 inventoryCogs。
 */
export function planInventoryIssue(lines: ReadonlyArray<IssuePlanLine>): IssuePlan {
  const issues: IssueLine[] = [];
  const shortfalls: Array<{ productId: string; missing: number }> = [];
  let inventoryCogs = 0;
  for (const l of lines) {
    const fromInventory = Math.max(0, l.demand - l.purchased);
    if (fromInventory > l.onHand) {
      shortfalls.push({ productId: l.productId, missing: fromInventory - l.onHand });
      continue;
    }
    if (fromInventory > 0) {
      const cogs = Math.round(fromInventory * l.avgCost);
      issues.push({ productId: l.productId, qty: fromInventory, avgCost: l.avgCost, cogs });
      inventoryCogs += cogs;
    }
  }
  return { issues, inventoryCogs, shortfalls };
}
