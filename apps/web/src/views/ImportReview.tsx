import { useEffect, useMemo, useState } from 'react';
import type { StagingPostDecision } from '@app/core';
import type { Repository, StoredAccount, StoredBook, StoredStagingBatch, StoredStagingRow } from '@app/store';
import { fmtMoney, todayISO } from '../format';
import {
  createImportBatch,
  loadCounterpartyMemory,
  postStagingRow,
  recallCounterparty,
  rememberCounterparties,
  revertImportBatch,
  settleImportRow,
  skipStagingRow,
} from '../import';
import type { CounterpartyMemory } from '../import';
import { suggestImportSettlements } from '../biz';
import type { SettleSuggestion } from '../biz';
import { parseImportFile, SOURCE_LABELS } from '../import-files';
import type { ImportSource } from '../import-files';
import { parseOcrImageFile } from '../import-ocr';
import { isDesktop } from '../db';

/** 批次来源标签：账单文件源走 SOURCE_LABELS；OCR 图片识别另立。 */
const srcLabel = (s: string): string => (s === 'ocr' ? '图片识别（OCR）' : (SOURCE_LABELS[s as ImportSource] ?? s));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Kind = StagingPostDecision['kind'];
/** 出口（增量3）：plain＝裸收支（现有 kind 路径）；settle＝核销已有应收/应付。draft（建草稿）后置 M18。 */
type Outlet = 'plain' | 'settle';
interface RowDecision {
  bookId: string;
  kind: Kind | '';
  accountId: string;
  /** 可编辑日期（OCR 草稿可能未识别日期；落库前须为合法 YYYY-MM-DD）。 */
  date: string;
  /** 出口路由：有核销建议默认 settle，否则 plain。 */
  outlet: Outlet;
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
  const [suggestions, setSuggestions] = useState<Record<string, SettleSuggestion>>({}); // 出口①核销建议（rowId → 建议）
  const [mem, setMem] = useState<CounterpartyMemory>({});
  const [payeeFilter, setPayeeFilter] = useState<string | null>(null); // 「筛选同名」：只看某对方的待复核行

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
      const cur = d[rowId] ?? { bookId: '', kind: '', accountId: '', date: '', outlet: 'plain' };
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
    // 出口①：逐行算核销建议（对方名精确命中客户/供应商 + 有未结清 → 建议核销）。生活账本自然无建议。
    const sugMap = await suggestImportSettlements(
      repo,
      books,
      r.map((row) => ({ id: row.id, direction: row.direction, payee: row.payee, amountMinor: row.amountMinor })),
      b.accountId,
      todayISO(),
    );
    const sugObj: Record<string, SettleSuggestion> = {};
    sugMap.forEach((v, k) => { sugObj[k] = v; });
    const init: Record<string, RowDecision> = {};
    for (const row of r) {
      const recalled = recallCounterparty(m, row.payee);
      const kind = defaultKind(row.suggestion, row.direction);
      let bookId = recalled?.bookId ?? '';
      let accountId = recalled?.accountId ?? '';
      // 校验记忆预填：账本须仍活跃、对手腿须在「当前 kind+账本」可选集内，否则清空——
      // 防受控 select 显示为空但 state 仍持旧 id，被 plainComplete() 当已指派而静默错记（如收入科目落成支出/转账腿）。
      if (bookId && !books.some((bk) => bk.id === bookId)) {
        bookId = '';
        accountId = '';
      }
      if (accountId && !accountsFor(kind, bookId, b.accountId).some((a) => a.id === accountId)) {
        accountId = '';
      }
      // 有核销建议 → 默认预选核销（用户拍板：匹配是建议、postAll 才落库＝仍是确认非静默；保留一键改裸收支）。
      init[row.id] = { kind, bookId, accountId, date: row.date, outlet: sugObj[row.id] ? 'settle' : 'plain' };
    }
    setMem(m); // 与「套用同类全填」共用同一记忆快照（本批开台即载入）
    setSuggestions(sugObj);
    setPayeeFilter(null);
    setActive(b);
    setRows(r);
    setDecisions(init);
  }

  /** 裸收支出口齐活：类型 + 账本 + 对手腿账户 + 合法日期。 */
  function plainComplete(d: RowDecision | undefined): boolean {
    return !!d && !!d.kind && !!d.bookId && !!d.accountId && ISO_DATE.test(d.date);
  }
  /** 一行是否可入账（按出口分叉）：settle＝有核销建议 + 合法日期；plain＝plainComplete。 */
  function ready(rowId: string, d: RowDecision | undefined): boolean {
    if (!d) return false;
    if (d.outlet === 'settle') return !!suggestions[rowId] && ISO_DATE.test(d.date);
    return plainComplete(d);
  }
  const assignedCount = rows.filter((r) => ready(r.id, decisions[r.id])).length;

  // 同名笔数（≥2 才给「筛选同名」入口；单笔无须筛）
  const payeeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const p = r.payee.trim();
      if (p) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  // 展示用行集：先按「筛选同名」过滤，再「未复核在上、已复核沉底」稳定排序（只动展示、不改 rows 源序与落库范围）
  const viewRows = useMemo(() => {
    const base = payeeFilter ? rows.filter((r) => r.payee.trim() === payeeFilter) : rows;
    return [...base].sort((a, b) => Number(ready(a.id, decisions[a.id])) - Number(ready(b.id, decisions[b.id])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, payeeFilter, decisions, suggestions]);

  /**
   * 顶部「套用同类全填」：把本批每条**未完成**待复核行的 账本 + 对手腿账户，用「同一对方」的模板填上。
   * 模板优先取**本批已填好的同名行**（用户刚教的一行 → 首批也能铺），其次取**持久对方记忆**（重复导入自动套）。
   * 红线：类型恒按账单解析器（不读记忆）→ 划转方向永不被翻转；账户须在该类型+账本下合法才填；
   * 绝不覆盖用户已填的字段或已完整的行。空对方名跳过。
   */
  function fillSameCounterparty(scope: StoredStagingRow[] = rows): void {
    if (!active) return;
    // 本批同名模板：对方(trim) → 某条「完整」决定的 {bookId, accountId}（取首条命中）。模板取自全批，
    // 故即便筛选只填某组，其它组已填好的同名行也能当模板（scope 只限定「填哪些」、不限定「拿谁当样板」）。
    const tpl = new Map<string, { bookId: string; accountId: string }>();
    for (const row of rows) {
      const d = decisions[row.id];
      const p = row.payee.trim();
      // 模板只取裸收支已填好的行：核销(settle)行无 bookId+科目语义、不作模板。
      if (p && d?.outlet !== 'settle' && plainComplete(d) && !tpl.has(p)) tpl.set(p, { bookId: d!.bookId, accountId: d!.accountId });
    }
    const next: Record<string, RowDecision> = { ...decisions };
    let filled = 0;
    let hadIncomplete = false;
    for (const row of scope) {
      const cur: RowDecision = next[row.id] ?? { bookId: '', kind: '', accountId: '', date: row.date, outlet: 'plain' };
      if (cur.outlet === 'settle' || plainComplete(cur)) continue; // 核销行不套用裸收支模板；已填好的行不动
      hadIncomplete = true;
      // 类型恒取解析器（或用户已选），不读记忆 → 划转方向永不被翻转（红线）。
      // 解析器拿不准的「待定」行（转账/红包，kind=''）整行跳过：缺类型无法选对手账户，半填只会误导。
      const kind = cur.kind || defaultKind(row.suggestion, row.direction);
      if (!kind) continue;
      const p = row.payee.trim();
      if (!p) continue;
      const t = tpl.get(p) ?? recallCounterparty(mem, row.payee);
      if (!t) continue;
      // 只对「模板注入」的字段做合法性校验，不碰用户已填的字段（避免误清；自防御、不依赖别处的 UI 不变量）。
      let bookId = cur.bookId;
      if (!bookId && t.bookId && books.some((b) => b.id === t.bookId)) bookId = t.bookId;
      let accountId = cur.accountId;
      // 注入账户须有账本、且在「该类型+账本」下合法（划转排除源账户、收支须该账本科目）——防记忆/同名跨类型错填、防无账本裸账户。
      if (!accountId && bookId && t.accountId && accountsFor(kind, bookId, active.accountId).some((a) => a.id === t.accountId)) {
        accountId = t.accountId;
      }
      if (kind !== cur.kind || bookId !== cur.bookId || accountId !== cur.accountId) {
        next[row.id] = { ...cur, kind, bookId, accountId };
        filled++;
      }
    }
    setDecisions(next);
    const remaining = scope.filter((r) => !ready(r.id, next[r.id])).length;
    if (filled > 0) {
      setMsg(`已按同名 / 历史记忆套用 ${filled} 行（类型仍按账单，账户已校验）${remaining ? `，仍有 ${remaining} 行待指派` : ''}。`);
    } else if (!hadIncomplete) {
      setMsg('本批待复核行都已指派，无需套用。');
    } else {
      setMsg('没有可套用的同名行或历史记忆，请手动指派。');
    }
  }

  async function postAll(): Promise<void> {
    if (!active) return;
    setBusy(true);
    const remembers: Array<{ payee: string; bookId: string; accountId: string }> = [];
    // 建议是开台时一次性快照、不随本批已核销递减。同批多条核销同一张应收单时，第二条若仍指同一 orderId，会把它顶到该单
    // 溢出为预收；这里对「本批已占用的 orderId」去重——后续重复者降级为 orderId=null 走客户级 FIFO，自然摊到下一张欠款单（更准）。
    const consumedOrderIds = new Set<string>();
    let posted = 0;
    let failed = 0;
    for (const row of rows) {
      const d = decisions[row.id];
      if (!ready(row.id, d)) continue;
      try {
        // 用复核台编辑后的日期落库（OCR 可能未识别日期 → 用户补填；core 兜死非法日期）。
        if (d!.outlet === 'settle') {
          // 出口①核销：把流水核销到已有应收/应付（不造裸收支 entry）。settle 行不写对方记忆（无 bookId+科目语义）。
          const sug = suggestions[row.id]!;
          const book = books.find((bk) => bk.id === sug.bookId)!;
          const orderId = sug.orderId && !consumedOrderIds.has(sug.orderId) ? sug.orderId : null;
          if (orderId) consumedOrderIds.add(orderId);
          await settleImportRow(repo, active, book, { ...row, date: d!.date }, { counterpartyType: sug.counterpartyType, entityId: sug.entityId, orderId, assetAccountId: sug.assetAccountId });
          posted++;
        } else {
          await postStagingRow(repo, active, { ...row, date: d!.date }, { kind: d!.kind as Kind, bookId: d!.bookId, accountId: d!.accountId });
          posted++;
          // 记住「对方 → 账本 + 对手腿账户」：四种 kind 都记（含内部划转的对手资金账户），下次导入自动预填——P2 持久对方记忆。
          // 类型不入记忆（恒按账单解析器定），故划转方向永不被记忆翻转（红线）。
          remembers.push({ payee: row.payee, bookId: d!.bookId, accountId: d!.accountId });
        }
      } catch {
        failed++;
      }
    }
    if (remembers.length) await rememberCounterparties(repo, remembers);
    const left = await repo.listStagingRows({ batchId: active.id, status: 'pending' });
    if (left.length === 0) await repo.updateStagingBatch(active.id, { status: 'committed' });
    setRows(left);
    setPayeeFilter(null); // 入账后行集变了，清掉筛选回到全部
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
    await revertImportBatch(repo, b.id, todayISO());
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
              <button className="lnk danger" disabled={busy} onClick={() => void onRevert(b)}>
                撤销整批
              </button>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div className="card">
          <h3>
            复核：{active.label} <span className="muted small">（{rows.length} 笔 · 已指派 {assignedCount}）</span>
          </h3>
          {rows.length > 0 &&
            (payeeFilter ? (
              <div className="imp-filterbar">
                <span>筛选同名：<b>{payeeFilter}</b> · {viewRows.length} 笔</span>
                <button className="lnk" disabled={busy} onClick={() => fillSameCounterparty(viewRows)}>全填本组</button>
                <button className="lnk" onClick={() => setPayeeFilter(null)}>清除筛选</button>
              </div>
            ) : (
              <div className="brow" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <button className="lnk" disabled={busy} onClick={() => fillSameCounterparty()}>套用同类全填</button>
                <span className="muted small">按本批同名对方 / 历史记忆补上未指派行的账本与对手账户（类型仍按账单）；点某行「筛选同名」可只看该对方、分组填。</span>
              </div>
            ))}
          {rows.length === 0 ? (
            <p className="muted small">本批没有待复核的草稿行。</p>
          ) : (
            <>
              {payeeFilter && viewRows.length === 0 && (
                <p className="muted small">该对方已无待复核行。<button className="lnk" onClick={() => setPayeeFilter(null)}>清除筛选</button></p>
              )}
              {viewRows.map((row) => {
                const d: RowDecision = decisions[row.id] ?? { bookId: '', kind: '', accountId: '', date: row.date, outlet: 'plain' };
                const sug = suggestions[row.id];
                const isSettle = d.outlet === 'settle';
                const acctOpts = accountsFor(d.kind, d.bookId, active.accountId);
                const amt = row.direction === 'out' ? -row.amountMinor : row.amountMinor;
                const done = ready(row.id, d);
                const p = row.payee.trim();
                return (
                  <div key={row.id} className={`brow imp-row${done ? ' done' : ''}`} style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center', borderTop: '1px solid var(--line, #eee)', paddingTop: 8 }}>
                    {done && <span className="imp-tick" title="已复核">✓</span>}
                    <input type="date" value={d.date} onChange={(e) => setDec(row.id, { date: e.target.value })} style={{ width: 132 }} title="记账日期（可改）" />
                    <span style={{ flex: 1, minWidth: 120 }}>
                      {row.payee || <span className="muted">（无对方）</span>}
                      {row.note && <span className="muted small"> · {row.note}</span>}
                      <span className="chip" style={{ marginLeft: 6 }}>{SUGGEST_LABEL[row.suggestion] ?? row.suggestion}</span>
                    </span>
                    <span className={`bnum${amt < 0 ? ' neg' : ''}`} style={{ width: 96, textAlign: 'right' }}>{fmtMoney(amt)}</span>
                    {/* 出口路由：仅当有核销建议（命中客户/供应商且有未结清）才出现；生意账本以外的行无此控件。 */}
                    {sug && (
                      <select value={d.outlet} onChange={(e) => setDec(row.id, { outlet: e.target.value as Outlet })} title="这笔生意流水的去向">
                        <option value="settle">核销</option>
                        <option value="plain">裸收支</option>
                        <option value="draft" disabled>建单据草稿（即将推出）</option>
                      </select>
                    )}
                    {isSettle && sug ? (
                      <span className="chip" style={{ minWidth: 200, background: 'var(--bg-accent, #eef2ff)' }} title={sug.matchedExact ? '金额与某单据相等，已预选核销该单' : '金额非整单，按最早欠款优先核销'}>
                        核销 → {sug.entityName} · {row.direction === 'in' ? '应收' : '应付'} {fmtMoney(sug.outstandingTotal)}{sug.orderId ? ' · 指定订单' : ' · 最早欠款优先'}
                      </span>
                    ) : (
                      <>
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
                      </>
                    )}
                    {!payeeFilter && p !== '' && (payeeCounts.get(p) ?? 0) >= 2 && (
                      <button className="lnk" title="只看该对方的同名流水、分组填" onClick={() => setPayeeFilter(p)}>筛选同名</button>
                    )}
                    <button className="lnk" onClick={() => void onSkip(row.id)}>跳过</button>
                  </div>
                );
              })}
              <div className="imp-foot">
                <button className="btn btn-primary" disabled={busy || assignedCount === 0} onClick={() => void postAll()}>
                  确认入账（{payeeFilter ? '全批 ' : ''}{assignedCount} 笔已指派）
                </button>
                {assignedCount < rows.length && <span className="muted small">未复核 {rows.length - assignedCount} 笔{payeeFilter ? '（含其它对方）' : ''}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
