import { accountBalance, allocateCustomerPayments, collectionEntry, convertAmount, creditPurchaseEntry, expandEntry, inventoryState, orderRevenueEntry, orderTotal, planInventoryIssue, purchaseTotal, supplierPaymentEntry } from '@app/core';
import type { AccountType, ConvertCtx, Customer, CustomerPayment, IssuePlanLine, Order, OrderLine, OrderPaymentStatus, OrderStatus, PurchaseLine, Supplier } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredCustomer, StoredInventoryMovement, StoredOrder, StoredProduct, StoredPurchase, StoredSettlement, StoredTransaction } from '@app/store';
import { genId } from './db';
import { daysBetween } from './format';

/**
 * 生意视图的编排层（UI 与 store 之间）：把业务动作翻译成「建应收子科目 → core 生成平衡分录 →
 * 落库」。core 保持纯、store 保持通用，业务语义（应收按客户建子科目）只活在这一层。
 *
 * 多币种：应收是单一币种资产，故按「客户 × 币种」建子科目——CNY 用 `应收账款/<名>`（向后兼容历史数据），
 * 非 CNY 用 `应收账款/<名> (币种)`。同一客户跨币种欠款落在不同子科目，互不混算。
 */

const AR_PARENT = '应收账款';
const REVENUE = '营业收入';

/** 应收子科目名：CNY 沿用 `应收账款/<名>`（兼容旧数据），非 CNY 追加 ` (币种)`。 */
const arName = (customerName: string, currency: string): string =>
  currency === 'CNY' ? `${AR_PARENT}/${customerName}` : `${AR_PARENT}/${customerName} (${currency})`;

/** 某客户的全部应收子科目（含各币种）：名为 `应收账款/<名>` 或 `应收账款/<名> (币种)`。 */
function customerArAccounts(accounts: StoredAccount[], customerName: string): StoredAccount[] {
  const base = `${AR_PARENT}/${customerName}`;
  return accounts.filter((a) => a.type === 'asset' && (a.name === base || a.name.startsWith(`${base} (`)));
}

/** 某客户当前应收余额（净额，折算到展示币种）：正=客户欠你，负=你欠客户（预收）。跨币种各子科目折算后相加。 */
export function receivableBalance(
  accounts: StoredAccount[],
  txns: StoredTransaction[],
  customerName: string,
  convert: ConvertCtx,
): number {
  let sum = 0;
  for (const a of customerArAccounts(accounts, customerName)) {
    sum += convertAmount(accountBalance(txns, a.id), a.currency, convert);
  }
  return sum;
}

/** 全账本应收账款科目 id（顶层「应收账款」+ 各客户/各币种子科目）。供收付实现制按 ΔAR 折算实收用。 */
export function receivableAccountIds(accounts: StoredAccount[]): string[] {
  return accounts.filter((a) => a.name === AR_PARENT || a.name.startsWith(`${AR_PARENT}/`)).map((a) => a.id);
}

/** 全账本客户往来汇总（折算到展示币种）：应收合计（别人欠你）/ 预收合计（你欠别人）。各币种子科目折算后归并。 */
export function receivableSummary(
  accounts: StoredAccount[],
  txns: StoredTransaction[],
  convert: ConvertCtx,
): { receivable: number; prepaid: number } {
  let receivable = 0;
  let prepaid = 0;
  for (const a of accounts) {
    if (!a.name.startsWith(`${AR_PARENT}/`)) continue;
    const bal = convertAmount(accountBalance(txns, a.id), a.currency, convert);
    if (bal > 0) receivable += bal;
    else if (bal < 0) prepaid += -bal;
  }
  return { receivable, prepaid };
}

/** 一张已完成订单的收款状态（FIFO 摊单后）。 */
export interface OrderPayState {
  status: OrderPaymentStatus;
  collected: number;
  total: number;
}

/** 一张未收清订单的应收明细（账龄 / 逾期 / 距到期天数）。 */
export interface OutstandingOrder {
  order: StoredOrder;
  /** 欠款（订单币种最小单位） */
  owed: number;
  /** 账龄：自下单日起的天数 */
  days: number;
  /** 已逾期：dueDays>0 且 days>dueDays */
  overdue: boolean;
  /** 距到期天数（dueDays>0 时 = dueDays−days，负=逾期 N 天）；dueDays=0（即时/货到付款）不追踪→null */
  daysToDue: number | null;
}

/**
 * 按「客户 × 币种」把收款 FIFO 摊到各已完成订单，得到每单收款状态 + 未收清订单的账龄/逾期。
 * 应收账龄报表与到期提醒共用——FIFO 与账期编排集中在此，UI 不重复实现。
 */
