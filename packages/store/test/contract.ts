import { describe, it, expect } from 'vitest';
import {
  accountBalance,
  budgetUsage,
  collectionEntry,
  expandEntry,
  incomeExpense,
  netWorth,
  orderRevenueEntry,
  orderTotal,
} from '@app/core';
import type { Account, Book, EntryInput, Order, Transaction } from '@app/core';
import type { Clock, Repository } from '../src/index';

export function fakeClock(): Clock {
  let n = 0;
  return () => `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.${String(n++).padStart(3, '0')}Z`;
}

export function counter(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export const B1 = 'bk-main';
export const B2 = 'bk-biz';

export const books: Book[] = [
  { id: B1, name: '我的日常', type: 'personal', archived: false },
  { id: B2, name: '小生意', type: 'business', archived: false },
];

const acc = (id: string, bookId: string, name: string, type: Account['type']): Account => ({
  id,
  bookId,
  name,
  type,
  parentId: null,
  currency: 'CNY',
  archived: false,
});

export const accounts: Account[] = [
  acc('bank', B1, '招行卡', 'asset'),
  acc('alipay', B1, '支付宝', 'asset'),
  acc('invest', B1, '投资账户', 'asset'),
  acc('card', B1, '信用卡', 'liability'),
  acc('food', B1, '餐饮', 'expense'),
  acc('salary', B1, '工资', 'income'),
  // 第二账本（生意）
  acc('b2bank', B2, '对公账户', 'asset'),
  acc('b2ar', B2, '应收账款', 'asset'),
  acc('b2sales', B2, '营业收入', 'income'),
  acc('b2supply', B2, '进货成本', 'expense'),
];

const SEED: EntryInput[] = [
  { kind: 'income', bookId: B1, date: '2026-05-01', amount: 500000, accountId: 'bank', categoryId: 'salary' },
  { kind: 'expense', bookId: B1, date: '2026-05-03', amount: 3000, accountId: 'bank', categoryId: 'food' },
  { kind: 'transfer', bookId: B1, date: '2026-05-05', amount: 100000, fromAccountId: 'bank', toAccountId: 'alipay' },
  { kind: 'transfer', bookId: B1, date: '2026-05-10', amount: 100000, fromAccountId: 'bank', toAccountId: 'invest' },
  // 生意账本
  { kind: 'income', bookId: B2, date: '2026-06-02', amount: 200000, accountId: 'b2bank', categoryId: 'b2sales' },
  { kind: 'expense', bookId: B2, date: '2026-06-03', amount: 80000, accountId: 'b2bank', categoryId: 'b2supply' },
];

async function seed(repo: Repository): Promise<Repository> {
  for (const b of books) await repo.addBook(b);
  for (const a of accounts) await repo.addAccount(a);
  const gen = counter();
  for (const e of SEED) await repo.addTransaction(expandEntry(e, gen));
  return repo;
}

/**
 * 共享 Repository 契约：内存与 SQLite 实现跑同一套，证明对外行为一致。
 */
export function runRepositoryContract(name: string, makeRepo: (now: Clock) => Repository): void {
  describe(`${name} · 账本`, () => {
    it('addBook 盖上同步元数据；重复抛错', async () => {
      const repo = makeRepo(fakeClock());
      const b = await repo.addBook(books[0]!);
      expect(b.deleted).toBe(false);
      expect(b.createdAt.startsWith('2026-01-01')).toBe(true);
      expect((await repo.getBook(B1))!.name).toBe('我的日常');
      await expect(repo.addBook(books[0]!)).rejects.toThrow();
    });

    it('listBooks 默认排除归档；updateBook 改名/归档', async () => {
      const repo = makeRepo(fakeClock());
      await repo.addBook(books[0]!);
      await repo.addBook(books[1]!);
      const renamed = await repo.updateBook(B2, { name: '外贸生意' });
      expect(renamed.name).toBe('外贸生意');
      await repo.updateBook(B2, { archived: true });
      expect((await repo.listBooks()).map((b) => b.id)).toEqual([B1]);
      expect((await repo.listBooks({ includeArchived: true })).length).toBe(2);
      await expect(repo.updateBook('nope', { name: 'x' })).rejects.toThrow();
    });
  });

  describe(`${name} · 账户`, () => {
    it('addAccount 校验账本存在；bookId 过滤', async () => {
      const repo = makeRepo(fakeClock());
      await repo.addBook(books[0]!);
      await repo.addBook(books[1]!);
      await repo.addAccount(accounts[0]!); // bank @B1
      await repo.addAccount(accounts[6]!); // b2bank @B2
      await expect(repo.addAccount({ ...accounts[1]!, bookId: 'ghost' })).rejects.toThrow();
      expect((await repo.listAccounts({ bookId: B1 })).map((a) => a.id)).toEqual(['bank']);
      expect((await repo.listAccounts({ bookId: B2 })).map((a) => a.id)).toEqual(['b2bank']);
      expect((await repo.listAccounts()).length).toBe(2);
    });

    it('listAccounts 默认排除归档；updateAccount bump updatedAt 保留 createdAt', async () => {
      const repo = makeRepo(fakeClock());
      await repo.addBook(books[0]!);
      await repo.addAccount(accounts[0]!);
      await repo.addAccount(accounts[1]!);
      const before = (await repo.getAccount('alipay'))!;
      const updated = await repo.updateAccount('alipay', { archived: true });
      expect(updated.archived).toBe(true);
      expect(updated.createdAt).toBe(before.createdAt);
      expect(updated.updatedAt > before.updatedAt).toBe(true);
      expect((await repo.listAccounts({ bookId: B1 })).map((a) => a.id)).toEqual(['bank']);
      expect((await repo.listAccounts({ bookId: B1, includeArchived: true })).length).toBe(2);
      await expect(repo.updateAccount('nope', { name: 'x' })).rejects.toThrow();
    });
  });

  describe(`${name} · 交易`, () => {
    it('拒绝未平衡分录、引用不存在账户、跨账本分录', async () => {
      const repo = makeRepo(fakeClock());
      await repo.addBook(books[0]!);
      await repo.addBook(books[1]!);
      await repo.addAccount(accounts[0]!); // bank B1
      await repo.addAccount(accounts[4]!); // food B1
      await repo.addAccount(accounts[6]!); // b2bank B2
      const mkTxn = (postings: Transaction['postings'], bookId = B1): Transaction => ({
        id: `t-${postings[0]!.id}`,
        bookId,
        date: '2026-05-01',
        payee: '',
        note: '',
        tags: [],
        postings,
      });
      // 未平衡
      await expect(
        repo.addTransaction(
          mkTxn([
            { id: 'p1', txnId: 't-p1', accountId: 'bank', amount: 100, currency: 'CNY' },
            { id: 'p2', txnId: 't-p1', accountId: 'food', amount: -50, currency: 'CNY' },
          ]),
        ),
      ).rejects.toThrow();
      // 引用不存在的账户
      await expect(
        repo.addTransaction(
          mkTxn([
            { id: 'p3', txnId: 't-p3', accountId: 'ghost', amount: 100, currency: 'CNY' },
            { id: 'p4', txnId: 't-p3', accountId: 'bank', amount: -100, currency: 'CNY' },
          ]),
        ),
      ).rejects.toThrow();
      // 跨账本分录（B1 交易引用 B2 账户）
      await expect(
        repo.addTransaction(
          mkTxn([
            { id: 'p5', txnId: 't-p5', accountId: 'b2bank', amount: 100, currency: 'CNY' },
            { id: 'p6', txnId: 't-p5', accountId: 'bank', amount: -100, currency: 'CNY' },
          ]),
        ),
      ).rejects.toThrow(/跨账本/);
    });

    it('listTransactions：bookId/日期/账户过滤 + 倒序 + 软删除排除', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      expect((await repo.listTransactions()).length).toBe(6);
      const b1 = await repo.listTransactions({ bookId: B1 });
      expect(b1.length).toBe(4);
      expect(b1.every((t) => t.bookId === B1)).toBe(true);
      expect((await repo.listTransactions({ bookId: B2 })).length).toBe(2);
      expect((await repo.listTransactions({ bookId: B1, from: '2026-05-01', to: '2026-05-04' })).length).toBe(2);
      const viaCard = await repo.listTransactions({ accountId: 'invest' });
      expect(viaCard.length).toBe(1);
      const dates = (await repo.listTransactions()).map((t) => t.date);
      expect([...dates].sort((a, b) => (a < b ? 1 : -1))).toEqual(dates);
      const food = (await repo.listTransactions({ accountId: 'food' }))[0]!;
      await repo.softDeleteTransaction(food.id);
      expect(await repo.getTransaction(food.id)).toBeNull();
      expect((await repo.listTransactions({ bookId: B1 })).length).toBe(3);
    });

    it('updateTransaction 保留 createdAt/bookId、禁止跨账本移动', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const t = (await repo.listTransactions({ accountId: 'food' }))[0]!;
      const replacement = expandEntry(
        { kind: 'expense', bookId: B1, date: '2026-05-03', amount: 5000, accountId: 'bank', categoryId: 'food' },
        counter('upd'),
      );
      const updated = await repo.updateTransaction(t.id, replacement);
      expect(updated.id).toBe(t.id);
      expect(updated.createdAt).toBe(t.createdAt);
      expect(updated.updatedAt > t.updatedAt).toBe(true);
      expect(updated.postings.find((p) => p.accountId === 'food')!.amount).toBe(5000);
      // 跨账本移动被拒
      const moved = expandEntry(
        { kind: 'income', bookId: B2, date: '2026-06-09', amount: 1000, accountId: 'b2bank', categoryId: 'b2sales' },
        counter('mv'),
      );
      await expect(repo.updateTransaction(t.id, moved)).rejects.toThrow(/不可移动/);
    });
  });

  describe(`${name} · 与 core 报表集成`, () => {
    it('单账本报表与全账本汇总都正确', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const a1 = await repo.listAccounts({ bookId: B1 });
      const t1 = await repo.listTransactions({ bookId: B1 });
      expect(netWorth(t1, a1)).toBe(497000); // 500000-3000（转账不改变净资产）
      expect(incomeExpense(t1, a1)).toEqual({ income: 500000, expense: 3000, net: 497000 });

      const a2 = await repo.listAccounts({ bookId: B2 });
      const t2 = await repo.listTransactions({ bookId: B2 });
      expect(incomeExpense(t2, a2)).toEqual({ income: 200000, expense: 80000, net: 120000 });

      // 财务总表 = 各账本之和（同一引擎直接喂全量数据）
      const all = netWorth(await repo.listTransactions(), await repo.listAccounts());
      expect(all).toBe(497000 + 120000);
    });
  });

  describe(`${name} · 预算`, () => {
    it('add/list/update/remove + 同账本校验 + bookId 过滤', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const b = await repo.addBudget({ id: 'bg1', bookId: B1, accountId: 'food', monthlyLimit: 50000 });
      expect(b.deleted).toBe(false);
      // 科目与预算不同账本 → 拒绝
      await expect(
        repo.addBudget({ id: 'bg2', bookId: B2, accountId: 'food', monthlyLimit: 1 }),
      ).rejects.toThrow(/同账本/);
      await repo.addBudget({ id: 'bg3', bookId: B2, accountId: 'b2supply', monthlyLimit: 100000 });
      expect((await repo.listBudgets()).length).toBe(2);
      expect((await repo.listBudgets({ bookId: B1 })).map((x) => x.id)).toEqual(['bg1']);
      const u = await repo.updateBudget('bg1', { monthlyLimit: 60000 });
      expect(u.monthlyLimit).toBe(60000);
      await repo.removeBudget('bg3');
      expect((await repo.listBudgets()).map((x) => x.id)).toEqual(['bg1']);
      await expect(repo.addBudget({ id: 'bg1', bookId: B1, accountId: 'food', monthlyLimit: 1 })).rejects.toThrow();
      await expect(repo.updateBudget('nope', { monthlyLimit: 1 })).rejects.toThrow();
      await expect(repo.removeBudget('nope')).rejects.toThrow();
    });

    it('集成 budgetUsage：账本作用域内计算', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addBudget({ id: 'bg1', bookId: B2, accountId: 'b2supply', monthlyLimit: 50000 });
      const lines = budgetUsage(
        await repo.listTransactions({ bookId: B2 }),
        await repo.listBudgets({ bookId: B2 }),
        '2026-06',
      );
      expect(lines.find((l) => l.accountId === 'b2supply')).toEqual({
        accountId: 'b2supply',
        limit: 50000,
        spent: 80000,
        remaining: -30000,
        over: true,
      });
    });
  });

  describe(`${name} · 生意（客户/订单/收款）`, () => {
    const cust = (id: string, bookId: string, name: string, dueDays = 0, archived = false) => ({
      id,
      bookId,
      name,
      phone: '',
      note: '',
      dueDays,
      archived,
    });

    it('客户 add/get + 账本校验 + bookId/归档过滤 + update', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const c = await repo.addCustomer(cust('cu1', B2, '张三', 30));
      expect(c.deleted).toBe(false);
      expect((await repo.getCustomer('cu1'))!.dueDays).toBe(30);
      await expect(repo.addCustomer(cust('cuX', 'ghost', '幽灵'))).rejects.toThrow();
      await repo.addCustomer(cust('cu2', B2, '李四'));
      expect((await repo.listCustomers({ bookId: B2 })).map((x) => x.id).sort()).toEqual(['cu1', 'cu2']);
      await repo.updateCustomer('cu2', { archived: true });
      expect((await repo.listCustomers({ bookId: B2 })).map((x) => x.id)).toEqual(['cu1']);
      expect((await repo.listCustomers({ bookId: B2, includeArchived: true })).length).toBe(2);
      await expect(repo.updateCustomer('nope', { name: 'x' })).rejects.toThrow();
    });

    it('订单 add（行往返）+ 同账本客户校验 + list 过滤 + updateOrder 状态', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer(cust('cu1', B2, '张三'));
      const order: Order = {
        id: 'o1',
        bookId: B2,
        customerId: 'cu1',
        date: '2026-06-10',
        status: 'pending_ship',
        note: '',
        revenueTxnId: null,
        lines: [
          { id: 'l1', orderId: 'o1', name: 'A货', qty: 2, unitPrice: 120000, productId: null },
          { id: 'l2', orderId: 'o1', name: 'B货', qty: 1, unitPrice: 50000, productId: null },
        ],
      };
      const stored = await repo.addOrder(order);
      expect(stored.lines.length).toBe(2);
      expect((await repo.getOrder('o1'))!.lines.map((l) => l.name)).toEqual(['A货', 'B货']);
      expect(orderTotal(stored.lines)).toBe(290000);
      await expect(repo.addOrder({ ...order, id: 'o2', customerId: 'ghost' })).rejects.toThrow();
      expect((await repo.listOrders({ bookId: B2 })).map((o) => o.id)).toEqual(['o1']);
      expect((await repo.listOrders({ customerId: 'cu1' })).length).toBe(1);
      expect((await repo.listOrders({ status: 'completed' })).length).toBe(0);
      const done = await repo.updateOrder('o1', { status: 'completed', revenueTxnId: 'tx-rev' });
      expect(done.status).toBe('completed');
      expect(done.revenueTxnId).toBe('tx-rev');
      expect(done.lines.length).toBe(2); // 改状态不丢行
      expect((await repo.listOrders({ status: 'completed' })).length).toBe(1);
      await expect(repo.updateOrder('nope', { status: 'cancelled' })).rejects.toThrow();
    });

    it('收款 add（订单/客户同账本校验）+ list 过滤；与 core 聚合出应收余额', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer(cust('cu1', B2, '张三'));
      const gen = counter('biz');
      const order: Order = {
        id: 'o1',
        bookId: B2,
        customerId: 'cu1',
        date: '2026-06-10',
        status: 'pending_ship',
        note: '',
        revenueTxnId: null,
        lines: [{ id: 'l1', orderId: 'o1', name: 'A货', qty: 1, unitPrice: 250000, productId: null }],
      };
      await repo.addOrder(order);
      // 完成 → 确认收入：借 应收(b2ar) 贷 营业收入(b2sales)
      const rev = orderRevenueEntry(
        { bookId: B2, date: '2026-06-10', amount: orderTotal(order.lines), receivableAccountId: 'b2ar', revenueAccountId: 'b2sales' },
        gen,
      );
      await repo.addTransaction(rev);
      await repo.updateOrder('o1', { status: 'completed', revenueTxnId: rev.id });
      // 收款 ¥1000：钱从应收转入对公账户
      const collect = collectionEntry(
        { bookId: B2, date: '2026-06-11', amount: 100000, receivableAccountId: 'b2ar', assetAccountId: 'b2bank' },
        gen,
      );
      await repo.addTransaction(collect);
      const s = await repo.addSettlement({
        id: 's1',
        bookId: B2,
        direction: 'in',
        counterpartyType: 'customer',
        counterpartyId: 'cu1',
        orderId: 'o1',
        amount: 100000,
        date: '2026-06-11',
        accountId: 'b2bank',
        note: '',
        txnId: collect.id,
      });
      expect(s.deleted).toBe(false);
      // 跨账本收款（B1 收款引用 B2 客户）被拒
      await expect(
        repo.addSettlement({
          id: 's2',
          bookId: B1,
          direction: 'in',
          counterpartyType: 'customer',
          counterpartyId: 'cu1',
          orderId: null,
          amount: 1,
          date: '2026-06-11',
          accountId: 'bank',
          note: '',
          txnId: null,
        }),
      ).rejects.toThrow(/同账本/);
      expect((await repo.listSettlements({ orderId: 'o1' })).map((x) => x.id)).toEqual(['s1']);
      expect((await repo.listSettlements({ counterpartyId: 'cu1' })).length).toBe(1);
      // 应收余额 = 250000 - 100000 = 150000（从分录聚合）
      const t2 = await repo.listTransactions({ bookId: B2 });
      expect(accountBalance(t2, 'b2ar')).toBe(150000);
    });
  });

  describe(`${name} · 商品（C1）`, () => {
    const prod = (id: string, bookId: string, name: string, cost: number, sale: number, isStock = false) => ({
      id,
      bookId,
      name,
      costPrice: cost,
      salePrice: sale,
      isStock,
      unit: '',
      archived: false,
    });

    it('商品 add/get + 账本校验 + bookId/归档过滤 + update', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const p = await repo.addProduct(prod('p1', B2, 'A型工具', 8000, 12500, true));
      expect(p.deleted).toBe(false);
      expect((await repo.getProduct('p1'))!.salePrice).toBe(12500);
      expect((await repo.getProduct('p1'))!.isStock).toBe(true);
      await expect(repo.addProduct(prod('pX', 'ghost', '幽灵货', 0, 0))).rejects.toThrow();
      await repo.addProduct(prod('p2', B2, 'B型配件', 1000, 3000));
      expect((await repo.listProducts({ bookId: B2 })).map((x) => x.id).sort()).toEqual(['p1', 'p2']);
      await repo.updateProduct('p2', { archived: true, salePrice: 3500 });
      expect((await repo.listProducts({ bookId: B2 })).map((x) => x.id)).toEqual(['p1']);
      expect((await repo.listProducts({ bookId: B2, includeArchived: true })).length).toBe(2);
      expect((await repo.getProduct('p2'))!.salePrice).toBe(3500);
      await expect(repo.updateProduct('nope', { name: 'x' })).rejects.toThrow();
    });

    it('订单行可关联商品 id 并往返；自由文本行 productId=null', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer({ id: 'cu1', bookId: B2, name: '张三', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addProduct(prod('p1', B2, 'A型工具', 8000, 12500, true));
      await repo.addOrder({
        id: 'o1',
        bookId: B2,
        customerId: 'cu1',
        date: '2026-06-10',
        status: 'pending_ship',
        note: '',
        revenueTxnId: null,
        lines: [
          { id: 'l1', orderId: 'o1', name: 'A型工具', qty: 2, unitPrice: 12500, productId: 'p1' },
          { id: 'l2', orderId: 'o1', name: '手写项', qty: 1, unitPrice: 500, productId: null },
        ],
      });
      const got = await repo.getOrder('o1');
      expect(got!.lines.map((l) => l.productId)).toEqual(['p1', null]);
    });
  });
}
