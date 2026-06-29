/**
 * 复式记账领域类型（平台无关、无 I/O）。
 *
 * 约定（beancount 风格的有符号记账）：
 * - 金额一律用「整数最小单位」（CNY 即「分」），杜绝浮点误差。
 * - 每笔交易的所有 posting 金额之和恒为 0（借贷平衡）。
 * - 账户余额 = 该账户所有 posting 金额之和。
 *   资产/费用余额通常为正，负债/收入/权益通常为负。
 *
 * 多账本（v0.2）：
 * - Book 是顶层容器（个人/生意/投资，可各建多个）；
 *   账户/交易/预算全部挂 bookId，一笔交易的所有分录必须属于同一账本。
 */

export type BookType = 'personal' | 'business' | 'investment';

export interface Book {
  id: string;
  name: string;
  type: BookType;
  archived: boolean;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: string;
  /** 归属/创建账本；`global=true` 时仅作元数据（全局账户的余额归入全局资金池，不计入某账本净资产）。 */
  bookId: string;
  name: string;
  type: AccountType;
  /** 层级科目；顶层为 null */
  parentId: string | null;
  /** ISO 4217；MVP 单一本位币 'CNY' */
  currency: string;
  /**
   * 全局/共享账户（真金白银：现金/银行/支付宝…）：所有账本共用、记账下拉都可选、对账按账户跨账本。
   * 缺省/false = 账本专属（损益科目、应收/应付/库存等虚拟账户恒专属）。
   */
  global?: boolean;
  archived: boolean;
}

/** 有符号的整数最小单位（如 CNY 的「分」）。 */
export type Minor = number;

export interface Posting {
  id: string;
  txnId: string;
  accountId: string;
  /** 有符号最小单位；同一交易下所有 posting 之和 === 0 */
  amount: Minor;
  currency: string;
  /** 已核销（对账勾对）。月度对账完成时置位；缺省/false = 未核销。 */
  cleared?: boolean;
}

export interface Transaction {
  id: string;
  bookId: string;
  /** 记账日期 YYYY-MM-DD */
  date: string;
  payee: string;
  note: string;
  /** 维度标签（自由扩展；生意/个人之分已由账本承担） */
  tags: string[];
  postings: Posting[];
  /**
   * 关联订单（M18a）：订单完成时生成的全部分录（确认收入 / 库存出库 COGS / 代采成本结转）都打此标记，
   * 撤销订单时 `listTransactions({orderId})` 一把捞全（含此前无处可查的代采结转孤儿分录）。
   * 缺省/null = 非订单完成分录（手记/收款核销/进货等）。
   */
  orderId?: string | null;
}

export interface Budget {
  id: string;
  bookId: string;
  /** 预算针对的科目（通常是费用科目） */
  accountId: string;
  /** 每月限额（minor units） */
  monthlyLimit: number;
}

/**
 * 生意系统（v0.2 B 期）：客户 / 订单 / 收款。
 * 业务单据是操作层，财务动作（订单完成确认收入、收款核销）自动生成平衡分录进复式内核，
 * 报表/应收余额从分录聚合——不另立平行账。见 ARCHITECTURE.md「多账本与生意系统」。
 */

export interface Customer {
  id: string;
  bookId: string;
  name: string;
  phone: string;
  note: string;
  /** 默认账期天数；到期日 = 订单日期 + dueDays。0 = 货到付款/即时 */
  dueDays: number;
  archived: boolean;
}

/**
 * 供应商档案（v0.2 C2 期）：镜像 Customer。赊购入库挂应付账款/<供应商>子科目，
 * dueDays 为默认账期（采购到期日 = 采购日 + dueDays）。
 */
export interface Supplier {
  id: string;
  bookId: string;
  name: string;
  phone: string;
  note: string;
  /** 默认账期天数；0 = 现款现货/即时 */
  dueDays: number;
  archived: boolean;
}

/**
 * 待采购 / 待发货 / 已发货 / 已完成 / 已取消。
 * 开单时若任一商品在手不足 → `pending_purchase`（同时生成待采购草稿单）；
 * 库存充足或采购确认后 → `pending_ship`；完成 → `completed`。
 */
export type OrderStatus = 'pending_purchase' | 'pending_ship' | 'shipped' | 'completed' | 'cancelled';

