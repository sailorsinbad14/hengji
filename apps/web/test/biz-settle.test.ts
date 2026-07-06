import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '@app/store';
import type { Repository, StoredBook } from '@app/store';
import { accountBalance } from '@app/core';
import type { Customer, Supplier } from '@app/core';
import { createBookWithChart, genId } from '../src/db';
import { saveOrder, completeOrder, recordCollection, recordCreditStockIn, settleStagingRow, suggestImportSettlements } from '../src/biz';

/**
 * 出口① 核销（账单导入 增量3）端到端：用 InMemoryRepository 建真实生意场景，验证
 * settleStagingRow（AR 按单 / AP 供应商级 FIFO·方案 B，确定性 id 崩溃自愈）与
 * suggestImportSettlements（先匹配后造护栏 / 仅 CNY / 精确等额预选）。
 */

const DATE = '2026-06-29';
const PAY = '对公账户';

async function bizBook(repo: Repository): Promise<{ book: StoredBook; pay: string }> {
  const { book } = await createBookWithChart(repo, '小生意', 'business');
  const stored = (await repo.getBook(book.id))!;
  const accs = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  return { book: stored, pay: accs.find((a) => a.name === PAY)!.id };
}

function mkCustomer(bookId: string, name: string): Customer {
  return { id: genId(), bookId, name, phone: '', note: '', dueDays: 0, archived: false };
}
function mkSupplier(bookId: string, name: string): Supplier {
  return { id: genId(), bookId, name, phone: '', note: '', dueDays: 0, archived: false };
}

async function arBalance(repo: Repository, bookId: string, custName: string): Promise<number> {
  const accs = await repo.listAccounts({ bookId, includeArchived: true });
  const ar = accs.find((a) => a.name === `应收账款/${custName}`);
  const txns = await repo.listTransactions({ bookId });
  return ar ? accountBalance(txns, ar.id) : 0;
}
async function apBalance(repo: Repository, bookId: string, supName: string): Promise<number> {
  const accs = await repo.listAccounts({ bookId, includeArchived: true });
  const ap = accs.find((a) => a.name === `应付账款/${supName}`);
  const txns = await repo.listTransactions({ bookId });
  return ap ? -accountBalance(txns, ap.id) + 0 : 0; // 负债余额为负，取负＝欠额（+0 归一 -0）
}

/** 建一张已完成服务订单（确认收入 → 应收=total），返回订单 id。 */
async function completedServiceOrder(repo: Repository, book: StoredBook, cust: Customer, total: number, currency = 'CNY', date = '2026-06-10'): Promise<string> {
  await saveOrder(repo, book, { customerId: cust.id, date, currency, note: '', lines: [{ productId: null, name: '服务费', qty: 1, unitPrice: total }] });
  const order = (await repo.listOrders({ bookId: book.id, customerId: cust.id })).sort((a, b) => (a.date < b.date ? 1 : -1))[0]!;
  await completeOrder(repo, book, (await repo.getOrder(order.id))!, cust);
  return order.id;
}

/** 赊购入库建应付：返回应付额（qty*unitCost）。 */
async function creditPurchase(repo: Repository, book: StoredBook, supplier: Supplier, name: string, qty: number, unitCost: number, date = '2026-06-01'): Promise<void> {
  const prod = { id: genId(), bookId: book.id, name, costPrice: unitCost, salePrice: unitCost * 2, quoteOnly: false, unit: '', archived: false };
  await repo.addProduct(prod);
  await recordCreditStockIn(repo, book, { productId: prod.id, qty, unitCost, date, supplier, note: '' });
}

/** 注入式确定性 id 生成器：首调返 txnId，其余随机。 */
function genFor(txnId: string): () => string {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return txnId;
    }
    return genId();
  };
}

