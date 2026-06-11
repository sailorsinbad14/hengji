import { useState } from 'react';
import { budgetUsage, toMinor } from '@app/core';
import type { AppData } from '../App';
import { genId } from '../db';
import { currentMonth, fmtMoney } from '../format';

export default function Budgets({ data }: { data: AppData }) {
  const { accounts, txns, budgets, repo, reload, book } = data;
  const month = currentMonth();
  const lines = budgetUsage(txns, budgets, month);
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? id;
  const candidates = accounts.filter((a) => a.type === 'expense' && !budgets.some((b) => b.accountId === a.id));
  const [accId, setAccId] = useState('');
  const [limit, setLimit] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const effAcc = candidates.some((a) => a.id === accId) ? accId : (candidates[0]?.id ?? '');

  async function add(): Promise<void> {
    setErr(null);
    const major = Number(limit);
    if (!effAcc || !Number.isFinite(major) || major <= 0) {
      setErr('请选择分类并输入有效限额');
      return;
    }
    try {
      await repo.addBudget({ id: genId(), bookId: book.id, accountId: effAcc, monthlyLimit: toMinor(major) });
      setLimit('');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 预算</h2>
        <span className="muted">{month}</span>
      </div>
      <div className="card">
        {lines.length === 0 && <p className="muted">还没有预算，先在下面加一个。</p>}
        {lines.map((l) => {
          const pct = l.limit > 0 ? Math.min(100, Math.round((l.spent / l.limit) * 100)) : 0;
          const budget = budgets.find((b) => b.accountId === l.accountId);
          return (
            <div className="brow" key={l.accountId}>
              <div className="bhead">
                <span className="bname">{nameOf(l.accountId)}</span>
                <span className={`bnum${l.over ? ' neg' : ''}`}>
                  {fmtMoney(l.spent)} / {fmtMoney(l.limit)}
                  {l.over ? ' · 已超支' : ''}
                </span>
                {budget && (
                  <button
                    className="del"
                    title="删除预算"
                    onClick={async () => {
                      if (confirm('删除该预算？')) {
                        await repo.removeBudget(budget.id);
                        await reload();
                      }
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="bar">
                <i className={l.over ? 'over' : ''} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="card">
        <h3>新增预算</h3>
        <div className="qgrid">
          <label>
            分类
            <select value={effAcc} onChange={(e) => setAccId(e.target.value)}>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            月度限额（元）
            <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="1000" />
          </label>
        </div>
        {err && <p className="form-err">{err}</p>}
        <button className="btn btn-primary" onClick={() => void add()}>
          添加
        </button>
      </div>
    </>
  );
}
