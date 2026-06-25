import { useEffect, useMemo, useState } from 'react';
import type { StagingPostDecision } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredStagingBatch, StoredStagingRow } from '@app/store';
import { fmtMoney } from '../format';
import {
  createImportBatch,
  loadCounterpartyMemory,
  postStagingRow,
  recallCounterparty,
  rememberCounterparties,
  revertImportBatch,
  skipStagingRow,
} from '../import';
import type { CounterpartyMemory } from '../import';
import { parseImportFile, SOURCE_LABELS } from '../import-files';
import type { ImportSource } from '../import-files';
import { parseOcrImageFile } from '../import-ocr';
import { isDesktop } from '../db';

/** 批次来源标签：账单文件源走 SOURCE_LABELS；OCR 图片识别另立。 */
const srcLabel = (s: string): string => (s === 'ocr' ? '图片识别（OCR）' : (SOURCE_LABELS[s as ImportSource] ?? s));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Kind = StagingPostDecision['kind'];
interface RowDecision {
  bookId: string;
  kind: Kind | '';
  accountId: string;
  /** 可编辑日期（OCR 草稿可能未识别日期；落库前须为合法 YYYY-MM-DD）。 */
  date: string;
}

const KIND_OPTS: Array<[Kind, string]> = [
  ['income', '收入'],
  ['expense', '支出'],
  ['transfer-out', '转出'],
  ['transfer-in', '转入'],
];

/** 建议 → 默认 kind。unknown / 双关 → 空（红线：人工定夺，不按 direction 兜底）。 */
function defaultKind(suggestion: string, direction: 'in' | 'out'): Kind | '' {
  switch (suggestion) {
    case 'income':
    case 'expense':
    case 'transfer-in':
    case 'transfer-out':
      return suggestion;
    case 'refund':
      return direction === 'in' ? 'income' : 'expense'; // 退款折成 income/expense（复核台可改科目）
    default:
      return '';
  }
}

const SUGGEST_LABEL: Record<string, string> = {
  income: '收入',
  expense: '支出',
  'transfer-in': '转入',
  'transfer-out': '转出',
  refund: '退款',
  unknown: '待定',
};

