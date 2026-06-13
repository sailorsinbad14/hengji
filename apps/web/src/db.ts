import { adjustBalanceEntry, creditPurchaseEntry, currentAvgCost, defaultChartFor, expandEntry, orderRevenueEntry, orderTotal, toMinor } from '@app/core';
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
  const prodA = genId();
  const prodB = genId();
  await repo.addProduct({ id: prodA, bookId: biz.book.id, name: 'A型工具', costPrice: toMinor(80), salePrice: toMinor(125), quoteOnly: false, unit: '个', archived: false });
  await repo.addProduct({ id: prodB, bookId: biz.book.id, name: 'B型配件', costPrice: toMinor(20), salePrice: toMinor(50), quoteOnly: false, unit: '个', archived: false });
  // 纯报价/服务（C2 模型重构）：设计费——不做库存、不进成本，开单可单列一行。
  await repo.addProduct({ id: genId(), bookId: biz.book.id, name: '设计费', costPrice: 0, salePrice: toMinor(500), quoteOnly: true, unit: '次', archived: false });
  // 库存（C2）：给两个库存品补货，展示在手/移动加权均价/库存值。库存商品 CNY 本位，钱从对公账户付。
  const invAcctId = genId();
  await repo.addAccount({ id: invAcctId, bookId: biz.book.id, name: '库存商品', type: 'asset', parentId: null, currency: 'CNY', archived: false });
  const stockIn = async (productId: string, qty: number, costYuan: number, date: string): Promise<void> => {
    const e = expandEntry(
      { kind: 'transfer', bookId: biz.book.id, date, amount: Math.round(qty * toMinor(costYuan)), currency: 'CNY', fromAccountId: biz.byName('对公账户'), toAccountId: invAcctId, payee: '进货', note: '补货' },
      genId,
    );
    await repo.addTransaction(e);
    await repo.addInventoryMovement({ id: genId(), bookId: biz.book.id, productId, date, kind: 'in', qty, unitCost: toMinor(costYuan), orderId: null, txnId: e.id, note: '补货' });
  };
  await stockIn(prodA, 30, 80, daysAgo(15)); // A型工具 30 @ ¥80
  await stockIn(prodA, 10, 90, daysAgo(8)); // 再补 10 @ ¥90 → 移动加权均价 ¥82.5
  await stockIn(prodB, 50, 20, daysAgo(15)); // B型配件 50 @ ¥20
  // 赊购入库（C2 应付）——展示「供应商 + 应付账款」：五金批发商账期30天，赊账进 B型配件 30 @ ¥18 = ¥540 应付。
  const supId = genId();
  await repo.addSupplier({ id: supId, bookId: biz.book.id, name: '五金批发商', phone: '', note: '', dueDays: 30, archived: false });
  const apParentId = genId();
  await repo.addAccount({ id: apParentId, bookId: biz.book.id, name: '应付账款', type: 'liability', parentId: null, currency: 'CNY', archived: false });
  const apSubId = genId();
  await repo.addAccount({ id: apSubId, bookId: biz.book.id, name: '应付账款/五金批发商', type: 'liability', parentId: apParentId, currency: 'CNY', archived: false });
  const apBuy = creditPurchaseEntry(
    { bookId: biz.book.id, date: daysAgo(10), amount: Math.round(30 * toMinor(18)), payableAccountId: apSubId, inventoryAccountId: invAcctId, payee: '五金批发商', note: '赊购B型配件' },
    genId,
  );
  await repo.addTransaction(apBuy);
  await repo.addInventoryMovement({ id: genId(), bookId: biz.book.id, productId: prodB, date: daysAgo(10), kind: 'in', qty: 30, unitCost: toMinor(18), orderId: null, txnId: apBuy.id, note: '赊购' });
  // 一笔逾期应付——展示「应付账龄分桶 + 应付到期提醒」：包装供应商账期7天，40天前赊购包材未付 → 逾期、落 31–60 桶。
  const sup2Id = genId();
  await repo.addSupplier({ id: sup2Id, bookId: biz.book.id, name: '包装供应商', phone: '', note: '', dueDays: 7, archived: false });
  const ap2SubId = genId();
  await repo.addAccount({ id: ap2SubId, bookId: biz.book.id, name: '应付账款/包装供应商', type: 'liability', parentId: apParentId, currency: 'CNY', archived: false });
  const ap2Buy = expandEntry(
    { kind: 'expense', bookId: biz.book.id, date: daysAgo(40), amount: toMinor(800), currency: 'CNY', accountId: ap2SubId, categoryId: biz.byName('运费杂费'), payee: '包装供应商', note: '赊购包材' },
    genId,
  );
  await repo.addTransaction(ap2Buy);
  // 营业成本科目 + 出库结转助手（订单完成时库存品按出库时点均价结转 COGS + 记 out 流水）
  const cogsAcctId = genId();
  await repo.addAccount({ id: cogsAcctId, bookId: biz.book.id, name: '营业成本', type: 'expense', parentId: null, currency: 'CNY', archived: false });
  const issueStock = async (orderId: string, productId: string, qty: number, date: string): Promise<void> => {
    const avg = currentAvgCost(await repo.listInventoryMovements({ bookId: biz.book.id, productId }));
    const e = expandEntry(
      { kind: 'expense', bookId: biz.book.id, date, amount: Math.round(qty * avg), currency: 'CNY', accountId: invAcctId, categoryId: cogsAcctId, payee: '', note: '成本结转' },
      genId,
    );
    await repo.addTransaction(e);
    await repo.addInventoryMovement({ id: genId(), bookId: biz.book.id, productId, date, kind: 'out', qty: -qty, unitCost: avg, orderId, txnId: e.id, note: '' });
  };
  // 一笔已完成但未收款的赊销——让「记账口径」切换在演示版可见：
  // 权责发生制本月收入含这 ¥1250，收付实现制不含（钱还没到账）。
  const custId = genId();
  await repo.addCustomer({ id: custId, bookId: biz.book.id, name: '老客户', phone: '', note: '', dueDays: 30, archived: false });
  const arSubId = genId();
  await repo.addAccount({ id: arSubId, bookId: biz.book.id, name: '应收账款/老客户', type: 'asset', parentId: biz.byName('应收账款'), currency: 'CNY', archived: false });
  const orderId = genId();
  const lines = [{ id: genId(), orderId, name: 'A型工具', qty: 10, unitPrice: toMinor(125), productId: prodA }];
  await repo.addOrder({ id: orderId, bookId: biz.book.id, customerId: custId, date: daysAgo(2), currency: 'CNY', status: 'pending_ship', note: '赊销一批', revenueTxnId: null, lines });
  const rev = orderRevenueEntry(
    { bookId: biz.book.id, date: daysAgo(2), amount: orderTotal(lines), receivableAccountId: arSubId, revenueAccountId: biz.byName('营业收入'), payee: '老客户', note: '赊销一批' },
    genId,
  );
  await repo.addTransaction(rev);
  await issueStock(orderId, prodA, 10, daysAgo(2)); // 出库 10 个 A型工具，结转 COGS（毛利 ¥1250−¥825=¥425）
  await repo.updateOrder(orderId, { status: 'completed', revenueTxnId: rev.id });

  // 一张「待采购」订单（C2 模型重构）——展示「不足自动采购」流程：定制礼盒在手 0，开单即生成待采购草稿单。
  const prodDrop = genId();
  await repo.addProduct({ id: prodDrop, bookId: biz.book.id, name: '定制礼盒', costPrice: toMinor(60), salePrice: toMinor(150), quoteOnly: false, unit: '个', archived: false });
  const dropOrderId = genId();
  await repo.addOrder({
    id: dropOrderId, bookId: biz.book.id, customerId: custId, date: daysAgo(1), currency: 'CNY', status: 'pending_purchase',
    note: '待采购礼盒', revenueTxnId: null,
    lines: [{ id: genId(), orderId: dropOrderId, name: '定制礼盒', qty: 10, unitPrice: toMinor(150), productId: prodDrop }],
  });
  // 开单时在手 0 → 自动生成草稿采购单（缺 10 个，单价预填进价 ¥60，无供应商/未记账，待「为此单采购」确认）
  const dropPurId = genId();
  await repo.addPurchase({
    id: dropPurId, bookId: biz.book.id, supplierId: '', orderId: dropOrderId, date: daysAgo(1), payMode: 'credit', note: '', txnId: null,
    lines: [{ id: genId(), purchaseId: dropPurId, name: '定制礼盒', qty: 10, unitCost: toMinor(60), productId: prodDrop }],
  });

  // 一张美元订单——展示「业务 AR 多币种」：海外客户赊购 $1,800，应收记 USD 子科目，
  // 可在订单页用美元账户收款。子科目名与 biz.arName('海外客户','USD') 一致，便于后续 UI 收款匹配。
  await repo.addAccount({ id: genId(), bookId: biz.book.id, name: '美元账户', type: 'asset', parentId: null, currency: 'USD', archived: false });
  const usdCustId = genId();
  await repo.addCustomer({ id: usdCustId, bookId: biz.book.id, name: '海外客户', phone: '', note: '', dueDays: 45, archived: false });
  const usdArId = genId();
  await repo.addAccount({ id: usdArId, bookId: biz.book.id, name: '应收账款/海外客户 (USD)', type: 'asset', parentId: biz.byName('应收账款'), currency: 'USD', archived: false });
  const usdOrderId = genId();
  const usdLines = [{ id: genId(), orderId: usdOrderId, name: 'A型工具', qty: 20, unitPrice: toMinor(90), productId: prodA }];
  await repo.addOrder({ id: usdOrderId, bookId: biz.book.id, customerId: usdCustId, date: daysAgo(3), currency: 'USD', status: 'pending_ship', note: '外贸订单', revenueTxnId: null, lines: usdLines });
  const usdRev = orderRevenueEntry(
    { bookId: biz.book.id, date: daysAgo(3), amount: orderTotal(usdLines), currency: 'USD', receivableAccountId: usdArId, revenueAccountId: biz.byName('营业收入'), payee: '海外客户', note: '外贸订单' },
    genId,
  );
  await repo.addTransaction(usdRev);
  await issueStock(usdOrderId, prodA, 20, daysAgo(3)); // 出库 20 个，COGS ¥1650（毛利 $1800 折 ¥12780 − ¥1650 = ¥11130）
  await repo.updateOrder(usdOrderId, { status: 'completed', revenueTxnId: usdRev.id });

  // 一笔已逾期的赊销——展示「应收账龄分桶 + 到期提醒横幅」：建材批发账期 15 天，下单 50 天前仍未收 → 逾期、落 31–60 桶。
  const odCustId = genId();
  await repo.addCustomer({ id: odCustId, bookId: biz.book.id, name: '建材批发', phone: '', note: '', dueDays: 15, archived: false });
  const odArId = genId();
  await repo.addAccount({ id: odArId, bookId: biz.book.id, name: '应收账款/建材批发', type: 'asset', parentId: biz.byName('应收账款'), currency: 'CNY', archived: false });
  const odOrderId = genId();
  const odLines = [{ id: genId(), orderId: odOrderId, name: '钢材一批', qty: 1, unitPrice: toMinor(3200), productId: null }];
  await repo.addOrder({ id: odOrderId, bookId: biz.book.id, customerId: odCustId, date: daysAgo(50), currency: 'CNY', status: 'pending_ship', note: '欠款未付', revenueTxnId: null, lines: odLines });
  const odRev = orderRevenueEntry(
    { bookId: biz.book.id, date: daysAgo(50), amount: orderTotal(odLines), receivableAccountId: odArId, revenueAccountId: biz.byName('营业收入'), payee: '建材批发', note: '欠款未付' },
    genId,
  );
  await repo.addTransaction(odRev);
  await repo.updateOrder(odOrderId, { status: 'completed', revenueTxnId: odRev.id });

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
  // 美股账户（美元）——展示「投资盈亏跨币聚合」：$1,000 → $1,100，浮盈 $100（USD）。
  // 累计盈亏 = ¥230 + $100 折合，证明跨币种 PnL 折算后相加。
  const usStockId = genId();
  await repo.addAccount({ id: usStockId, bookId: inv.book.id, name: '美股账户', type: 'asset', parentId: null, currency: 'USD', archived: false });
  await repo.addTransaction(
    adjustBalanceEntry(
      { bookId: inv.book.id, date: daysAgo(20), accountId: usStockId, currentBalance: 0, targetValue: toMinor(1000), counterAccountId: inv.byName('期初余额'), currency: 'USD', note: '期初余额' },
      genId,
    ),
  );
  await repo.addTransaction(
    adjustBalanceEntry(
      { bookId: inv.book.id, date: daysAgo(1), accountId: usStockId, currentBalance: toMinor(1000), targetValue: toMinor(1100), counterAccountId: inv.byName('投资盈亏'), currency: 'USD', note: '更新投资现值' },
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
