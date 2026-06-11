import { useState } from 'react';
import { expandEntry, toMinor } from '@app/core';
import type { EntryInput } from '@app/core';
import type { AppData } from '../App';
import { genId } from '../db';
import { CURRENCY_SYMBOL, todayISO } from '../format';

type Kind = 'expense' | 'income' | 'transfer';

const KIND_LABEL: Record<Kind, string> = { expense: '支出', income: '收入', transfer: '转账' };

export default function QuickEntry({ data }: { data: AppData }) {
  const { accounts, repo, reload, book } = data;
  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [payee, setPayee] = useState('');
  const [catId, setCatId] = useState('');
  const [accId, setAccId] = useState('');
  const [toId, setToId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const cats = accounts.filter((a) => a.type === (kind === 'expense' ? 'expense' : 'income'));
  const reals = accounts.filter((a) => a.type === 'asset' || a.type === 'liability');
  const effCat = cats.some((c) => c.id === catId) ? catId : (cats[0]?.id ?? '');
  const effAcc = reals.some((c) => c.id === accId) ? accId : (reals[0]?.id ?? '');
  const effTo = reals.some((c) => c.id === toId) ? toId : (reals[1]?.id ?? reals[0]?.id ?? '');
  // 分录币种 = 选中真实账户（资产/负债）的币种；分类(income/expense)随账户币种走
  const accCurrency = reals.find((a) => a.id === effAcc)?.currency ?? 'CNY';
  const sym = CURRENCY_SYMBOL[accCurrency] ?? accCurrency;

  async function save(): Promise<void> {
    setErr(null);
    setOk(null);
    const major = Number(amount);
    if (!Number.isFinite(major) || major <= 0) {
      setErr('请输入有效的正数金额');
      return;
    }
    try {
      const minor = toMinor(major);
      let input: EntryInput;
      if (kind === 'transfer') {
        if (effAcc === effTo) {
          setErr('转出与转入账户不能相同');
          return;
        }
        const toCurrency = reals.find((a) => a.id === effTo)?.currency ?? 'CNY';
        if (toCurrency !== accCurrency) {
          setErr('跨币种转账（换汇）暂未支持，将在后续版本提供；目前请选同币种账户。');
          return;
        }
        input = { kind, bookId: book.id, date, amount: minor, currency: accCurrency, payee, tags: [], fromAccountId: effAcc, toAccountId: effTo };
      } else {
        input = { kind, bookId: book.id, date, amount: minor, currency: accCurrency, payee, tags: [], accountId: effAcc, categoryId: effCat };
      }
      await repo.addTransaction(expandEntry(input, genId));
      await reload();
      setAmount('');
      setPayee('');
      setOk('已记账 ✓');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card">
      <h3>记一笔</h3>
      <div className="qtabs">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button key={k} className={`qtab${kind === k ? ` on k-${k}` : ''}`} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="qgrid">
        <label>
          金额（{sym}）
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          日期
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {kind !== 'transfer' ? (
          <>
            <label>
              {kind === 'expense' ? '分类' : '来源'}
              <select value={effCat} onChange={(e) => setCatId(e.target.value)}>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              账户
              <select value={effAcc} onChange={(e) => setAccId(e.target.value)}>
                {reals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              从
              <select value={effAcc} onChange={(e) => setAccId(e.target.value)}>
                {reals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              到
              <select value={effTo} onChange={(e) => setToId(e.target.value)}>
                {reals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="full">
          备注
          <input placeholder="商家 / 备注（可选）" value={payee} onChange={(e) => setPayee(e.target.value)} />
        </label>
      </div>
      {err && <p className="form-err">{err}</p>}
      {ok && <p className="form-ok">{ok}</p>}
      <button className="btn btn-primary wfull" onClick={() => void save()}>
        保存
      </button>
    </div>
  );
}
