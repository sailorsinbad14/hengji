import { accountBalance, balancesByCurrency, convertAmount, incomeExpense, netWorth, unclearedCount } from '@app/core';
import type { AppData } from '../App';
import { currencyDef, currentMonth, fmtMoney } from '../format';
import { receivableAccountIds, receivableSummary } from '../biz';
import TxnRow from '../components/TxnRow';
import QuickEntry from './QuickEntry';

const PALETTE = ['#0e9f6e', '#4f46e5', '#d97706', '#0ea5e9', '#8b5cf6', '#14b8a6', '#e5484d'];

function Donut({ slices, total, display }: { slices: Array<{ name: string; value: number }>; total: number; display: string }) {
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
            <span className="lv">{fmtMoney(s.value, display)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard({ data }: { data: AppData }) {
  const { accounts, txns, allTxns, book, basis, convert } = data;
  const month = currentMonth();
  const period = { from: `${month}-01`, to: `${month}-31` };
  // 账户全局化：本账本净额 = 专属（非全局）资产−负债；可用资金 = 全局共享账户（余额散落多账本→用全量 txns）。
  const bookScoped = accounts.filter((a) => !a.global);
  const globalAccts = accounts.filter((a) => a.global);
  const bookNw = netWorth(allTxns, bookScoped, convert);
  const funds = netWorth(allTxns, globalAccts, convert);
  const hasGlobal = globalAccts.length > 0;
  const arIds = basis === 'cash' ? receivableAccountIds(accounts) : undefined;
  const ie = incomeExpense(txns, accounts, { period, basis, receivableAccountIds: arIds, convert });
  // 资产饼图：本账本专属资产（全局资金单列「可用资金」，不混入），折合展示币种比例分布
  const slices = bookScoped
    .filter((a) => a.type === 'asset')
    .map((a) => ({ name: a.name, value: convertAmount(accountBalance(allTxns, a.id), a.currency, convert) }))
    .filter((s) => s.value > 0);
  const totalAssets = slices.reduce((s, x) => s + x.value, 0);
  const netLabel = book.type === 'business' ? '本月利润' : '本月结余';
  const nwLabel = book.type === 'business' ? '经营净额' : '本账本净额';
  const recv = book.type === 'business' ? receivableSummary(accounts, txns, convert) : null;
  // 多币种：本账本专属账户跨币种时，标头标注「折合<展示币种>」+ 各币种小计
  const display = convert.display;
  const byCur = [...balancesByCurrency(allTxns, bookScoped).entries()].filter(([, v]) => v !== 0);
  const converted = byCur.some(([c]) => c !== display); // 持有非展示币种 → 标头需标注折合
  const multiCurrency = byCur.length > 1; // 多于一种币种 → 列各币种原币小计

  // 滚动对账状态：仅对本账本专属账户（全局账户对账在全局入口）。
  const hasReconciled = txns.some((t) => t.postings.some((p) => p.cleared));
  const pendingAccts = bookScoped
    .filter((a) => a.type === 'asset' || a.type === 'liability')
    .filter((a) => unclearedCount(txns, a.id) > 0).length;

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 总览</h2>
        <span className="muted">
          {basis === 'cash' && <span className="basis-tag">收付实现制</span>}
          {hasReconciled && (
            <span className={`recon-badge${pendingAccts === 0 ? ' ok' : ''}`}>
              {pendingAccts === 0 ? '本期已对账 ✓' : `${pendingAccts} 个账户待对账`}
            </span>
          )}
          {month}
        </span>
      </div>
      <div className="stats">
        <div className="stat hero-stat">
          <div className="k">{nwLabel}{converted ? `（折合${currencyDef(display).name}）` : ''}</div>
          <div className="v">{fmtMoney(bookNw, display)}</div>
          {multiCurrency && (
            <div className="cur-breakdown">
              {byCur.map(([cur, amt]) => (
                <span key={cur} className="cur-chip">
                  {fmtMoney(amt, cur)}
                </span>
              ))}
            </div>
          )}
        </div>
        {hasGlobal && (
          <div className="stat">
            <div className="k">可用资金<span className="muted"> · 全局共享</span></div>
            <div className="v sm">{fmtMoney(funds, display)}</div>
          </div>
        )}
        <div className="stat">
          <div className="k">本月收入</div>
          <div className="v sm pos">{fmtMoney(ie.income, display)}</div>
        </div>
        <div className="stat">
          <div className="k">本月支出</div>
          <div className="v sm neg">{fmtMoney(ie.expense, display)}</div>
        </div>
        <div className="stat">
          <div className="k">{netLabel}</div>
          <div className={`v sm${book.type === 'business' ? ' biz' : ''}`}>{fmtMoney(ie.net, display)}</div>
        </div>
      </div>
      <div className="mid">
        <div className="card">
          <h3>
            资产分布 <span className="mini">合计 {fmtMoney(totalAssets, display)}</span>
          </h3>
          <Donut slices={slices} total={totalAssets} display={display} />
          {recv && (recv.receivable > 0 || recv.prepaid > 0) && (
            <div className="recv-line">
              客户往来：
              <span className={recv.receivable > 0 ? 'neg' : 'muted'}>应收 {fmtMoney(recv.receivable, display)}</span>
              {recv.prepaid > 0 && <span className="recv-pre"> · 预收 {fmtMoney(recv.prepaid, display)}</span>}
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
