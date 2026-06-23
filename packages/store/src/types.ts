import type { Account, Book, Budget, Customer, DraftSuggestion, FeeDefinition, FeeTier, InventoryMovement, Order, OrderStatus, PluginDocument, Product, Purchase, PurchaseLine, Reconciliation, Settlement, StagingBatch, StagingBatchStatus, StagingRow, StagingRowStatus, Supplier, Transaction } from '@app/core';

/** 每条记录都带的同步元数据，为将来的云同步预留。 */
export interface SyncMeta {
  createdAt: string;
  updatedAt: string;
  /** 软删除：保留行、标记删除，便于同步与撤销 */
  deleted: boolean;
}

export type StoredBook = Book & SyncMeta;
export type StoredAccount = Account & SyncMeta;
export type StoredTransaction = Transaction & SyncMeta;
export type StoredBudget = Budget & SyncMeta;
export type StoredCustomer = Customer & SyncMeta;
export type StoredSupplier = Supplier & SyncMeta;
export type StoredOrder = Order & SyncMeta;
export type StoredSettlement = Settlement & SyncMeta;
export type StoredProduct = Product & SyncMeta;
export type StoredPurchase = Purchase & SyncMeta;
export type StoredFeeDefinition = FeeDefinition & SyncMeta;
export type StoredReconciliation = Reconciliation & SyncMeta;
export type StoredInventoryMovement = InventoryMovement & SyncMeta;
export type StoredPluginDocument = PluginDocument & SyncMeta;
export type StoredStagingBatch = StagingBatch & SyncMeta;
export type StoredStagingRow = StagingRow & SyncMeta;

/**
 * 通用设置项（KV）。scope = 'app' 为应用级，或某账本 id 为账本级。
 * value 为字符串，语义由读取方解释（枚举直接存字面值、复杂值存 JSON）。
 * 记账口径/对账周期/多币种汇率表等共用此表，避免逐功能建表。
 */
export interface StoredSetting {
  scope: string;
  key: string;
  value: string;
  updatedAt: string;
}

/** 时钟注入：返回 ISO 时间戳；默认实现用 Date，测试注入确定性时钟。 */
export type Clock = () => string;

export interface BookPatch {
  name?: string;
  archived?: boolean;
}

export interface AccountPatch {
  name?: string;
  type?: Account['type'];
  parentId?: string | null;
  currency?: string;
  global?: boolean;
  archived?: boolean;
}

export interface BudgetPatch {
  accountId?: string;
  monthlyLimit?: number;
}

export interface CustomerPatch {
  name?: string;
  phone?: string;
  note?: string;
  dueDays?: number;
  archived?: boolean;
}

/** 供应商可改字段（结构同 CustomerPatch）。 */
export type SupplierPatch = CustomerPatch;

/** B 期订单创建后行不可改（改 = 取消重建）；只允许改状态/备注/收入分录关联。 */
export interface OrderPatch {
  status?: OrderStatus;
  note?: string;
  revenueTxnId?: string | null;
}

export interface ProductPatch {
  name?: string;
  costPrice?: number;
  salePrice?: number;
  quoteOnly?: boolean;
  unit?: string;
  archived?: boolean;
}

/** 额外费用定义可改字段（C2 Step 4）。 */
export interface FeeDefinitionPatch {
  name?: string;
  calcType?: FeeDefinition['calcType'];
  tiers?: FeeTier[];
  archived?: boolean;
}

/** 采购单可改字段：草稿确认时补供应商/付款方式/采购价/记账 id，或更新备注。lines 给定即整单替换。 */
export interface PurchasePatch {
  supplierId?: string;
  date?: string;
  payMode?: 'cash' | 'credit';
  note?: string;
  txnId?: string | null;
  lines?: PurchaseLine[];
}

/** 导入批次可改字段：复核台标记已提交/已撤销，或更新文件名标签。source/accountId 建后不可变（改＝删批次重导）。 */
export interface StagingBatchPatch {
  label?: string;
  status?: StagingBatchStatus;
}

/** 草稿行可改字段（复核决定）：指派账本/对手腿、修正建议、落库回填 txnId、置状态。 */
export interface StagingRowPatch {
  assignedBookId?: string | null;
  assignedAccountId?: string | null;
  suggestion?: DraftSuggestion;
  status?: StagingRowStatus;
  txnId?: string | null;
}

