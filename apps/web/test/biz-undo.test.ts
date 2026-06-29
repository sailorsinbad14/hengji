import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '@app/store';
import type { Repository, StoredBook } from '@app/store';
import { accountBalance, inventoryState } from '@app/core';
import type { Customer } from '@app/core';
import { createBookWithChart, genId } from '../src/db';
import {
  saveOrder,
  completeOrder,
  recordCollection,
  recordStockIn,
  removeSettlement,
  revertOrderCompletion,
  removeOrder,
} from '../src/biz';

/**
 * 撤销原语（账单导入 增量2）端到端：用 InMemoryRepository 建真实生意场景，验证
 * removeSettlement（软删 + 已对账红冲）/ revertOrderCompletion（含末端约束）/ removeOrder。
 * 底层 store 原语、core 纯函数已各自契约/单测覆盖；本测验「编排接线」正确。
 */

const DATE = '2026-06-29';

async function bizBook(repo: Repository): Promise<{ book: StoredBook; pay: string }> {
  const { book } = await createBookWithChart(repo, '小生意', 'business');
  const stored = (await repo.getBook(book.id))!;
  const accs = await repo.listAccounts({ bookId: book.id, includeArchived: true });
  return { book: stored, pay: accs.find((a) => a.name === '对公账户')!.id };
}

async function arBalance(repo: Repository, bookId: string, custName: string): Promise<number> {
  const accs = await repo.listAccounts({ bookId, includeArchived: true });
  const ar = accs.find((a) => a.name === `应收账款/${custName}`);
  const txns = await repo.listTransactions({ bookId });
  return ar ? accountBalance(txns, ar.id) : 0;
}

function mkCustomer(bookId: string, name: string): Customer {
  return { id: genId(), bookId, name, phone: '', note: '', dueDays: 0, archived: false };
}

/** 建一张「自由文本行、不涉库存」的已完成订单（确认收入 → 应收=total），返回订单 id。 */
async function completedServiceOrder(repo: Repository, book: StoredBook, cust: Customer, total: number): Promise<string> {
  await saveOrder(repo, book, {
    customerId: cust.id,
    date: '2026-06-10',
    currency: 'CNY',
    note: '',
    lines: [{ productId: null, name: '服务费', qty: 1, unitPrice: total }],
  });
  const order = (await repo.listOrders({ bookId: book.id, customerId: cust.id }))[0]!;
  await completeOrder(repo, book, (await repo.getOrder(order.id))!, cust);
  return order.id;
}

describe('removeSettlement（增量2）', () => {
  it('软删路径：撤收款 → 应收恢复、Settlement 消失、核销分录软删', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    expect(await arBalance(repo, book.id, '张三')).toBe(100000); // 确认收入后应收 ¥1000

    await recordCollection(repo, book, { customer: cust, orderId, currency: 'CNY', amount: 40000, date: '2026-06-11', assetAccountId: pay, note: '' });
    expect(await arBalance(repo, book.id, '张三')).toBe(60000); // 收 ¥400 → 应收 ¥600
    const s = (await repo.listSettlements({ orderId }))[0]!;

    await removeSettlement(repo, s.id, { date: DATE });
    expect(await repo.getSettlement(s.id)).toBeNull(); // Settlement 消失
    expect(await arBalance(repo, book.id, '张三')).toBe(100000); // 应收回到 ¥1000
    // 核销分录软删：触及收款账户的交易只剩 0 笔（收款被软删、确认收入不碰 pay）
    expect((await repo.listTransactions({ bookId: book.id, accountId: pay })).length).toBe(0);
  });

  it('红冲路径：撤已对账(cleared)收款 → 追加反向分录、原分录保留、应收恢复', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '李四');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    await recordCollection(repo, book, { customer: cust, orderId, currency: 'CNY', amount: 40000, date: '2026-06-11', assetAccountId: pay, note: '' });

    // 模拟对账：把收款交易在收款账户上的 posting 标 cleared
    const collTxn = (await repo.listTransactions({ bookId: book.id, accountId: pay }))[0]!;
    const collLeg = collTxn.postings.find((p) => p.accountId === pay)!;
    await repo.setPostingsCleared([collLeg.id], true);

    const s = (await repo.listSettlements({ orderId }))[0]!;
    const txnCountBefore = (await repo.listTransactions({ bookId: book.id })).length;
    await removeSettlement(repo, s.id, { date: DATE });

    expect(await repo.getTransaction(collTxn.id)).not.toBeNull(); // 原分录保留（红冲不软删）
    expect((await repo.listTransactions({ bookId: book.id })).length).toBe(txnCountBefore + 1); // 多一笔冲正
    expect(await repo.getSettlement(s.id)).toBeNull();
    expect(await arBalance(repo, book.id, '李四')).toBe(100000); // 净额：应收恢复
    // 冲正落撤销当期
    const rev = (await repo.listTransactions({ bookId: book.id })).find((t) => t.date === DATE)!;
    expect(rev.postings.find((p) => p.accountId === pay)!.amount).toBe(-40000); // 收款账户被冲回 −¥400
  });
});