export function customerOrderStatus(
  orders: StoredOrder[],
  customers: StoredCustomer[],
  settlements: StoredSettlement[],
  today: string,
): { payStatus: Map<string, OrderPayState>; outstanding: OutstandingOrder[] } {
  const payStatus = new Map<string, OrderPayState>();
  const outstanding: OutstandingOrder[] = [];
  const orderById = new Map(orders.map((o) => [o.id, o] as const));

  // 已完成订单按「客户|币种」分组（不同币种应收不混算）
  const byKey = new Map<string, StoredOrder[]>();
  for (const o of orders) {
    if (o.status !== 'completed') continue;
    const k = `${o.customerId}|${o.currency}`;
    const arr = byKey.get(k) ?? [];
    arr.push(o);
    byKey.set(k, arr);
  }
  // 收款明细按「客户|币种」（币种取自所属订单；UI 始终带 orderId，null 兜底 CNY）
  const paysByKey = new Map<string, CustomerPayment[]>();
  for (const s of settlements) {
    if (s.direction !== 'in' || s.counterpartyType !== 'customer') continue;
    const cur = (s.orderId ? orderById.get(s.orderId)?.currency : undefined) ?? 'CNY';
    const k = `${s.counterpartyId}|${cur}`;
    const arr = paysByKey.get(k) ?? [];
    arr.push({ orderId: s.orderId, amount: s.amount });
    paysByKey.set(k, arr);
  }

  for (const [key, custOrders] of byKey) {
    const cid = key.slice(0, key.lastIndexOf('|')); // 客户 id（UUID 不含 '|'）
    const cust = customers.find((c) => c.id === cid);
    if (!cust) continue;
    const ledger = allocateCustomerPayments(
      custOrders.map((o) => ({ id: o.id, total: orderTotal(o.lines), date: o.date })),
      paysByKey.get(key) ?? [],
    );
    for (const a of ledger.allocations) {
      payStatus.set(a.orderId, { status: a.status, collected: a.collected, total: a.total });
      if (a.status !== 'paid') {
        const ord = custOrders.find((o) => o.id === a.orderId)!;
        const days = daysBetween(ord.date, today);
        outstanding.push({
          order: ord,
          owed: a.total - a.collected,
          days,
          overdue: cust.dueDays > 0 && days > cust.dueDays,
          daysToDue: cust.dueDays > 0 ? cust.dueDays - days : null,
        });
      }
    }
  }
  outstanding.sort((x, y) => y.days - x.days);
  return { payStatus, outstanding };
}

/** 找/建顶层「应收账款」资产父科目，返回 id。 */
async function ensureReceivableParent(repo: Repository, book: StoredBook, accounts: StoredAccount[]): Promise<string> {
  const parent = accounts.find((a) => a.type === 'asset' && a.name === AR_PARENT && a.parentId === null);
  if (parent) return parent.id;
  const created = await repo.addAccount({
    id: genId(),
    bookId: book.id,
    name: AR_PARENT,
    type: 'asset',
    parentId: null,
    currency: 'CNY', // 容器节点（无分录），各币种应收落各子科目
    archived: false,
  });
  return created.id;
}

/** 找/建某客户某币种的应收子科目，返回其账户 id（已归档则恢复）。币种决定子科目名与币种属性。 */
async function ensureReceivableAccount(
  repo: Repository,
  book: StoredBook,
  customer: Customer,
  currency: string,
): Promise<string> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const existing = accounts.find((a) => a.type === 'asset' && a.name === arName(customer.name, currency));
  if (existing) {
    if (existing.archived) await repo.updateAccount(existing.id, { archived: false });
    return existing.id;
  }
  const parentId = await ensureReceivableParent(repo, book, accounts);
  const created = await repo.addAccount({
    id: genId(),
    bookId: book.id,
    name: arName(customer.name, currency),
    type: 'asset',
    parentId,
    currency,
    archived: false,
  });
  return created.id;
}

/** 客户改名时同步其全部应收子科目名（各币种），避免下次成单另建子科目、欠款余额分裂。 */
export async function renameCustomer(repo: Repository, book: StoredBook, oldName: string, newName: string): Promise<void> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const oldBase = `${AR_PARENT}/${oldName}`;
  const newBase = `${AR_PARENT}/${newName}`;
  for (const ar of customerArAccounts(accounts, oldName)) {
    // 保留币种后缀 ` (USD)` 等：仅替换 `应收账款/<旧名>` 这段前缀
    await repo.updateAccount(ar.id, { name: newBase + ar.name.slice(oldBase.length) });
  }
}

/** 某商品某单的库存缺口（开单/完成时按当时库存校验）。 */
export interface ProductShortfall {
  productId: string;
  name: string;
  /** 本单需求数量 */
  demand: number;
  /** 当前在手 */
  onHand: number;
  /** 缺口 = max(0, demand − onHand) */
  missing: number;
  /** 商品进价（草稿采购单预填用） */
  costPrice: number;
}

/**
 * 算某组订单行的库存缺口（统一库存模型）：非 quoteOnly、带 productId 的行按商品聚合需求，
 * 与当前在手比，缺口 = max(0, 需求 − 在手)。无缺口商品不返回。开单生成草稿采购单 / 完成前校验共用。
 */
