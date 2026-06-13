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
  bookId: string;
  name: string;
  type: AccountType;
  /** 层级科目；顶层为 null */
  parentId: string | null;
  /** ISO 4217；MVP 单一本位币 'CNY' */
  currency: string;
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
 * 采购单（C2 模型重构）：「为此单采购」——一张采购单对应一张订单（orderId）。
 * 开单时若商品在手不足，自动生成**草稿态**采购单（`supplierId=''`、`txnId=null`、行单价 = 进价预填）；
 * 确认采购时补供应商、采购价并记账（借代采在途/贷应付 or 现金）、写 `txnId`。
 * `txnId === null` 即草稿（尚未记账，可作废）；`txnId !== null` 即已确认。
 * 成本计入「代采在途成本」holding 资产、订单完成时结转 COGS（不过库存均价池）。CNY 本位（外币采购后置）。
 */
export interface Purchase {
  id: string;
  bookId: string;
  /** 供应商 id；草稿态为 '' （确认时补） */
  supplierId: string;
  /** 关联订单（为此单采购） */
  orderId: string;
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
