import { useEffect, useMemo, useState } from 'react';
import { accountBalance } from '@app/core';
import type { BookType } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredBudget, StoredSetting, StoredTransaction } from '@app/store';
import { BOOK_META, createBookWithChart, isDesktop, ready } from './db';
import { fmtMoney } from './format';
import OverviewAll from './views/OverviewAll';
import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Budgets from './views/Budgets';
import Invest from './views/Invest';
import Accounts from './views/Accounts';
import Customers from './views/Customers';
import Orders from './views/Orders';
import Products from './views/Products';
import Settings from './views/Settings';

type View = 'dashboard' | 'txns' | 'budgets' | 'invest' | 'accounts' | 'customers' | 'orders' | 'products' | 'settings';

export interface AppData {
  repo: Repository;
  /** 当前账本（已选定时） */
  book: StoredBook;
  /** 当前账本作用域内的数据 */
  accounts: StoredAccount[];
  txns: StoredTransaction[];
  budgets: StoredBudget[];
  /** 当前账本作用域内的设置（KV） */
  settings: StoredSetting[];
  reload: () => Promise<void>;
}

const TABS: Record<BookType, Array<[View, string]>> = {
  personal: [
    ['dashboard', '总览'],
    ['txns', '流水'],
    ['budgets', '预算'],
    ['accounts', '账户'],
    ['settings', '设置'],
  ],
  business: [
    ['dashboard', '总览'],
    ['orders', '订单'],
    ['customers', '客户'],
    ['products', '商品'],
    ['txns', '流水'],
    ['budgets', '预算'],
    ['accounts', '账户'],
    ['settings', '设置'],
  ],
  investment: [
    ['invest', '投资'],
    ['txns', '流水'],
    ['accounts', '账户'],
    ['settings', '设置'],
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

  async function loadFrom(r: Repository): Promise<void> {
    const [bk, a, t, b, s] = await Promise.all([
      r.listBooks(),
      r.listAccounts(),
      r.listTransactions(),
      r.listBudgets(),
      r.listSettings(),
    ]);
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
      settings: settings.filter((s) => s.scope === cur),
    }),
    [accounts, txns, budgets, settings, cur],
  );

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
    ? { repo, book: curBook, ...scoped, reload: () => loadFrom(repo) }
    : null;
  const tabs = curBook ? TABS[curBook.type] : [];

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
                    <span className={`bal${bal < 0 ? ' neg' : ''}`}>{fmtMoney(bal)}</span>
                  </div>
                );
              })}
          </>
        )}

        <div className="s-note">
          {isDesktop
            ? '桌面版：数据已持久化到本地 SQLite。'
            : '网页演示版：数据存内存，刷新即重置；桌面版数据落本地 SQLite。'}
        </div>
      </aside>
      <main className="main">
        {cur === 'all' || !data ? (
          <OverviewAll books={books} accounts={accounts} txns={txns} settings={settings} onOpen={openBook} />
        ) : (
          <>
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
            {view === 'orders' && <Orders data={data} />}
            {view === 'products' && <Products data={data} />}
            {view === 'settings' && <Settings data={data} />}
          </>
        )}
      </main>
    </div>
  );
}