export function orderShortfalls(
  lines: ReadonlyArray<{ productId: string | null; qty: number }>,
  products: StoredProduct[],
  movements: StoredInventoryMovement[],
): ProductShortfall[] {
  const prodById = new Map(products.map((p) => [p.id, p]));
  const demandBy = new Map<string, number>();
  for (const l of lines) {
    const prod = l.productId ? prodById.get(l.productId) : undefined;
    if (prod && !prod.quoteOnly) demandBy.set(prod.id, (demandBy.get(prod.id) ?? 0) + l.qty);
  }
  const out: ProductShortfall[] = [];
  for (const [pid, demand] of demandBy) {
    const prod = prodById.get(pid)!;
    const st = inventoryState(movements.filter((m) => m.productId === pid));
    const missing = Math.max(0, demand - st.qty);
    if (missing > 0) out.push({ productId: pid, name: prod.name, demand, onHand: st.qty, missing, costPrice: prod.costPrice });
  }
  return out;
}

/**
 * 开单（统一库存模型）：建订单；非 quoteOnly 商品行按当前库存算缺口——
 * 任一缺口>0 → 订单「待采购」并生成草稿采购单（行=各缺口商品×缺口数量，单价预填进价）；
 * 全部在手充足（或仅 quoteOnly/自由文本行）→ 直接「待发货」。草稿单 supplierId=''、txnId=null，确认时补全。
 */
export async function saveOrder(
  repo: Repository,
  book: StoredBook,
  opts: {
    customerId: string;
    date: string;
    currency: string;
    note: string;
    lines: Array<{ productId: string | null; name: string; qty: number; unitPrice: number }>;
  },
): Promise<void> {
  const orderId = genId();
  const lines: OrderLine[] = opts.lines.map((l) => ({ id: genId(), orderId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, productId: l.productId }));
  const products = await repo.listProducts({ bookId: book.id });
  const movements = await repo.listInventoryMovements({ bookId: book.id });
  const shortfalls = orderShortfalls(lines, products, movements);
  const status: OrderStatus = shortfalls.length > 0 ? 'pending_purchase' : 'pending_ship';
  await repo.addOrder({ id: orderId, bookId: book.id, customerId: opts.customerId, date: opts.date, currency: opts.currency, status, note: opts.note, revenueTxnId: null, lines });
  // 每个缺货商品各生成一张草稿采购单——不同商品可来自不同供应商，各自独立确认。
  for (const s of shortfalls) {
    const purchaseId = genId();
    await repo.addPurchase({
      id: purchaseId, bookId: book.id, supplierId: '', kind: 'dropship', orderId, destAccountId: null, date: opts.date, payMode: 'credit', note: '', txnId: null,
      lines: [{ id: genId(), purchaseId, productId: s.productId, name: s.name, qty: s.missing, unitCost: s.costPrice }],
    });
  }
}

/**
 * 完成订单：① 确认收入（赊销）借应收/客户(订单币种)、贷营业收入；
 * ② 各商品需求拆「已采购覆盖」(代采在途结转 COGS) + 「从库存出库」(移动加权均价结转 COGS) 两部分；
 * 库存出库部分按 `planInventoryIssue` 拆行——采购+库存仍不够则整单不落（校验在任何写入之前）。
 */
export async function completeOrder(repo: Repository, book: StoredBook, order: Order, customer: Customer): Promise<void> {
  const total = orderTotal(order.lines);
  if (total <= 0) throw new Error('订单金额为 0，无法完成');
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const revenue = accounts.find((a) => a.type === 'income' && a.name === REVENUE);
  if (!revenue) throw new Error('未找到「营业收入」科目，请先在账户页添加');

  // 商品需求（非 quoteOnly、带 productId 的行按商品聚合）
  const products = await repo.listProducts({ bookId: book.id, includeArchived: true });
  const prodById = new Map(products.map((p) => [p.id, p]));
  const demandBy = new Map<string, number>();
  for (const line of order.lines) {
    const prod = line.productId ? prodById.get(line.productId) : undefined;
    if (prod && !prod.quoteOnly) demandBy.set(prod.id, (demandBy.get(prod.id) ?? 0) + line.qty);
  }

  // 已确认采购（txnId 非空）覆盖的数量（按商品）+ 该单代采成本（完成时从代采在途结转 COGS）
  const confirmed = (await repo.listPurchases({ bookId: book.id, orderId: order.id })).filter((p) => p.txnId != null);
  const purchasedBy = new Map<string, number>();
  let dropshipCost = 0;
  for (const p of confirmed) {
    dropshipCost += purchaseTotal(p.lines);
    for (const l of p.lines) if (l.productId) purchasedBy.set(l.productId, (purchasedBy.get(l.productId) ?? 0) + l.qty);
  }

  // 拆分：库存出库 vs 采购覆盖（core 纯函数）。采购+库存仍不够则整单不落。
  const movements = await repo.listInventoryMovements({ bookId: book.id });
  const planLines: IssuePlanLine[] = [...demandBy].map(([pid, demand]) => {
    const st = inventoryState(movements.filter((m) => m.productId === pid));
    return { productId: pid, demand, onHand: st.qty, avgCost: st.avgCost, purchased: purchasedBy.get(pid) ?? 0 };
  });
  const plan = planInventoryIssue(planLines);
  if (plan.shortfalls.length > 0) {
    const names = plan.shortfalls.map((s) => `${prodById.get(s.productId)?.name ?? s.productId} 缺 ${s.missing}`).join('；');
    throw new Error(`库存不足，且未为此单采购覆盖：${names}。请先「为此单采购」或到库存页补货`);
  }

  // ① 确认收入
  const arId = await ensureReceivableAccount(repo, book, customer, order.currency);
  const entry = orderRevenueEntry(
    { bookId: book.id, date: order.date, amount: total, currency: order.currency, receivableAccountId: arId, revenueAccountId: revenue.id, payee: customer.name, note: order.note },
    genId,
  );
  await repo.addTransaction(entry);

  // ② 库存出库 COGS：借营业成本 / 贷库存商品（CNY 本位），并按拆行记 out 出库流水
  if (plan.inventoryCogs > 0) {
    const invId = await ensureInventoryAccount(repo, book);
    const cogsId = await ensureCogsAccount(repo, book);
    const cogsEntry = expandEntry(
      { kind: 'expense', bookId: book.id, date: order.date, amount: plan.inventoryCogs, currency: 'CNY', accountId: invId, categoryId: cogsId, payee: customer.name, note: '成本结转' },
      genId,
    );
    await repo.addTransaction(cogsEntry);
    for (const iss of plan.issues) {
      await repo.addInventoryMovement({
        id: genId(),
        bookId: book.id,
        productId: iss.productId,
        date: order.date,
        kind: 'out',
        qty: -iss.qty,
        unitCost: iss.avgCost,
        orderId: order.id,
        txnId: cogsEntry.id,
        note: '',
      });
    }
  }

  // ③ 代采成本结转：该单采购成本从「代采在途成本」结转营业成本（借营业成本 / 贷代采在途，CNY 本位）
  if (dropshipCost > 0) {
    const wipId = await ensureDropshipAccount(repo, book);
    const cogsId = await ensureCogsAccount(repo, book);
    const dsEntry = expandEntry(
      { kind: 'expense', bookId: book.id, date: order.date, amount: dropshipCost, currency: 'CNY', accountId: wipId, categoryId: cogsId, payee: customer.name, note: '代采成本结转' },
      genId,
    );
    await repo.addTransaction(dsEntry);
  }

  await repo.updateOrder(order.id, { status: 'completed', revenueTxnId: entry.id });
}