export interface TxnQuery {
  /** 仅该账本的交易 */
  bookId?: string;
  /** 闭区间起始日期 YYYY-MM-DD */
  from?: string;
  /** 闭区间结束日期 */
  to?: string;
  /** 仅含该标签的交易 */
  tag?: string;
  /** 仅含触及该账户的交易 */
  accountId?: string;
}

/**
 * 平台无关的持久层接口。InMemory / node:sqlite / rusqlite+SQLCipher 桥（桌面）三个实现
 * 遵循同一契约；UI 只依赖此接口。
 *
 * 多账本约束（实现负责校验）：
 * - 账户必须挂在已存在的账本上；
 * - 一笔交易的全部分录账户必须与交易同账本（禁止跨账本分录）；
 * - 交易不可移动到其他账本；预算科目必须与预算同账本。
 */
export interface Repository {
  addBook(book: Book): Promise<StoredBook>;
  getBook(id: string): Promise<StoredBook | null>;
  listBooks(opts?: { includeArchived?: boolean }): Promise<StoredBook[]>;
  updateBook(id: string, patch: BookPatch): Promise<StoredBook>;

  addAccount(account: Account): Promise<StoredAccount>;
  getAccount(id: string): Promise<StoredAccount | null>;
  listAccounts(opts?: { includeArchived?: boolean; bookId?: string }): Promise<StoredAccount[]>;
  updateAccount(id: string, patch: AccountPatch): Promise<StoredAccount>;

  addTransaction(txn: Transaction): Promise<StoredTransaction>;
  getTransaction(id: string): Promise<StoredTransaction | null>;
  listTransactions(query?: TxnQuery): Promise<StoredTransaction[]>;
  updateTransaction(id: string, txn: Transaction): Promise<StoredTransaction>;
  softDeleteTransaction(id: string): Promise<void>;

  addBudget(budget: Budget): Promise<StoredBudget>;
  listBudgets(query?: { bookId?: string }): Promise<StoredBudget[]>;
  updateBudget(id: string, patch: BudgetPatch): Promise<StoredBudget>;
  removeBudget(id: string): Promise<void>;