export default function ImportReview({
  repo,
  books,
  accounts,
  reload,
}: {
  repo: Repository;
  books: StoredBook[];
  accounts: StoredAccount[];
  reload: () => Promise<void>;
}): React.ReactElement {
  const globalAccounts = useMemo(
    () => accounts.filter((a) => a.global && (a.type === 'asset' || a.type === 'liability') && !a.archived),
    [accounts],
  );

  const [source, setSource] = useState<ImportSource>('alipay-fund-flow');
  const [srcAccount, setSrcAccount] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [batches, setBatches] = useState<StoredStagingBatch[]>([]);
  const [active, setActive] = useState<StoredStagingBatch | null>(null);
  const [rows, setRows] = useState<StoredStagingRow[]>([]);
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});
  const [, setMem] = useState<CounterpartyMemory>({});

  useEffect(() => {
    if (!srcAccount && globalAccounts[0]) setSrcAccount(globalAccounts[0].id);
  }, [globalAccounts, srcAccount]);

  async function refreshBatches(): Promise<void> {
    const all = await repo.listStagingBatches();
    setBatches(all.filter((b) => b.status !== 'reverted'));
    setMem(await loadCounterpartyMemory(repo));
  }
  useEffect(() => {
    void refreshBatches();
  }, []);

  /** 该 kind+账本下可选的对手腿账户：income/expense=该账本收入/支出科目；transfer=其它全局资金账户（排除源账户）。 */
  function accountsFor(kind: Kind | '', bookId: string, sourceAccountId: string): StoredAccount[] {
    if (!kind) return [];
    if (kind === 'income') return accounts.filter((a) => a.bookId === bookId && a.type === 'income' && !a.archived);
    if (kind === 'expense') return accounts.filter((a) => a.bookId === bookId && a.type === 'expense' && !a.archived);
    return globalAccounts.filter((a) => a.id !== sourceAccountId);
  }

  function setDec(rowId: string, patch: Partial<RowDecision>): void {
    setDecisions((d) => {
      const cur = d[rowId] ?? { bookId: '', kind: '', accountId: '', date: '' };
      const next: RowDecision = { ...cur, ...patch };
      // 改 kind / 账本 → 旧科目可能不在新选项里，清空待重选
      if ((patch.kind !== undefined && patch.kind !== cur.kind) || (patch.bookId !== undefined && patch.bookId !== cur.bookId)) {
        next.accountId = '';
      }
      return { ...d, [rowId]: next };
    });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重选同名文件
    if (!file) return;
    if (!srcAccount) {
      setMsg('请先选择导入到哪个全局账户。');
      return;
    }
    setBusy(true);
    try {
      const parsed = await parseImportFile(source, file);
      const res = await createImportBatch(repo, { source, accountId: srcAccount, label: file.name }, parsed.rows);
      const warn = parsed.warnings.length ? `，${parsed.warnings.length} 行有提示被跳过` : '';
      if (!res.batch) {
        setMsg(
          parsed.rows.length === 0
            ? `没从「${file.name}」解析出任何记录，请确认文件来源与格式是否匹配（如支付宝资金流水 CSV / 微信账单 xlsx）${warn}。`
            : `「${file.name}」共 ${parsed.rows.length} 笔，全部已导入过、无新增${warn}。`,
        );
      } else {
        setMsg(`「${file.name}」新增 ${res.added} 笔待复核${res.skipped ? `，${res.skipped} 笔重复跳过` : ''}${warn}。`);
        await openBatch(res.batch);
      }
      await refreshBatches();
    } catch (err) {
      setMsg(`解析失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 上传单笔截图 → 本地 OCR 起草（desktop-only）→ 同一复核台。OCR 粗、warnings 多，落库前人工逐笔核对。 */
  async function onOcrFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!srcAccount) {
      setMsg('请先选择导入到哪个全局账户。');
      return;
    }
    setBusy(true);
    try {
      const parsed = await parseOcrImageFile(file);
      if (parsed.rows.length === 0) {
        setMsg(`未能从图片识别出单笔记录：${parsed.warnings.join('；') || '请确认上传的是单笔账单 / 收款详情截图。'}`);
      } else {
        const res = await createImportBatch(repo, { source: 'ocr', accountId: srcAccount, label: `图片识别·${file.name}` }, parsed.rows);
        if (!res.batch) {
          setMsg('这张图识别到的记录此前已导入过，无新增。');
        } else {
          setMsg(`图片识别出 ${res.added} 笔待复核。${parsed.warnings.length ? `提示：${parsed.warnings.join('；')}` : ''}`);
          await openBatch(res.batch);
        }
      }
      await refreshBatches();
    } catch (err) {
      setMsg(`图片识别失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openBatch(b: StoredStagingBatch): Promise<void> {
    const r = await repo.listStagingRows({ batchId: b.id, status: 'pending' });
    const m = await loadCounterpartyMemory(repo);
    const init: Record<string, RowDecision> = {};
    for (const row of r) {
      const recalled = recallCounterparty(m, row.payee);
      const kind = defaultKind(row.suggestion, row.direction);
      let bookId = recalled?.bookId ?? '';
      let accountId = recalled?.accountId ?? '';
      // 校验记忆预填：账本须仍活跃、对手腿须在「当前 kind+账本」可选集内，否则清空——
      // 防受控 select 显示为空但 state 仍持旧 id，被 complete() 当已指派而静默错记（如收入科目落成支出/转账腿）。
      if (bookId && !books.some((bk) => bk.id === bookId)) {
        bookId = '';
        accountId = '';
      }
      if (accountId && !accountsFor(kind, bookId, b.accountId).some((a) => a.id === accountId)) {
        accountId = '';
      }
      init[row.id] = { kind, bookId, accountId, date: row.date };
    }
    setActive(b);
    setRows(r);
    setDecisions(init);
  }

  function complete(d: RowDecision | undefined): boolean {
    return !!d && !!d.kind && !!d.bookId && !!d.accountId && ISO_DATE.test(d.date);
  }
  const assignedCount = rows.filter((r) => complete(decisions[r.id])).length;

  async function postAll(): Promise<void> {
    if (!active) return;
    setBusy(true);
    const remembers: Array<{ payee: string; bookId: string; accountId: string }> = [];
    let posted = 0;
    let failed = 0;
    for (const row of rows) {
      const d = decisions[row.id];
      if (!complete(d)) continue;
      try {
        // 用复核台编辑后的日期落库（OCR 可能未识别日期 → 用户补填；core stagingRowToEntry 兜死非法日期）。
        await postStagingRow(repo, active, { ...row, date: d!.date }, { kind: d!.kind as Kind, bookId: d!.bookId, accountId: d!.accountId });
        posted++;
        if (d!.kind === 'income' || d!.kind === 'expense') remembers.push({ payee: row.payee, bookId: d!.bookId, accountId: d!.accountId });
      } catch {
        failed++;
      }
    }
    if (remembers.length) await rememberCounterparties(repo, remembers);
    const left = await repo.listStagingRows({ batchId: active.id, status: 'pending' });
    if (left.length === 0) await repo.updateStagingBatch(active.id, { status: 'committed' });
    setRows(left);
    setMsg(`已入账 ${posted} 笔${failed ? `，${failed} 笔失败` : ''}。${left.length ? ` 还有 ${left.length} 笔待指派。` : ' 本批已全部处理。'}`);
    if (left.length === 0) setActive(null);
    setBusy(false);
    await reload();
    await refreshBatches();
  }

  async function onSkip(rowId: string): Promise<void> {
    await skipStagingRow(repo, rowId);
    setRows((rs) => rs.filter((r) => r.id !== rowId));
    await refreshBatches();
  }

  async function onRevert(b: StoredStagingBatch): Promise<void> {
    if (!confirm(`撤销「${b.label}」整批？会删除它已入账的交易（余额回退），草稿作废。要重做请重新导入。`)) return;
    setBusy(true);
    await revertImportBatch(repo, b.id);
    if (active?.id === b.id) {
      setActive(null);
      setRows([]);
    }
    setMsg(`已撤销「${b.label}」。`);
    setBusy(false);
    await reload();
    await refreshBatches();
  }

  return (
    <>
      <div className="card">
        <h3>导入账单</h3>
        <p className="muted small">
          上传支付宝 / 微信账单，逐笔核对后落账——当场分清生意 / 生活。算账与去重由本地引擎执行，文件不上传云端。
        </p>
        {globalAccounts.length === 0 ? (
          <p className="muted small">
            还没有「全局账户」。请到任一账本的「账户」页，把你的支付宝 / 微信 / 银行卡设为全局账户，再回来导入。
          </p>
        ) : (
          <>
          <div className="brow" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <select value={source} onChange={(e) => setSource(e.target.value as ImportSource)}>
              {(Object.keys(SOURCE_LABELS) as ImportSource[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
            <span className="muted small">导入到</span>
            <select value={srcAccount} onChange={(e) => setSrcAccount(e.target.value)}>
              {globalAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <input type="file" accept={source === 'wechat-bill' ? '.xlsx' : '.csv,.txt'} disabled={busy} onChange={(e) => void onFile(e)} />
          </div>
          {isDesktop && (
            <div className="brow" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, borderTop: '1px solid var(--line, #eee)', paddingTop: 8 }}>
              <span className="muted small">单笔截图（本地识别）</span>
              <input type="file" accept="image/*" disabled={busy} onChange={(e) => void onOcrFile(e)} />
              <span className="muted small">支付 / 收款详情截图 → 本地 OCR 起草，复核后入账（不上传云端）</span>
            </div>
          )}
          </>
        )}
        {msg && <p className="small" style={{ marginTop: 8 }}>{msg}</p>}
      </div>

      {batches.length > 0 && (
        <div className="card">
          <h3>导入批次</h3>
          {batches.map((b) => (
            <div className="brow" key={b.id} style={{ alignItems: 'center' }}>
              <span className="chip">{b.status === 'committed' ? '已入账' : '复核中'}</span>
              <span style={{ flex: 1 }}>
                {b.label} <span className="muted small">· {srcLabel(b.source)}</span>
              </span>
              {b.status === 'reviewing' && (
                <button className="lnk" onClick={() => void openBatch(b)}>
                  复核
                </button>
              )}
              <button className="lnk danger" onClick={() => void onRevert(b)}>
                撤销整批
              </button>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div className="card">
          <h3>
            复核：{active.label} <span className="muted small">（{rows.length} 笔待指派）</span>
          </h3>
          {rows.length === 0 ? (
            <p className="muted small">本批没有待复核的草稿行。</p>
          ) : (
            <>
              {rows.map((row) => {
                const d = decisions[row.id] ?? { bookId: '', kind: '', accountId: '', date: row.date };
                const acctOpts = accountsFor(d.kind, d.bookId, active.accountId);
                const amt = row.direction === 'out' ? -row.amountMinor : row.amountMinor;
                return (
                  <div key={row.id} className="brow" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center', borderTop: '1px solid var(--line, #eee)', paddingTop: 8 }}>
                    <input type="date" value={d.date} onChange={(e) => setDec(row.id, { date: e.target.value })} style={{ width: 132 }} title="记账日期（可改）" />
                    <span style={{ flex: 1, minWidth: 120 }}>
                      {row.payee || <span className="muted">（无对方）</span>}
                      {row.note && <span className="muted small"> · {row.note}</span>}
                      <span className="chip" style={{ marginLeft: 6 }}>{SUGGEST_LABEL[row.suggestion] ?? row.suggestion}</span>
                    </span>
                    <span className={`bnum${amt < 0 ? ' neg' : ''}`} style={{ width: 96, textAlign: 'right' }}>{fmtMoney(amt)}</span>
                    <select value={d.bookId} onChange={(e) => setDec(row.id, { bookId: e.target.value })}>
                      <option value="">选账本…</option>
                      {books.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <select value={d.kind} onChange={(e) => setDec(row.id, { kind: e.target.value as Kind })}>
                      <option value="">类型…</option>
                      {KIND_OPTS.map(([k, label]) => (
                        <option key={k} value={k}>{label}</option>
                      ))}
                    </select>
                    <select value={d.accountId} onChange={(e) => setDec(row.id, { accountId: e.target.value })} disabled={!d.kind || !d.bookId}>
                      <option value="">{d.kind === 'income' || d.kind === 'expense' ? '选分类…' : '选对手账户…'}</option>
                      {acctOpts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <button className="lnk" onClick={() => void onSkip(row.id)}>跳过</button>
                  </div>
                );
              })}
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-primary" disabled={busy || assignedCount === 0} onClick={() => void postAll()}>
                  确认入账（{assignedCount} 笔已指派）
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