/** 记一笔收款：钱从应收/客户(订单币种)转入同币种收款资产账户，并落 Settlement 记录。 */
export async function recordCollection(
  repo: Repository,
  book: StoredBook,
  opts: {
    customer: Customer;
    orderId: string | null;
    currency: string;
    amount: number;
    date: string;
    assetAccountId: string;
    note: string;
  },
): Promise<void> {
  const arId = await ensureReceivableAccount(repo, book, opts.customer, opts.currency);
  const entry = collectionEntry(
    { bookId: book.id, date: opts.date, amount: opts.amount, currency: opts.currency, receivableAccountId: arId, assetAccountId: opts.assetAccountId, payee: opts.customer.name, note: opts.note },
    genId,
  );
  await repo.addTransaction(entry);
  await repo.addSettlement({
    id: genId(),
    bookId: book.id,
    direction: 'in',
    counterpartyType: 'customer',
    counterpartyId: opts.customer.id,
    orderId: opts.orderId,
    amount: opts.amount,
    date: opts.date,
    accountId: opts.assetAccountId,
    note: opts.note,
    txnId: entry.id,
  });
}

// —— C2 库存 ——
// 库存以人民币本位计：库存商品(资产)/营业成本(费用)均为 CNY 科目；按需自动建（同 AR 的 ensure 模式）。
const INVENTORY = '库存商品';
const COGS = '营业成本';
const DROPSHIP_WIP = '代采在途成本';
const OPENING_EQUITY = '期初余额';
const INVENTORY_LOSS_GAIN = '库存损溢';

/** 找/建某顶层科目（按名+类型，CNY 本位容器），返回 id；已归档则恢复。 */
async function ensureNamedAccount(repo: Repository, book: StoredBook, name: string, type: AccountType): Promise<string> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const found = accounts.find((a) => a.type === type && a.name === name && a.parentId === null);
  if (found) {
    if (found.archived) await repo.updateAccount(found.id, { archived: false });
    return found.id;
  }
  const created = await repo.addAccount({ id: genId(), bookId: book.id, name, type, parentId: null, currency: 'CNY', archived: false });
  return created.id;
}

/** 找/建「库存商品」资产科目（CNY）。 */
export function ensureInventoryAccount(repo: Repository, book: StoredBook): Promise<string> {
  return ensureNamedAccount(repo, book, INVENTORY, 'asset');
}

/** 找/建「营业成本」费用科目（CNY，出库结转 COGS 用）。 */
export function ensureCogsAccount(repo: Repository, book: StoredBook): Promise<string> {
  return ensureNamedAccount(repo, book, COGS, 'expense');
}

/** 找/建「代采在途成本」资产科目（CNY，代采采购计入、订单完成结转 COGS 的中转）。 */
export function ensureDropshipAccount(repo: Repository, book: StoredBook): Promise<string> {
  return ensureNamedAccount(repo, book, DROPSHIP_WIP, 'asset');
}

/** 找/建「期初余额」权益科目（CNY，期初库存的对方科目）。 */
export function ensureOpeningEquityAccount(repo: Repository, book: StoredBook): Promise<string> {
  return ensureNamedAccount(repo, book, OPENING_EQUITY, 'equity');
}

