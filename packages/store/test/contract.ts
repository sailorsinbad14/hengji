import { describe, it, expect } from 'vitest';
import {
  accountBalance,
  budgetUsage,
  collectionEntry,
  expandEntry,
  incomeExpense,
  inventoryState,
  netWorth,
  orderRevenueEntry,
  orderTotal,
} from '@app/core';
import type { Account, Book, EntryInput, Order, StagingRow, Transaction } from '@app/core';
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

    it('全局账户：跨账本可见 + 可被任意账本交易引用 + 可跨账本对账（账户全局化 Phase 1）', async () => {
      const repo = makeRepo(fakeClock());
      await repo.addBook(books[0]!); // B1 个人
      await repo.addBook(books[1]!); // B2 生意
      await repo.addAccount(accounts[0]!); // bank @B1（账本账户）
      await repo.addAccount(accounts[6]!); // b2bank @B2（账本账户）
      await repo.addAccount(accounts[8]!); // b2sales @B2 收入
      // 全局支付宝（home=B1，global），两个账本都该看得到
      await repo.addAccount({ id: 'ali', bookId: B1, name: '支付宝', type: 'asset', parentId: null, currency: 'CNY', global: true, archived: false });
      expect((await repo.getAccount('ali'))!.global).toBe(true);
      expect((await repo.listAccounts({ bookId: B1 })).map((a) => a.id).sort()).toEqual(['ali', 'bank']);
      expect((await repo.listAccounts({ bookId: B2 })).map((a) => a.id).sort()).toEqual(['ali', 'b2bank', 'b2sales']);
      // B2 交易引用全局支付宝（home 是 B1）→ 允许（借支付宝/贷营业收入）
      await repo.addTransaction({
        id: 't-g', bookId: B2, date: '2026-06-10', payee: '', note: '', tags: [],
        postings: [
          { id: 'pg1', txnId: 't-g', accountId: 'ali', amount: 10000, currency: 'CNY' },
          { id: 'pg2', txnId: 't-g', accountId: 'b2sales', amount: -10000, currency: 'CNY' },
        ],
      });
      expect(accountBalance(await repo.listTransactions(), 'ali')).toBe(10000);
      // 账本账户跨账本仍被拒（b2bank 属 B2，B1 交易引用之）
      await expect(
        repo.addTransaction({
          id: 't-x', bookId: B1, date: '2026-06-10', payee: '', note: '', tags: [],
          postings: [
            { id: 'px1', txnId: 't-x', accountId: 'bank', amount: -100, currency: 'CNY' },
            { id: 'px2', txnId: 't-x', accountId: 'b2bank', amount: 100, currency: 'CNY' },
          ],
        }),
      ).rejects.toThrow(/跨账本/);
      // 全局账户可在任意账本下对账（rec.bookId=B2，账户 home=B1）
      const r = await repo.addReconciliation({ id: 'rg', bookId: B2, accountId: 'ali', statementBalance: 10000, statementDate: '2026-06-10', completedAt: '2026-06-10T00:00:00Z' });
      expect(r.accountId).toBe('ali');
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
    const supp = (id: string, bookId: string, name: string, dueDays = 0, archived = false) => ({
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

    it('供应商 add/get + 账本校验 + bookId/归档过滤 + update（镜像客户）', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const s = await repo.addSupplier(supp('su1', B2, '五金批发商', 30));
      expect(s.deleted).toBe(false);
      expect((await repo.getSupplier('su1'))!.dueDays).toBe(30);
      await expect(repo.addSupplier(supp('suX', 'ghost', '幽灵'))).rejects.toThrow();
      await repo.addSupplier(supp('su2', B2, '物料商'));
      expect((await repo.listSuppliers({ bookId: B2 })).map((x) => x.id).sort()).toEqual(['su1', 'su2']);
      await repo.updateSupplier('su2', { archived: true });
      expect((await repo.listSuppliers({ bookId: B2 })).map((x) => x.id)).toEqual(['su1']);
      expect((await repo.listSuppliers({ bookId: B2, includeArchived: true })).length).toBe(2);
      await expect(repo.updateSupplier('nope', { name: 'x' })).rejects.toThrow();
    });

    it('付款 settlement（direction=out / 供应商同账本校验）', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addSupplier(supp('su1', B2, '五金批发商'));
      const pay = await repo.addSettlement({
        id: 'sp1',
        bookId: B2,
        direction: 'out',
        counterpartyType: 'supplier',
        counterpartyId: 'su1',
        orderId: null,
        amount: 50000,
        date: '2026-06-11',
        accountId: 'b2bank',
        note: '付货款',
        txnId: null,
      });
      expect(pay.direction).toBe('out');
      // 跨账本付款（B1 付款引用 B2 供应商）被拒
      await expect(
        repo.addSettlement({
          id: 'sp2',
          bookId: B1,
          direction: 'out',
          counterpartyType: 'supplier',
          counterpartyId: 'su1',
          orderId: null,
          amount: 1,
          date: '2026-06-11',
          accountId: 'bank',
          note: '',
          txnId: null,
        }),
      ).rejects.toThrow(/同账本/);
      expect((await repo.listSettlements({ counterpartyId: 'su1' })).map((x) => x.id)).toEqual(['sp1']);
    });

    it('订单 add（行往返）+ 同账本客户校验 + list 过滤 + updateOrder 状态', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer(cust('cu1', B2, '张三'));
      const order: Order = {
        id: 'o1',
        bookId: B2,
        customerId: 'cu1',
        date: '2026-06-10',
        currency: 'USD',
        status: 'pending_ship',
        note: '',
        revenueTxnId: null,
        lines: [
          { id: 'l1', orderId: 'o1', name: 'A货', qty: 2, unitPrice: 120000, productId: null },
          { id: 'l2', orderId: 'o1', name: 'B货', qty: 1, unitPrice: 50000, productId: null },
        ],
      };
      const stored = await repo.addOrder(order);
      expect(stored.currency).toBe('USD'); // 订单币种往返
      expect((await repo.getOrder('o1'))!.currency).toBe('USD');
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
        currency: 'CNY',
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
    const prod = (id: string, bookId: string, name: string, cost: number, sale: number, quoteOnly = false) => ({
      id,
      bookId,
      name,
      costPrice: cost,
      salePrice: sale,
      quoteOnly,
      unit: '',
      archived: false,
    });

    it('商品 add/get + 账本校验 + bookId/归档过滤 + update', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const p = await repo.addProduct(prod('p1', B2, 'A型工具', 8000, 12500));
      expect(p.deleted).toBe(false);
      expect((await repo.getProduct('p1'))!.salePrice).toBe(12500);
      expect((await repo.getProduct('p1'))!.quoteOnly).toBe(false);
      await expect(repo.addProduct(prod('pX', 'ghost', '幽灵货', 0, 0))).rejects.toThrow();
      await repo.addProduct(prod('p2', B2, 'B型配件', 1000, 3000));
      expect((await repo.listProducts({ bookId: B2 })).map((x) => x.id).sort()).toEqual(['p1', 'p2']);
      await repo.updateProduct('p2', { archived: true, salePrice: 3500 });
      expect((await repo.listProducts({ bookId: B2 })).map((x) => x.id)).toEqual(['p1']);
      expect((await repo.listProducts({ bookId: B2, includeArchived: true })).length).toBe(2);
      expect((await repo.getProduct('p2'))!.salePrice).toBe(3500);
      await expect(repo.updateProduct('nope', { name: 'x' })).rejects.toThrow();
      // 纯报价/服务行 quoteOnly 往返 + update 切换
      await repo.addProduct(prod('p3', B2, '设计费', 0, 50000, true));
      expect((await repo.getProduct('p3'))!.quoteOnly).toBe(true);
      await repo.updateProduct('p3', { quoteOnly: false });
      expect((await repo.getProduct('p3'))!.quoteOnly).toBe(false);
    });

    it('采购单 add（行往返）+ 供应商/订单同账本校验 + list 过滤', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer({ id: 'cu1', bookId: B2, name: '张三', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addSupplier({ id: 'su1', bookId: B2, name: '代采供应商', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addOrder({
        id: 'o1', bookId: B2, customerId: 'cu1', date: '2026-06-10', currency: 'CNY',
        status: 'pending_purchase', note: '', revenueTxnId: null,
        lines: [{ id: 'l1', orderId: 'o1', name: '代采件', qty: 2, unitPrice: 9000, productId: null }],
      });
      const p = await repo.addPurchase({
        id: 'pu1', bookId: B2, supplierId: 'su1', kind: 'dropship', orderId: 'o1', destAccountId: null, date: '2026-06-10',
        payMode: 'credit', note: '为此单采购', txnId: null,
        lines: [{ id: 'pl1', purchaseId: 'pu1', name: '代采件', qty: 2, unitCost: 5000, productId: null }],
      });
      expect(p.lines.length).toBe(1);
      const got = (await repo.getPurchase('pu1'))!;
      expect(got.lines[0]!.unitCost).toBe(5000);
      expect(got.payMode).toBe('credit');
      expect(got.kind).toBe('dropship');
      // 跨账本供应商被拒
      await expect(
        repo.addPurchase({ id: 'puX', bookId: B1, supplierId: 'su1', kind: 'dropship', orderId: 'o1', destAccountId: null, date: '2026-06-10', payMode: 'cash', note: '', txnId: null, lines: [] }),
      ).rejects.toThrow(/同账本/);
      // stock 采购无订单（orderId=null，'' 哨兵往返）+ kind/dest 往返
      const ps = await repo.addPurchase({
        id: 'pu2', bookId: B2, supplierId: 'su1', kind: 'stock', orderId: null, destAccountId: null, date: '2026-06-11',
        payMode: 'cash', note: '补库存', txnId: 't9',
        lines: [{ id: 'pl9', purchaseId: 'pu2', name: '货', qty: 3, unitCost: 4000, productId: null }],
      });
      expect(ps.orderId).toBeNull();
      expect((await repo.getPurchase('pu2'))!.orderId).toBeNull();
      expect((await repo.getPurchase('pu2'))!.kind).toBe('stock');
      expect((await repo.listPurchases({ orderId: 'o1' })).map((x) => x.id)).toEqual(['pu1']); // 无订单的 pu2 不混入
      expect((await repo.listPurchases({ supplierId: 'su1' })).map((x) => x.id).sort()).toEqual(['pu1', 'pu2']);
      // expense 采购：dest 费用科目往返
      const pe = await repo.addPurchase({
        id: 'pu3', bookId: B2, supplierId: '', kind: 'expense', orderId: null, destAccountId: 'b2supply', date: '2026-06-11',
        payMode: 'cash', note: '运费', txnId: 't8', lines: [{ id: 'pl8', purchaseId: 'pu3', name: '运费', qty: 1, unitCost: 5000, productId: null }],
      });
      expect(pe.destAccountId).toBe('b2supply');
      expect((await repo.getPurchase('pu3'))!.destAccountId).toBe('b2supply');
    });

    it('采购单草稿态：空供应商可建 → updatePurchase 补供应商/采购价/记账确认；removePurchase 作废（C2 重构）', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer({ id: 'cu1', bookId: B2, name: '张三', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addSupplier({ id: 'su1', bookId: B2, name: '供应商', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addOrder({
        id: 'o1', bookId: B2, customerId: 'cu1', date: '2026-06-10', currency: 'CNY',
        status: 'pending_purchase', note: '', revenueTxnId: null,
        lines: [{ id: 'l1', orderId: 'o1', name: '货', qty: 5, unitPrice: 9000, productId: 'p1' }],
      });
      // 草稿：supplierId='' / txnId=null，跳过供应商校验
      await repo.addPurchase({
        id: 'pu1', bookId: B2, supplierId: '', kind: 'dropship', orderId: 'o1', destAccountId: null, date: '2026-06-10',
        payMode: 'credit', note: '', txnId: null,
        lines: [{ id: 'pl1', purchaseId: 'pu1', name: '货', qty: 5, unitCost: 6000, productId: 'p1' }],
      });
      expect((await repo.getPurchase('pu1'))!.supplierId).toBe('');
      // 确认：补供应商 + 改采购价（整单替换 lines）+ 写 txnId
      const confirmed = await repo.updatePurchase('pu1', {
        supplierId: 'su1', txnId: 't1',
        lines: [{ id: 'pl2', purchaseId: 'pu1', name: '货', qty: 5, unitCost: 6500, productId: 'p1' }],
      });
      expect(confirmed.supplierId).toBe('su1');
      expect(confirmed.txnId).toBe('t1');
      expect(confirmed.lines.map((l) => l.unitCost)).toEqual([6500]);
      // 跨账本供应商被拒
      await repo.addSupplier({ id: 'b1sup', bookId: B1, name: '外账供应商', phone: '', note: '', dueDays: 0, archived: false });
      await expect(repo.updatePurchase('pu1', { supplierId: 'b1sup' })).rejects.toThrow(/同账本/);
      // 作废：软删，list 不再返回
      await repo.removePurchase('pu1');
      expect(await repo.getPurchase('pu1')).toBeNull();
      expect((await repo.listPurchases({ orderId: 'o1' })).length).toBe(0);
      await expect(repo.removePurchase('pu1')).rejects.toThrow();
    });

    it('额外费用定义 add/list/update + 订单行 feeIds 往返（C2 Step 4）', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer({ id: 'cu1', bookId: B2, name: '张三', phone: '', note: '', dueDays: 0, archived: false });
      const f = await repo.addFeeDefinition({ id: 'f1', bookId: B2, name: '佣金', calcType: 'percent', tiers: [{ threshold: 0, value: 5 }, { threshold: 60000, value: 4 }], archived: false });
      expect(f.calcType).toBe('percent');
      expect(f.tiers).toEqual([{ threshold: 0, value: 5 }, { threshold: 60000, value: 4 }]);
      await expect(repo.addFeeDefinition({ id: 'fX', bookId: 'ghost', name: 'x', calcType: 'fixed', tiers: [], archived: false })).rejects.toThrow();
      expect((await repo.listFeeDefinitions({ bookId: B2 })).map((x) => x.id)).toEqual(['f1']);
      await repo.updateFeeDefinition('f1', { archived: true, tiers: [{ threshold: 0, value: 3 }] });
      expect((await repo.listFeeDefinitions({ bookId: B2 })).length).toBe(0); // 归档默认排除
      const arch = (await repo.listFeeDefinitions({ bookId: B2, includeArchived: true }))[0]!;
      expect(arch.tiers).toEqual([{ threshold: 0, value: 3 }]);
      await expect(repo.updateFeeDefinition('nope', { name: 'x' })).rejects.toThrow();
      // 订单行 feeIds 往返：有费用的行存 ['f1']，无费用的行归一化为 []
      await repo.addOrder({
        id: 'o1', bookId: B2, customerId: 'cu1', date: '2026-06-10', currency: 'CNY', status: 'pending_ship', note: '', revenueTxnId: null,
        lines: [
          { id: 'l1', orderId: 'o1', name: '货', qty: 2, unitPrice: 10000, productId: null, feeIds: ['f1'] },
          { id: 'l2', orderId: 'o1', name: '服务', qty: 1, unitPrice: 5000, productId: null },
        ],
      });
      const got = await repo.getOrder('o1');
      expect(got!.lines.map((l) => l.feeIds)).toEqual([['f1'], []]);
    });

    it('订单行可关联商品 id 并往返；自由文本行 productId=null', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addCustomer({ id: 'cu1', bookId: B2, name: '张三', phone: '', note: '', dueDays: 0, archived: false });
      await repo.addProduct(prod('p1', B2, 'A型工具', 8000, 12500));
      await repo.addOrder({
        id: 'o1',
        bookId: B2,
        customerId: 'cu1',
        date: '2026-06-10',
        currency: 'CNY',
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

    it('库存出入库流水：add + list 过滤 + 同账本校验；core 聚合在手数量/均价', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      await repo.addProduct(prod('p1', B2, 'A型工具', 8000, 12500, true));
      await repo.addInventoryMovement({ id: 'm1', bookId: B2, productId: 'p1', date: '2026-06-01', kind: 'in', qty: 10, unitCost: 8000, orderId: null, txnId: 't1', note: '进货' });
      await repo.addInventoryMovement({ id: 'm2', bookId: B2, productId: 'p1', date: '2026-06-02', kind: 'out', qty: -3, unitCost: 8000, orderId: 'o1', txnId: 't2', note: '' });
      const all = await repo.listInventoryMovements({ bookId: B2, productId: 'p1' });
      expect(all.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
      expect((await repo.listInventoryMovements({ orderId: 'o1' })).map((m) => m.id)).toEqual(['m2']);
      // core 回放：在手 7 个、均价 ¥80、库存值 ¥560
      const st = inventoryState(all);
      expect(st).toEqual({ qty: 7, totalCost: 56000, avgCost: 8000 });
      // 商品不在本账本 → 拒绝
      await expect(
        repo.addInventoryMovement({ id: 'm3', bookId: B1, productId: 'p1', date: '2026-06-03', kind: 'in', qty: 1, unitCost: 8000, orderId: null, txnId: null, note: '' }),
      ).rejects.toThrow();
    });
  });

  describe(`${name} · 插件单据（插件地基）`, () => {
    it('add/get/list 过滤 + data/txnIds JSON 往返 + 账本校验 + removePluginDocument 软删', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const d = await repo.addPluginDocument({
        id: 'd1', bookId: B2, pluginId: 'builtin', docType: 'platformSale',
        data: { shop: '拼多多', lines: [{ name: '数码配件', qty: 1, unitPrice: 100000 }] },
        txnIds: ['t1', 't2'],
      });
      expect(d.deleted).toBe(false);
      const got = (await repo.getPluginDocument('d1'))!;
      expect(got.data).toEqual({ shop: '拼多多', lines: [{ name: '数码配件', qty: 1, unitPrice: 100000 }] });
      expect(got.txnIds).toEqual(['t1', 't2']);
      // 账本校验
      await expect(repo.addPluginDocument({ id: 'dX', bookId: 'ghost', pluginId: 'builtin', docType: 'platformSale', data: {}, txnIds: [] })).rejects.toThrow();
      // list 过滤：bookId / pluginId / docType（每维度都有会被排除的负向 fixture，确保过滤真生效）
      await repo.addPluginDocument({ id: 'd2', bookId: B2, pluginId: 'builtin', docType: 'other', data: {}, txnIds: [] });
      await repo.addPluginDocument({ id: 'd3', bookId: B1, pluginId: 'builtin', docType: 'platformSale', data: {}, txnIds: [] });
      await repo.addPluginDocument({ id: 'd4', bookId: B1, pluginId: 'thirdparty', docType: 'other', data: {}, txnIds: [] });
      expect((await repo.listPluginDocuments({ bookId: B2 })).map((x) => x.id).sort()).toEqual(['d1', 'd2']);
      expect((await repo.listPluginDocuments({ docType: 'platformSale' })).map((x) => x.id).sort()).toEqual(['d1', 'd3']);
      expect((await repo.listPluginDocuments({ bookId: B2, docType: 'platformSale' })).map((x) => x.id)).toEqual(['d1']);
      // pluginId 过滤需能把别的插件排除掉（不同 pluginId 的 d4 不得混入 builtin 结果）
      expect((await repo.listPluginDocuments({ pluginId: 'builtin' })).map((x) => x.id).sort()).toEqual(['d1', 'd2', 'd3']);
      expect((await repo.listPluginDocuments({ pluginId: 'thirdparty' })).map((x) => x.id)).toEqual(['d4']);
      // removePluginDocument 软删：get 返 null、list 排除、重复删抛错
      await repo.removePluginDocument('d1');
      expect(await repo.getPluginDocument('d1')).toBeNull();
      expect((await repo.listPluginDocuments({ bookId: B2 })).map((x) => x.id)).toEqual(['d2']);
      await expect(repo.removePluginDocument('d1')).rejects.toThrow();
    });
  });

  describe(`${name} · 导入复核台脊梁（staging）`, () => {
    const mkRow = (over: Partial<StagingRow> & { id: string; batchId: string; bizNo: string }): StagingRow => ({
      date: '2026-06-01',
      datetime: '2026-06-01 12:00:00',
      amountMinor: 10000,
      direction: 'out',
      payee: '商户',
      counterpartyAccount: '',
      note: '',
      accountingType: '在线支付',
      suggestion: 'expense',
      assignedBookId: null,
      assignedAccountId: null,
      status: 'pending',
      txnId: null,
      ...over,
    });

    it('批次/行：批量插入 + 批次校验（整批原子）+ 状态机 + biz_no 去重/自愈', async () => {
      const repo = await seed(makeRepo(fakeClock()));

      // addStagingBatch 盖同步元数据、status 保留；重复抛错
      const batch = await repo.addStagingBatch({ id: 'sb1', source: 'alipay-fund-flow', accountId: 'alipay', label: '6月.csv', status: 'reviewing' });
      expect(batch.deleted).toBe(false);
      expect(batch.createdAt.startsWith('2026-01-01')).toBe(true);
      expect(batch.status).toBe('reviewing');
      await expect(repo.addStagingBatch({ id: 'sb1', source: 'x', accountId: 'a', label: '', status: 'reviewing' })).rejects.toThrow();

      // addStagingRows 批量插入：按入参顺序返回、默认 pending/txnId=null
      const rows = await repo.addStagingRows([
        mkRow({ id: 'sr1', batchId: 'sb1', bizNo: 'A001', suggestion: 'expense' }),
        mkRow({ id: 'sr2', batchId: 'sb1', bizNo: 'A002', direction: 'in', suggestion: 'income' }),
        mkRow({ id: 'sr3', batchId: 'sb1', bizNo: 'A003', suggestion: 'unknown', accountingType: '转账' }),
      ]);
      expect(rows.map((r) => r.id)).toEqual(['sr1', 'sr2', 'sr3']);
      expect(rows.every((r) => r.status === 'pending' && r.txnId === null)).toBe(true);
      expect(await repo.addStagingRows([])).toEqual([]); // 空数组安全

      // 引用不存在批次 → 抛错且整批不写（srX 不得因 srBad 失败前已落而残留）
      await expect(
        repo.addStagingRows([mkRow({ id: 'srX', batchId: 'sb1', bizNo: 'A100' }), mkRow({ id: 'srBad', batchId: 'ghost', bizNo: 'A101' })]),
      ).rejects.toThrow();
      expect((await repo.listStagingRows({ batchId: 'sb1' })).map((r) => r.id).sort()).toEqual(['sr1', 'sr2', 'sr3']);

      // 同批入参 id 重复 → 三实现一致抛错且整批不写（不静默覆盖/返回幽灵行）
      await expect(
        repo.addStagingRows([mkRow({ id: 'srDup', batchId: 'sb1', bizNo: 'A200' }), mkRow({ id: 'srDup', batchId: 'sb1', bizNo: 'A201' })]),
      ).rejects.toThrow();
      expect((await repo.listStagingRows({ batchId: 'sb1' })).map((r) => r.id).sort()).toEqual(['sr1', 'sr2', 'sr3']);

      // listStagingRows status 过滤
      expect((await repo.listStagingRows({ batchId: 'sb1', status: 'pending' })).length).toBe(3);
      expect((await repo.listStagingRows({ status: 'posted' })).length).toBe(0);

      // updateStagingRow：复核决定（指派账本/对手腿 + 落库回填 txnId + 置 posted）
      const posted = await repo.updateStagingRow('sr1', { assignedBookId: B1, assignedAccountId: 'food', status: 'posted', txnId: 't-sr1' });
      expect([posted.assignedBookId, posted.assignedAccountId, posted.status, posted.txnId]).toEqual([B1, 'food', 'posted', 't-sr1']);
      // 只改 suggestion（unknown → transfer-out），其余字段保持
      const fixed = await repo.updateStagingRow('sr3', { suggestion: 'transfer-out' });
      expect(fixed.suggestion).toBe('transfer-out');
      expect(fixed.status).toBe('pending');
      await expect(repo.updateStagingRow('nope', { status: 'skipped' })).rejects.toThrow();

      // biz_no 去重 / 落库中断自愈：查 posted 命中的 biz_no（A001 已落、A999 未见）
      const postedByBiz = await repo.listStagingRows({ status: 'posted', bizNos: ['A001', 'A999'] });
      expect(postedByBiz.map((r) => r.bizNo)).toEqual(['A001']);
      expect(await repo.listStagingRows({ bizNos: [] })).toEqual([]); // 空 bizNos → 空结果（非全量）

      // updateStagingBatch：状态机 reviewing → committed；list status 过滤
      const committed = await repo.updateStagingBatch('sb1', { status: 'committed' });
      expect(committed.status).toBe('committed');
      expect((await repo.listStagingBatches({ status: 'reviewing' })).length).toBe(0);
      expect((await repo.listStagingBatches({ status: 'committed' })).map((b) => b.id)).toEqual(['sb1']);
      await expect(repo.updateStagingBatch('nope', { status: 'reverted' })).rejects.toThrow();
    });
  });

  describe(`${name} · 设置（KV）`, () => {
    it('set/get + upsert 覆盖 + scope 隔离 + list 过滤', async () => {
      const repo = makeRepo(fakeClock());
      expect(await repo.getSetting(B1, 'accountingBasis')).toBeNull();
      const s = await repo.setSetting(B1, 'accountingBasis', 'cash');
      expect(s.value).toBe('cash');
      expect(s.updatedAt.startsWith('2026-01-01')).toBe(true);
      expect((await repo.getSetting(B1, 'accountingBasis'))!.value).toBe('cash');
      // upsert：同 scope+key 覆盖，不新增行
      const before = (await repo.getSetting(B1, 'accountingBasis'))!.updatedAt;
      const s2 = await repo.setSetting(B1, 'accountingBasis', 'accrual');
      expect(s2.value).toBe('accrual');
      expect(s2.updatedAt > before).toBe(true);
      expect((await repo.listSettings(B1)).length).toBe(1);
      // scope 隔离：另一账本与 app 级互不串
      await repo.setSetting(B2, 'accountingBasis', 'cash');
      await repo.setSetting('app', 'theme', 'dark');
      expect((await repo.getSetting(B2, 'accountingBasis'))!.value).toBe('cash');
      expect((await repo.listSettings(B1)).map((x) => x.key)).toEqual(['accountingBasis']);
      expect((await repo.listSettings()).length).toBe(3);
    });
  });

  describe(`${name} · 月度对账`, () => {
    it('分录默认未核销；setPostingsCleared 批量置位/取消，往返读到', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const t1 = await repo.listTransactions({ bookId: B1 });
      const banks = t1.flatMap((t) => t.postings.filter((p) => p.accountId === 'bank'));
      expect(banks.every((p) => !p.cleared)).toBe(true); // 默认全未核销
      const ids = banks.slice(0, 2).map((p) => p.id);
      await repo.setPostingsCleared(ids, true);
      const after = (await repo.listTransactions({ bookId: B1 })).flatMap((t) => t.postings);
      expect(after.filter((p) => p.cleared).map((p) => p.id).sort()).toEqual([...ids].sort());
      // 取消核销
      await repo.setPostingsCleared([ids[0]!], false);
      const after2 = (await repo.listTransactions({ bookId: B1 })).flatMap((t) => t.postings).filter((p) => p.cleared);
      expect(after2.map((p) => p.id)).toEqual([ids[1]]);
      // 空数组 no-op
      await repo.setPostingsCleared([], true);
    });

    it('addReconciliation 校验账本/账户同账本 + list 过滤 + 倒序', async () => {
      const repo = await seed(makeRepo(fakeClock()));
      const r1 = await repo.addReconciliation({
        id: 'rc1',
        bookId: B1,
        accountId: 'bank',
        statementBalance: 497000,
        statementDate: '2026-05-31',
        completedAt: '2026-05-31T10:00:00Z',
      });
      expect(r1.deleted).toBe(false);
      expect(r1.createdAt.startsWith('2026-01-01')).toBe(true);
      // 账户不存在 / 账户跨账本 → 拒
      await expect(
        repo.addReconciliation({ id: 'rcX', bookId: B1, accountId: 'ghost', statementBalance: 0, statementDate: '2026-05-31', completedAt: 'x' }),
      ).rejects.toThrow();
      await expect(
        repo.addReconciliation({ id: 'rcY', bookId: B1, accountId: 'b2bank', statementBalance: 0, statementDate: '2026-05-31', completedAt: 'x' }),
      ).rejects.toThrow(/同账本/);
      await repo.addReconciliation({
        id: 'rc2',
        bookId: B1,
        accountId: 'bank',
        statementBalance: 500000,
        statementDate: '2026-06-30',
        completedAt: '2026-06-30T10:00:00Z',
      });
      // 倒序（最近完成在前）+ 账户过滤
      expect((await repo.listReconciliations({ accountId: 'bank' })).map((r) => r.id)).toEqual(['rc2', 'rc1']);
      expect((await repo.listReconciliations({ bookId: B2 })).length).toBe(0);
      await expect(
        repo.addReconciliation({ id: 'rc1', bookId: B1, accountId: 'bank', statementBalance: 1, statementDate: 'x', completedAt: 'x' }),
      ).rejects.toThrow();
    });
  });
}
