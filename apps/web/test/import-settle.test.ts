import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '@app/store';
import type { Repository, StoredBook, StoredStagingBatch, StoredStagingRow } from '@app/store';
import { accountBalance } from '@app/core';
import type { Customer } from '@app/core';
import { createBookWithChart, genId } from '../src/db';
import { saveOrder, completeOrder } from '../src/biz';
import { settleImportRow, revertImportBatch } from '../src/import';

/**
 * 出口① 核销落库/撤销（账单导入 增量3）：settleImportRow（确定性 id 崩溃自愈、源账户用全局账户·镜像生产）
 * + revertImportBatch 对核销行走 removeSettlement（应收恢复、Settlement 软删、无孤儿）。
 */

const DATE = '2026-06-29';

async function bizBook(repo: Repository): Promise<{ book: StoredBook; global: string }> {
  const { book } = await createBookWithChart(repo, '小生意', 'business');
  const stored = (await repo.getBook(book.id))!;
  // 镜像生产：导入源账户是全局资产账户（支付宝/微信/银行，全账本共用）
  const g = await repo.addAccount({ id: genId(), bookId: book.id, name: '支付宝', type: 'asset', parentId: null, currency: 'CNY', global: true, archived: false });
  return { book: stored, global: g.id };
}

function mkCustomer(bookId: string, name: string): Customer {
  return { id: genId(), bookId, name, phone: '', note: '', dueDays: 0, archived: false };
}

async function arBalance(repo: Repository, bookId: string, custName: string): Promise<number> {
  const accs = await repo.listAccounts({ bookId, includeArchived: true });
  const ar = accs.find((a) => a.name === `应收账款/${custName}`);
  const txns = await repo.listTransactions({ bookId });
  return ar ? accountBalance(txns, ar.id) : 0;
}

async function completedServiceOrder(repo: Repository, book: StoredBook, cust: Customer, total: number): Promise<string> {
  await saveOrder(repo, book, { customerId: cust.id, date: '2026-06-10', currency: 'CNY', note: '', lines: [{ productId: null, name: '服务费', qty: 1, unitPrice: total }] });
  const order = (await repo.listOrders({ bookId: book.id, customerId: cust.id }))[0]!;
  await completeOrder(repo, book, (await repo.getOrder(order.id))!, cust);
  return order.id;
}

/** 建一个 pending 收款草稿行，返回 {batch, row}。 */
async function pendingInRow(repo: Repository, source: string, accountId: string, payee: string, amountMinor: number): Promise<{ batch: StoredStagingBatch; row: StoredStagingRow }> {
  const batch = await repo.addStagingBatch({ id: genId(), source, accountId, label: 't', status: 'reviewing' });
  const id = genId();
  await repo.addStagingRows([
    { id, batchId: batch.id, bizNo: `B_${id}`, date: '2026-06-11', datetime: '2026-06-11 10:00:00', amountMinor, direction: 'in', payee, counterpartyAccount: '', note: '收款', accountingType: '', suggestion: 'income', assignedBookId: null, assignedAccountId: null, status: 'pending', txnId: null },
  ]);
  const row = (await repo.listStagingRows({ batchId: batch.id, status: 'pending' }))[0]!;
  return { batch, row };
}