/** 找/建「库存损溢」收入科目（CNY，盘点调整的对方科目，双向：盘盈贷增/盘亏借减，同对账盘盈盘亏模式）。 */
export function ensureInventoryLossGainAccount(repo: Repository, book: StoredBook): Promise<string> {
  return ensureNamedAccount(repo, book, INVENTORY_LOSS_GAIN, 'income');
}

/**
 * 盘点 / 库存调整（C2 模型重构 Step 2）：把某商品在手数调到实际盘点数 `targetQty`，差额计「库存损溢」。
 * - 盘亏（target<在手）：按当前均价结转——借库存损溢 / 贷库存商品（asset 减）+ adjust 流水(qty<0, unitCost=均价)。
 * - 盘盈（target>在手）：按 `gainUnitCost ?? 当前均价` 入账——借库存商品 / 贷库存损溢 + adjust 流水(qty>0)。
 *   均价为 0（空库存）且未给单价 → 价值 0，只记数量流水、不记账。
 * 原因必填、记入流水与分录备注。不改 core：adjust 是合法 movement 类型，inventoryState 按 qty 正负回放。
 */
export async function recordStockAdjust(
  repo: Repository,
  book: StoredBook,
  opts: { productId: string; targetQty: number; reason: string; date: string; gainUnitCost?: number },
): Promise<void> {
  const reason = opts.reason.trim();
  if (!reason) throw new Error('请填写盘点 / 调整原因');
  if (!Number.isFinite(opts.targetQty) || opts.targetQty < 0) throw new Error('实际数量需为非负数');
  const movements = await repo.listInventoryMovements({ bookId: book.id, productId: opts.productId });
  const st = inventoryState(movements);
  const delta = opts.targetQty - st.qty;
  if (delta === 0) throw new Error('盘点数量与在手一致，无需调整');
  // 盘亏按当前均价结转；盘盈按给定单价或当前均价（空库存均价 0 时建议填单价，否则价值为 0）
  const unitCost = delta < 0 ? st.avgCost : (opts.gainUnitCost ?? st.avgCost);
  const value = Math.round(Math.abs(delta) * unitCost);
  let txnId: string | null = null;
  if (value > 0) {
    const invId = await ensureInventoryAccount(repo, book);
    const lgId = await ensureInventoryLossGainAccount(repo, book);
    const entry = expandEntry(
      {
        // 盘盈：借库存商品 / 贷库存损溢（income）；盘亏：借库存损溢 / 贷库存商品
        kind: delta > 0 ? 'income' : 'expense',
        bookId: book.id,
        date: opts.date,
        amount: value,
        currency: 'CNY',
        accountId: invId,
        categoryId: lgId,
        payee: '库存盘点',
        note: reason,
      },
      genId,
    );
    await repo.addTransaction(entry);
    txnId = entry.id;
  }
  await repo.addInventoryMovement({
    id: genId(),
    bookId: book.id,
    productId: opts.productId,
    date: opts.date,
    kind: 'adjust',
    qty: delta,
    unitCost,
    orderId: null,
    txnId,
    note: reason,
  });
}

/**
 * 期初库存（建商品时可选）：把已有库存按期初单价计入「库存商品」，对方科目「期初余额」（权益），
 * 并记一条 in 出入库流水。与进货的区别：不动现金/应付，是开账存量。单价为 0 时只记数量流水、不记账。
 */
export async function recordOpeningStock(
  repo: Repository,
  book: StoredBook,
  opts: { productId: string; qty: number; unitCost: number; date: string },
): Promise<void> {
  if (opts.qty <= 0) throw new Error('期初库存数量必须为正数');
  const amount = Math.round(opts.qty * opts.unitCost);
  let txnId: string | null = null;
  if (amount > 0) {
    const invId = await ensureInventoryAccount(repo, book);
    const openingId = await ensureOpeningEquityAccount(repo, book);
    // 借库存商品(+) / 贷期初余额(−)：transfer 从 期初余额 到 库存商品
    const entry = expandEntry(
      { kind: 'transfer', bookId: book.id, date: opts.date, amount, currency: 'CNY', fromAccountId: openingId, toAccountId: invId, payee: '期初库存', note: '期初库存' },
      genId,
    );
    await repo.addTransaction(entry);
    txnId = entry.id;
  }
  await repo.addInventoryMovement({
    id: genId(),
    bookId: book.id,
    productId: opts.productId,
    date: opts.date,
    kind: 'in',
    qty: opts.qty,
    unitCost: opts.unitCost,
    orderId: null,
    txnId,
    note: '期初库存',
  });
}

/**
 * 进货 / 补库存：钱从付款账户(CNY)转入「库存商品」(借库存/贷资产)，并记一条 in 出入库流水(带进价)。
 * 在手数量与均价由流水回放聚合，不存死值。库存为人民币本位，故付款账户须为 CNY。
 */
