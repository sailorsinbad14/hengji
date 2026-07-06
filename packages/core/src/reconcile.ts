import type { Transaction } from './types';

/**
 * 对账（勾对式）的纯计算助手。会话编排（勾选哪些、补录/改/删纠错）活在 UI 层，
 * core 只提供「已核销余额」与「差额」两个口径，便于测试与复用。
 */

/** 某账户已核销(cleared)分录之和——上次对账留下的基线余额。 */
export function clearedBalance(txns: Transaction[], accountId: string): number {
  let sum = 0;
  for (const t of txns) {
    for (const p of t.postings) {
      if (p.accountId === accountId && p.cleared) sum += p.amount;
    }
  }
  return sum;
}

/**
 * 对账差额 = 对账单余额 − 已勾选合计。
 * 0 表示账实相符、可完成对账；≠0 需补录/改金额/删除，或走盘盈盘亏逃生口对平。
 */
export function reconcileDifference(statementBalance: number, checkedSum: number): number {
  return statementBalance - checkedSum;
}

/**
 * 某账户未核销分录数——上次对账后新增/未对的笔数。
 * 0 = 该账户已全部核销（本期已对账的判据）。
 */
export function unclearedCount(txns: Transaction[], accountId: string): number {
  let n = 0;
  for (const t of txns) {
    for (const p of t.postings) {
      if (p.accountId === accountId && !p.cleared) n++;
    }
  }
  return n;
}

/** 一条对账单流水项（已折成与目标账户分录同口径的有符号金额：进账+ / 出账−）。 */
export interface StatementItem {
  signedAmount: number;
  date: string;
}

/** 一条账户分录（pid + 有符号金额 + 所在交易日期）。 */
export interface LedgerItem {
  id: string;
  amount: number;
  date: string;
}

/** 账单 ↔ 账户分录的匹配结果。 */
export interface StatementMatch {
  /** 每个账单项 → 命中的分录 id（null=未匹配）。 */
  rowMatch: Array<string | null>;
  /** 命中的分录 id（去重，用于自动勾选 cleared）。 */
  matchedIds: string[];
  /** 未匹配的账单项下标（账单有、账里无＝漏记，补录候选）。 */
  unmatchedIndexes: number[];
}

/** 两个 YYYY-MM-DD 相差天数（UTC，避开时区）；非法日期返回 NaN（自然落在窗口外）。 */
function dayDiff(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86400000;
}

/**
 * 账单流水 ↔ 账户分录 一对一匹配（自动对账勾对用）。
 * 规则：有符号金额**精确相等**（同口径，已由调用方按账户折好正负）+ 日期在 ±windowDays 内、就近贪心；
 * 一条分录至多被一个账单项命中（避免重复勾）。纯函数。命中的分录建议标 cleared，未匹配项＝漏记。
 */
export function matchStatement(items: StatementItem[], ledger: LedgerItem[], windowDays = 3): StatementMatch {
  const used = new Set<string>();
  const rowMatch: Array<string | null> = [];
  for (const it of items) {
    let bestId: string | null = null;
    let bestDiff = Infinity;
    for (const p of ledger) {
      if (used.has(p.id) || p.amount !== it.signedAmount) continue;
      const diff = Math.abs(dayDiff(it.date, p.date));
      if (diff <= windowDays && diff < bestDiff) {
        bestId = p.id;
        bestDiff = diff;
      }
    }
    if (bestId !== null) used.add(bestId);
    rowMatch.push(bestId);
  }
  const unmatchedIndexes: number[] = [];
  rowMatch.forEach((m, i) => {
    if (m === null) unmatchedIndexes.push(i);
  });
  return { rowMatch, matchedIds: [...used], unmatchedIndexes };
}
