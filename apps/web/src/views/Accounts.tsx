import { useEffect, useState } from 'react';
import { accountBalance } from '@app/core';
import type { AccountType } from '@app/core';
import type { StoredAccount } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { currencyList, fmtMoney } from '../format';

// 生意/插件流程按显示名 ensure-or-create 的科目（平台销售单等）：禁改名/归档，
// 否则断开名字关联——再开单时 ensureNamedAccount 按旧名找不到、重建新科目，余额被劈成两个；
// 改「营业收入」还会让 completeOrder 直接抛错。与应收/应付子科目同等保护。
const NAMED_MANAGED = new Set(['营业收入', '平台佣金', '物流费', '平台应收款']);

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
  const [newGlobal, setNewGlobal] = useState(false);
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
  // 仅"真金白银"账户可设为共享：资产/负债，且非自动托管/虚拟账户（应收应付/库存/代采在途/平台单据科目）
  const VIRTUAL = new Set(['库存商品', '代采在途成本']);
  const isManaged = (name: string): boolean =>
    name === '应收账款' || name.startsWith('应收账款/') || name === '应付账款' || name.startsWith('应付账款/') || NAMED_MANAGED.has(name);
  const canShare = (a: StoredAccount): boolean =>
    (a.type === 'asset' || a.type === 'liability') && !isManaged(a.name) && !VIRTUAL.has(a.name);
  const shareableType = newType === 'asset' || newType === 'liability';

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
    await repo.addAccount({ id: genId(), bookId: book.id, name, type: newType, parentId: null, currency, global: shareableType && newGlobal, archived: false });
    setNewName('');
    setNewGlobal(false);
    await refresh();
    await reload();
  }

  /** 切换账户的"共享给所有账本"（仅真金白银账户）。 */
  async function toggleGlobal(a: StoredAccount): Promise<void> {
    await repo.updateAccount(a.id, { global: !a.global });
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
                a.name === '应收账款' || a.name.startsWith('应收账款/') || a.name === '应付账款' || a.name.startsWith('应付账款/') || NAMED_MANAGED.has(a.name);
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
                        {a.global && <span className="chip"> 全局共享</span>}
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
                          {canShare(a) && !a.archived && (
                            <button className="lnk" onClick={() => void toggleGlobal(a)} title="共享账户对所有账本可见、对账按账户跨账本">
                              {a.global ? '取消共享' : '设为共享'}
                            </button>
                          )}
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
        {shareableType && (
          <label className="chkline">
            <input type="checkbox" checked={newGlobal} onChange={(e) => setNewGlobal(e.target.checked)} /> 共享给所有账本（真金白银账户，如公用的支付宝/银行卡——生意和生活混用同一账户时勾选）
          </label>
        )}
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
