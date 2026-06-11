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
