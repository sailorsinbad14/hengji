import type { Account, Transaction } from './types';

/** 单个账户余额 = 其所有 posting 之和。 */
export function accountBalance(txns: Transaction[], accountId: string): number {
  let sum = 0;
  for (const t of txns) {
    for (const p of t.postings) {
      if (p.accountId === accountId) sum += p.amount;
    }
  }
  return sum;
}

/**
 * 多币种折算上下文：rates[币种] = 1 单位该币种折合多少展示币种（同 scale）；display = 展示币种。
 * 展示币种自身 rate 视为 1；缺失汇率按 1 兜底（调用方应为在用币种补齐汇率）。
 */
export interface ConvertCtx {
  rates: Record<string, number>;
  display: string;
}

/** 把一笔原币最小单位金额折算到展示币种（Phase 1 同为 2 位小数，直接按汇率乘）。 */
export function convertAmount(minor: number, from: string, ctx: ConvertCtx): number {
  if (from === ctx.display) return minor;
  return Math.round(minor * (ctx.rates[from] ?? 1));
}

/** 净资产 = 所有「资产 + 负债」账户余额之和（负债以负数存储，故直接相加）。
 *  传 convert 则把各分录按其币种折算到展示币种；不传则原样相加（单币种／向后兼容）。 */
export function netWorth(txns: Transaction[], accounts: Account[], convert?: ConvertCtx): number {
  const relevant = new Set(
    accounts.filter((a) => a.type === 'asset' || a.type === 'liability').map((a) => a.id),
  );
  let sum = 0;
  for (const t of txns) {
    for (const p of t.postings) {
      if (relevant.has(p.accountId)) sum += convert ? convertAmount(p.amount, p.currency, convert) : p.amount;
    }
  }
  return sum;
}

/**
 * 按币种分组的余额（原币精确，不折算）：默认资产+负债（净资产口径）。
 * 用于财务总表「先按币种分组小计」。返回 Map<币种, 该币种净额>。
 */
export function balancesByCurrency(
  txns: Transaction[],
  accounts: Account[],
  types: ReadonlyArray<Account['type']> = ['asset', 'liability'],
): Map<string, number> {
  const want = new Set(types);
  const relevant = new Set(accounts.filter((a) => want.has(a.type)).map((a) => a.id));
  const out = new Map<string, number>();
  for (const t of txns) {
    for (const p of t.postings) {
      if (relevant.has(p.accountId)) out.set(p.currency, (out.get(p.currency) ?? 0) + p.amount);
    }
  }
  return out;
}

/** 闭区间日期过滤（ISO YYYY-MM-DD，字典序即时间序）。 */
export interface Period {
  from?: string;
  to?: string;
}

function inPeriod(date: string, period?: Period): boolean {
  if (!period) return true;
  if (period.from && date < period.from) return false;
  if (period.to && date > period.to) return false;
  return true;
}

export interface IncomeExpense {
  /** 已翻正：收入显示为正数 */
  income: number;
  expense: number;
  /** 利润 = income - expense */
  net: number;
}

/** 记账口径：权责发生制（确认即收入）/ 收付实现制（实收才算收入）。 */
export type AccountingBasis = 'accrual' | 'cash';

/**
 * 收支汇总；可选按时间区间、按标签（如 'business' 得到小生意利润）过滤。
 * 收入账户 posting 在有符号约定下为负，这里翻正后返回。
 *
 * 记账口径（basis，仅影响收入侧）：
 * - 'accrual'（默认）：本期收入 = 确认的营业收入（赊销在完成订单时即计）。
 * - 'cash'：本期收入 = 实收 = 权责确认 − 本期应收净增(ΔAR)。恒等式来历：
 *   ΔAR = 赊销 − 回款；直收 ΔAR=0 两口径相同；赊销当期 AR 增、抵消不计；回款 AR 减、计入；
 *   预收 AR 负、即时计入。底层分录不变，纯报表层换聚合。
 *   需调用方传入应收账款科目 id 集合（命名约定活在 web 层，core 保持纯）。
 */
export function incomeExpense(
  txns: Transaction[],
  accounts: Account[],
  opts: {
    period?: Period;
    tag?: string;
    basis?: AccountingBasis;
    receivableAccountIds?: Iterable<string>;
    /** 多币种：传则把各分录按其币种折算到展示币种再汇总；不传则原样（单币种／向后兼容） */
    convert?: ConvertCtx;
  } = {},
): IncomeExpense {
  const typeOf = new Map(accounts.map((a) => [a.id, a.type] as const));
  const arSet = opts.basis === 'cash' ? new Set(opts.receivableAccountIds ?? []) : null;
  const conv = (p: { amount: number; currency: string }): number =>
    opts.convert ? convertAmount(p.amount, p.currency, opts.convert) : p.amount;
  let incomeSum = 0;
  let expenseSum = 0;
  let arDelta = 0;
  for (const t of txns) {
    if (!inPeriod(t.date, opts.period)) continue;
    if (opts.tag && !t.tags.includes(opts.tag)) continue;
    for (const p of t.postings) {
      const ty = typeOf.get(p.accountId);
      if (ty === 'income') incomeSum += conv(p);
      else if (ty === 'expense') expenseSum += conv(p);
      if (arSet?.has(p.accountId)) arDelta += conv(p);
    }
  }
  const income = -incomeSum - arDelta;
  const expense = expenseSum;
  return { income, expense, net: income - expense };
}
