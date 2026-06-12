import { useEffect, useMemo, useState } from 'react';
import { accountBalance, adjustBalanceEntry, toMinor, unclearedCount } from '@app/core';
import type { StoredReconciliation } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { currencyDef, fmtMoney, todayISO } from '../format';

const GAIN_LOSS = '盘盈盘亏';

/** 勾对式对账：选账户 → 填对账单余额 → 逐笔勾选 → 差额对到 0 → 完成对账。 */
export default function Reconcile({ data }: { data: AppData }) {
  const { repo, book, accounts, txns, reload } = data;

  const recAccounts = useMemo(
    () => accounts.filter((a) => (a.type === 'asset' || a.type === 'liability') && !a.archived),
    [accounts],
  );

  const clearedIdsOf = (accountId: string): Set<string> =>
    new Set(txns.flatMap((t) => t.postings).filter((p) => p.accountId === accountId && p.cleared).map((p) => p.id));

  const [accountId, setAccountId] = useState(() => recAccounts[0]?.id ?? '');
  const [checked, setChecked] = useState<Set<string>>(() => clearedIdsOf(recAccounts[0]?.id ?? ''));
  const [stmt, setStmt] = useState('');
  const [stmtDate, setStmtDate] = useState(todayISO());
  const [lastRec, setLastRec] = useState<StoredReconciliation | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 上次对账记录：随账户与数据变化刷新（不碰 checked，避免抹掉勾选中途状态）
  useEffect(() => {
    let alive = true;
    void repo.listReconciliations({ accountId }).then((rs) => {
      if (alive) setLastRec(rs[0] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [accountId, txns, repo]);

  function selectAccount(id: string): void {
    setAccountId(id);
    setChecked(clearedIdsOf(id));
    setStmt('');
    setMsg(null);
    setErr(null);
  }

  // 该账户的分录（含所在交易信息），按日期升序——贴对账单阅读顺序
  const rows = useMemo(() => {
    const out: Array<{ pid: string; date: string; title: string; amount: number }> = [];
    for (const t of txns) {
      for (const p of t.postings) {
        if (p.accountId !== accountId) continue;
        out.push({ pid: p.id, date: t.date, title: t.payee || t.note || '交易', amount: p.amount });
      }
    }
    return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : 0));
  }, [txns, accountId]);

  // 对账账户的币种决定金额精度与显示符号（账户可为非人民币）
  const curCode = recAccounts.find((a) => a.id === accountId)?.currency ?? 'CNY';
  const dec = currencyDef(curCode).decimals;

  const currentBalance = useMemo(() => accountBalance(txns, accountId), [txns, accountId]);
  const checkedSum = useMemo(
    () => rows.reduce((s, r) => (checked.has(r.pid) ? s + r.amount : s), 0),
    [rows, checked],
  );

  const stmtTrim = stmt.trim();
  const stmtNum = stmtTrim === '' ? null : Number(stmtTrim);
  const stmtValid = stmtNum !== null && Number.isFinite(stmtNum);
  const stmtMinor = stmtValid ? toMinor(stmtNum, dec) : null;
  const diff = stmtMinor === null ? null : stmtMinor - checkedSum;

  function toggle(pid: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
    setMsg(null);
  }

  async function complete(): Promise<void> {
    if (diff !== 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const checkedIds = rows.filter((r) => checked.has(r.pid)).map((r) => r.pid);
      const uncheckedIds = rows.filter((r) => !checked.has(r.pid)).map((r) => r.pid);
      await repo.setPostingsCleared(checkedIds, true);
      if (uncheckedIds.length) await repo.setPostingsCleared(uncheckedIds, false);
      await repo.addReconciliation({
        id: genId(),
        bookId: book.id,
        accountId,
        statementBalance: stmtMinor!,
        statementDate: stmtDate,
        completedAt: new Date().toISOString(),
      });
      await reload();
      const acctName = accounts.find((a) => a.id === accountId)?.name ?? '账户';
      setMsg(`已完成对账：「${acctName}」余额与对账单 ${fmtMoney(stmtMinor!, curCode)} 相符，${checkedIds.length} 笔已核销。`);
    } finally {
      setBusy(false);
    }
  }

  /** 逃生口：差额查不出错时，记一笔盘盈盘亏调整把差额对平，并自动勾选这笔调整。 */
  async function adjust(): Promise<void> {
    if (diff === null || diff === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      let gl = accounts.find((a) => a.type === 'income' && a.name === GAIN_LOSS);
      if (!gl) {
        gl = await repo.addAccount({
          id: genId(),
          bookId: book.id,
          name: GAIN_LOSS,
          type: 'income',
          parentId: null,
          currency: accounts[0]?.currency ?? 'CNY',
          archived: false,
        });
      }
      const entry = adjustBalanceEntry(
        {
          bookId: book.id,
          date: stmtDate,
          accountId,
          currentBalance: checkedSum,
          targetValue: stmtMinor!,
          counterAccountId: gl.id,
          currency: curCode, // 调整腿按对账账户的币种
          note: '对账盘盈盘亏调整',
        },
        genId,
      );
      await repo.addTransaction(entry);
      const adjPosting = entry.postings.find((p) => p.accountId === accountId)!;
      setChecked((prev) => new Set(prev).add(adjPosting.id));
      await reload();
      setMsg('已记盘盈盘亏调整并勾选，差额已对平，可完成对账。');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '调整失败');
    } finally {
      setBusy(false);
    }
  }

  if (recAccounts.length === 0) {
    return (
      <>
        <div className="main-head">
          <h2>{book.name} · 对账</h2>
        </div>
        <div className="card">
          <p className="muted">本账本还没有资产/负债账户可对账。先到「账户」页添加。</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 对账</h2>
        <span className="muted">勾对式 · 逐笔核对</span>
      </div>

      <div className="card">
        <div className="rec-setup">
          <label>
            对账账户
            <select value={accountId} onChange={(e) => selectAccount(e.target.value)}>
              {recAccounts.map((a) => {
                const n = unclearedCount(txns, a.id);
                return (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {n > 0 ? ` · ${n} 待核销` : ' · 已全核销'}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            对账单余额（元）
            <input
              inputMode="decimal"
              placeholder="如 4970.00；负债欠款记负"
              value={stmt}
              onChange={(e) => {
                setStmt(e.target.value);
                setMsg(null);
              }}
            />
          </label>
          <label>
            对账截止日
            <input type="date" value={stmtDate} onChange={(e) => setStmtDate(e.target.value)} />
          </label>
        </div>
        <div className="rec-hint muted small">
          账户当前余额 {fmtMoney(currentBalance, curCode)}
          {(() => {
            const n = unclearedCount(txns, accountId);
            return n > 0 ? <> · {n} 笔待核销</> : <> · 已全部核销 ✓</>;
          })()}
          {lastRec && <> · 上次对账 {lastRec.statementDate}（{fmtMoney(lastRec.statementBalance, curCode)}）</>}
        </div>
      </div>

      <div className="card">
        <h3>
          流水勾对 <span className="mini">{rows.length} 笔</span>
        </h3>
        {rows.length === 0 ? (
          <p className="muted">该账户暂无流水。</p>
        ) : (
          <div className="rec-list">
            {rows.map((r) => (
              <label className={`rec-row${checked.has(r.pid) ? ' on' : ''}`} key={r.pid}>
                <input type="checkbox" checked={checked.has(r.pid)} onChange={() => toggle(r.pid)} />
                <span className="rec-date">{r.date}</span>
                <span className="rec-title">{r.title}</span>
                <span className={`rec-amt ${r.amount < 0 ? 'neg' : 'pos'}`}>{fmtMoney(r.amount, curCode)}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="card rec-foot">
        <div className="rec-tally">
          <span>已勾选合计 <b>{fmtMoney(checkedSum, curCode)}</b></span>
          <span className={`rec-diff${diff === 0 ? ' ok' : ''}`}>
            差额 <b>{diff === null ? '—' : fmtMoney(diff, curCode)}</b>
          </span>
        </div>
        <div className="rec-actions">
          {diff !== null && diff !== 0 && (
            <button className="btn" onClick={() => void adjust()} disabled={busy}>
              记盘盈盘亏调整 {fmtMoney(diff, curCode)}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void complete()} disabled={busy || diff !== 0}>
            完成对账
          </button>
        </div>
        {!stmtValid && stmtTrim !== '' && <p className="form-err">对账单余额需为数字</p>}
        {err && <p className="form-err">{err}</p>}
        {msg && <p className="rec-ok">{msg}</p>}
      </div>
    </>
  );
}
