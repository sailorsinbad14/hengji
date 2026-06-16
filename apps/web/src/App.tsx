import { useEffect, useMemo, useState } from 'react';
import { accountBalance, convertAmount, outstandingCharges, unclearedCount } from '@app/core';
import type { AccountingBasis, BookType, ConvertCtx } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredBudget, StoredCustomer, StoredFeeDefinition, StoredOrder, StoredSetting, StoredSettlement, StoredSupplier, StoredTransaction } from '@app/store';
import { BOOK_META, createBookWithChart, demoRepoOnce, isDesktop, openDesktopRepoOnce, resetDesktopRepo } from './db';
import { daysBetween, fmtMoney, setCurrencyRegistry, todayISO } from './format';
import { customerOrderStatus, payableLedger } from './biz';
import { advancedOn, autoLockMinOf, basisOf, convertCtxOf, currenciesOf, dueLeadOf, multiCurrencyOn, reconcileDayOf, reconcileLeadOf, reconcileTargetDate, reconcileWindowOpen } from './settings';
import { lock as lockDb, securityStatus } from '@app/store/crypto';
import UnlockScreen from './components/UnlockScreen';
import OverviewAll from './views/OverviewAll';
import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Budgets from './views/Budgets';
import Invest from './views/Invest';
import Accounts from './views/Accounts';
import Customers from './views/Customers';
import Suppliers from './views/Suppliers';
import Orders from './views/Orders';
import Products from './views/Products';
import Inventory from './views/Inventory';
import Purchases from './views/Purchases';
import FeeDefinitions from './views/FeeDefinitions';
import Reconcile from './views/Reconcile';
import Settings from './views/Settings';

type View = 'dashboard' | 'txns' | 'budgets' | 'invest' | 'accounts' | 'reconcile' | 'customers' | 'suppliers' | 'orders' | 'products' | 'inventory' | 'purchases' | 'fees' | 'documents';
/** 顶层导航：财务总表 / 全局设置 / 某账本 id。 */
const OVERVIEW = 'all';
const SETTINGS = '__settings__';
const RECONCILE = '__reconcile__';

export interface AppData {
  repo: Repository;
  /** 当前账本（已选定时） */
  book: StoredBook;
  /** 当前账本可见账户：本账本专属 + 全部全局账户（记账下拉/账户页用） */
  accounts: StoredAccount[];
  /** 本账本交易（损益/最近交易/账本专属账户余额用） */
  txns: StoredTransaction[];
  /** 全部账本交易（全局账户余额跨账本聚合用——全局账户的流水散落多账本） */
  allTxns: StoredTransaction[];
  budgets: StoredBudget[];
  /** 全局记账口径（对所有账本生效） */
  basis: AccountingBasis;
  /** 多币种折算上下文（展示币种 + 汇率表，app 级全局） */
  convert: ConvertCtx;
  /** 多币种开关（关时隐藏账户币种选择等） */
  mcEnabled: boolean;
  reload: () => Promise<void>;
}

const TABS: Record<BookType, Array<[View, string]>> = {
  personal: [
    ['dashboard', '总览'],
    ['txns', '流水'],
    ['budgets', '预算'],
    ['accounts', '账户'],
  ],
  business: [
    ['dashboard', '总览'],
    ['orders', '订单'],
    ['customers', '客户'],
    ['suppliers', '供应商'],
    ['products', '商品'],
    ['inventory', '库存'],
    ['purchases', '采购'],
    ['fees', '费用'],
    ['txns', '流水'],
    ['budgets', '预算'],
    ['accounts', '账户'],
  ],
  investment: [
    ['invest', '投资'],
    ['txns', '流水'],
    ['accounts', '账户'],
  ],
};

// 极简模式（默认）下的生意账本 tab：跟个人账本几乎一样，隐藏进销存/采购/费用等专业功能。
// 需要的用户在「设置 → 开启商家进阶功能」后看到完整 TABS.business。
const SIMPLE_BUSINESS_TABS: Array<[View, string]> = [
  ['dashboard', '总览'],
  ['txns', '流水'],
  ['budgets', '预算'],
  ['accounts', '账户'],
];

