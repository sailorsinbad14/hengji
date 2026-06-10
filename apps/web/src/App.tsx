import { useEffect, useState } from 'react';
import { accountBalance } from '@app/core';
import type { Repository, StoredAccount, StoredBudget, StoredTransaction } from '@app/store';
import { isDesktop, ready } from './db';
import { fmtMoney } from './format';
import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Budgets from './views/Budgets';
import Invest from './views/Invest';

type View = 'dashboard' | 'txns' | 'budgets' | 'invest';

export interface AppData {
  repo: Repository;
  accounts: StoredAccount[];
  txns: StoredTransaction[];
  budgets: StoredBudget[];
  reload: () => Promise<void>;
}

const NAV: Array<[View, string]> = [
  ['dashboard', '📊 总览'],
  ['txns', '📒 流水'],
  ['budgets', '🎯 预算'],
  ['invest', '📈 投资'],
];

export default function App() {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [txns, setTxns] = useState<StoredTransaction[]>([]);
  const [budgets, setBudgets] = useState<StoredBudget[]>([]);
  const [view, setView] = useState<View>('dashboard');

  async function loadFrom(r: Repository): Promise<void> {
    const [a, t, b] = await Promise.all([r.listAccounts(), r.listTransactions(), r.listBudgets()]);
    setAccounts(a);
    setTxns(t);
    setBudgets(b);
  }

  useEffect(() => {
    void ready.then(async (r) => {
      await loadFrom(r);
      setRepo(r);
    });
  }, []);

  if (!repo) return <div className="splash">账本加载中…</div>;

  const data: AppData = { repo, accounts, txns, budgets, reload: () => loadFrom(repo) };
  const sideAccounts = accounts.filter((a) => a.type === 'asset' || a.type === 'liability');

  return (
    <div className="app">
      <aside className="side">
        <div className="s-brand">
          <span className="mark">衡</span> 衡记
        </div>
        {NAV.map(([v, label]) => (
          <button key={v} className={`navi${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
        <div className="s-label">账户</div>
        {sideAccounts.map((a) => {
          const b = accountBalance(txns, a.id);
          return (
            <div className="acct" key={a.id}>
              <span className="nm">{a.name}</span>
              <span className={`bal${b < 0 ? ' neg' : ''}`}>{fmtMoney(b)}</span>
            </div>
          );
        })}
        <div className="s-note">
          {isDesktop
            ? '桌面版：数据已持久化到本地 SQLite。'
            : '网页演示版：数据存内存，刷新即重置；桌面版数据落本地 SQLite。'}
        </div>
      </aside>
      <main className="main">
        {view === 'dashboard' && <Dashboard data={data} />}
        {view === 'txns' && <Transactions data={data} />}
        {view === 'budgets' && <Budgets data={data} />}
        {view === 'invest' && <Invest data={data} />}
      </main>
    </div>
  );
}
