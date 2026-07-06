/**
 * 账单导入 · 标准化草稿行（增量1）。
 *
 * 各账单源（支付宝资金流水 / 微信 xlsx / 银行…）各有一个解析器，把原始账单**纯函数地**
 * 解析成一组统一的 `ImportDraftRow`。草稿行不直接落库——它们先进「复核台」，由用户逐笔
 * 核对（指派账本 + 分类、修正建议）后才生成正式交易。这道人工闸门是红线（解析/AI 只起草、
 * 算账与落库由确定性引擎在用户确认后执行）。
 */

/**
 * 记账语义建议（复核台据此预选，用户可改）：
 * - `income` / `expense`：与外部对象的真实收 / 支；
 * - `transfer-in` / `transfer-out`：自有账户间的内部划转（理财申购/赎回、提现、充值…），**不是**收支；
 * - `refund`：退款（冲账方向看本行 `direction`：in=收到退款冲原支出 / out=退款给他人冲原收入）；
 * - `unknown`：未识别**或语义双关**（如「转账」可能转给自己）的类型 —— 解析器不猜，留待复核台确认。
 *
 * ⚠️ 下游落库契约（红线）：`unknown` 行**必须**由复核台显式定夺，**绝不能**按 `direction`
 * 兜底落成 income/expense；`transfer-*` / `refund` 需复核台补「对手账户 / 原交易引用」才能展开成
 * 平衡复式分录（解析器只给方向建议，不负责对手腿）。
 */
export type DraftSuggestion = 'income' | 'expense' | 'transfer-in' | 'transfer-out' | 'refund' | 'unknown';

/** 资金方向：进账 / 出账。 */
export type Direction = 'in' | 'out';

/** 一笔从外部账单解析出的标准化草稿行（尚未落库）。 */
export interface ImportDraftRow {
  /** 来源标识，如 'alipay-fund-flow' */
  source: string;
  /** 去重键（账单内唯一，如支付宝交易号）——再次导入同一账单据此跳过 */
  bizNo: string;
  /** 记账日期 'YYYY-MM-DD' */
  date: string;
  /** 原始时间戳（含时分秒），原样保留供展示/排序 */
  datetime: string;
  /** 金额（最小单位/分），**恒为正**；收支方向看 direction */
  amountMinor: number;
  /** 资金方向 */
  direction: Direction;
  /** 对方（优先「对方名称」，缺则「对方账户」） */
  payee: string;
  /** 对方账户原始串（银行卡 / 邮箱 / 手机掩码等）；供复核台「自转判定」与落库对手腿用，缺省省略 */
  counterpartyAccount?: string;
  /** 备注（商品名称 / 备注 / 业务描述等合成） */
  note: string;
  /** 原始账务类型（如「在线支付」「理财申购」），保留供复核台展示与映射追溯 */
  accountingType: string;
  /** 记账语义建议（复核台预选） */
  suggestion: DraftSuggestion;
}

/** 账单元数据（账号 / 查询区间 / 导出时间）。 */
export interface ImportMeta {
  source: string;
  account?: string;
  rangeStart?: string;
  rangeEnd?: string;
  exportedAt?: string;
}

/** 解析结果：草稿行 + 元数据 + 告警（空行 / 无法解析 / 未知账务类型）。 */
export interface ImportParseResult {
  rows: ImportDraftRow[];
  meta: ImportMeta;
  warnings: string[];
}