describe('settleImportRow（增量3 核销落库 + 自愈）', () => {
  it('核销收款：应收清零、行 posted（imp_<id> / set_<id>）、不重复落（崩溃重放幂等）', async () => {
    const repo = new InMemoryRepository();
    const { book, global } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    const { batch, row } = await pendingInRow(repo, 'alipay-fund-flow', global, '张三', 100000);

    await settleImportRow(repo, batch, book, row, { counterpartyType: 'customer', entityId: cust.id, orderId, assetAccountId: global });

    expect(await arBalance(repo, book.id, '张三')).toBe(0);
    const posted = (await repo.listStagingRows({ batchId: batch.id, status: 'posted' }))[0]!;
    expect(posted.txnId).toBe(`imp_${row.id}`);
    expect(posted.assignedBookId).toBe(book.id);
    expect(posted.assignedAccountId).toBe(global);
    expect(await repo.getSettlement(`set_${row.id}`)).not.toBeNull();
    expect((await repo.listSettlements({ bookId: book.id })).length).toBe(1);

    // 崩溃重放：再调一次（用同一 pending 快照）→ 不重复建交易/Settlement
    await settleImportRow(repo, batch, book, row, { counterpartyType: 'customer', entityId: cust.id, orderId, assetAccountId: global });
    expect((await repo.listSettlements({ bookId: book.id })).length).toBe(1);
    expect(await arBalance(repo, book.id, '张三')).toBe(0); // 仍清零、未被二次核销成负
  });
});

describe('revertImportBatch（增量3 核销行整批撤销）', () => {
  it('撤含核销行的批：应收恢复、Settlement 软删、交易软删、行 skipped、批 reverted、无孤儿', async () => {
    const repo = new InMemoryRepository();
    const { book, global } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    const { batch, row } = await pendingInRow(repo, 'alipay-fund-flow', global, '张三', 100000);
    await settleImportRow(repo, batch, book, row, { counterpartyType: 'customer', entityId: cust.id, orderId, assetAccountId: global });
    expect(await arBalance(repo, book.id, '张三')).toBe(0);

    await revertImportBatch(repo, batch.id, DATE);

    expect(await arBalance(repo, book.id, '张三')).toBe(100000); // 应收恢复
    expect(await repo.getSettlement(`set_${row.id}`)).toBeNull(); // Settlement 软删（无孤儿）
    expect(await repo.getTransaction(`imp_${row.id}`)).toBeNull(); // 核销分录软删
    const skipped = await repo.listStagingRows({ batchId: batch.id, status: 'skipped' });
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.txnId).toBeNull();
    const b = (await repo.listStagingBatches()).find((x) => x.id === batch.id)!;
    expect(b.status).toBe('reverted');
  });

  it('已对账(cleared)核销行：撤销红冲恢复应收一次，重复撤销不二次回退（每行原子）', async () => {
    const repo = new InMemoryRepository();
    const { book, global } = await bizBook(repo);
    const cust = mkCustomer(book.id, '张三');
    await repo.addCustomer(cust);
    const orderId = await completedServiceOrder(repo, book, cust, 100000);
    const { batch, row } = await pendingInRow(repo, 'alipay-fund-flow', global, '张三', 100000);
    await settleImportRow(repo, batch, book, row, { counterpartyType: 'customer', entityId: cust.id, orderId, assetAccountId: global });
    expect(await arBalance(repo, book.id, '张三')).toBe(0);

    // 模拟对账：把核销分录在收款账户上的 posting 标 cleared → 撤销走红冲（非软删）
    const collTxn = (await repo.getTransaction(`imp_${row.id}`))!;
    const leg = collTxn.postings.find((p) => p.accountId === global)!;
    await repo.setPostingsCleared([leg.id], true);

    const txnCountBefore = (await repo.listTransactions({ bookId: book.id })).length;
    await revertImportBatch(repo, batch.id, DATE);
    expect(await arBalance(repo, book.id, '张三')).toBe(100000); // 红冲恢复一次
    expect((await repo.listTransactions({ bookId: book.id })).length).toBe(txnCountBefore + 1); // 多一笔冲正、原分录保留
    expect(await repo.getSettlement(`set_${row.id}`)).toBeNull();

    // 重复撤销整批（重入）：行已 skipped、不再处理 → 应收不二次回退、无新增冲正
    await revertImportBatch(repo, batch.id, DATE);
    expect(await arBalance(repo, book.id, '张三')).toBe(100000); // 仍 100000，未变 200000
    expect((await repo.listTransactions({ bookId: book.id })).length).toBe(txnCountBefore + 1);
  });
});
