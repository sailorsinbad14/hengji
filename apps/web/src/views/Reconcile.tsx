import { useEffect, useMemo, useState } from 'react';
import { accountBalance, adjustBalanceEntry, expandEntry, matchStatement, toMinor, unclearedCount } from '@app/core';
import type { EntryInput, StatementItem } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredReconciliation, StoredTransaction } from '@app/store';
import { genId } from '../db';
import { currencyDef, fmtMoney, todayISO } from '../format';
import { parseImportFile, SOURCE_LABELS } from '../import-files';
import type { ImportSource } from '../import-files';

const GAIN_LOSS = '盘盈盘亏';
type AddKind = 'income' | 'expense' | 'transfer';

/**
 * 勾对式对账（账户全局化 Phase 4：全局入口、按账户跨账本）：
 * 选账户 → 填对账单余额 → 逐笔勾选（每条流水标所属账本、可按账本筛选核对各自小计）→ 差额对到 0 → 完成。
 * 全局共享账户的流水散落多账本，故用全量交易聚合该账户分录。补录/调整：全局账户由用户手动选账本，
 * 账本专属账户固定其所属账本。
 */
export default function Reconcile({
  repo,
  accounts,
  allTxns,
  books,
  reload,
}: {
  repo: Repository;
  accounts: StoredAccount[];
  allTxns: StoredTransaction[];
  books: StoredBook[];
  reload: () => Promise<void>;
}) {
  // books 为全量（含归档），故全局账户跨归档账本的历史流水也能查到名字（标「已归档」），不再显示「未知账本」。
  const bookName = (id: string): string => {
    const b = books.find((x) => x.id === id);
    return b ? (b.archived ? `${b.name}（已归档）` : b.name) : '（未知账本）';
  };
  // 补录归属账本只能选未归档账本（不把交易写回已归档账本）。
  const liveBooks = books.filter((b) => !b.archived);

  // 全部资产/负债账户（含全局共享）跨账本对账；按账本名+账户名排序，全局置顶
  const recAccounts = useMemo(
    () =>
      accounts
        .filter((a) => (a.type === 'asset' || a.type === 'liability') && !a.archived)
        .sort((x, y) => Number(!!y.global) - Number(!!x.global) || x.bookId.localeCompare(y.bookId) || x.name.localeCompare(y.name)),
    [accounts],
  );

  const clearedIdsOf = (accountId: string): Set<string> =>
    new Set(allTxns.flatMap((t) => t.postings).filter((p) => p.accountId === accountId && p.cleared).map((p) => p.id));

  const [accountId, setAccountId] = useState(() => recAccounts[0]?.id ?? '');
  const [checked, setChecked] = useState<Set<string>>(() => clearedIdsOf(recAccounts[0]?.id ?? ''));
  const [bookFilter, setBookFilter] = useState<'all' | string>('all'); // 流水按账本筛选（仅核对用，不影响整账户对账）
  const [stmt, setStmt] = useState('');
  const [stmtDate, setStmtDate] = useState(todayISO());
  const [lastRec, setLastRec] = useState<StoredReconciliation | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 内联补录一笔（对账时发现漏记的款项，免去跳「记一笔」丢失勾选进度）
  const [addOpen, setAddOpen] = useState(false);
  const [aKind, setAKind] = useState<AddKind>('expense');
  const [aAmount, setAAmount] = useState('');
  const [aCatId, setACatId] = useState('');
  const [aBook, setABook] = useState('');
  const [aDate, setADate] = useState(todayISO());
  const [aCounterId, setACounterId] = useState(''); // 转账补录的对手资金账户
  const [aTransferOut, setATransferOut] = useState(true); // 转账方向：true=本对账账户转出
  const [prefillFromIdx, setPrefillFromIdx] = useState<number | null>(null); // 从哪条漏记预填的（补录后精确移除该行，而非清空整列）

  // 导入账单自动勾对（③ 对账 match）：解析账单 → 按金额同口径+日期窗口匹配本账户分录 → 自动勾选命中、列出漏记
  const [matchSource, setMatchSource] = useState<ImportSource>('alipay-fund-flow');
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ total: number; matched: number; unmatched: Array<{ date: string; payee: string; signedAmount: number; direction: 'in' | 'out'; suggestion: string }> } | null>(null);

  const selAccount = recAccounts.find((a) => a.id === accountId);
  const homeBookId = selAccount?.bookId ?? '';
  const curCode = selAccount?.currency ?? 'CNY';
  const dec = currencyDef(curCode).decimals;

  // 上次对账记录：随账户与数据变化刷新（不碰 checked，避免抹掉勾选中途状态）
  useEffect(() => {
    let alive = true;
    void repo.listReconciliations({ accountId }).then((rs) => {
      if (alive) setLastRec(rs[0] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [accountId, allTxns, repo]);

  // 悬浮补录框：Esc 关闭
  useEffect(() => {
    if (!addOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen]);

  function selectAccount(id: string): void {
    setAccountId(id);
    setChecked(clearedIdsOf(id));
    setBookFilter('all');
    setStmt('');
    setMsg(null);
    setErr(null);
    setMatchInfo(null);
  }

  // 该账户的分录（含所在交易的账本），按日期升序——贴对账单阅读顺序
  const allRows = useMemo(() => {
    const out: Array<{ pid: string; txnId: string; bookId: string; date: string; title: string; amount: number; cleared: boolean }> = [];
    for (const t of allTxns) {
      for (const p of t.postings) {
        if (p.accountId !== accountId) continue;
        out.push({ pid: p.id, txnId: t.id, bookId: t.bookId, date: t.date, title: t.payee || t.note || '交易', amount: p.amount, cleared: !!p.cleared });
      }
    }
    return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : 0));
  }, [allTxns, accountId]);

  // 该账户涉及的账本（用于筛选 chips）
  const rowBooks = useMemo(() => [...new Set(allRows.map((r) => r.bookId))], [allRows]);
  const rows = bookFilter === 'all' ? allRows : allRows.filter((r) => r.bookId === bookFilter);

  const addCats = accounts.filter((a) => a.type === aKind && a.bookId === aBook && !a.global && !a.archived);
  const effACat = addCats.some((c) => c.id === aCatId) ? aCatId : (addCats[0]?.id ?? '');
  // 转账补录的对手资金账户：全部资产/负债账户（含全局），排除当前对账账户（对手腿不能等于源）
  const counterAccounts = accounts.filter((a) => (a.type === 'asset' || a.type === 'liability') && !a.archived && a.id !== accountId);
  const effCounter = counterAccounts.some((c) => c.id === aCounterId) ? aCounterId : (counterAccounts[0]?.id ?? '');
  // 补录归属账本：全局账户可选任意账本；账本专属账户只能落其所属账本（铁律）
  const addBookOptions = selAccount?.global ? liveBooks : liveBooks.filter((b) => b.id === homeBookId);

  const currentBalance = useMemo(() => accountBalance(allTxns, accountId), [allTxns, accountId]);
  // 已勾选合计 / 差额：始终按整账户（全部 rows），筛选只影响展示
  const checkedSum = useMemo(() => allRows.reduce((s, r) => (checked.has(r.pid) ? s + r.amount : s), 0), [allRows, checked]);
  // 当前筛选（某账本）下的小计——对完整账户后核对各账本贡献
  const filteredCheckedSum = bookFilter === 'all' ? null : rows.reduce((s, r) => (checked.has(r.pid) ? s + r.amount : s), 0);

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
    if (busy) return;
    // 反馈而非静默禁用：差额缺/不为 0 时点「完成对账」，明确告诉用户卡在哪、怎么解（而非按钮灰着没反应）。
    if (diff === null) {
      setErr('请先填写对账单余额，再完成对账。');
      return;
    }
    if (diff !== 0) {
      setErr(`差额 ${fmtMoney(diff, curCode)} 未对平：请补录漏记 / 修正金额 / 或记一笔盘盈盘亏调整后再完成。`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const checkedIds = allRows.filter((r) => checked.has(r.pid)).map((r) => r.pid);
      const uncheckedIds = allRows.filter((r) => !checked.has(r.pid)).map((r) => r.pid);
      await repo.setPostingsCleared(checkedIds, true);
      if (uncheckedIds.length) await repo.setPostingsCleared(uncheckedIds, false);
      await repo.addReconciliation({
        id: genId(),
        bookId: homeBookId, // 对账记录挂账户 home 账本（仅元数据；查询按 accountId）
        accountId,
        statementBalance: stmtMinor!,
        statementDate: stmtDate,
        completedAt: new Date().toISOString(),
      });
      await reload();
      setMsg(`已完成对账：「${selAccount?.name ?? '账户'}」余额与对账单 ${fmtMoney(stmtMinor!, curCode)} 相符，${checkedIds.length} 笔已核销。`);
    } finally {
      setBusy(false);
    }
  }

  /** 逃生口：差额查不出错时，记一笔盘盈盘亏调整把差额对平，并自动勾选这笔调整（落账户 home 账本）。 */
  async function adjust(): Promise<void> {
    if (diff === null || diff === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      let gl = accounts.find((a) => a.type === 'income' && a.name === GAIN_LOSS && a.bookId === homeBookId);
      if (!gl) {
        gl = await repo.addAccount({ id: genId(), bookId: homeBookId, name: GAIN_LOSS, type: 'income', parentId: null, currency: 'CNY', archived: false });
      }
      const entry = adjustBalanceEntry(
        { bookId: homeBookId, date: stmtDate, accountId, currentBalance: checkedSum, targetValue: stmtMinor!, counterAccountId: gl.id, currency: curCode, note: '对账盘盈盘亏调整' },
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

  /** 内联补录一笔漏记的收支（落对账账户 + 用户所选账本的收支分类），并自动勾选。 */
  async function addMissing(): Promise<void> {
    if (busy) return;
    setErr(null);
    const major = Number(aAmount);
    if (!Number.isFinite(major) || major <= 0) {
      setErr('请输入有效的补录金额');
      return;
    }
    if (!aBook) {
      setErr('请选择补录归属账本');
      return;
    }
    if (aKind === 'transfer') {
      if (!effCounter) {
        setErr('请选择转账的对手账户');
        return;
      }
    } else if (!effACat) {
      setErr(`「${bookName(aBook)}」没有${aKind === 'income' ? '收入' : '支出'}分类，先去该账本「账户」页加一个`);
      return;
    }
    setBusy(true);
    try {
      const amountMinor = toMinor(major, dec);
      // 转账（内部划转，如理财申购）：本对账账户与对手资金账户互转，按方向定 from/to——不再被迫记成收/支（错口径）。
      const input: EntryInput =
        aKind === 'transfer'
          ? {
              kind: 'transfer',
              bookId: aBook,
              date: aDate,
              amount: amountMinor,
              currency: curCode,
              ...(aTransferOut ? { fromAccountId: accountId, toAccountId: effCounter } : { fromAccountId: effCounter, toAccountId: accountId }),
              payee: '对账补录',
              note: '',
            }
          : { kind: aKind, bookId: aBook, date: aDate, amount: amountMinor, currency: curCode, payee: '对账补录', accountId, categoryId: effACat };
      const entry = expandEntry(input, genId);
      await repo.addTransaction(entry);
      const newPosting = entry.postings.find((p) => p.accountId === accountId)!;
      setChecked((prev) => new Set(prev).add(newPosting.id));
      setAAmount('');
      setAddOpen(false);
      // 从漏记列表「精确移除」已补的那一行（而非清空整列）——可连续补下一条；防同一行重复补录靠"它已不在列表里"。
      if (prefillFromIdx !== null) {
        setMatchInfo((prev) => (prev ? { ...prev, matched: prev.matched + 1, unmatched: prev.unmatched.filter((_, i) => i !== prefillFromIdx) } : prev));
      }
      setPrefillFromIdx(null);
      await reload();
      setMsg('已补录一笔并自动勾选。');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '补录失败');
    } finally {
      setBusy(false);
    }
  }

  /** 导入账单自动勾对：解析账单 → 把行折成与本账户同口径的有符号金额 → matchStatement → 自动勾选命中、记漏记。 */
  async function onMatchFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重选同名文件
    if (!file) return;
    setMatchBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const parsed = await parseImportFile(matchSource, file);
      // 进账+ / 出账−，与账户分录 amount 同口径。常见「出账=支出 / 进账=收入」路径成立；信用卡还款、
      // 退款冲正等反向场景符号可能不符，请在下方流水里手动核对再完成对账（金额相等但方向相反会错配）。
      const signed = (r: { direction: 'in' | 'out'; amountMinor: number }): number => (r.direction === 'in' ? r.amountMinor : -r.amountMinor);
      const items: StatementItem[] = parsed.rows.map((r) => ({ signedAmount: signed(r), date: r.date }));
      // 只配**未核销**分录：已 cleared 的是往期已对账分录，纳入会挤占本期账单行的坑位 → 假漏记 → 诱导重复补录
      const ledger = allRows.filter((r) => !r.cleared).map((r) => ({ id: r.pid, amount: r.amount, date: r.date }));
      const res = matchStatement(items, ledger, 3);
      setChecked((prev) => {
        const next = new Set(prev);
        for (const id of res.matchedIds) next.add(id);
        return next;
      });
      const unmatched = res.unmatchedIndexes.map((i) => {
        const r = parsed.rows[i]!;
        return { date: r.date, payee: r.payee, signedAmount: signed(r), direction: r.direction, suggestion: r.suggestion };
      });
      setMatchInfo({ total: parsed.rows.length, matched: res.matchedIds.length, unmatched });
      setMsg(
        `「${file.name}」共 ${parsed.rows.length} 笔：自动勾选 ${res.matchedIds.length} 笔已记账，${unmatched.length} 笔账里没有（漏记，下方可补录）。核对差额到 0 即可完成对账。`,
      );
    } catch (err) {
      setErr(`对账单解析失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMatchBusy(false);
    }
  }

  /** 把一笔漏记的账单行预填进「补录」表单（类型/金额/日期/对手），用户确认后补录并自动勾选、从漏记列表消解。 */
  function prefillAdd(u: { date: string; direction: 'in' | 'out'; signedAmount: number; suggestion: string }, idx: number): void {
    setAddOpen(true);
    // 智能默认类型：内部划转（理财申购等）→ 转账（按方向定转出/转入）；否则按方向收/支。用户仍可改。
    const isTransfer = u.suggestion === 'transfer-in' || u.suggestion === 'transfer-out';
    setAKind(isTransfer ? 'transfer' : u.direction === 'in' ? 'income' : 'expense');
    setATransferOut(u.direction === 'out');
    setAAmount(String(Math.abs(u.signedAmount) / 10 ** dec));
    setADate(u.date);
    setABook(selAccount?.global ? (liveBooks[0]?.id ?? '') : homeBookId);
    setPrefillFromIdx(idx);
    setErr(null);
  }

  /** 内联删除一笔（重复 / 错记）——整笔交易软删，保留其余勾选进度。 */
  async function removeRow(row: { txnId: string; cleared: boolean }): Promise<void> {
    if (busy) return;
    const warn = row.cleared
      ? '这笔已核销，删除会影响已完成的对账记录。确定删除整笔交易？'
      : '删除整笔交易（含其对方分录）？此操作不可撤销。';
    if (!confirm(warn)) return;
    setBusy(true);
    setErr(null);
    try {
      await repo.softDeleteTransaction(row.txnId);
      await reload();
      setMsg('已删除一笔。');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  if (recAccounts.length === 0) {
    return (
      <>
        <div className="main-head">
          <h2>对账</h2>
        </div>
        <div className="card">
          <p className="muted">还没有资产/负债账户可对账。先到某账本「账户」页添加。</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="main-head">
        <h2>对账</h2>
        <span className="muted">勾对式 · 按账户跨账本</span>
      </div>

      <div className="card">
        <div className="rec-setup">
          <label>
            对账账户
            <select value={accountId} onChange={(e) => selectAccount(e.target.value)}>
              {recAccounts.map((a) => {
                const n = unclearedCount(allTxns, a.id);
                return (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.global ? '全局共享' : bookName(a.bookId)}
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
            const n = unclearedCount(allTxns, accountId);
            return n > 0 ? <> · {n} 笔待核销</> : <> · 已全部核销 ✓</>;
          })()}
          {selAccount?.global && <> · 全局共享（流水来自各账本）</>}
          {lastRec && <> · 上次对账 {lastRec.statementDate}（{fmtMoney(lastRec.statementBalance, curCode)}）</>}
        </div>
      </div>

      <div className="card">
        <h3>
          导入账单自动勾对 <span className="mini">可选 · 账单流水 ↔ 已记账</span>
        </h3>
        <p className="muted small">
          上传该账户的支付宝 / 微信账单，自动勾选金额、日期对得上的已记账流水；账单上有、账里没有的（漏记）列在下方可一键补录。算账与匹配在本地执行，文件不上传云端。
        </p>
        <div className="brow" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select
            value={matchSource}
            onChange={(e) => {
              setMatchSource(e.target.value as ImportSource);
              setMatchInfo(null); // 换源清掉上一次的漏记快照，避免跨源残留
            }}
          >
            {(Object.keys(SOURCE_LABELS) as ImportSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
          <input type="file" accept={matchSource === 'wechat-bill' ? '.xlsx' : '.csv,.txt'} disabled={matchBusy} onChange={(e) => void onMatchFile(e)} />
        </div>
        {matchInfo && matchInfo.unmatched.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="small" style={{ margin: '0 0 6px' }}>
              账单上有、账里没有（漏记 {matchInfo.unmatched.length} 笔）——<span className="muted">补录前请确认下方流水里确实没有同金额的这笔，避免重复记账。</span>
            </p>
            {matchInfo.unmatched.map((u, i) => (
              <div className="brow" key={i} style={{ alignItems: 'center' }}>
                <span className="muted small" style={{ width: 84 }}>{u.date}</span>
                <span style={{ flex: 1 }}>{u.payee || <span className="muted">（无对方）</span>}</span>
                <span className={`rec-amt ${u.signedAmount < 0 ? 'neg' : 'pos'}`}>{fmtMoney(u.signedAmount, curCode)}</span>
                <button className="lnk" onClick={() => prefillAdd(u, i)} disabled={busy || matchBusy}>
                  补录这笔
                </button>
              </div>
            ))}
          </div>
        )}
        {matchInfo && matchInfo.unmatched.length === 0 && matchInfo.total > 0 && (
          <p className="small" style={{ marginTop: 8 }}>账单 {matchInfo.total} 笔全部对上已记账 ✓</p>
        )}
      </div>

      <div className="card">
        <h3>
          流水勾对 <span className="mini">{rows.length} 笔{bookFilter !== 'all' ? ` · 本账本已勾选 ${fmtMoney(filteredCheckedSum ?? 0, curCode)}` : ''}</span>
        </h3>
        {rowBooks.length > 1 && (
          <div className="rec-bookfilter">
            <button className={`chip${bookFilter === 'all' ? ' on' : ''}`} onClick={() => setBookFilter('all')}>
              全部账本
            </button>
            {rowBooks.map((bid) => (
              <button key={bid} className={`chip${bookFilter === bid ? ' on' : ''}`} onClick={() => setBookFilter(bid)}>
                {bookName(bid)}
              </button>
            ))}
          </div>
        )}
        {rows.length === 0 ? (
          <p className="muted">该账户暂无流水。</p>
        ) : (
          <div className="rec-list">
            {rows.map((r) => (
              <label className={`rec-row${checked.has(r.pid) ? ' on' : ''}`} key={r.pid}>
                <input type="checkbox" checked={checked.has(r.pid)} onChange={() => toggle(r.pid)} />
                <span className="rec-date">{r.date}</span>
                <span className="rec-title">
                  {r.title}
                  {rowBooks.length > 1 && <span className="chip"> {bookName(r.bookId)}</span>}
                </span>
                <span className={`rec-amt ${r.amount < 0 ? 'neg' : 'pos'}`}>{fmtMoney(r.amount, curCode)}</span>
                <button
                  className="del rec-del"
                  title="删除这笔（错记/重复）"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void removeRow(r);
                  }}
                  disabled={busy}
                >
                  ×
                </button>
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
          <button
            className="btn"
            title="对账单上有、账里漏记的款项"
            onClick={() => {
              setAddOpen(true);
              setADate(stmtDate);
              setABook(selAccount?.global ? (liveBooks[0]?.id ?? '') : homeBookId);
              setPrefillFromIdx(null); // 通用补录入口（非从某条漏记预填）→ 不动漏记列表
              setErr(null);
            }}
          >
            ＋ 补录一笔
          </button>
          {diff !== null && diff !== 0 && (
            <button className="btn" onClick={() => void adjust()} disabled={busy}>
              记盘盈盘亏调整 {fmtMoney(diff, curCode)}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void complete()} disabled={busy}>
            完成对账
          </button>
        </div>
        {!stmtValid && stmtTrim !== '' && <p className="form-err">对账单余额需为数字</p>}
        {!addOpen && err && <p className="form-err">{err}</p>}
        {msg && <p className="rec-ok">{msg}</p>}
      </div>

      {addOpen && (
        <div className="rec-float" role="dialog" aria-label="补录一笔">
          <div className="rec-float-head">
            <h4>补录一笔{prefillFromIdx !== null ? '（漏记预填）' : ''}</h4>
            <button className="rec-float-x" title="关闭" onClick={() => setAddOpen(false)}>×</button>
          </div>
          <div className="qgrid">
            <label>
              归属账本
              <select value={aBook} onChange={(e) => setABook(e.target.value)} disabled={addBookOptions.length <= 1}>
                {addBookOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              类型
              <select value={aKind} onChange={(e) => setAKind(e.target.value as AddKind)}>
                <option value="expense">支出</option>
                <option value="income">收入</option>
                <option value="transfer">转账（内部划转）</option>
              </select>
            </label>
            <label>
              金额（{currencyDef(curCode).symbol}）
              <input inputMode="decimal" value={aAmount} onChange={(e) => setAAmount(e.target.value)} placeholder="0.00" />
            </label>
            {aKind === 'transfer' ? (
              <>
                <label>
                  方向
                  <select value={aTransferOut ? 'out' : 'in'} onChange={(e) => setATransferOut(e.target.value === 'out')}>
                    <option value="out">转出（本账户 → 对手）</option>
                    <option value="in">转入（对手 → 本账户）</option>
                  </select>
                </label>
                <label>
                  对手账户
                  <select value={effCounter} onChange={(e) => setACounterId(e.target.value)}>
                    {counterAccounts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label>
                分类
                <select value={effACat} onChange={(e) => setACatId(e.target.value)}>
                  {addCats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              日期
              <input type="date" value={aDate} onChange={(e) => setADate(e.target.value)} />
            </label>
          </div>
          <div className="arow-btns" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => void addMissing()} disabled={busy}>
              补录并勾选
            </button>
            <button className="lnk" onClick={() => setAddOpen(false)}>取消</button>
          </div>
          {err && <p className="form-err" style={{ marginTop: 8 }}>{err}</p>}
        </div>
      )}
    </>
  );
}
