/**
 * 复核台脊梁 · 通用暂存（staging）领域类型（账单导入 增量1·②）。
 *
 * 这是一根**通用**脊梁：导入（支付宝/微信）是第一个进料，将来对账 match / 本地 OCR /
 * 语音 ASR / 云 LLM 草稿都汇入同一张暂存区，复核台逐笔人工核对后才落正式交易。
 * 故命名 `staging_*`、带 `source` 字段；但**列只放导入现用的**，绝不预建 OCR/语音/对账专用列
 * （壳通用、列克制 = YAGNI）。
 *
 * 数据流：解析器 `ImportDraftRow[]` → 建 `StagingBatch` + 一批 `StagingRow`（草稿态）→
 * 复核台逐行指派账本/科目、补对手腿、定夺 `unknown` → `expandEntry` 落库、回填 `txnId`。
 * 算账永远走确定性引擎、人工核对永远在（红线）。
 */

import type { EntryInput } from './ledger';
import type { Direction, DraftSuggestion } from './import/types';

/** 批次状态：审中 → 已提交（全行落库/跳过）/ 已撤销（整批反向）。 */
export type StagingBatchStatus = 'reviewing' | 'committed' | 'reverted';

/** 草稿行状态：待复核 → 已落库 / 已跳过。 */
export type StagingRowStatus = 'pending' | 'posted' | 'skipped';

/** 一次导入/进料的批次。 */
export interface StagingBatch {
  id: string;
  /** 进料来源：'alipay-fund-flow' | 'wechat-bill'（将来：reconcile / ocr / voice / llm）。 */
  source: string;
  /** 导入时选定的全局源账户（支付宝/微信/银行…），整批共用。 */
  accountId: string;
  /** 文件名 / 描述，供复核台展示。 */
  label: string;
  status: StagingBatchStatus;
}

/**
 * 一笔草稿行：标准化解析字段（同 `ImportDraftRow`，`source` 上移到批次）+ 复核决定。
 * `assignedAccountId` 是「对手腿账户」：income/expense 时＝分类科目；transfer/refund 时＝对手资金账户。
 */
export interface StagingRow {
  id: string;
  batchId: string;
  /** 去重键（账单内唯一，如支付宝交易号/微信交易单号）；建索引：再导去重 + 落库中断自愈。 */
  bizNo: string;
  date: string;
  datetime: string;
  /** 最小单位/分，恒为正；收支方向看 direction。 */
  amountMinor: number;
  direction: Direction;
  payee: string;
  counterpartyAccount: string;
  note: string;
  accountingType: string;
  /** 记账语义（解析器预选，复核台可改）。 */
  suggestion: DraftSuggestion;
  /** 复核决定：指派账本（pending 时为 null）。 */
  assignedBookId: string | null;
  /** 复核决定：对手腿账户（pending 时为 null）。 */
  assignedAccountId: string | null;
  status: StagingRowStatus;
  /** 落库后回填的交易 id（pending/skipped 时为 null）。 */
  txnId: string | null;
}

/**
 * 复核台对一行的落库决定。**红线**：解析器的 `unknown`/双关行必须由复核台先定夺成具体 `kind`，
 * 本类型不含 unknown——`stagingRowToEntry` 不读 suggestion 兜底（绝不按 direction 静默记错）。
 * `refund` 由复核台按冲账方向折成 income/expense（退款进账冲原支出＝把钱记回该支出科目）。
 */
export interface StagingPostDecision {
  kind: 'income' | 'expense' | 'transfer-in' | 'transfer-out';
  /** 落入的账本。 */
  bookId: string;
  /** 对手腿账户：income/expense=分类科目；transfer=对手资金账户。 */
  accountId: string;
}

/**
 * 把一条已复核的草稿行 + 落库决定 + 源账户（整批选定的全局账户），纯函数地映射成 `expandEntry` 输入。
 * 金额/平衡校验交给 `expandEntry`；这里只定方向与两腿账户：
 * - income：钱进源账户（借源账户 / 贷分类收入）；
 * - expense：钱出源账户（借分类支出 / 贷源账户）；
 * - transfer-out：源账户 → 对手账户；transfer-in：对手账户 → 源账户。
 * 守卫：对手腿不得等于源账户（否则一腿自抵＝空交易）。导入恒单一币种 CNY（由 expandEntry 默认）。
 */
export function stagingRowToEntry(
  row: Pick<StagingRow, 'amountMinor' | 'date' | 'payee' | 'note'>,
  decision: StagingPostDecision,
  sourceAccountId: string,
): EntryInput {
  if (!decision.bookId || !decision.accountId) {
    throw new Error('落库决定缺账本或对手腿账户（草稿未复核指派，不得落库）');
  }
  if (decision.accountId === sourceAccountId) {
    throw new Error('对手腿账户不能等于源账户');
  }
  // 红线：日期必须合法（YYYY-MM-DD）才落库。CSV/xlsx 解析器恒产合法日期，但 OCR 草稿可能日期未识别（date=''）——
  // 空/非法日期落库会生成「无日期交易」：仍计入账户余额，却从所有按月（预算/收支）视图静默消失。此处兜死，
  // 任何调用方（含复核台）都不得落无日期交易；OCR 行须先在复核台补填合法日期。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    throw new Error('草稿行日期非法（应为 YYYY-MM-DD），不得落库；请在复核台补填日期');
  }
  const base = { bookId: decision.bookId, date: row.date, amount: row.amountMinor, payee: row.payee, note: row.note, tags: [] as string[] };
  switch (decision.kind) {
    case 'income':
      return { ...base, kind: 'income', accountId: sourceAccountId, categoryId: decision.accountId };
    case 'expense':
      return { ...base, kind: 'expense', accountId: sourceAccountId, categoryId: decision.accountId };
    case 'transfer-out':
      return { ...base, kind: 'transfer', fromAccountId: sourceAccountId, toAccountId: decision.accountId };
    case 'transfer-in':
      return { ...base, kind: 'transfer', fromAccountId: decision.accountId, toAccountId: sourceAccountId };
  }
}
