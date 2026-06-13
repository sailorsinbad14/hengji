import { balancesByCurrency, incomeExpense, netWorth } from '@app/core';
import type { ConvertCtx } from '@app/core';
import type { StoredAccount, StoredBook, StoredSetting, StoredTransaction } from '@app/store';
import { BOOK_META } from '../db';
import { receivableAccountIds } from '../biz';
import { basisOf } from '../settings';
import { currencyDef, currentMonth, fmtMoney } from '../format';

export default function OverviewAll({
  books,
  accounts,
  txns,
  settings,
  convert,
  onOpen,
}: {
  books: StoredBook[];
  accounts: StoredAccount[];
  txns: StoredTransaction[];
  settings: StoredSetting[];
  convert: ConvertCtx;
  onOpen: (id: string) => void;
}) {
  const month = currentMonth();
  const period = { from: `${month}-01`, to: `${month}-31` };
  // 只汇总可见（非归档）账本：books 已排除归档，但 accounts/txns 是全量，
  // 按 books 的 id 过滤，避免归档账本仍计入总净资产/收支、与下方各账本卡片之和对不上。
  const visible = new Set(books.map((b) => b.id));
  const va = accounts.filter((x) => visible.has(x.bookId));
  const vt = txns.filter((x) => visible.has(x.bookId));
  const display = convert.display;
  const totalNw = netWorth(vt, va, convert); // 全部净资产（折合展示币种）= 全局资金 + Σ各账本专属净额
  // 净资产按币种分组（原币精确）——多于一种币种时展示分组小计
  const byCur = [...balancesByCurrency(vt, va).entries()].filter(([, v]) => v !== 0);
  const converted = byCur.some(([c]) => c !== display); // 持有非展示币种 → 标头标注折合
  const multiCurrency = byCur.length > 1; // 多于一种币种 → 列各币种原币小计
  // 全局资金（真金白银，全账本共享）——按 a.global 区分、单列一次，不计入某账本，杜绝重复计
  const globalAccts = va.filter((a) => a.global);
  const funds = netWorth(vt, globalAccts, convert);
  const hasGlobal = globalAccts.length > 0;

  // 全局记账口径（对所有账本一致），各账本算收支再求和——与各账本 Dashboard 数字一致。
  // 各账本卡的「净额」只算本账本专属（非全局）账户，全局资金单列上方。
  const basis = basisOf(settings);
  const perBook = books.map((b) => {
    const a = accounts.filter((x) => x.bookId === b.id && !x.global);
    const t = txns.filter((x) => x.bookId === b.id);
    const arIds = basis === 'cash' ? receivableAccountIds(a) : undefined;
    const ie = incomeExpense(t, a, { period, basis, receivableAccountIds: arIds, convert });
    return { book: b, nw: netWorth(t, a, convert), ie, txCount: t.length };
  });
  const totalIe = perBook.reduce(
    (s, x) => ({ income: s.income + x.ie.income, expense: s.expense + x.ie.expense, net: s.net + x.ie.net }),
    { income: 0, expense: 0, net: 0 },
  );

  return (
    <>
      <div className="main-head">
        <h2>财务总表 · 全部账本</h2>
        <span className="muted">{month}</span>
      </div>
      <div className="stats">
        <div className="stat hero-stat">
          <div className="k">全部净资产{converted ? `（折合${currencyDef(display).name}）` : ''}（{books.length} 个账本汇总）</div>
          <div className="v">{fmtMoney(totalNw, display)}</div>
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
            <div className="k">全局资金<span className="muted"> · 全账本共享</span></div>
            <div className="v sm">{fmtMoney(funds, display)}</div>
          </div>
        )}
        <div className="stat">
          <div className="k">本月总收入</div>
          <div className="v sm pos">{fmtMoney(totalIe.income, display)}</div>
        </div>
        <div className="stat">
          <div className="k">本月总支出</div>
          <div className="v sm neg">{fmtMoney(totalIe.expense, display)}</div>
        </div>
        <div className="stat">
          <div className="k">本月总结余</div>
          <div className="v sm">{fmtMoney(totalIe.net, display)}</div>
        </div>
      </div>
      <div className="bookcards">
        {perBook.map(({ book, nw, ie, txCount }) => (
          <button className="bookcard" key={book.id} onClick={() => onOpen(book.id)}>
            <div className="bc-head">
              {BOOK_META[book.type].emoji} {book.name}
              <span className={`bk-type ${BOOK_META[book.type].cls}`}>{BOOK_META[book.type].label}</span>
            </div>
            <div className="bc-nw">{fmtMoney(nw, display)}</div>
            <div className="bc-sub">
              {book.type === 'business' ? '经营净额' : '专属净额'} · 本月{book.type === 'business' ? '利润' : '结余'} {ie.net >= 0 ? '+' : ''}
              {fmtMoney(ie.net, display)} · {txCount} 笔
            </div>
          </button>
        ))}
      </div>
      <p className="muted small">
        全部净资产 = {hasGlobal ? '全局资金（共享）+ ' : ''}各账本专属净额之和；账本卡只算本账本专属账户，公用资金（支付宝/银行卡等）归全局。点击卡片进入账本。
      </p>
    </>
  );
}