export interface OrderLine {
  id: string;
  orderId: string;
  /** 商品名（可来自商品主数据，也可自由文本） */
  name: string;
  /** 数量（可含小数，如按重量计） */
  qty: number;
  /** 单价（最小单位/分） */
  unitPrice: Minor;
  /** 关联的商品主数据 id；自由文本行为 null（C1 期） */
  productId: string | null;
  /** 本行应用的额外费用定义 id 列表（C2 Step 4）；缺省/空 = 无额外费用 */
  feeIds?: string[];
}

/**
 * 商品主数据（v0.2 C1 期 → C2 模型重构）：开单时可选商品自动带价，免去重复手输。
 * 统一库存模型：所有商品默认都做库存追踪（统一在手数，默认 0），开单不限库存，
 * 不足部分在开单时自动生成「待采购草稿单」，确认采购即采即出（成本直挂订单、不过库存均价池）。
 * `quoteOnly` 是反向标记：纯报价/服务行（设计费/打样费/安装费），不进成本、不触发库存与自动采购。
 */
export interface Product {
  id: string;
  bookId: string;
  name: string;
  /** 进价（最小单位/分） */
  costPrice: Minor;
  /** 售价（最小单位/分） */
  salePrice: Minor;
  /** 纯报价/服务行：不做库存追踪、不进成本、不触发自动采购。默认 false = 库存追踪。 */
  quoteOnly: boolean;
  /** 单位（个/kg…），可空 */
  unit: string;
  archived: boolean;
}

export interface Order {
  id: string;
  bookId: string;
  customerId: string;
  /** 下单日期 YYYY-MM-DD */
  date: string;
  /** 订单结算币种（ISO 4217 / 自定义代码）；行单价/总额、确认收入、收款均按此币种。默认 'CNY'。 */
  currency: string;
  status: OrderStatus;
  note: string;
  /** 已完成时生成的收入确认分录 id；未完成为 null */
  revenueTxnId: string | null;
  lines: OrderLine[];
}

/**
 * 额外费用计算方式（C2 Step 4，flagship 公式引擎）：
 * - `percent`：百分比——按适用商品行金额 × 档位百分数（如佣金 5%）。
 * - `fixed`：固定金额——一次性收取档位金额（如运费 ¥10/单）。
 * - `perQty`：按数量——适用商品行数量合计 × 档位单位额（如包装费 ¥2/件）。
 */
export type FeeCalcType = 'percent' | 'fixed' | 'perQty';

/** 声明式阶梯一档：分组合计达到 threshold（含）起适用本档 value。最低档 threshold=0。 */
export interface FeeTier {
  /** 阶梯阈值（最小单位/分；perQty 下按数量阈值）；无阶梯则单档 threshold=0 */
  threshold: number;
  /** percent: 百分数(5=5%)；fixed: 固定额(分)；perQty: 每单位额(分) */
  value: number;
}

/**
 * 额外费用定义（C2 Step 4）：账本级可复用，开单时在商品行上勾选应用。
 * 声明式阶梯档位表——LLM 自然语言生成公式的目标格式（后置：LLM 只翻译成此结构，算账由 `computeFees` 确定性执行）。
 */
export interface FeeDefinition {
  id: string;
  bookId: string;
  name: string;
  calcType: FeeCalcType;
  /** 阶梯档位（按 threshold 升序，至少一档；含 threshold=0 基础档）。分组合计落在哪档用哪档 value。 */
  tiers: FeeTier[];
  archived: boolean;
}

/** in = 收款（来自客户）；out = 付款（给供应商，C 期）。 */
export type SettlementDirection = 'in' | 'out';
export type CounterpartyType = 'customer' | 'supplier';

export interface Settlement {
  id: string;
  bookId: string;
  direction: SettlementDirection;
  counterpartyType: CounterpartyType;
  /** customerId（B 期）/ supplierId（C 期） */
  counterpartyId: string;
  /** 可选关联单据 */
  orderId: string | null;
  /** 正数最小单位 */
  amount: Minor;
  date: string;
  /** 收/付款使用的资产账户（微信商户/对公账户/现金…）——账户即渠道，不另设"方式"字段 */
  accountId: string;
  note: string;
  /** 生成的核销分录 id */
  txnId: string | null;
}

