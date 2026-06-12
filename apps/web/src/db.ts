import { adjustBalanceEntry, defaultChartFor, expandEntry, orderRevenueEntry, orderTotal, toMinor } from '@app/core';
import type { Account, Book, BookType, EntryInput } from '@app/core';
import { InMemoryRepository } from '@app/store';
import type { Repository } from '@app/store';
import { localISO } from './format';

export const genId = (): string => crypto.randomUUID();

/** 是否运行在 Tauri 桌面壳内 */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

/** 在 repo 中创建账本 + 默认科目表，返回账本与按名取账户的工具。 */
export async function createBookWithChart(
  repo: Repository,
  name: string,
  type: BookType,
): Promise<{ book: Book; byName: (name: string) => string }> {
  const book: Book = { id: genId(), name, type, archived: false };
  await repo.addBook(book);
  const chart = defaultChartFor(type, book.id, genId);
  for (const a of chart) await repo.addAccount(a);
  const byName = (n: string): string => {
    const hit = chart.find((a) => a.name === n);
    if (!hit) throw new Error(`默认科目缺失：${n}`);
    return hit.id;
  };
  return { book, byName };
}

/**
 * 模块级单例：StrictMode 双调 effect 也只 bootstrap 一次。
 * 桌面（Tauri）→ 本地 SQLite 持久化；浏览器 → 内存仓库 + 多账本样本数据演示。
 */
export const ready: Promise<Repository> = isDesktop ? bootstrapDesktop() : bootstrapDemo();

/** 桌面：本地 SQLite（load 时自动迁移；遗留数据已回填 default 账本）。无账本时创建首个个人账本。 */
async function bootstrapDesktop(): Promise<Repository> {
  const { TauriSqlRepository } = await import('@app/store/tauri');
  const repo = await TauriSqlRepository.load('sqlite:heng.db');
  const books = await repo.listBooks({ includeArchived: true });
  if (books.length === 0) {
    await createBookWithChart(repo, '我的账本', 'personal');
  }
  return repo;
}

