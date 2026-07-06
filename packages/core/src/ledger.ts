import type { Posting, Transaction } from './types';
import { assertMinor } from './money';

/** 一组 posting 的金额之和（不分币种，仅内部/单币种使用）。 */
export function balanceOf(postings: Posting[]): number {
  return postings.reduce((sum, p) => sum + p.amount, 0);
}

/** 按币种分组求和。 */
function sumByCurrency(postings: Posting[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of postings) m.set(p.currency, (m.get(p.currency) ?? 0) + p.amount);
  return m;
}

/**
 * 平衡规则（多币种）：
 * - 单一币种：分录求和必须 = 0（普通交易，现有 CNY 账目不受影响）。
 * - 多币种：视为「换汇/跨币转账」——两条原币腿本就不等价，豁免求和=0。
 * 空分录视为平衡。
 */
export function isBalanced(postings: Posting[]): boolean {
  const byCur = sumByCurrency(postings);
  if (byCur.size <= 1) return (byCur.values().next().value ?? 0) === 0;
  return true; // 多币种：换汇豁免
}

export function assertBalanced(postings: Posting[]): void {
  const byCur = sumByCurrency(postings);
  if (byCur.size <= 1) {
    const b = byCur.values().next().value ?? 0;
    if (b !== 0) throw new Error(`交易未平衡：postings 之和为 ${b}，应为 0`);
  }
  // 多币种（换汇）：豁免同币种求和=0
}

export type EntryKind = 'expense' | 'income' | 'transfer';

interface EntryBase {
  bookId: string;
  date: string;
  /** 正的最小单位金额 */
  amount: number;
  currency?: string;
  payee?: string;
  note?: string;
  tags?: string[];
}

/**
 * 单式记账输入（面向用户的简单语义），由 expandEntry 自动展开成平衡的复式分录。
 * - expense：钱从 accountId（资产/负债）流出，归类到 categoryId（费用科目）
 * - income：钱进入 accountId（资产），来源为 categoryId（收入科目）
 * - transfer：从 fromAccountId 转到 toAccountId
 */
export type EntryInput =
  | (EntryBase & { kind: 'expense'; accountId: string; categoryId: string })
  | (EntryBase & { kind: 'income'; accountId: string; categoryId: string })
  | (EntryBase & { kind: 'transfer'; fromAccountId: string; toAccountId: string });

/**
 * 把单式输入展开为一笔平衡的复式交易。
 * genId 由调用方注入（store/shell 传 crypto.randomUUID，测试传确定性计数器），
 * 以保持 core 纯函数、无环境依赖。
 */
export function expandEntry(input: EntryInput, genId: () => string): Transaction {
  assertMinor(input.amount, 'amount');
  if (input.amount <= 0) {
    throw new Error('amount 必须为正数（最小单位）');
  }
  const currency = input.currency ?? 'CNY';
  const txnId = genId();
  const mk = (accountId: string, amount: number): Posting => ({
    id: genId(),
    txnId,
    accountId,
    amount,
    currency,
  });

  let postings: Posting[];
  switch (input.kind) {
    case 'expense':
      postings = [mk(input.categoryId, input.amount), mk(input.accountId, -input.amount)];
      break;
    case 'income':
      postings = [mk(input.accountId, input.amount), mk(input.categoryId, -input.amount)];
      break;
    case 'transfer':
      postings = [mk(input.toAccountId, input.amount), mk(input.fromAccountId, -input.amount)];
      break;
    default: {
      const _exhaustive: never = input;
      throw new Error(`未知的记账类型：${String(_exhaustive)}`);
    }
  }

  assertBalanced(postings);
  return {
    id: txnId,
    bookId: input.bookId,
    date: input.date,
    payee: input.payee ?? '',
    note: input.note ?? '',
    tags: input.tags ?? [],
    postings,
  };
}

/**
 * 红冲（反向冲销，账单导入 增量2）：给定一笔已落库交易，生成一笔金额逐腿取反的「冲正」交易
 * （新 id、新日期、payee/note 由调用方给），**原交易不动**。用于撤销已对账(cleared)分录——
 * 保留审计轨迹、不破坏已完成对账的快照（冲正落在撤销当期、不回改历史期间）。
 * 单币种取反后仍求和=0；多币种逐腿取反、按币种豁免。冲正分录不带 cleared（是新发生、未对账事项）。
 */
export function reversalEntry(
  source: Pick<Transaction, 'bookId' | 'postings'>,
  opts: { date: string; payee?: string; note?: string; tags?: string[] },
  genId: () => string,
): Transaction {
  const txnId = genId();
  const postings: Posting[] = source.postings.map((p) => ({
    id: genId(),
    txnId,
    accountId: p.accountId,
    amount: -p.amount,
    currency: p.currency,
  }));
  assertBalanced(postings);
  return {
    id: txnId,
    bookId: source.bookId,
    date: opts.date,
    payee: opts.payee ?? '',
    note: opts.note ?? '',
    tags: opts.tags ?? [],
    postings,
  };
}

export interface ForexInput {
  bookId: string;
  date: string;
  /** 汇出账户（原币减少） */
  fromAccountId: string;
  /** 汇出金额（正数最小单位，fromCurrency 计） */
  fromAmount: number;
  fromCurrency: string;
  /** 到账账户（原币增加） */
  toAccountId: string;
  /** 实际到账金额（正数最小单位，toCurrency 计） */
  toAmount: number;
  toCurrency: string;
  payee?: string;
  note?: string;
  tags?: string[];
}

/**
 * 换汇 / 跨币转账：只记两条**原币实际数**（汇出额、到账额），不在录入时折算、不自动记汇损。
 * 汇损隐含在原币余额差里，仅在折算总值时体现（见 ARCHITECTURE「多币种」）。
 * 两腿币种不同，`assertBalanced` 按币种分组豁免「求和=0」。
 */
export function forexEntry(input: ForexInput, genId: () => string): Transaction {
  assertMinor(input.fromAmount, 'fromAmount');
  assertMinor(input.toAmount, 'toAmount');
  if (input.fromAmount <= 0 || input.toAmount <= 0) {
    throw new Error('汇出 / 到账金额必须为正数（最小单位）');
  }
  if (input.fromCurrency === input.toCurrency) {
    throw new Error('同币种请用普通转账（transfer），换汇要求两腿币种不同');
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new Error('汇出与到账账户不能相同');
  }
  const txnId = genId();
  const postings: Posting[] = [
    { id: genId(), txnId, accountId: input.toAccountId, amount: input.toAmount, currency: input.toCurrency },
    { id: genId(), txnId, accountId: input.fromAccountId, amount: -input.fromAmount, currency: input.fromCurrency },
  ];
  assertBalanced(postings); // 多币种 → 豁免；仅守住「非空」等基本前提
  return {
    id: txnId,
    bookId: input.bookId,
    date: input.date,
    payee: input.payee ?? '',
    note: input.note ?? '换汇',
    tags: input.tags ?? [],
    postings,
  };
}
