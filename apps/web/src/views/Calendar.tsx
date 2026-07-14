import { useMemo, useState } from 'react';
import { dailyTotals } from '@app/core';
import type { StoredRecurringRule } from '@app/store';
import type { AppData } from '../App';
import TxnRow from '../components/TxnRow';
import { currentMonth, fmtMoney, todayISO } from '../format';
import { monthGridDates, shiftMonth } from '../calendar';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const KIND_LABEL = { expense: '支出', income: '收入', transfer: '转账' } as const;

export default function Calendar({ data }: { data: AppData }) {
  const { accounts, txns, recurringRules, book, convert } = data;
  const [month, setMonth] = useState(currentMonth());
  const [selected, setSelected] = useState<string | null>(null);
  const today = todayISO();

  const totals = useMemo(() => dailyTotals(txns, accounts, month, convert), [txns, accounts, month, convert]);
  const dueByDate = useMemo(() => {
    const m = new Map<string, StoredRecurringRule[]>();
    for (const r of recurringRules) {
      if (!r.active) continue;
      m.set(r.nextDueDate, [...(m.get(r.nextDueDate) ?? []), r]);
    }
    return m;
  }, [recurringRules]);
  const cells = useMemo(() => monthGridDates(month), [month]);

  function nav(delta: number): void {
    setMonth((m) => shiftMonth(m, delta));
    setSelected(null);
  }

  function goToday(): void {
    setMonth(currentMonth());
    setSelected(null);
  }

  const dayTxns = selected ? txns.filter((t) => t.date === selected) : [];
  const dayDue = selected ? (dueByDate.get(selected) ?? []) : [];

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 日历</h2>
        <div className="head-actions">
          <button className="btn" onClick={() => nav(-1)}>
            ‹ 上月
          </button>
          <span className="muted">{month}</span>
          <button className="btn" onClick={goToday}>
            回到本月
          </button>
          <button className="btn" onClick={() => nav(1)}>
            下月 ›
          </button>
        </div>
      </div>
      <div className="card">
        <div className="cal-weekdays">
          {WEEKDAY_LABELS.map((w) => (
            <div key={w} className="cal-wd">
              {w}
            </div>
          ))}
        </div>
        <div className="cal-grid">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="cal-cell blank" />;
            const t = totals.get(date);
            const due = dueByDate.get(date);
            return (
              <button
                key={date}
                type="button"
                className={`cal-cell${date === today ? ' today' : ''}${date === selected ? ' selected' : ''}`}
                onClick={() => setSelected(date)}
              >
                <span className="cal-daynum">{Number(date.slice(8))}</span>
                {t && (
                  <span className={`cal-net ${t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : 'neutral'}`}>{fmtMoney(t.net, convert.display)}</span>
                )}
                {t && <span className="cal-count muted">{t.count} 笔</span>}
                {due && due.length > 0 && <span className="cal-due">⏰ {due.length}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {selected && (
        <div className="card">
          <h3>
            {selected}
            {selected === today && <span className="chip"> 今天</span>}
          </h3>
          {dayDue.map((r) => (
            <div className="brow" key={r.id}>
              <div className="bhead">
                <span className="bname">⏰ {r.payee || KIND_LABEL[r.kind]}</span>
                <span className="muted small">到期周期记账 · 去「周期记账」页确认或跳过</span>
              </div>
            </div>
          ))}
          {dayTxns.length === 0 ? (
            <p className="muted">这天没有交易{dayDue.length > 0 ? '（仅到期提醒）' : ''}</p>
          ) : (
            dayTxns.map((t) => <TxnRow key={t.id} txn={t} data={data} />)
          )}
        </div>
      )}
    </>
  );
}
