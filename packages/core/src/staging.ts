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