  // 生意（v0.2 B 期）：客户 / 订单 / 收款。约束（实现负责校验）：
  // - 客户/订单/收款必须挂在已存在的账本上；
  // - 订单的客户、收款的客户/关联订单必须与单据同账本。
  addCustomer(customer: Customer): Promise<StoredCustomer>;
  getCustomer(id: string): Promise<StoredCustomer | null>;
  listCustomers(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredCustomer[]>;
  updateCustomer(id: string, patch: CustomerPatch): Promise<StoredCustomer>;

  // 供应商（v0.2 C2 期，应付）：镜像客户。赊购入库挂应付账款/<供应商>子科目。
  addSupplier(supplier: Supplier): Promise<StoredSupplier>;
  getSupplier(id: string): Promise<StoredSupplier | null>;
  listSuppliers(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredSupplier[]>;
  updateSupplier(id: string, patch: SupplierPatch): Promise<StoredSupplier>;

  addOrder(order: Order): Promise<StoredOrder>;
  getOrder(id: string): Promise<StoredOrder | null>;
  listOrders(query?: { bookId?: string; customerId?: string; status?: OrderStatus }): Promise<StoredOrder[]>;
  updateOrder(id: string, patch: OrderPatch): Promise<StoredOrder>;

  addSettlement(settlement: Settlement): Promise<StoredSettlement>;
  listSettlements(query?: { bookId?: string; orderId?: string; counterpartyId?: string }): Promise<StoredSettlement[]>;

  addProduct(product: Product): Promise<StoredProduct>;
  getProduct(id: string): Promise<StoredProduct | null>;
  listProducts(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredProduct[]>;
  updateProduct(id: string, patch: ProductPatch): Promise<StoredProduct>;

  // 额外费用定义（v0.2 C2 Step 4）：账本级可复用，开单行勾选应用。约束：必须挂在已存在账本上。
  addFeeDefinition(fee: FeeDefinition): Promise<StoredFeeDefinition>;
  listFeeDefinitions(opts?: { bookId?: string; includeArchived?: boolean }): Promise<StoredFeeDefinition[]>;
  updateFeeDefinition(id: string, patch: FeeDefinitionPatch): Promise<StoredFeeDefinition>;

  // 采购单（C2 模型重构）：「为此单采购」，一张采购单对应一张订单。开单不足时生成草稿态
  // （supplierId=''、txnId=null），确认时用 updatePurchase 补供应商/采购价/记账 id，作废用 removePurchase。
  // 约束：已确认采购单（supplierId 非空）的供应商、关联订单必须与采购单同账本。
  addPurchase(purchase: Purchase): Promise<StoredPurchase>;
  getPurchase(id: string): Promise<StoredPurchase | null>;
  listPurchases(query?: { bookId?: string; orderId?: string; supplierId?: string }): Promise<StoredPurchase[]>;
  updatePurchase(id: string, patch: PurchasePatch): Promise<StoredPurchase>;
  removePurchase(id: string): Promise<void>;

  // 库存出入库流水（v0.2 C2 期）：只追加、不改（盘点纠错另记一笔 adjust）。
  // 在手数量/移动加权均价由 core inventoryState 回放流水聚合，不存死值。约束：商品须与流水同账本。
  addInventoryMovement(m: InventoryMovement): Promise<StoredInventoryMovement>;
  listInventoryMovements(query?: { bookId?: string; productId?: string; orderId?: string }): Promise<StoredInventoryMovement[]>;

  // 通用设置（KV）：scope='app' 或账本 id。setSetting 为 upsert（同 scope+key 覆盖）。
  getSetting(scope: string, key: string): Promise<StoredSetting | null>;
  setSetting(scope: string, key: string, value: string): Promise<StoredSetting>;
  listSettings(scope?: string): Promise<StoredSetting[]>;

  // 月度对账：标记分录已核销 + 记录完成的对账会话。补录/改/删纠错复用现有交易 CRUD。
  // setPostingsCleared 直接按 posting id 批量置位（完成对账时写入勾选状态全集）。
  setPostingsCleared(postingIds: string[], cleared: boolean): Promise<void>;
  addReconciliation(rec: Reconciliation): Promise<StoredReconciliation>;
  listReconciliations(query?: { bookId?: string; accountId?: string }): Promise<StoredReconciliation[]>;

  // 插件单据实例（插件地基 Step 1）：声明式单据 → 平衡分录后存此。约束：必须挂在已存在账本上。
  // removePluginDocument 软删（撤单时由编排层先反向 txnIds 再软删）。
  addPluginDocument(doc: PluginDocument): Promise<StoredPluginDocument>;
  listPluginDocuments(query?: { bookId?: string; pluginId?: string; docType?: string }): Promise<StoredPluginDocument[]>;
  getPluginDocument(id: string): Promise<StoredPluginDocument | null>;
  removePluginDocument(id: string): Promise<void>;

  // 导入复核台脊梁（账单导入 增量1·②；通用 staging，将来对账/OCR/语音/AI 复用）。
  // 草稿批次 + 草稿行先入此暂存区，复核台逐笔指派账本/对手腿、定夺 unknown，确认后才 expandEntry
  // 落正式交易并回填 txnId。精简契约（只给复核台要的 ~6 方法，非全 CRUD）：
  // - addStagingRows 批量插入（一把事务、整批原子；行 id 在批内/库内须唯一，否则整批拒）；
  // - listStagingRows 支持 batchId/status/bizNos 过滤。bizNos 兼做「再导去重」与「落库中断自愈」，
  //   但**仅按 biz_no 匹配、不含 source**——biz_no 仅在同一 source 内唯一，编排层去重须按
  //   (source, biz_no) 复合键判等（取 batch.source）、并把结果当存在性集合用（同号可多行 posted）；
  // - 行/批次只软删与状态机，无硬删。撤销＝batch.status='reverted' + 反向 txnIds + **逐行退出
  //   posted（清 txnId）**，否则死交易的 biz_no 会污染去重集致重导被吞；均由编排层负责。
  addStagingBatch(batch: StagingBatch): Promise<StoredStagingBatch>;
  addStagingRows(rows: StagingRow[]): Promise<StoredStagingRow[]>;
  listStagingBatches(query?: { status?: StagingBatchStatus }): Promise<StoredStagingBatch[]>;
  listStagingRows(query?: { batchId?: string; status?: StagingRowStatus; bizNos?: string[] }): Promise<StoredStagingRow[]>;
  updateStagingBatch(id: string, patch: StagingBatchPatch): Promise<StoredStagingBatch>;
  updateStagingRow(id: string, patch: StagingRowPatch): Promise<StoredStagingRow>;
}
