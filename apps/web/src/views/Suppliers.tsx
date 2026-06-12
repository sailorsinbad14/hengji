import { useEffect, useState } from 'react';
import { fromMinor, toMinor } from '@app/core';
import type { StoredSupplier } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney, todayISO } from '../format';
import { payableBalance, payableSummary, recordSupplierPayment, renameSupplier } from '../biz';

export default function Suppliers({ data }: { data: AppData }) {
  const { repo, book, accounts, txns, reload, convert } = data;
  const [list, setList] = useState<StoredSupplier[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [dueDays, setDueDays] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // 还款表单（按供应商展开）
  const [payFor, setPayFor] = useState<string | null>(null);
  const [pAmount, setPAmount] = useState('');
  const [pDate, setPDate] = useState(todayISO());
  const [pAcct, setPAcct] = useState('');

  async function refresh(): Promise<void> {
    setList(await repo.listSuppliers({ bookId: book.id, includeArchived: true }));
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const rows = list.slice().sort((a, b) => Number(a.archived) - Number(b.archived));
  // 还款付款账户：人民币本位，限 CNY 资产，排除应收/库存商品自管科目（应付为负债，已被资产过滤排除）
  const payAccounts = accounts.filter(
    (a) => a.type === 'asset' && a.currency === 'CNY' && !a.name.startsWith('应收账款') && a.name !== '库存商品',
  );
  const summary = payableSummary(accounts, txns, convert);

  async function add(): Promise<void> {
    setErr(null);
    const nm = name.trim();
    if (!nm) {
      setErr('请输入供应商名称');
      return;
    }
    if (list.some((s) => s.name === nm)) {
      setErr(`已有同名供应商「${nm}」`);
      return;
    }
    const dd = dueDays.trim() === '' ? 0 : Number(dueDays);
    if (!Number.isInteger(dd) || dd < 0) {
      setErr('账期天数需为非负整数');
      return;
    }
    await repo.addSupplier({ id: genId(), bookId: book.id, name: nm, phone: phone.trim(), note: '', dueDays: dd, archived: false });
    setName('');
    setPhone('');
    setDueDays('');
    await refresh();
  }

  async function saveRename(s: StoredSupplier): Promise<void> {
    const nm = draft.trim();
    if (!nm || nm === s.name) {
      setEditId(null);
      return;
    }
    await repo.updateSupplier(s.id, { name: nm });
    await renameSupplier(repo, book, s.name, nm);
    setEditId(null);
    await refresh();
    await reload();
  }

  async function toggleArchive(s: StoredSupplier): Promise<void> {
    if (!s.archived) {
      const owed = payableBalance(accounts, txns, s.name, convert);
      const msg =
        owed > 0
          ? `「${s.name}」还有应付 ${fmtMoney(owed, convert.display)} 未付清，仍要归档？归档后不在进货赊账中出现，历史保留。`
          : `归档「${s.name}」？归档后不在进货赊账中出现，可随时恢复。`;
      if (!confirm(msg)) return;
    }
    await repo.updateSupplier(s.id, { archived: !s.archived });
    await refresh();
  }

  function openPay(s: StoredSupplier): void {
    setErr(null);
    setPayFor(s.id);
    // 应付恒人民币本位：预填按 CNY 计（payableBalance 默认折算到展示币种，这里强制 CNY）
    const owedCny = payableBalance(accounts, txns, s.name, { ...convert, display: 'CNY' });
    setPAmount(owedCny > 0 ? String(fromMinor(owedCny)) : '');
    setPDate(todayISO());
    setPAcct(payAccounts[0]?.id ?? '');
  }

  async function submitPay(s: StoredSupplier): Promise<void> {
    setErr(null);
    const amt = Number(pAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('请输入有效付款金额');
      return;
    }
    if (!pAcct) {
      setErr('没有人民币付款账户（应付按人民币本位，还款需从 CNY 账户付）');
      return;
    }
    try {
      await recordSupplierPayment(repo, book, { supplier: s, amount: toMinor(amt), date: pDate, assetAccountId: pAcct, note: '' });
      setPayFor(null);
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 供应商</h2>
      </div>

      {(summary.payable > 0 || summary.prepaid > 0) && (
        <div className="card">
          <div className="recv-head">
            <h3 style={{ margin: 0 }}>应付概览</h3>
            <span className="recv-sums">
              <span className={summary.payable > 0 ? 'neg' : 'muted'}>应付 {fmtMoney(summary.payable, convert.display)}</span>
              {summary.prepaid > 0 && <span className="recv-pre">预付 {fmtMoney(summary.prepaid, convert.display)}</span>}
            </span>
          </div>
        </div>
      )}

      <div className="card">
        {rows.length === 0 && <p className="muted">还没有供应商，先在下面添加一个。进货时可选「赊账」记应付。</p>}
        {rows.map((s) => {
          const owed = payableBalance(accounts, txns, s.name, convert);
          return (
            <div className="brow" key={s.id}>
              <div className="bhead">
                {editId === s.id ? (
                  <input
                    className="bname"
                    style={{ flex: 1 }}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename(s);
                      if (e.key === 'Escape') setEditId(null);
                    }}
                  />
                ) : (
                  <span className={`bname${s.archived ? ' muted' : ''}`}>
                    {s.name}
                    {s.phone && <span className="muted"> · {s.phone}</span>}
                    {s.dueDays > 0 && <span className="muted"> · 账期{s.dueDays}天</span>}
                    {s.archived && <span className="chip"> 已归档</span>}
                  </span>
                )}
                {!s.archived && <span className={`bnum${owed > 0 ? ' neg' : ''}`}>{owed > 0 ? `应付 ${fmtMoney(owed, convert.display)}` : '已结清'}</span>}
                <div className="arow-btns">
                  {editId === s.id ? (
                    <>
                      <button className="lnk" onClick={() => void saveRename(s)}>
                        保存
                      </button>
                      <button className="lnk" onClick={() => setEditId(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      {!s.archived && owed > 0 && (
                        <button className="lnk" onClick={() => openPay(s)}>
                          还款
                        </button>
                      )}
                      <button
                        className="lnk"
                        onClick={() => {
                          setEditId(s.id);
                          setDraft(s.name);
                        }}
                      >
                        改名
                      </button>
                      <button className={`lnk${s.archived ? '' : ' danger'}`} onClick={() => void toggleArchive(s)}>
                        {s.archived ? '恢复' : '归档'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {payFor === s.id && (
                <div className="qgrid" style={{ marginTop: 8 }}>
                  <label>
                    付款金额(¥)
                    <input inputMode="decimal" value={pAmount} onChange={(e) => setPAmount(e.target.value)} placeholder="0.00" />
                  </label>
                  <label>
                    日期
                    <input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} />
                  </label>
                  <label>
                    付款账户
                    <select value={pAcct} onChange={(e) => setPAcct(e.target.value)}>
                      {payAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="arow-btns" style={{ alignSelf: 'end' }}>
                    <button className="btn btn-primary" onClick={() => void submitPay(s)}>
                      确认付款
                    </button>
                    <button className="lnk" onClick={() => setPayFor(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>新增供应商</h3>
        <div className="qgrid">
          <label>
            名称
            <input placeholder="供应商名称" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            电话（可选）
            <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            默认账期（天，可选）
            <input inputMode="numeric" placeholder="0 = 现款现货" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          </label>
        </div>
        {err && <p className="form-err">{err}</p>}
        <button className="btn btn-primary" onClick={() => void add()}>
          添加
        </button>
      </div>
    </>
  );
}
