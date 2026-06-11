import { incomeExpense, netWorth } from '@app/core';
import type { StoredAccount, StoredBook, StoredTransaction } from '@app/store';
import { BOOK_META } from '../db';
import { currentMonth, fmtMoney } from '../format';

export default function OverviewAll({
  books,
  accounts,
  txns,
  onOpen,
}: {
  books: StoredBook[];
  accounts: StoredAccount[];
  txns: StoredTransaction[];
  onOpen: (id: string) => void;
}) {
  const month = currentMonth();
  const period = { from: `${month}-01`, to: `${month}-31` };
  // 只汇总可见（非归档）账本：books 已排除归档，但 accounts/txns 是全量，
  // 按 books 的 id 过滤，避免归档账本仍计入总净资产/收支、与下方各账本卡片之和对不上。
  const visible = new Set(books.map((b) => b.id));
  const va = accounts.filter((x) => visible.has(x.bookId));
  const vt = txns.filter((x) => visible.has(x.bookId));
  const totalNw = netWorth(vt, va);
  const totalIe = incomeExpense(vt, va, { period });

  const perBook = books.map((b) => {
    const a = accounts.filter((x) => x.bookId === b.id);
    const t = txns.filter((x) => x.bookId === b.id);
    const ie = incomeExpense(t, a, { period });
    return { book: b, nw: netWorth(t, a), net: ie.net, txCount: t.length };
  });

  return (
    <>
      <div className="main-head">
        <h2>财务总表 · 全部账本</h2>
        <span className="muted">{month}</span>
      </div>
      <div className="stats">
        <div className="stat hero-stat">
          <div className="k">全部净资产（{books.length} 个账本汇总）</div>
          <div className="v">{fmtMoney(totalNw)}</div>
        </div>
        <div className="stat">
          <div className="k">本月总收入</div>
          <div className="v sm pos">{fmtMoney(totalIe.income)}</div>
        </div>
        <div className="stat">
          <div className="k">本月总支出</div>
          <div className="v sm neg">{fmtMoney(totalIe.expense)}</div>
        </div>
        <div className="stat">
          <div className="k">本月总结余</div>
          <div className="v sm">{fmtMoney(totalIe.net)}</div>
        </div>
      </div>
      <div className="bookcards">
        {perBook.map(({ book, nw, net, txCount }) => (
          <button className="bookcard" key={book.id} onClick={() => onOpen(book.id)}>
            <div className="bc-head">
              {BOOK_META[book.type].emoji} {book.name}
              <span className={`bk-type ${BOOK_META[book.type].cls}`}>{BOOK_META[book.type].label}</span>
            </div>
            <div className="bc-nw">{fmtMoney(nw)}</div>
            <div className="bc-sub">
              本月{book.type === 'business' ? '利润' : '结余'} {net >= 0 ? '+' : ''}
              {fmtMoney(net)} · {txCount} 笔
            </div>
          </button>
        ))}
      </div>
      <p className="muted small">汇总 = 各账本净资产之和（引擎按复式分录聚合）；点击卡片或左侧列表进入账本。</p>
    </>
  );
}