export async function recordStockIn(
  repo: Repository,
  book: StoredBook,
  opts: { productId: string; qty: number; unitCost: number; date: string; payAccountId: string; note: string },
): Promise<void> {
  if (opts.qty <= 0) throw new Error('进货数量必须为正数');
  const amount = Math.round(opts.qty * opts.unitCost); // CNY 最小单位
  if (amount <= 0) throw new Error('进货金额为 0');
  const invId = await ensureInventoryAccount(repo, book);
  const entry = expandEntry(
    { kind: 'transfer', bookId: book.id, date: opts.date, amount, currency: 'CNY', fromAccountId: opts.payAccountId, toAccountId: invId, payee: '进货', note: opts.note },
    genId,
  );
  await repo.addTransaction(entry);
  await repo.addInventoryMovement({
    id: genId(),
    bookId: book.id,
    productId: opts.productId,
    date: opts.date,
    kind: 'in',
    qty: opts.qty,
    unitCost: opts.unitCost,
    orderId: null,
    txnId: entry.id,
    note: opts.note,
  });
  await recordStockPurchase(repo, book, { productId: opts.productId, qty: opts.qty, unitCost: opts.unitCost, date: opts.date, payMode: 'cash', supplierId: '', txnId: entry.id, note: opts.note });
}

/** 记一条「补库存进货」的采购单（kind=stock，无订单），与进货分录/流水共用 txnId，供采购页统一查看。 */
async function recordStockPurchase(
  repo: Repository,
  book: StoredBook,
  opts: { productId: string; qty: number; unitCost: number; date: string; payMode: 'cash' | 'credit'; supplierId: string; txnId: string; note: string },
): Promise<void> {
  const product = await repo.getProduct(opts.productId);
  const purchaseId = genId();
  await repo.addPurchase({
    id: purchaseId,
    bookId: book.id,
    supplierId: opts.supplierId,
    kind: 'stock',
    orderId: null,
    destAccountId: null,
    date: opts.date,
    payMode: opts.payMode,
    note: opts.note,
    txnId: opts.txnId,
    lines: [{ id: genId(), purchaseId, productId: opts.productId, name: product?.name ?? '进货', qty: opts.qty, unitCost: opts.unitCost }],
  });
}

// —— C2 应付（供应商赊购 + 还款）——
// 镜像 AR：应付按「供应商 × 币种」建子科目，挂顶层「应付账款」(负债)下。C2c 仅 CNY（外币采购后置），
// 但保留币种参数与命名规则（CNY=`应付账款/<名>`，非 CNY 追加 ` (币种)`）便于后续扩展。
const AP_PARENT = '应付账款';

/** 应付子科目名：CNY 沿用 `应付账款/<名>`，非 CNY 追加 ` (币种)`。 */
const apName = (supplierName: string, currency: string): string =>
  currency === 'CNY' ? `${AP_PARENT}/${supplierName}` : `${AP_PARENT}/${supplierName} (${currency})`;

/** 某供应商的全部应付子科目（含各币种）。 */
function supplierApAccounts(accounts: StoredAccount[], supplierName: string): StoredAccount[] {
  const base = `${AP_PARENT}/${supplierName}`;
  return accounts.filter((a) => a.type === 'liability' && (a.name === base || a.name.startsWith(`${base} (`)));
}

/** 某供应商当前应付余额（折算到展示币种）：正=你欠供应商，负=你已预付。负债账户余额为负，故取负。 */
export function payableBalance(
  accounts: StoredAccount[],
  txns: StoredTransaction[],
  supplierName: string,
  convert: ConvertCtx,
): number {
  let sum = 0;
  for (const a of supplierApAccounts(accounts, supplierName)) {
    sum += -convertAmount(accountBalance(txns, a.id), a.currency, convert);
  }
  return sum;
}

/** 全账本应付汇总（折算到展示币种）：应付合计（你欠供应商）/ 预付合计（你已预付）。 */
export function payableSummary(
  accounts: StoredAccount[],
  txns: StoredTransaction[],
  convert: ConvertCtx,
): { payable: number; prepaid: number } {
  let payable = 0;
  let prepaid = 0;
  for (const a of accounts) {
    if (a.type !== 'liability' || !a.name.startsWith(`${AP_PARENT}/`)) continue;
    const owed = -convertAmount(accountBalance(txns, a.id), a.currency, convert); // 正=欠供应商
    if (owed > 0) payable += owed;
    else if (owed < 0) prepaid += -owed;
  }
  return { payable, prepaid };
}

/**
 * 某供应商应付账上的赊欠台账（CNY 本位）：从应付子科目分录聚合——赊购=贷应付（负）记一笔 charge，
 * 还款=借应付（正）累加 paid。供应付账龄/到期用 `outstandingCharges` FIFO 摊还。
 */
export function payableLedger(
  accounts: StoredAccount[],
  txns: StoredTransaction[],
  supplierName: string,
): { charges: Array<{ amount: number; date: string }>; paid: number } {
  const ids = new Set(supplierApAccounts(accounts, supplierName).map((a) => a.id));
  const charges: Array<{ amount: number; date: string }> = [];
  let paid = 0;
  for (const t of txns) {
    for (const p of t.postings) {
      if (!ids.has(p.accountId)) continue;
      if (p.amount < 0) charges.push({ amount: -p.amount, date: t.date }); // 赊购：欠款增
      else if (p.amount > 0) paid += p.amount; // 还款：欠款减
    }
  }
  return { charges, paid };
}