/** 浏览器演示：内存仓库 + 4 个账本的样本数据（刷新即重置）。 */
async function bootstrapDemo(): Promise<Repository> {
  const repo = new InMemoryRepository();

  const opening = async (
    bookId: string,
    byName: (n: string) => string,
    accountName: string,
    amountYuan: number,
  ): Promise<void> => {
    await repo.addTransaction(
      adjustBalanceEntry(
        {
          bookId,
          date: daysAgo(40),
          accountId: byName(accountName),
          currentBalance: 0,
          targetValue: toMinor(amountYuan),
          counterAccountId: byName('期初余额'),
          note: '期初余额',
        },
        genId,
      ),
    );
  };

  // —— 我的日常（个人）
  const me = await createBookWithChart(repo, '我的日常', 'personal');
  await opening(me.book.id, me.byName, '银行卡', 20000);
  await opening(me.book.id, me.byName, '支付宝', 3000);
  await opening(me.book.id, me.byName, '微信钱包', 300);
  await opening(me.book.id, me.byName, '现金', 500);
  const meEntries: EntryInput[] = [
    { kind: 'income', bookId: me.book.id, date: daysAgo(9), amount: toMinor(12000), accountId: me.byName('银行卡'), categoryId: me.byName('工资'), payee: '工资' },
    { kind: 'expense', bookId: me.book.id, date: daysAgo(8), amount: toMinor(36.5), accountId: me.byName('微信钱包'), categoryId: me.byName('餐饮'), payee: '午餐' },
    { kind: 'expense', bookId: me.book.id, date: daysAgo(6), amount: toMinor(28), accountId: me.byName('支付宝'), categoryId: me.byName('交通'), payee: '打车' },
    { kind: 'expense', bookId: me.book.id, date: daysAgo(5), amount: toMinor(326), accountId: me.byName('信用卡'), categoryId: me.byName('购物'), payee: '超市采购' },
    { kind: 'expense', bookId: me.book.id, date: daysAgo(2), amount: toMinor(88), accountId: me.byName('银行卡'), categoryId: me.byName('娱乐'), payee: '电影' },
    { kind: 'expense', bookId: me.book.id, date: daysAgo(1), amount: toMinor(45.8), accountId: me.byName('微信钱包'), categoryId: me.byName('餐饮'), payee: '晚餐' },
  ];
  for (const e of meEntries) await repo.addTransaction(expandEntry(e, genId));
  await repo.addBudget({ id: genId(), bookId: me.book.id, accountId: me.byName('餐饮'), monthlyLimit: toMinor(1000) });
  await repo.addBudget({ id: genId(), bookId: me.book.id, accountId: me.byName('交通'), monthlyLimit: toMinor(300) });
  await repo.addBudget({ id: genId(), bookId: me.book.id, accountId: me.byName('购物'), monthlyLimit: toMinor(300) });
  // 多币种演示：开关打开（默认关）+ 自定义币种注册表（美元 2 位 / 比特币 8 位）+ 两个外币账户
  await repo.setSetting('app', 'multiCurrency', 'on');
  await repo.setSetting(
    'app',
    'currencies',
    JSON.stringify([
      { code: 'USD', symbol: '$', name: '美元', decimals: 2, rate: 7.1 },
      { code: 'BTC', symbol: '₿', name: '比特币', decimals: 8, rate: 400000 },
    ]),
  );
  const usdId = genId();
  await repo.addAccount({ id: usdId, bookId: me.book.id, name: '美元储蓄', type: 'asset', parentId: null, currency: 'USD', archived: false });
  await repo.addTransaction(
    adjustBalanceEntry(
      { bookId: me.book.id, date: daysAgo(40), accountId: usdId, currentBalance: 0, targetValue: toMinor(2000), counterAccountId: me.byName('期初余额'), currency: 'USD', note: '期初余额' },
      genId,
    ),
  );
  const btcId = genId();
  await repo.addAccount({ id: btcId, bookId: me.book.id, name: '比特币钱包', type: 'asset', parentId: null, currency: 'BTC', archived: false });
  await repo.addTransaction(
    adjustBalanceEntry(
      { bookId: me.book.id, date: daysAgo(40), accountId: btcId, currentBalance: 0, targetValue: toMinor(0.05, 8), counterAccountId: me.byName('期初余额'), currency: 'BTC', note: '期初余额' },
      genId,
    ),
  );

  // —— 妻子的账本（个人 #2，演示同类型多账本）
  const wife = await createBookWithChart(repo, '妻子的账本', 'personal');
  await opening(wife.book.id, wife.byName, '银行卡', 8000);
  await opening(wife.book.id, wife.byName, '支付宝', 600);
  const wifeEntries: EntryInput[] = [
    { kind: 'income', bookId: wife.book.id, date: daysAgo(9), amount: toMinor(6800), accountId: wife.byName('银行卡'), categoryId: wife.byName('工资'), payee: '工资' },
    { kind: 'expense', bookId: wife.book.id, date: daysAgo(3), amount: toMinor(420), accountId: wife.byName('支付宝'), categoryId: wife.byName('购物'), payee: '护肤品' },
    { kind: 'expense', bookId: wife.book.id, date: daysAgo(5), amount: toMinor(980), accountId: wife.byName('银行卡'), categoryId: wife.byName('娱乐'), payee: '瑜伽课包' },
  ];
  for (const e of wifeEntries) await repo.addTransaction(expandEntry(e, genId));

  // —— 外贸小生意（生意）
  const biz = await createBookWithChart(repo, '外贸小生意', 'business');
  await opening(biz.book.id, biz.byName, '对公账户', 30000);
  const bizEntries: EntryInput[] = [
    { kind: 'income', bookId: biz.book.id, date: daysAgo(4), amount: toMinor(2000), accountId: biz.byName('微信商户'), categoryId: biz.byName('营业收入'), payee: '客户收款' },
    { kind: 'expense', bookId: biz.book.id, date: daysAgo(3), amount: toMinor(800), accountId: biz.byName('对公账户'), categoryId: biz.byName('进货成本'), payee: '进货' },
    { kind: 'expense', bookId: biz.book.id, date: daysAgo(2), amount: toMinor(120), accountId: biz.byName('对公账户'), categoryId: biz.byName('运费杂费'), payee: '快递费' },
  ];
  for (const e of bizEntries) await repo.addTransaction(expandEntry(e, genId));
  await repo.addProduct({ id: genId(), bookId: biz.book.id, name: 'A型工具', costPrice: toMinor(80), salePrice: toMinor(125), isStock: true, unit: '个', archived: false });
  await repo.addProduct({ id: genId(), bookId: biz.book.id, name: 'B型配件', costPrice: toMinor(20), salePrice: toMinor(50), isStock: true, unit: '个', archived: false });
  // 一笔已完成但未收款的赊销——让「记账口径」切换在演示版可见：
  // 权责发生制本月收入含这 ¥1250，收付实现制不含（钱还没到账）。
  const custId = genId();
  await repo.addCustomer({ id: custId, bookId: biz.book.id, name: '老客户', phone: '', note: '', dueDays: 30, archived: false });
  const arSubId = genId();
  await repo.addAccount({ id: arSubId, bookId: biz.book.id, name: '应收账款/老客户', type: 'asset', parentId: biz.byName('应收账款'), currency: 'CNY', archived: false });
  const orderId = genId();
  const lines = [{ id: genId(), orderId, name: 'A型工具', qty: 10, unitPrice: toMinor(125), productId: null }];
  await repo.addOrder({ id: orderId, bookId: biz.book.id, customerId: custId, date: daysAgo(2), status: 'pending_ship', note: '赊销一批', revenueTxnId: null, lines });
  const rev = orderRevenueEntry(
    { bookId: biz.book.id, date: daysAgo(2), amount: orderTotal(lines), receivableAccountId: arSubId, revenueAccountId: biz.byName('营业收入'), payee: '老客户', note: '赊销一批' },
    genId,
  );
  await repo.addTransaction(rev);
  await repo.updateOrder(orderId, { status: 'completed', revenueTxnId: rev.id });

  // —— 投资组合（投资）
  const inv = await createBookWithChart(repo, '投资组合', 'investment');
  await opening(inv.book.id, inv.byName, '投资账户', 5000);
  await repo.addTransaction(
    adjustBalanceEntry(
      {
        bookId: inv.book.id,
        date: daysAgo(1),
        accountId: inv.byName('投资账户'),
        currentBalance: toMinor(5000),
        targetValue: toMinor(5230),
        counterAccountId: inv.byName('投资盈亏'),
        note: '更新投资现值',
      },
      genId,
    ),
  );

  return repo;
}

/** 账本类型的展示元信息 */
export const BOOK_META: Record<BookType, { emoji: string; label: string; cls: string }> = {
  personal: { emoji: '👤', label: '个人', cls: 't-p' },
  business: { emoji: '💼', label: '生意', cls: 't-b' },
  investment: { emoji: '📈', label: '投资', cls: 't-i' },
};
