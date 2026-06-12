import { useEffect, useMemo, useState } from 'react';
import { fromMinor, inventoryState, toMinor } from '@app/core';
import type { StoredInventoryMovement, StoredProduct } from '@app/store';
import type { AppData } from '../App';
import { fmtMoney, todayISO } from '../format';
import { recordStockIn } from '../biz';

export default function Inventory({ data }: { data: AppData }) {
  const { repo, book, accounts, reload } = data;
  const [products, setProducts] = useState<StoredProduct[]>([]);
  const [movements, setMovements] = useState<StoredInventoryMovement[]>([]);
  const [pid, setPid] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [payAcct, setPayAcct] = useState('');
  const [date, setDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [ps, ms] = await Promise.all([
      repo.listProducts({ bookId: book.id }),
      repo.listInventoryMovements({ bookId: book.id }),
    ]);
    setProducts(ps);
    setMovements(ms);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const stockProducts = products.filter((p) => p.isStock);
  // 库存为人民币本位：付款账户限 CNY 资产，排除应收/库存商品自管科目
  const payAccounts = accounts.filter(
    (a) => a.type === 'asset' && a.currency === 'CNY' && !a.name.startsWith('应收账款') && a.name !== '库存商品',
  );
  const effProd = stockProducts.some((p) => p.id === pid) ? pid : (stockProducts[0]?.id ?? '');
  const effPay = payAccounts.some((a) => a.id === payAcct) ? payAcct : (payAccounts[0]?.id ?? '');
  const selProd = stockProducts.find((p) => p.id === effProd);

  const byProduct = useMemo(() => {
    const m = new Map<string, StoredInventoryMovement[]>();
    for (const mv of movements) {
      const arr = m.get(mv.productId) ?? [];
      arr.push(mv);
      m.set(mv.productId, arr);
    }
    return m;
  }, [movements]);

  const rows = stockProducts.map((p) => ({ p, st: inventoryState(byProduct.get(p.id) ?? []) }));
  const totalValue = rows.reduce((s, r) => s + r.st.totalCost, 0);

  async function add(): Promise<void> {
    setErr(null);
    if (!effProd) {
      setErr('还没有库存品——去「商品」页把商品勾选为「库存品」');
      return;
    }
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setErr('请输入有效进货数量');
      return;
    }
    const c = cost.trim() === '' ? fromMinor(selProd?.costPrice ?? 0) : Number(cost);
    if (!Number.isFinite(c) || c < 0) {
      setErr('请输入有效进价');
      return;
    }
    if (!effPay) {
      setErr('没有人民币付款账户（库存按人民币本位，进货需从 CNY 账户付）');
      return;
    }
    setSaving(true);
    try {
      await recordStockIn(repo, book, { productId: effProd, qty: q, unitCost: toMinor(c), date, payAccountId: effPay, note: '' });
      setQty('');
      setCost('');
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 库存</h2>
        <span className="muted">库存值合计 {fmtMoney(totalValue)}（人民币本位）</span>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <p className="muted">还没有库存品。去「商品」页把商品勾选为「库存品」，再来这里进货、查看在手与成本。</p>
        ) : (
          rows.map(({ p, st }) => (
            <div className="brow" key={p.id}>
              <div className="bhead">
                <span className="bname">
                  {p.name}
                  {p.unit && <span className="muted"> / {p.unit}</span>}
                </span>
                <span className={`bnum${st.qty <= 0 ? ' neg' : ''}`}>
                  在手 {st.qty}
                  {p.unit ? ` ${p.unit}` : ''} <span className="muted">· 均价 {fmtMoney(st.avgCost)} · 值 {fmtMoney(st.totalCost)}</span>
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h3>进货 / 补库存</h3>
        {stockProducts.length === 0 ? (
          <p className="muted">先到「商品」页添加库存品。</p>
        ) : (
          <>
            <p className="muted small">入库按进价计入「库存商品」，钱从所选账户付出。出库与成本结转在订单完成时自动发生。</p>
            <div className="qgrid">
              <label>
                商品
                <select value={effProd} onChange={(e) => setPid(e.target.value)}>
                  {stockProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                数量
                <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
              </label>
              <label>
                进价（元/单位）
                <input
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder={selProd ? String(fromMinor(selProd.costPrice)) : '0.00'}
                />
              </label>
              <label>
                付款账户
                <select value={effPay} onChange={(e) => setPayAcct(e.target.value)}>
                  {payAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                日期
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            </div>
            {err && <p className="form-err">{err}</p>}
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => void add()} disabled={saving}>
              进货入库
            </button>
          </>
        )}
      </div>
    </>
  );
}