describe('revertOrderCompletion（增量2）', () => {
  it('撤完成订单（末笔出库）→ 库存复原、订单退回待发货、分录全反向', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const prod = { id: genId(), bookId: book.id, name: 'A货', costPrice: 8000, salePrice: 12000, quoteOnly: false, unit: '', archived: false };
    await repo.addProduct(prod);
    await recordStockIn(repo, book, { productId: prod.id, qty: 10, unitCost: 8000, date: '2026-06-01', payAccountId: pay, note: '' });
    const cust = mkCustomer(book.id, '王五');
    await repo.addCustomer(cust);
    await saveOrder(repo, book, { customerId: cust.id, date: '2026-06-10', currency: 'CNY', note: '', lines: [{ productId: prod.id, name: 'A货', qty: 3, unitPrice: 12000 }] });
    const orderId = (await repo.listOrders({ bookId: book.id, customerId: cust.id }))[0]!.id;
    await completeOrder(repo, book, (await repo.getOrder(orderId))!, cust);

    const invAfterComplete = inventoryState(await repo.listInventoryMovements({ bookId: book.id, productId: prod.id }));
    expect(invAfterComplete.qty).toBe(7); // 10 − 3

    await revertOrderCompletion(repo, book, orderId, { date: DATE });

    const invAfterRevert = inventoryState(await repo.listInventoryMovements({ bookId: book.id, productId: prod.id }));
    expect(invAfterRevert.qty).toBe(10); // 出库流水软删 → 回到 10
    const order = (await repo.getOrder(orderId))!;
    expect(order.status).toBe('pending_ship');
    expect(order.revenueTxnId).toBeNull();
    expect((await repo.listTransactions({ bookId: book.id, orderId })).length).toBe(0); // 收入/COGS 全反向
  });

  it('末端约束：该单出库之后又有进出库 → 拒绝撤销，引导 adjust', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const prod = { id: genId(), bookId: book.id, name: 'B货', costPrice: 8000, salePrice: 12000, quoteOnly: false, unit: '', archived: false };
    await repo.addProduct(prod);
    await recordStockIn(repo, book, { productId: prod.id, qty: 10, unitCost: 8000, date: '2026-06-01', payAccountId: pay, note: '' });
    const cust = mkCustomer(book.id, '赵六');
    await repo.addCustomer(cust);
    await saveOrder(repo, book, { customerId: cust.id, date: '2026-06-10', currency: 'CNY', note: '', lines: [{ productId: prod.id, name: 'B货', qty: 3, unitPrice: 12000 }] });
    const orderId = (await repo.listOrders({ bookId: book.id, customerId: cust.id }))[0]!.id;
    await completeOrder(repo, book, (await repo.getOrder(orderId))!, cust);
    // 该单出库（06-10）之后再进货（06-15）= 出库不再是末尾
    await recordStockIn(repo, book, { productId: prod.id, qty: 5, unitCost: 9000, date: '2026-06-15', payAccountId: pay, note: '' });

    await expect(revertOrderCompletion(repo, book, orderId, { date: DATE })).rejects.toThrow(/无法安全撤销/);
    // 拒绝后状态不变（仍 completed、库存不动）
    expect((await repo.getOrder(orderId))!.status).toBe('completed');
  });

  it('护栏：有收款核销时拒绝撤销完成（先撤收款）', async () => {
    const repo = new InMemoryRepository();
    const { book, pay } = await bizBook(repo);
    const cust = mkCustomer(book.id, '钱七');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    await recordCollection(repo, book, { customer: cust, orderId, currency: 'CNY', amount: 40000, date: '2026-06-11', assetAccountId: pay, note: '' });
    await expect(revertOrderCompletion(repo, book, orderId, { date: DATE })).rejects.toThrow(/先撤销收款/);
  });
});

describe('removeOrder（增量2）', () => {
  it('删草稿订单（缺货→草稿采购单）→ 订单软删、草稿采购单一并退掉', async () => {
    const repo = new InMemoryRepository();
    const { book } = await bizBook(repo);
    const prod = { id: genId(), bookId: book.id, name: 'C货', costPrice: 5000, salePrice: 9000, quoteOnly: false, unit: '', archived: false };
    await repo.addProduct(prod); // 0 库存
    const cust = mkCustomer(book.id, '孙八');
    await repo.addCustomer(cust);
    await saveOrder(repo, book, { customerId: cust.id, date: '2026-06-10', currency: 'CNY', note: '', lines: [{ productId: prod.id, name: 'C货', qty: 5, unitPrice: 9000 }] });
    const order = (await repo.listOrders({ bookId: book.id, customerId: cust.id }))[0]!;
    expect(order.status).toBe('pending_purchase'); // 缺货 → 待采购 + 草稿采购单
    expect((await repo.listPurchases({ bookId: book.id, orderId: order.id })).length).toBe(1);

    await removeOrder(repo, book, order.id, { date: DATE });
    expect(await repo.getOrder(order.id)).toBeNull();
    expect((await repo.listPurchases({ bookId: book.id, orderId: order.id })).length).toBe(0); // 草稿采购单退掉
  });
});