/** 采购单行：为某订单专门采购的一项（草稿态单价 = 商品进价预填，确认时可改）。 */
export interface PurchaseLine {
  id: string;
  purchaseId: string;
  /** 采购的商品 id（自由文本行为 null） */
  productId: string | null;
  name: string;
  qty: number;
  /** 采购单价（最小单位，CNY 本位） */
  unitCost: Minor;
}

/**
 * 采购去向（C2 模型重构 Step 3）：
 * - `stock`：补库存进货——借库存商品/贷（现金 or 应付），进移动加权均价池（无关联订单）。
 * - `dropship`：为某订单代采——借代采在途/贷（现金 or 应付），挂 `orderId`、订单完成时结转 COGS（不过库存池）。
 * - `expense`：费用采购——借目标费用科目（`destAccountId`）/贷（现金 or 应付），不进库存（无关联订单）。
 */
export type PurchaseKind = 'stock' | 'dropship' | 'expense';

/**
 * 采购单（C2 模型重构）：采购一等公民。`kind` 决定去向（见 PurchaseKind）。
 * dropship 关联订单（`orderId`）；stock/expense 无订单（`orderId = null`）。
 * 代采可先生成**草稿态**（`supplierId=''`、`txnId=null`、行单价=进价预填，开单不足时自动生成），
 * 确认时补供应商、采购价并记账、写 `txnId`；`txnId === null` 即草稿（可作废）、`!== null` 即已确认。
 * CNY 本位（外币采购后置）。
 */
export interface Purchase {
  id: string;
  bookId: string;
  /** 供应商 id；草稿态 / 现结无供应商时为 '' */
  supplierId: string;
  /** 采购去向 */
  kind: PurchaseKind;
  /** 关联订单（仅 dropship 为此单采购）；stock/expense 为 null */
  orderId: string | null;
  /** 费用采购的目标费用科目 id（仅 kind=expense）；其余为 null */
  destAccountId: string | null;
  date: string;
  /** 付款方式：cash=现结 / credit=赊账（记应付账款/供应商） */
  payMode: 'cash' | 'credit';
  note: string;
  /** 采购生成的分录 id；草稿态为 null（未记账） */
  txnId: string | null;
  lines: PurchaseLine[];
}

/**
 * 月度对账会话（勾对式 statement reconciliation，v0.2）：
 * 把某账户流水逐笔勾对真实对账单，差额对到 0 才完成。完成时记一条历史，
 * 并把勾选的分录标记 cleared。详见 ARCHITECTURE.md「月度对账」。
 * MVP 只存「已完成」记录（审计/上次对账基线）；勾选中途状态活在 UI。
 */
export interface Reconciliation {
  id: string;
  bookId: string;
  /** 对账的账户（资产/负债） */
  accountId: string;
  /** 对账单余额（有符号最小单位，与账户余额同号约定） */
  statementBalance: Minor;
  /** 对账截止日 YYYY-MM-DD */
  statementDate: string;
  /** 完成时间 ISO */
  completedAt: string;
}

/** 出入库类型：in=进货/补货（+），out=订单出库（−），adjust=盘点调整（±）。 */
export type InventoryKind = 'in' | 'out' | 'adjust';

/**
 * 库存出入库流水（v0.2 C2 期）：库存品的在手数量与移动加权均价**不存死值**，全部由流水回放聚合
 * （见 ARCHITECTURE「库存」）。in 记进价；out 记出库时点的移动加权均价（结转营业成本用）。
 * 库存成本以人民币本位计（库存商品/营业成本为 CNY 科目）。
 */
export interface InventoryMovement {
  id: string;
  bookId: string;
  productId: string;
  /** 发生日期 YYYY-MM-DD */
  date: string;
  kind: InventoryKind;
  /** 有符号数量：in 为正、out 为负（与 kind 一致） */
  qty: number;
  /** 单位成本（人民币最小单位/分）：in=进价，out=出库时点移动加权均价 */
  unitCost: Minor;
  /** 关联订单（out 由订单完成产生）；进货为 null */
  orderId: string | null;
  /** 生成的复式分录 id（进货=借库存/贷资产；出库=借营业成本/贷库存） */
  txnId: string | null;
  note: string;
}
