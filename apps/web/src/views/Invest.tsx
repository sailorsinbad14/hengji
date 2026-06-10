import { useState } from 'react';
import { accountBalance, adjustBalanceEntry, fromMinor, toMinor } from '@app/core';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney, todayISO } from '../format';

export default function Invest({ data }: { data: AppData }) {
  const { accounts, txns, repo, reload } = data;
  const assets = accounts.filter((a) => a.type === 'asset');
  const pnl = accounts.find((a) => a.name === '投资盈亏');
  const [accId, setAccId] = useState('');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const defaultAcc = assets.find((a) => a.name === '投资账户') ?? assets[0];
  const eff = assets.find((a) => a.id === accId) ?? defaultAcc;
  if (!eff || !pnl) return <p className="muted">缺少投资相关科目（投资账户 / 投资盈亏）。</p>;

  const balance = accountBalance(txns, eff.id);
  const cumPnl = -accountBalance(txns, pnl.id); // 收入科目余额为负 → 翻正即累计盈亏

  async function save(): Promise<void> {
    setErr(null);
    setOk(null);
    const major = Number(value);
    if (!Number.isFinite(major) || major < 0) {
      setErr('请输入有效现值');
      return;
    }
    try {
      await repo.addTransaction(
        adjustBalanceEntry(
          {
            date: todayISO(),
            accountId: eff!.id,
            currentBalance: balance,
            targetValue: toMinor(major),
            counterAccountId: pnl!.id,
            note: '更新投资现值',
          },
          genId,
        ),
      );
      await reload();
      setValue('');
      setOk('已更新 ✓');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>投资</h2>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="k">当前现值（{eff.name}）</div>
          <div className="v sm">{fmtMoney(balance)}</div>
        </div>
        <div className="stat">
          <div className="k">累计投资盈亏</div>
          <div className={`v sm ${cumPnl >= 0 ? 'pos' : 'neg'}`}>{(cumPnl > 0 ? '+' : '') + fmtMoney(cumPnl)}</div>
        </div>
      </div>
      <div className="card">
        <h3>更新现值</h3>
        <p className="muted">
          输入账户最新市值，差额自动作为浮盈/浮亏记入「投资盈亏」并计入净资产。极简档——不跟踪持仓明细（完整投资模块见路线
          v0.3）。
        </p>
        <div className="qgrid" style={{ marginTop: 10 }}>
          <label>
            账户
            <select value={eff.id} onChange={(e) => setAccId(e.target.value)}>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            最新现值（元）
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={String(fromMinor(balance))}
            />
          </label>
        </div>
        {err && <p className="form-err">{err}</p>}
        {ok && <p className="form-ok">{ok}</p>}
        <button className="btn btn-primary" onClick={() => void save()}>
          更新现值
        </button>
      </div>
    </>
  );
}
