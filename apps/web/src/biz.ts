import { accountBalance, collectionEntry, convertAmount, expandEntry, orderRevenueEntry, orderTotal } from '@app/core';
import type { AccountType, ConvertCtx, Customer, Order } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredTransaction } from '@app/store';
import { genId } from './db';

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

/** 完成订单 → 确认收入（赊销）：借应收/客户(订单币种)、贷营业收入；回写订单状态与收入分录 id。 */
export async function completeOrder(repo: Repository, book: StoredBook, order: Order, customer: Customer): Promise<void> {
  const total = orderTotal(order.lines);
  if (total <= 0) throw new Error('订单金额为 0，无法完成');
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const revenue = accounts.find((a) => a.type === 'income' && a.name === REVENUE);
  if (!revenue) throw new Error('未找到「营业收入」科目，请先在账户页添加');
  const arId = await ensureReceivableAccount(repo, book, customer, order.currency);
  const entry = orderRevenueEntry(
    { bookId: book.id, date: order.date, amount: total, currency: order.currency, receivableAccountId: arId, revenueAccountId: revenue.id, payee: customer.name, note: order.note },
    genId,
  );
  await repo.addTransaction(entry);
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
}