/** 找/建顶层「应付账款」负债父科目，返回 id。 */
async function ensurePayableParent(repo: Repository, book: StoredBook, accounts: StoredAccount[]): Promise<string> {
  const parent = accounts.find((a) => a.type === 'liability' && a.name === AP_PARENT && a.parentId === null);
  if (parent) return parent.id;
  const created = await repo.addAccount({
    id: genId(),
    bookId: book.id,
    name: AP_PARENT,
    type: 'liability',
    parentId: null,
    currency: 'CNY', // 容器节点（无分录），各币种应付落各子科目
    archived: false,
  });
  return created.id;
}

/** 找/建某供应商某币种的应付子科目，返回账户 id（已归档则恢复）。 */
async function ensurePayableAccount(repo: Repository, book: StoredBook, supplier: Supplier, currency: string): Promise<string> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const existing = accounts.find((a) => a.type === 'liability' && a.name === apName(supplier.name, currency));
  if (existing) {
    if (existing.archived) await repo.updateAccount(existing.id, { archived: false });
    return existing.id;
  }
  const parentId = await ensurePayableParent(repo, book, accounts);
  const created = await repo.addAccount({
    id: genId(),
    bookId: book.id,
    name: apName(supplier.name, currency),
    type: 'liability',
    parentId,
    currency,
    archived: false,
  });
  return created.id;
}

/** 供应商改名时同步其全部应付子科目名（各币种），避免下次成单另建子科目、欠款余额分裂。 */
export async function renameSupplier(repo: Repository, book: StoredBook, oldName: string, newName: string): Promise<void> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const oldBase = `${AP_PARENT}/${oldName}`;
  const newBase = `${AP_PARENT}/${newName}`;
  for (const ap of supplierApAccounts(accounts, oldName)) {
    await repo.updateAccount(ap.id, { name: newBase + ap.name.slice(oldBase.length) });
  }
}

/**
 * 赊购入库：借 库存商品 / 贷 应付账款/供应商（CNY 本位），并记一条 in 出入库流水（带进价）。
 * 与 recordStockIn 的区别仅在贷方——这里贷应付（欠供应商），而非贷付款资产账户。
 */
export async function recordCreditStockIn(
  repo: Repository,
  book: StoredBook,
  opts: { productId: string; qty: number; unitCost: number; date: string; supplier: Supplier; note: string },
): Promise<void> {
  if (opts.qty <= 0) throw new Error('进货数量必须为正数');
  const amount = Math.round(opts.qty * opts.unitCost);
  if (amount <= 0) throw new Error('进货金额为 0');
  const invId = await ensureInventoryAccount(repo, book);
  const apId = await ensurePayableAccount(repo, book, opts.supplier, 'CNY');
  const entry = creditPurchaseEntry(
    { bookId: book.id, date: opts.date, amount, currency: 'CNY', payableAccountId: apId, inventoryAccountId: invId, payee: opts.supplier.name, note: opts.note },
    genId,
  );
  await repo.addTransaction(entry);
  await repo.addInventoryMovement({
    id: genId(),
    bookId: book.id,
    productId: opts.productId,
    date: opts.date,
    kind: 'in',
    qty: opts.qty,
    unitCost: opts.unitCost,
    orderId: null,
    txnId: entry.id,
    note: opts.note,
  });
  await recordStockPurchase(repo, book, { productId: opts.productId, qty: opts.qty, unitCost: opts.unitCost, date: opts.date, payMode: 'credit', supplierId: opts.supplier.id, txnId: entry.id, note: opts.note });
}

/** 付供应商货款：钱从付款资产账户(CNY)转入 应付账款/供应商（冲减欠款），并落 Settlement(out/supplier) 记录。 */
export async function recordSupplierPayment(
  repo: Repository,
  book: StoredBook,
  opts: { supplier: Supplier; amount: number; date: string; assetAccountId: string; note: string },
): Promise<void> {
  const apId = await ensurePayableAccount(repo, book, opts.supplier, 'CNY');
  const entry = supplierPaymentEntry(
    { bookId: book.id, date: opts.date, amount: opts.amount, currency: 'CNY', payableAccountId: apId, assetAccountId: opts.assetAccountId, payee: opts.supplier.name, note: opts.note },
    genId,
  );
  await repo.addTransaction(entry);
  await repo.addSettlement({
    id: genId(),
    bookId: book.id,
    direction: 'out',
    counterpartyType: 'supplier',
    counterpartyId: opts.supplier.id,
    orderId: null,
    amount: opts.amount,
    date: opts.date,
    accountId: opts.assetAccountId,
    note: opts.note,
    txnId: entry.id,
  });
}

// —— 为某订单采购（即采即出，成本直挂订单不过库存均价池）——

/**
 * 确认/补全订单的草稿采购单：补供应商 + 各行采购价 → 记账（借代采在途成本 / 贷 付款账户[现结]
 * 或 应付账款/供应商[赊账]）→ 写回采购单（supplierId/payMode/txnId/lines）。成本计入「代采在途成本」holding，
 * 订单完成时由 completeOrder 结转 COGS。CNY 本位。确认后把订单从「待采购」转「待发货」。
 * @param costs 各采购行的采购价（最小单位/分），按行 id 映射；缺省沿用草稿预填进价。
 */