export default function App() {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [allBooks, setAllBooks] = useState<StoredBook[]>([]); // 含归档（活跃账本由下方 books 派生）
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [txns, setTxns] = useState<StoredTransaction[]>([]);
  const [budgets, setBudgets] = useState<StoredBudget[]>([]);
  const [settings, setSettings] = useState<StoredSetting[]>([]);
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [customers, setCustomers] = useState<StoredCustomer[]>([]);
  const [suppliers, setSuppliers] = useState<StoredSupplier[]>([]);
  const [settlements, setSettlements] = useState<StoredSettlement[]>([]);
  const [feeDefs, setFeeDefs] = useState<StoredFeeDefinition[]>([]);
  const [cur, setCur] = useState<'all' | string>('all');
  const [view, setView] = useState<View>('dashboard');
  const [creating, setCreating] = useState(false);
  const [nbName, setNbName] = useState('');
  const [nbType, setNbType] = useState<BookType>('personal');
  const [reconDismissed, setReconDismissed] = useState<Set<string>>(new Set());
  const [dueDismissed, setDueDismissed] = useState<Set<string>>(new Set());
  const [apDueDismissed, setApDueDismissed] = useState<Set<string>>(new Set());
  // 启动门（桌面加密）：'loading' 探测中 / 'locked' 显解锁屏 / 'open' 已开库。浏览器演示恒 'open'。
  const [gate, setGate] = useState<'loading' | 'locked' | 'open'>('loading');
  const [encrypted, setEncrypted] = useState(false);

  async function loadFrom(r: Repository): Promise<void> {
    const [bk, a, t, b, s, os, cs, st, sup, fd] = await Promise.all([
      r.listBooks({ includeArchived: true }),
      r.listAccounts(),
      r.listTransactions(),
      r.listBudgets(),
      r.listSettings(),
      r.listOrders(),
      r.listCustomers({ includeArchived: true }),
      r.listSettlements(),
      r.listSuppliers({ includeArchived: true }),
      r.listFeeDefinitions({ includeArchived: true }),
    ]);
    setCurrencyRegistry(currenciesOf(s)); // 注入币种注册表，供 fmtMoney 等取符号/小数位
    setAllBooks(bk);
    setAccounts(a);
    setTxns(t);
    setBudgets(b);
    setSettings(s);
    setOrders(os);
    setCustomers(cs);
    setSettlements(st);
    setSuppliers(sup);
    setFeeDefs(fd);
  }

  // 启动门：浏览器→直接开演示库；桌面→先查加密状态，未加密直接开，已加密则渲染解锁屏（开库前）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isDesktop) {
        const r = await demoRepoOnce();
        if (cancelled) return;
        await loadFrom(r);
        setRepo(r);
        setGate('open');
        return;
      }
      const st = await securityStatus();
      if (cancelled) return;
      setEncrypted(st.encrypted);
      if (st.encrypted) {
        setGate('locked'); // 显解锁屏，待 unlock 成功再开库（见 openAfterUnlock）
        return;
      }
      const r = await openDesktopRepoOnce(false);
      if (cancelled) return;
      await loadFrom(r);
      setRepo(r);
      setGate('open');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 解锁成功（DEK 已在 Rust 侧）后开密文库进入主界面。
  async function openAfterUnlock(): Promise<void> {
    const r = await openDesktopRepoOnce(true);
    await loadFrom(r);
    setRepo(r);
    setGate('open');
  }

  // 设/移除密码后刷新加密态（驱动自动锁开关 + 状态显示）。
  function refreshSecurity(): void {
    void securityStatus().then((s) => setEncrypted(s.encrypted));
  }

  // 自动锁（仅桌面已加密且开启时）：无操作达时长 → 锁定（清 DEK + 关库）→ 回解锁屏。
  useEffect(() => {
    if (gate !== 'open' || !encrypted) return;
    const mins = autoLockMinOf(settings);
    if (mins <= 0) return;
    const ms = mins * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    let lastActivity = Date.now();
    const doLock = (): void => {
      void lockDb().finally(() => {
        // lockDb 是异步 IPC：往返期间若有新活动，取消锁定、重启计时，遵守「无操作达时长才锁」。
        if (Date.now() - lastActivity < ms) {
          reset();
          return;
        }
        resetDesktopRepo();
        setRepo(null);
        setGate('locked');
      });
    };
    const reset = (): void => {
      lastActivity = Date.now();
      clearTimeout(timer);
      timer = setTimeout(doLock, ms);
    };
    const evts: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    evts.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      evts.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [gate, encrypted, settings]);

  // 归档账本只置 book.archived，其账户/流水仍 live（listAccounts/listTransactions 不按账本归档过滤）→
  // 聚合须按「未归档账本」收窄：归档账本的【账本专属】账户隐藏；但【全局账户】是跨账本共享、home 仅创建元数据，
  // home 账本被归档仍保留（否则共享的真金白银账户会从其它账本蒸发）。books=活跃账本；allBooks 供 Reconcile 查归档名。
  const books = useMemo(() => allBooks.filter((b) => !b.archived), [allBooks]);
  const visible = useMemo(() => new Set(books.map((b) => b.id)), [books]);
  const liveAccounts = useMemo(() => accounts.filter((a) => a.global || visible.has(a.bookId)), [accounts, visible]);

  const curBook = useMemo(() => books.find((b) => b.id === cur) ?? null, [books, cur]);
  const scoped = useMemo(
    () => ({
      // 全局账户对所有账本可见；本账本专属账户按 bookId（均已剔除归档账本的账户/孤儿全局账户）
      accounts: liveAccounts.filter((a) => a.global || a.bookId === cur),
      txns: txns.filter((t) => t.bookId === cur),
      budgets: budgets.filter((b) => b.bookId === cur),
    }),
    [liveAccounts, txns, budgets, cur],
  );

  // 多币种生效值：开关开 **或** 持有任一外币账户（liveAccounts 已排除归档账户 + 归档账本的账户）。
  // 持有外币数据时强制视为开启——否则「关却仍显示外币」自相矛盾；归档所有外币账户/账本后即可切回纯人民币。
  const mcEnabled = multiCurrencyOn(settings) || liveAccounts.some((a) => a.currency !== 'CNY');

  // 全局设置（app 级，对所有账本生效）；在任何提前 return 之前调用，保证 Hook 顺序稳定。
  const convert = useMemo(() => convertCtxOf(settings, mcEnabled), [settings, mcEnabled]);
  const basis = useMemo(() => basisOf(settings), [settings]);
  // 商家进阶功能开关（默认关＝极简）：门控生意账本专业 tab、对账入口、投资账本类型、专业提醒横幅。
  const advanced = advancedOn(settings);

  // 对账提醒：全局配置对账日 + 进入提前窗口 + 当前账本仍有未核销分录（已对账则不扰）。
  const reconReminder = useMemo(() => {
    if (!curBook) return null;
    const day = reconcileDayOf(settings);
    if (!day || !reconcileWindowOpen(new Date(), day, reconcileLeadOf(settings))) return null;
    const hasPending = scoped.accounts
      .filter((a) => (a.type === 'asset' || a.type === 'liability') && !a.global) // 全局账户对账在全局入口（Phase 4）
      .some((a) => unclearedCount(scoped.txns, a.id) > 0);
    return hasPending ? reconcileTargetDate(new Date(), day) : null;
  }, [curBook, settings, scoped.accounts, scoped.txns]);

  // 应收到期提醒（仅生意账本）：有未收清订单临近到期（距到期 ≤ 提前天数，含已逾期）即提醒去收款。
  const dueReminder = useMemo(() => {
    if (!curBook || curBook.type !== 'business') return null;
    const lead = dueLeadOf(settings);
    if (lead === null) return null;
    const { outstanding } = customerOrderStatus(
      orders.filter((o) => o.bookId === curBook.id),
      customers.filter((c) => c.bookId === curBook.id),
      settlements.filter((s) => s.bookId === curBook.id),
      todayISO(),
      feeDefs.filter((f) => f.bookId === curBook.id),
    );
    const due = outstanding.filter((o) => o.daysToDue !== null && o.daysToDue <= lead);
    if (due.length === 0) return null;
    return {
      count: due.length,
      overdueCount: due.filter((o) => o.overdue).length,
      total: due.reduce((s, o) => s + convertAmount(o.owed, o.order.currency, convert), 0),
    };
  }, [curBook, settings, orders, customers, settlements, feeDefs, convert]);

  // 应付到期提醒（仅生意账本，复用同一提前天数设置）：供应商赊购临近到期（购货日 + 账期），含已逾期。
  const apDueReminder = useMemo(() => {
    if (!curBook || curBook.type !== 'business') return null;
    const lead = dueLeadOf(settings);
    if (lead === null) return null;
    const today = todayISO();
    let count = 0;
    let overdueCount = 0;
    let total = 0;
    for (const sup of suppliers) {
      if (sup.bookId !== curBook.id || sup.dueDays <= 0) continue; // 现款现货（dueDays=0）不追踪到期
      const { charges, paid } = payableLedger(scoped.accounts, scoped.txns, sup.name);
      for (const c of outstandingCharges(charges, paid)) {
        const days = daysBetween(c.date, today);
        const daysToDue = sup.dueDays - days;
        if (daysToDue <= lead) {
          count++;
          if (days > sup.dueDays) overdueCount++;
          total += convertAmount(c.amount, 'CNY', convert);
        }
      }
    }
    return count > 0 ? { count, overdueCount, total } : null;
  }, [curBook, settings, suppliers, scoped.accounts, scoped.txns, convert]);

  if (gate === 'locked') return <UnlockScreen onUnlocked={openAfterUnlock} />;
  if (!repo) return <div className="splash">账本加载中…</div>;

  function openBook(id: 'all' | string, type?: BookType): void {
    setCur(id);
    const t = type ?? books.find((x) => x.id === id)?.type;
    setView(t === 'investment' ? 'invest' : 'dashboard');
  }

  async function createBook(): Promise<void> {
    const name = nbName.trim();
    if (!name || !repo) return;
    const { book } = await createBookWithChart(repo, name, nbType);
    await loadFrom(repo);
    setCreating(false);
    setNbName('');
    // books state 此刻尚未更新，类型直接随创建参数传入
    openBook(book.id, nbType);
  }

  async function archiveBook(): Promise<void> {
    if (!repo || !curBook) return;
    if (!confirm(`归档「${curBook.name}」？账本会从列表隐藏，数据保留且总表不再计入。`)) return;
    await repo.updateBook(curBook.id, { archived: true });
    await loadFrom(repo);
    openBook('all');
  }

  const data: AppData | null = curBook
    ? { repo, book: curBook, ...scoped, allTxns: txns, basis, convert, mcEnabled, reload: () => loadFrom(repo) }
    : null;
  // 极简模式下生意账本只显示精简 tab；个人/投资账本本就简单，不变。
  const tabs = curBook ? (curBook.type === 'business' && !advanced ? SIMPLE_BUSINESS_TABS : TABS[curBook.type]) : [];
  // 提醒横幅（对账 / 往来到期）属进阶功能，极简模式下不弹（也没有对应 tab 可去）。
  const showReminder = advanced && reconReminder && curBook && !reconDismissed.has(curBook.id);
  const showDueReminder = advanced && dueReminder && curBook && !dueDismissed.has(curBook.id);
  const showApDueReminder = advanced && apDueReminder && curBook && !apDueDismissed.has(curBook.id);

  return (
    <div className="app">
      <aside className="side">
        <div className="s-brand">
          <span className="mark">衡</span> 衡记
        </div>

        <div className="s-label">账本</div>
        <button className={`book${cur === 'all' ? ' on' : ''}`} onClick={() => openBook('all')}>
          🧮 财务总表
        </button>
        {books.map((b) => (
          <button key={b.id} className={`book${cur === b.id ? ' on' : ''}`} onClick={() => openBook(b.id)}>
            {BOOK_META[b.type].emoji} {b.name}
            <span className={`bk-type ${BOOK_META[b.type].cls}`}>{BOOK_META[b.type].label}</span>
          </button>
        ))}
        {!creating ? (
          <button className="book add" onClick={() => setCreating(true)}>
            ＋ 新建账本
          </button>
        ) : (
          <div className="nb-form">
            <input
              placeholder="账本名称"
              value={nbName}
              onChange={(e) => setNbName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createBook();
              }}
            />
            <select value={nbType} onChange={(e) => setNbType(e.target.value as BookType)}>
              <option value="personal">个人</option>
              <option value="business">生意</option>
              {advanced && <option value="investment">投资</option>}
            </select>
            <div className="nb-actions">
              <button className="btn btn-primary nb-btn" onClick={() => void createBook()}>
                创建
              </button>
              <button className="nb-cancel" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {curBook && (
          <>
            <div className="s-label">本账本账户</div>
            {scoped.accounts
              .filter((a) => a.type === 'asset' || a.type === 'liability')
              .map((a) => {
                // 全局账户余额跨账本聚合（流水散落多账本）→ 用全量 txns；账本专属账户仅本账本流水触及，结果一致
                const bal = accountBalance(txns, a.id);
                return (
                  <div className="acct" key={a.id}>
                    <span className="nm">
                      {a.name}
                      {a.global && <span className="chip"> 全局</span>}
                    </span>
                    <span className={`bal${bal < 0 ? ' neg' : ''}`}>{fmtMoney(bal, a.currency)}</span>
                  </div>
                );
              })}
          </>
        )}

        {advanced && (
          <button className={`book settings-link${cur === RECONCILE ? ' on' : ''}`} onClick={() => setCur(RECONCILE)}>
            ✓ 对账
          </button>
        )}
        <button className={`book settings-link${cur === SETTINGS ? ' on' : ''}`} onClick={() => setCur(SETTINGS)}>
          ⚙ 设置
        </button>

        <div className="s-note">
          {isDesktop
            ? '桌面版：数据已持久化到本地 SQLite。'
            : '网页演示版：数据存内存，刷新即重置；桌面版数据落本地 SQLite。'}
        </div>
      </aside>
      <main className="main">
        {cur === SETTINGS ? (
          <Settings
            repo={repo}
            settings={settings}
            usedCurrencies={new Set(liveAccounts.map((a) => a.currency))}
            reload={() => loadFrom(repo)}
            onSecurityChange={refreshSecurity}
          />
        ) : cur === RECONCILE ? (
          <Reconcile repo={repo} accounts={liveAccounts} allTxns={txns} books={allBooks} reload={() => loadFrom(repo)} />
        ) : cur === OVERVIEW || !data ? (
          <OverviewAll books={books} accounts={accounts} txns={txns} settings={settings} convert={convert} onOpen={openBook} />
        ) : (
          <>
            {showReminder && (
              <div className="recon-banner">
                <span>📋 本月对账日 {reconReminder} 临近，建议核对各账户余额。</span>
                <div className="rb-actions">
                  <button className="btn btn-primary rb-go" onClick={() => setCur(RECONCILE)}>
                    去对账
                  </button>
                  <button
                    className="rb-x"
                    onClick={() => setReconDismissed((s) => new Set(s).add(curBook!.id))}
                  >
                    稍后
                  </button>
                </div>
              </div>
            )}
            {showDueReminder && (
              <div className="recon-banner due-banner">
                <span>
                  💰 有 {dueReminder!.count} 笔应收
                  {dueReminder!.overdueCount > 0 &&
                    (dueReminder!.overdueCount === dueReminder!.count ? '已逾期' : `（其中 ${dueReminder!.overdueCount} 笔已逾期）`)}
                  {dueReminder!.overdueCount === 0 && '即将到期'}
                  ，合计 {fmtMoney(dueReminder!.total, convert.display)}，建议及时跟进收款。
                </span>
                <div className="rb-actions">
                  <button className="btn btn-primary rb-go" onClick={() => setView('orders')}>
                    去收款
                  </button>
                  <button className="rb-x" onClick={() => setDueDismissed((s) => new Set(s).add(curBook!.id))}>
                    稍后
                  </button>
                </div>
              </div>
            )}
            {showApDueReminder && (
              <div className="recon-banner due-banner">
                <span>
                  💸 有 {apDueReminder!.count} 笔应付
                  {apDueReminder!.overdueCount > 0 &&
                    (apDueReminder!.overdueCount === apDueReminder!.count ? '已逾期' : `（其中 ${apDueReminder!.overdueCount} 笔已逾期）`)}
                  {apDueReminder!.overdueCount === 0 && '即将到期'}
                  ，合计 {fmtMoney(apDueReminder!.total, convert.display)}，建议及时安排付款。
                </span>
                <div className="rb-actions">
                  <button className="btn btn-primary rb-go" onClick={() => setView('suppliers')}>
                    去付款
                  </button>
                  <button className="rb-x" onClick={() => setApDueDismissed((s) => new Set(s).add(curBook!.id))}>
                    稍后
                  </button>
                </div>
              </div>
            )}
            <div className="book-head">
              <div className="seg">
                {tabs.map(([v, label]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                    {label}
                  </button>
                ))}
              </div>
              <button className="archive" onClick={() => void archiveBook()}>
                归档账本
              </button>
            </div>
            {view === 'dashboard' && <Dashboard data={data} />}
            {view === 'txns' && <Transactions data={data} />}
            {view === 'budgets' && <Budgets data={data} />}
            {view === 'invest' && <Invest data={data} />}
            {view === 'accounts' && <Accounts data={data} />}
            {view === 'customers' && <Customers data={data} />}
            {view === 'suppliers' && <Suppliers data={data} />}
            {view === 'orders' && <Orders data={data} />}
            {view === 'products' && <Products data={data} />}
            {view === 'inventory' && <Inventory data={data} />}
            {view === 'purchases' && <Purchases data={data} />}
            {view === 'fees' && <FeeDefinitions data={data} />}
          </>
        )}
      </main>
    </div>
  );
}
