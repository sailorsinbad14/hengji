import { accountBalance, incomeExpense, netWorth } from '@app/core';
import type { AppData } from '../App';
import { currentMonth, fmtMoney } from '../format';
import { receivableAccountIds, receivableSummary } from '../biz';
import { basisOf } from '../settings';
import TxnRow from '../components/TxnRow';
import QuickEntry from './QuickEntry';

const PALETTE = ['#0e9f6e', '#4f46e5', '#d97706', '#0ea5e9', '#8b5cf6', '#14b8a6', '#e5484d'];

function Donut({ slices, total }: { slices: Array<{ name: string; value: number }>; total: number }) {
  if (total <= 0) return <p className="muted">暂无资产数据</p>;
  let acc = 0;
  return (
    <div className="donut-row">
      <svg width="130" height="130" viewBox="0 0 36 36">
        <g transform="rotate(-90 18 18)">
          <circle cx="18" cy="18" r="15.915" fill="none" stroke="#eef1f5" strokeWidth="4.2" />
          {slices.map((s, i) => {
            const len = (s.value / total) * 100;
            const el = (
              <circle
                key={s.name}
                cx="18"
                cy="18"
                r="15.915"
                fill="none"
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth="4.2"
                strokeDasharray={`${len} ${100 - len}`}
                strokeDashoffset={-acc}
              />
            );
            acc += len;
            return el;
          })}
        </g>
      </svg>
      <div className="legend">
        {slices.map((s, i) => (
          <div key={s.name}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            {s.name}
            <span className="lv">{fmtMoney(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard({ data }: { data: AppData }) {
  const { accounts, txns, book, settings } = data;
  const month = currentMonth();
  const period = { from: `${month}-01`, to: `${month}-31` };
  const nw = netWorth(txns, accounts);
  const basis = basisOf(settings, book.id);
  const arIds = basis === 'cash' ? receivableAccountIds(accounts) : undefined;
  const ie = incomeExpense(txns, accounts, { period, basis, receivableAccountIds: arIds });
  const slices = accounts
    .filter((a) => a.type === 'asset')
    .map((a) => ({ name: a.name, value: accountBalance(txns, a.id) }))
    .filter((s) => s.value > 0);
  const totalAssets = slices.reduce((s, x) => s + x.value, 0);
  const netLabel = book.type === 'business' ? '本月利润' : '本月结余';
  const recv = book.type === 'business' ? receivableSummary(accounts, txns) : null;

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 总览</h2>
        <span className="muted">
          {basis === 'cash' && <span className="basis-tag">收付实现制</span>}
          {month}
        </span>
      </div>
      <div className="stats">
        <div className="stat hero-stat">
          <div className="k">净资产</div>
          <div className="v">{fmtMoney(nw)}</div>
        </div>
        <div className="stat">
          <div className="k">本月收入</div>
          <div className="v sm pos">{fmtMoney(ie.income)}</div>
        </div>
        <div className="stat">
          <div className="k">本月支出</div>
          <div className="v sm neg">{fmtMoney(ie.expense)}</div>
        </div>
        <div className="stat">
          <div className="k">{netLabel}</div>
          <div className={`v sm${book.type === 'business' ? ' biz' : ''}`}>{fmtMoney(ie.net)}</div>
        </div>
      </div>
      <div className="mid">
        <div className="card">
          <h3>
            资产分布 <span className="mini">合计 {fmtMoney(totalAssets)}</span>
          </h3>
          <Donut slices={slices} total={totalAssets} />
          {recv && (recv.receivable > 0 || recv.prepaid > 0) && (
            <div className="recv-line">
              客户往来：
              <span className={recv.receivable > 0 ? 'neg' : 'muted'}>应收 {fmtMoney(recv.receivable)}</span>
              {recv.prepaid > 0 && <span className="recv-pre"> · 预收 {fmtMoney(recv.prepaid)}</span>}
            </div>
          )}
        </div>
        <QuickEntry data={data} />
      </div>
      <div className="card">
        <h3>最近交易</h3>
        {txns.length === 0 ? (
          <p className="muted">还没有交易，从「记一笔」开始。</p>
        ) : (
          txns.slice(0, 6).map((t) => <TxnRow key={t.id} txn={t} data={data} />)
        )}
      </div>
    </>
  );
}
