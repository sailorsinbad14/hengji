import { accountBalance, collectionEntry, orderRevenueEntry, orderTotal } from '@app/core';
import type { Customer, Order } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredTransaction } from '@app/store';
import { genId } from './db';

/**
 * 生意视图的编排层（UI 与 store 之间）：把业务动作翻译成「建应收子科目 → core 生成平衡分录 →
 * 落库」。core 保持纯、store 保持通用，业务语义（应收按客户建子科目）只活在这一层。
 */

const AR_PARENT = '应收账款';
const REVENUE = '营业收入';

const arName = (customerName: string): string => `${AR_PARENT}/${customerName}`;

/** 某客户当前应收余额（欠款）= 其应收子科目余额；无子科目则为 0。 */
export function receivableBalance(accounts: StoredAccount[], txns: StoredTransaction[], customerName: string): number {
  const ar = accounts.find((a) => a.name === arName(customerName));
  return ar ? accountBalance(txns, ar.id) : 0;
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
    currency: accounts[0]?.currency ?? 'CNY',
    archived: false,
  });
  return created.id;
}

/** 找/建某客户的应收子科目「应收账款/客户名」，返回其账户 id（已归档则恢复）。 */
async function ensureReceivableAccount(repo: Repository, book: StoredBook, customer: Customer): Promise<string> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const existing = accounts.find((a) => a.type === 'asset' && a.name === arName(customer.name));
  if (existing) {
    if (existing.archived) await repo.updateAccount(existing.id, { archived: false });
    return existing.id;
  }
  const parentId = await ensureReceivableParent(repo, book, accounts);
  const created = await repo.addAccount({
    id: genId(),
    bookId: book.id,
    name: arName(customer.name),
    type: 'asset',
    parentId,
    currency: accounts[0]?.currency ?? 'CNY',
    archived: false,
  });
  return created.id;
}

/** 客户改名时同步其应收子科目名，避免下次成单另建子科目、欠款余额分裂。 */
export async function renameCustomer(repo: Repository, book: StoredBook, oldName: string, newName: string): Promise<void> {
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const ar = accounts.find((a) => a.type === 'asset' && a.name === arName(oldName));
  if (ar) await repo.updateAccount(ar.id, { name: arName(newName) });
}

/** 完成订单 → 确认收入（赊销）：借应收/客户、贷营业收入；回写订单状态与收入分录 id。 */
export async function completeOrder(repo: Repository, book: StoredBook, order: Order, customer: Customer): Promise<void> {
  const total = orderTotal(order.lines);
  if (total <= 0) throw new Error('订单金额为 0，无法完成');
  const accounts = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  const revenue = accounts.find((a) => a.type === 'income' && a.name === REVENUE);
  if (!revenue) throw new Error('未找到「营业收入」科目，请先在账户页添加');
  const arId = await ensureReceivableAccount(repo, book, customer);
  const entry = orderRevenueEntry(
    { bookId: book.id, date: order.date, amount: total, receivableAccountId: arId, revenueAccountId: revenue.id, payee: customer.name, note: order.note },
    genId,
  );
  await repo.addTransaction(entry);
  await repo.updateOrder(order.id, { status: 'completed', revenueTxnId: entry.id });
}

/** 记一笔收款：钱从应收/客户转入收款资产账户，并落 Settlement 记录。 */
export async function recordCollection(
  repo: Repository,
  book: StoredBook,
  opts: {
    customer: Customer;
    orderId: string | null;
    amount: number;
    date: string;
    assetAccountId: string;
    note: string;
  },
): Promise<void> {
  const arId = await ensureReceivableAccount(repo, book, opts.customer);
  const entry = collectionEntry(
    { bookId: book.id, date: opts.date, amount: opts.amount, receivableAccountId: arId, assetAccountId: opts.assetAccountId, payee: opts.customer.name, note: opts.note },
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
