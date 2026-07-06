import { useEffect, useState } from 'react';
import type { StoredCustomer } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney } from '../format';
import { receivableBalance, renameCustomer } from '../biz';

export default function Customers({ data }: { data: AppData }) {
  const { repo, book, accounts, txns, reload, convert } = data;
  const [list, setList] = useState<StoredCustomer[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [dueDays, setDueDays] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setList(await repo.listCustomers({ bookId: book.id, includeArchived: true }));
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const rows = list.slice().sort((a, b) => Number(a.archived) - Number(b.archived));

  async function add(): Promise<void> {
    setErr(null);
    const nm = name.trim();
    if (!nm) {
      setErr('请输入客户名称');
      return;
    }
    if (list.some((c) => c.name === nm)) {
      setErr(`已有同名客户「${nm}」`);
      return;
    }
    const dd = dueDays.trim() === '' ? 0 : Number(dueDays);
    if (!Number.isInteger(dd) || dd < 0) {
      setErr('账期天数需为非负整数');
      return;
    }
    await repo.addCustomer({ id: genId(), bookId: book.id, name: nm, phone: phone.trim(), note: '', dueDays: dd, archived: false });
    setName('');
    setPhone('');
    setDueDays('');
    await refresh();
  }

  async function saveRename(c: StoredCustomer): Promise<void> {
    const nm = draft.trim();
    if (!nm || nm === c.name) {
      setEditId(null);
      return;
    }
    await repo.updateCustomer(c.id, { name: nm });
    await renameCustomer(repo, book, c.name, nm);
    setEditId(null);
    await refresh();
    await reload();
  }

  async function toggleArchive(c: StoredCustomer): Promise<void> {
    if (!c.archived) {
      const owed = receivableBalance(accounts, txns, c.name, convert);
      const msg =
        owed > 0
          ? `「${c.name}」还有应收 ${fmtMoney(owed, convert.display)} 未收清，仍要归档？归档后不在新建订单中出现，历史保留。`
          : `归档「${c.name}」？归档后不在新建订单中出现，可随时恢复。`;
      if (!confirm(msg)) return;
    }
    await repo.updateCustomer(c.id, { archived: !c.archived });
    await refresh();
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 客户</h2>
      </div>

      <div className="card">
        <h3>新增客户</h3>
        <div className="qgrid">
          <label>
            名称
            <input placeholder="客户名称" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            电话（可选）
            <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            默认账期（天，可选）
            <input inputMode="numeric" placeholder="0 = 货到付款" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          </label>
        </div>
        {err && <p className="form-err">{err}</p>}
        <button className="btn btn-primary" onClick={() => void add()}>
          添加
        </button>
      </div>

      <div className="card">
        {rows.length === 0 && <p className="muted">还没有客户，在上方添加一个。</p>}
        {rows.map((c) => {
          const owed = receivableBalance(accounts, txns, c.name, convert);
          return (
            <div className="brow" key={c.id}>
              <div className="bhead">
                {editId === c.id ? (
                  <input
                    className="bname"
                    style={{ flex: 1 }}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename(c);
                      if (e.key === 'Escape') setEditId(null);
                    }}
                  />
                ) : (
                  <span className={`bname${c.archived ? ' muted' : ''}`}>
                    {c.name}
                    {c.phone && <span className="muted"> · {c.phone}</span>}
                    {c.dueDays > 0 && <span className="muted"> · 账期{c.dueDays}天</span>}
                    {c.archived && <span className="chip"> 已归档</span>}
                  </span>
                )}
                {!c.archived && <span className={`bnum${owed > 0 ? ' neg' : ''}`}>{owed > 0 ? `应收 ${fmtMoney(owed, convert.display)}` : '已结清'}</span>}
                <div className="arow-btns">
                  {editId === c.id ? (
                    <>
                      <button className="lnk" onClick={() => void saveRename(c)}>
                        保存
                      </button>
                      <button className="lnk" onClick={() => setEditId(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="lnk"
                        onClick={() => {
                          setEditId(c.id);
                          setDraft(c.name);
                        }}
                      >
                        改名
                      </button>
                      <button className={`lnk${c.archived ? '' : ' danger'}`} onClick={() => void toggleArchive(c)}>
                        {c.archived ? '恢复' : '归档'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