export async function confirmOrderPurchase(
  repo: Repository,
  book: StoredBook,
  opts: {
    purchase: StoredPurchase;
    supplier: Supplier;
    date: string;
    payMode: 'cash' | 'credit';
    payAccountId?: string;
    costs: Record<string, number>;
    note: string;
  },
): Promise<void> {
  const lines: PurchaseLine[] = opts.purchase.lines.map((l) => ({ ...l, unitCost: opts.costs[l.id] ?? l.unitCost }));
  const total = purchaseTotal(lines);
  if (total <= 0) throw new Error('采购金额为 0');
  const wipId = await ensureDropshipAccount(repo, book);
  let txn;
  if (opts.payMode === 'credit') {
    const apId = await ensurePayableAccount(repo, book, opts.supplier, 'CNY');
    txn = creditPurchaseEntry(
      { bookId: book.id, date: opts.date, amount: total, currency: 'CNY', payableAccountId: apId, inventoryAccountId: wipId, payee: opts.supplier.name, note: opts.note },
      genId,
    );
  } else {
    if (!opts.payAccountId) throw new Error('现结采购需选付款账户');
    txn = expandEntry(
      { kind: 'transfer', bookId: book.id, date: opts.date, amount: total, currency: 'CNY', fromAccountId: opts.payAccountId, toAccountId: wipId, payee: opts.supplier.name, note: opts.note },
      genId,
    );
  }
  await repo.addTransaction(txn);
  await repo.updatePurchase(opts.purchase.id, { supplierId: opts.supplier.id, date: opts.date, payMode: opts.payMode, note: opts.note, txnId: txn.id, lines });
  if (opts.purchase.orderId) await advanceIfNoDrafts(repo, book, opts.purchase.orderId);
}

/** 订单的草稿采购单全部确认/作废后，从「待采购」转「待发货」（一单可有多张草稿，逐张处理）。 */
async function advanceIfNoDrafts(repo: Repository, book: StoredBook, orderId: string): Promise<void> {
  const order = await repo.getOrder(orderId);
  if (!order || order.status !== 'pending_purchase') return;
  const remaining = (await repo.listPurchases({ bookId: book.id, orderId })).filter((p) => !p.txnId);
  if (remaining.length === 0) await repo.updateOrder(orderId, { status: 'pending_ship' });
}

/**
 * 作废草稿采购单（库存已够、无需采购时）：软删采购单（草稿无记账，安全）+ 订单转「待发货」。
 * 仅对草稿（txnId=null）调用；已确认采购需手动反向，不走此路径。
 */
export async function voidDraftPurchase(repo: Repository, book: StoredBook, purchase: StoredPurchase): Promise<void> {
  await repo.removePurchase(purchase.id);
  if (purchase.orderId) await advanceIfNoDrafts(repo, book, purchase.orderId);
}

/**
 * 费用采购（C2 模型重构 Step 3）：买入直接计入费用的东西（运费 / 办公用品等），不进库存、不挂订单。
 * 借目标费用科目 / 贷（现结=付款资产账户；赊账=应付账款/供应商）。产出 kind='expense' 采购单，采购页可见。
 */
export async function recordExpensePurchase(
  repo: Repository,
  book: StoredBook,
  opts: {
    destAccountId: string;
    amount: number;
    description: string;
    date: string;
    payMode: 'cash' | 'credit';
    payAccountId?: string;
    supplier?: Supplier;
    note: string;
  },
): Promise<void> {
  if (opts.amount <= 0) throw new Error('采购金额需大于 0');
  let supplierId = '';
  let txn;
  if (opts.payMode === 'credit') {
    if (!opts.supplier) throw new Error('赊账采购需选供应商');
    supplierId = opts.supplier.id;
    const apId = await ensurePayableAccount(repo, book, opts.supplier, 'CNY');
    txn = expandEntry(
      { kind: 'expense', bookId: book.id, date: opts.date, amount: opts.amount, currency: 'CNY', accountId: apId, categoryId: opts.destAccountId, payee: opts.supplier.name, note: opts.description },
      genId,
    );
  } else {
    if (!opts.payAccountId) throw new Error('现结采购需选付款账户');
    txn = expandEntry(
      { kind: 'expense', bookId: book.id, date: opts.date, amount: opts.amount, currency: 'CNY', accountId: opts.payAccountId, categoryId: opts.destAccountId, payee: '采购', note: opts.description },
      genId,
    );
  }
  await repo.addTransaction(txn);
  const purchaseId = genId();
  await repo.addPurchase({
    id: purchaseId,
    bookId: book.id,
    supplierId,
    kind: 'expense',
    orderId: null,
    destAccountId: opts.destAccountId,
    date: opts.date,
    payMode: opts.payMode,
    note: opts.note,
    txnId: txn.id,
    lines: [{ id: genId(), purchaseId, productId: null, name: opts.description, qty: 1, unitCost: opts.amount }],
  });
}
