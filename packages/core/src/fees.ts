import type { FeeDefinition, FeeTier } from './types';

/**
 * 额外费用公式引擎（C2 Step 4，flagship 核心）：确定性、纯函数、可单测、可复算可审计。
 * 两遍计算：① 按费用定义汇总「应用它的商品行」的分组合计 → 定档（声明式阶梯，B3 范围=本订单内）；
 *           ② 按 calcType 算费用金额。费用都当收入（B4），订单总额 = 商品额 + Σ费用。
 * LLM 后置（B6）：LLM 只把自然语言翻译成 FeeDefinition 结构，算账走本函数。
 */

/** 参与计算的商品行（行金额=分，含数量与所应用的费用 id）。 */
export interface FeeLine {
  /** 行金额（最小单位/分）= round(qty × unitPrice） */
  amount: number;
  qty: number;
  /** 本行应用的费用定义 id */
  feeIds: string[];
}

/** 单项费用的计算结果。 */
export interface FeeResult {
  feeId: string;
  name: string;
  /** 适用档位的 value（百分数 / 固定额 / 单位额，透明展示用） */
  rate: number;
  calcType: FeeDefinition['calcType'];
  /** 该费用合计（最小单位/分） */
  amount: number;
}

/** 取 threshold ≤ 分组合计 的最高档；分组合计低于所有阈值时兜底最低档。tiers 至少一档。 */
function pickTier(tiers: ReadonlyArray<FeeTier>, groupTotal: number): FeeTier | undefined {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let chosen: FeeTier | undefined;
  for (const t of sorted) if (t.threshold <= groupTotal) chosen = t;
  return chosen ?? sorted[0];
}

/**
 * 计算一组商品行应用的全部额外费用，返回每项费用合计（按 feeDefs 顺序，无适用行的跳过）。
 * - percent：Σ 各适用行 round(行金额 × 档位百分数 / 100)
 * - perQty：Σ 各适用行 round(行数量 × 档位单位额)
 * - fixed：一次性 = 档位金额（与适用行数无关）
 * 档位由「应用本费用的行」的分组合计决定（percent/fixed 按金额合计，perQty 按数量合计）。
 */
export function computeFees(lines: ReadonlyArray<FeeLine>, feeDefs: ReadonlyArray<FeeDefinition>): FeeResult[] {
  const out: FeeResult[] = [];
  for (const fee of feeDefs) {
    if (fee.tiers.length === 0) continue;
    const applying = lines.filter((l) => l.feeIds.includes(fee.id));
    if (applying.length === 0) continue;
    const baseTotal = applying.reduce((s, l) => s + l.amount, 0);
    const qtyTotal = applying.reduce((s, l) => s + l.qty, 0);
    // 阶梯按分组合计定档：perQty 用数量合计，其余用金额合计
    const tier = pickTier(fee.tiers, fee.calcType === 'perQty' ? qtyTotal : baseTotal);
    if (!tier) continue;
    let amount: number;
    if (fee.calcType === 'percent') amount = applying.reduce((s, l) => s + Math.round((l.amount * tier.value) / 100), 0);
    else if (fee.calcType === 'perQty') amount = applying.reduce((s, l) => s + Math.round(l.qty * tier.value), 0);
    else amount = tier.value; // fixed：一次性
    out.push({ feeId: fee.id, name: fee.name, rate: tier.value, calcType: fee.calcType, amount });
  }
  return out;
}

/** 全部额外费用合计（最小单位/分）。 */
export function feesTotal(results: ReadonlyArray<FeeResult>): number {
  return results.reduce((s, r) => s + r.amount, 0);
}
