import { useState } from 'react';
import { accountBalance, adjustBalanceEntry, convertAmount, toMinor } from '@app/core';
import type { AppData } from '../App';
import { genId } from '../db';
import { currencyDef, fmtMoney, todayISO } from '../format';

export default function Invest({ data }: { data: AppData }) {
  const { accounts, txns, repo, reload, book, convert } = data;
  const assets = accounts.filter((a) => a.type === 'asset');
  const pnl = accounts.find((a) => a.name === '投资盈亏');
  const [accId, setAccId] = useState('');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const eff = assets.find((a) => a.id === accId) ?? assets[0];
  if (!eff || !pnl) return <p className="muted">本账本缺少投资科目（投资账户 / 投资盈亏）。</p>;

  const balance = accountBalance(txns, eff.id);
  // 累计盈亏：投资盈亏科目各币种 posting 折算到展示币种后求和再翻正（多投资账户可不同币种，原币不可直接相加）
  const display = convert.display;
  let pnlMinor = 0;
  const pnlCurrencies = new Set<string>();
  for (const t of txns) {
    for (const p of t.postings) {
      if (p.accountId !== pnl.id) continue;
      pnlMinor += convertAmount(p.amount, p.currency, convert);
      pnlCurrencies.add(p.currency);
    }
  }
  const cumPnl = -pnlMinor; // 收入科目余额为负 → 翻正即累计盈亏
  const pnlConverted = [...pnlCurrencies].some((c) => c !== display); // 含非展示币种 → 标注折合
  const dec = currencyDef(eff.currency).decimals; // 现值更新/显示按账户币种精度

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
            bookId: book.id,
            date: todayISO(),
            accountId: eff!.id,
            currentBalance: balance,
            targetValue: toMinor(major, dec),
            counterAccountId: pnl!.id,
            currency: eff!.currency, // 两腿按账户币种，避免在非人民币账户上混入人民币分录
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
        <h2>{book.name} · 投资</h2>
      </div>
      <div className="stats">
        <div className="stat hero-stat">
          <div className="k">当前现值（{eff.name}）</div>
          <div className="v">{fmtMoney(balance, eff.currency)}</div>
        </div>
        <div className="stat">
          <div className="k">累计投资盈亏{pnlConverted ? `（折合${currencyDef(display).name}）` : ''}</div>
          <div className={`v sm ${cumPnl >= 0 ? 'pos' : 'neg'}`}>{(cumPnl > 0 ? '+' : '') + fmtMoney(cumPnl, display)}</div>
        </div>
      </div>
      <div className="card">
        <h3>更新现值</h3>
        <p className="muted">
          输入账户最新市值，差额自动作为浮盈/浮亏记入「投资盈亏」并计入净资产。极简档——不跟踪持仓明细（完整投资模块见路线
          v0.4）。
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
            最新现值（{currencyDef(eff.currency).symbol}）
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={String(balance / 10 ** dec)}
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
