import { useEffect, useMemo, useState } from 'react';
import { accountBalance, unclearedCount } from '@app/core';
import type { AccountingBasis, BookType, ConvertCtx } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredBudget, StoredSetting, StoredTransaction } from '@app/store';
import { BOOK_META, createBookWithChart, isDesktop, ready } from './db';
import { fmtMoney, setCurrencyRegistry } from './format';
import { basisOf, convertCtxOf, currenciesOf, multiCurrencyOn, reconcileDayOf, reconcileLeadOf, reconcileTargetDate, reconcileWindowOpen } from './settings';
import OverviewAll from './views/OverviewAll';
import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Budgets from './views/Budgets';
import Invest from './views/Invest';
import Accounts from './views/Accounts';
import Customers from './views/Customers';
import Orders from './views/Orders';
import Products from './views/Products';
import Inventory from './views/Inventory';
import Reconcile from './views/Reconcile';
import Settings from './views/Settings';

type View = 'dashboard' | 'txns' | 'budgets' | 'invest' | 'accounts' | 'reconcile' | 'customers' | 'orders' | 'products' | 'inventory';
/** 顶层导航：财务总表 / 全局设置 / 某账本 id。 */
const OVERVIEW = 'all';
const SETTINGS = '__settings__';

export interface AppData {
  repo: Repository;
  /** 当前账本（已选定时） */
  book: StoredBook;
  /** 当前账本作用域内的数据 */
  accounts: StoredAccount[];
  txns: StoredTransaction[];
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
    ['reconcile', '对账'],
  ],
  business: [
    ['dashboard', '总览'],
    ['orders', '订单'],
    ['customers', '客户'],
    ['products', '商品'],
    ['inventory', '库存'],
    ['txns', '流水'],
    ['budgets', '预算'],
    ['accounts', '账户'],
    ['reconcile', '对账'],
  ],
  investment: [
    ['invest', '投资'],
    ['txns', '流水'],
    ['accounts', '账户'],
    ['reconcile', '对账'],
  ],
};

export default function App() {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [txns, setTxns] = useState<StoredTransaction[]>([]);
  const [budgets, setBudgets] = useState<StoredBudget[]>([]);
  const [settings, setSettings] = useState<StoredSetting[]>([]);
  const [cur, setCur] = useState<'all' | string>('all');
  const [view, setView] = useState<View>('dashboard');
  const [creating, setCreating] = useState(false);
  const [nbName, setNbName] = useState('');
  const [nbType, setNbType] = useState<BookType>('personal');
  const [reconDismissed, setReconDismissed] = useState<Set<string>>(new Set());

  async function loadFrom(r: Repository): Promise<void> {
    const [bk, a, t, b, s] = await Promise.all([
      r.listBooks(),
      r.listAccounts(),
      r.listTransactions(),
      r.listBudgets(),
      r.listSettings(),
    ]);
    setCurrencyRegistry(currenciesOf(s)); // 注入币种注册表，供 fmtMoney 等取符号/小数位
    setBooks(bk);
    setAccounts(a);
    setTxns(t);
    setBudgets(b);
    setSettings(s);
  }

  useEffect(() => {
    void ready.then(async (r) => {
      await loadFrom(r);
      setRepo(r);
    });
  }, []);

  const curBook = useMemo(() => books.find((b) => b.id === cur) ?? null, [books, cur]);
  const scoped = useMemo(
    () => ({
      accounts: accounts.filter((a) => a.bookId === cur),
      txns: txns.filter((t) => t.bookId === cur),
      budgets: budgets.filter((b) => b.bookId === cur),
    }),
    [accounts, txns, budgets, cur],
  );

  // 多币种生效值：开关开 **或** 持有任一外币账户（accounts 已排除归档）。
  // 持有外币数据时强制视为开启——否则「关却仍显示外币」自相矛盾；要回纯人民币须先归档所有外币账户。
  const mcEnabled = multiCurrencyOn(settings) || accounts.some((a) => a.currency !== 'CNY');

  // 全局设置（app 级，对所有账本生效）；在任何提前 return 之前调用，保证 Hook 顺序稳定。
  const convert = useMemo(() => convertCtxOf(settings, mcEnabled), [settings, mcEnabled]);
  const basis = useMemo(() => basisOf(settings), [settings]);

  // 对账提醒：全局配置对账日 + 进入提前窗口 + 当前账本仍有未核销分录（已对账则不扰）。
  const reconReminder = useMemo(() => {
    if (!curBook) return null;
    const day = reconcileDayOf(settings);
    if (!day || !reconcileWindowOpen(new Date(), day, reconcileLeadOf(settings))) return null;
    const hasPending = scoped.accounts
      .filter((a) => a.type === 'asset' || a.type === 'liability')
      .some((a) => unclearedCount(scoped.txns, a.id) > 0);
    return hasPending ? reconcileTargetDate(new Date(), day) : null;
  }, [curBook, settings, scoped.accounts, scoped.txns]);

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
    ? { repo, book: curBook, ...scoped, basis, convert, mcEnabled, reload: () => loadFrom(repo) }
    : null;
  const tabs = curBook ? TABS[curBook.type] : [];
  const showReminder = reconReminder && curBook && !reconDismissed.has(curBook.id);

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
              <option value="investment">投资</option>
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
                const bal = accountBalance(scoped.txns, a.id);
                return (
                  <div className="acct" key={a.id}>
                    <span className="nm">{a.name}</span>
                    <span className={`bal${bal < 0 ? ' neg' : ''}`}>{fmtMoney(bal, a.currency)}</span>
                  </div>
                );
              })}
          </>
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
            usedCurrencies={new Set(accounts.map((a) => a.currency))}
            reload={() => loadFrom(repo)}
          />
        ) : cur === OVERVIEW || !data ? (
          <OverviewAll books={books} accounts={accounts} txns={txns} settings={settings} convert={convert} onOpen={openBook} />
        ) : (
          <>
            {showReminder && (
              <div className="recon-banner">
                <span>📋 本月对账日 {reconReminder} 临近，建议核对各账户余额。</span>
                <div className="rb-actions">
                  <button className="btn btn-primary rb-go" onClick={() => setView('reconcile')}>
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
            {view === 'reconcile' && <Reconcile data={data} />}
            {view === 'customers' && <Customers data={data} />}
            {view === 'orders' && <Orders data={data} />}
            {view === 'products' && <Products data={data} />}
            {view === 'inventory' && <Inventory data={data} />}
          </>
        )}
      </main>
    </div>
  );
}