describe('settleStagingRow（增量3 出口①核销落库）', () => {
  it('AR 收款核销：应收回退、Settlement 落于该单、不建订单/不碰库存、id 确定性', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    expect(await arBalance(repo, book.id, '张三')).toBe(100000);
    const ordersBefore = (await repo.listOrders({ bookId: book.id })).length;
    const movesBefore = (await repo.listInventoryMovements({ bookId: book.id })).length;

    await settleStagingRow(repo, book, {
      direction: 'in',
      target: { counterpartyType: 'customer', entityId: cust.id, orderId, assetAccountId: pay },
      amount: 100000,
      date: '2026-06-11',
      note: '收款',
      idGen: genFor('imp_rowA'),
      settlementId: 'set_rowA',
    });

    expect(await arBalance(repo, book.id, '张三')).toBe(0); // 应收清零
    const s = (await repo.getSettlement('set_rowA'))!;
    expect(s.orderId).toBe(orderId);
    expect(s.txnId).toBe('imp_rowA'); // 交易 id 确定性派生
    expect(await repo.getTransaction('imp_rowA')).not.toBeNull();
    expect((await repo.listOrders({ bookId: book.id })).length).toBe(ordersBefore); // 没建新订单
    expect((await repo.listInventoryMovements({ bookId: book.id })).length).toBe(movesBefore); // 没碰库存
  });

  it('AP 付款核销：应付回退、Settlement orderId=null（供应商级 FIFO·方案 B）', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const sup = mkSupplier(book.id, '甲供应商');
    await repo.addSupplier(sup);
    await creditPurchase(repo, book, sup, 'A货', 10, 8000); // 应付 80000
    expect(await apBalance(repo, book.id, '甲供应商')).toBe(80000);

    await settleStagingRow(repo, book, {
      direction: 'out',
      target: { counterpartyType: 'supplier', entityId: sup.id, orderId: null, assetAccountId: pay },
      amount: 80000,
      date: '2026-06-12',
      note: '付款',
      idGen: genFor('imp_rowB'),
      settlementId: 'set_rowB',
    });

    expect(await apBalance(repo, book.id, '甲供应商')).toBe(0);
    const s = (await repo.getSettlement('set_rowB'))!;
    expect(s.orderId).toBeNull();
    expect(s.direction).toBe('out');
    expect(s.txnId).toBe('imp_rowB');
  });
});

describe('suggestImportSettlements（增量3 核销建议）', () => {
  it('AR 精确等额 → 预选该单、matchedExact', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '张三', amountMinor: 100000 }], pay, DATE);
    const s = sug.get('r1')!;
    expect(s.counterpartyType).toBe('customer');
    expect(s.entityId).toBe(cust.id);
    expect(s.orderId).toBe(orderId);
    expect(s.matchedExact).toBe(true);
    expect(s.assetAccountId).toBe(pay);
    expect(s.outstandingTotal).toBe(100000);
  });

  it('AR 有未结清但非等额 → 建议核销 orderId=null、matchedExact=false', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    await completedServiceOrder(repo, book, cust, 100000);

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '张三', amountMinor: 50000 }], pay, DATE);
    const s = sug.get('r1')!;
    expect(s.orderId).toBeNull(); // 无等额单 → 整体 FIFO
    expect(s.matchedExact).toBe(false);
    expect(s.outstandingTotal).toBe(100000);
  });

  it('AR 客户已结清 → 无建议（先匹配后造护栏）', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    await recordCollection(repo, book, { customer: cust, orderId, currency: 'CNY', amount: 100000, date: '2026-06-11', assetAccountId: pay, note: '' });

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '张三', amountMinor: 100000 }], pay, DATE);
    expect(sug.has('r1')).toBe(false);
  });

  it('对方名无同名实体 → 无建议', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    await completedServiceOrder(repo, book, cust, 100000);

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '王五', amountMinor: 100000 }], pay, DATE);
    expect(sug.has('r1')).toBe(false);
  });

  it('生活账本（无客户/供应商）→ 无建议', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo); // 不加任何客户/供应商
    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '张三', amountMinor: 100000 }], pay, DATE);
    expect(sug.has('r1')).toBe(false);
  });

  it('非 CNY 单 → 无建议（跨币种护栏）', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    await completedServiceOrder(repo, book, cust, 100000, 'USD');

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'in', payee: '张三', amountMinor: 100000 }], pay, DATE);
    expect(sug.has('r1')).toBe(false);
  });

  it('AP 供应商有应付 → 建议核销 orderId=null、matchedExact', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const sup = mkSupplier(book.id, '甲供应商');
    await repo.addSupplier(sup);
    await creditPurchase(repo, book, sup, 'A货', 10, 8000); // 应付 80000

    const sug = await suggestImportSettlements(repo, [book], [{ id: 'r1', direction: 'out', payee: '甲供应商', amountMinor: 80000 }], pay, DATE);
    const s = sug.get('r1')!;
    expect(s.counterpartyType).toBe('supplier');
    expect(s.entityId).toBe(sup.id);
    expect(s.orderId).toBeNull();
    expect(s.matchedExact).toBe(true);
    expect(s.outstandingTotal).toBe(80000);
  });
});
