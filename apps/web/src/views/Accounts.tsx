import { useEffect, useState } from 'react';
import { accountBalance } from '@app/core';
import type { AccountType } from '@app/core';
import type { StoredAccount } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { currencyList, fmtMoney } from '../format';

const GROUPS: Array<{ type: AccountType; label: string; hint: string }> = [
  { type: 'asset', label: '资产账户', hint: '现金 / 银行卡 / 钱包等' },
  { type: 'liability', label: '负债账户', hint: '信用卡 / 花呗 / 借款等' },
  { type: 'income', label: '收入分类', hint: '工资 / 营业收入等' },
  { type: 'expense', label: '支出分类', hint: '餐饮 / 交通 / 进货成本等' },
  { type: 'equity', label: '权益', hint: '期初余额等' },
];

const TYPE_LABEL: Record<AccountType, string> = {
  asset: '资产账户',
  liability: '负债账户',
  income: '收入分类',
  expense: '支出分类',
  equity: '权益',
};

export default function Accounts({ data }: { data: AppData }) {
  const { repo, book, txns, reload } = data;
  const [all, setAll] = useState<StoredAccount[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('expense');
  const [newCurrency, setNewCurrency] = useState('CNY');
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setAll(await repo.listAccounts({ bookId: book.id, includeArchived: true }));
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const usable = all.filter((a) => !a.deleted);
  // 仅开启多币种 + 资产/负债账户才可选币种；其余沿用人民币
  const currencyMatters = data.mcEnabled && (newType === 'asset' || newType === 'liability');

  async function add(): Promise<void> {
    setErr(null);
    const name = newName.trim();
    if (!name) {
      setErr('请输入名称');
      return;
    }
    if (usable.some((a) => a.type === newType && a.name === name)) {
      setErr(`「${TYPE_LABEL[newType]}」下已有同名「${name}」`);
      return;
    }
    const currency = currencyMatters ? newCurrency : 'CNY';
    await repo.addAccount({ id: genId(), bookId: book.id, name, type: newType, parentId: null, currency, archived: false });
    setNewName('');
    await refresh();
    await reload();
  }

  async function saveRename(a: StoredAccount): Promise<void> {
    const name = draft.trim();
    if (!name || name === a.name) {
      setEditId(null);
      return;
    }
    await repo.updateAccount(a.id, { name });
    setEditId(null);
    await refresh();
    await reload();
  }

  async function toggleArchive(a: StoredAccount): Promise<void> {
    if (!a.archived) {
      const used = txns.some((t) => t.postings.some((p) => p.accountId === a.id));
      const msg = used
        ? `归档「${a.name}」？该账户已有交易记录，归档后会从记账下拉中隐藏，历史数据保留。`
        : `归档「${a.name}」？归档后会从记账下拉中隐藏，可随时恢复。`;
      if (!confirm(msg)) return;
    }
    await repo.updateAccount(a.id, { archived: !a.archived });
    await refresh();
    await reload();
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 账户与分类</h2>
      </div>

      {GROUPS.map((g) => {
        const rows = usable
          .filter((a) => a.type === g.type)
          .sort((x, y) => Number(x.archived) - Number(y.archived));
        if (rows.length === 0) return null;
        const showBal = g.type === 'asset' || g.type === 'liability';
        return (
          <div className="card" key={g.type}>
            <h3>{g.label}</h3>
            {rows.map((a) => {
              // 应收账款/应付账款及其按客户/供应商自动建的子科目由生意流程托管：禁止改名/归档，
              // 否则会断开「应收账款/客户名」「应付账款/供应商名」的名字关联、或被默认 listAccounts 排除而漏算。
              const managed =
                a.name === '应收账款' || a.name.startsWith('应收账款/') || a.name === '应付账款' || a.name.startsWith('应付账款/');
              return (
                <div className="brow" key={a.id}>
                  <div className="bhead">
                    {editId === a.id && !managed ? (
                      <input
                        className="bname"
                        style={{ flex: 1 }}
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveRename(a);
                          if (e.key === 'Escape') setEditId(null);
                        }}
                      />
                    ) : (
                      <span className={`bname${a.archived ? ' muted' : ''}`}>
                        {a.name}
                        {showBal && a.currency !== 'CNY' && <span className="chip"> {a.currency}</span>}
                        {a.archived && <span className="chip"> 已归档</span>}
                      </span>
                    )}
                    {showBal && !a.archived && <span className="bnum">{fmtMoney(accountBalance(txns, a.id), a.currency)}</span>}
                    <div className="arow-btns">
                      {managed ? (
                        <span className="muted" style={{ fontSize: 12 }}>自动管理</span>
                      ) : editId === a.id ? (
                        <>
                          <button className="lnk" onClick={() => void saveRename(a)}>
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
                              setEditId(a.id);
                              setDraft(a.name);
                            }}
                          >
                            改名
                          </button>
                          <button className={`lnk${a.archived ? '' : ' danger'}`} onClick={() => void toggleArchive(a)}>
                            {a.archived ? '恢复' : '归档'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="card">
        <h3>新增账户 / 分类</h3>
        <div className="qgrid">
          <label>
            名称
            <input
              placeholder="如 招商银行 / 餐饮"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
          </label>
          <label>
            类型
            <select value={newType} onChange={(e) => setNewType(e.target.value as AccountType)}>
              {GROUPS.map((g) => (
                <option key={g.type} value={g.type}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          {currencyMatters && (
            <label>
              币种
              <select value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)}>
                {currencyList().map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} {c.code}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 10 }}>
          {GROUPS.find((g) => g.type === newType)?.hint}
        </p>
        {err && <p className="form-err">{err}</p>}
        <button className="btn btn-primary" onClick={() => void add()}>
          添加
        </button>
      </div>
    </>
  );
}
