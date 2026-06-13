import { useEffect, useMemo, useState } from 'react';
import { fromMinor, inventoryState, toMinor } from '@app/core';
import type { StoredInventoryMovement, StoredProduct, StoredSupplier } from '@app/store';
import type { AppData } from '../App';
import { fmtMoney, todayISO } from '../format';
import { recordCreditStockIn, recordStockAdjust, recordStockIn } from '../biz';

export default function Inventory({ data }: { data: AppData }) {
  const { repo, book, accounts, reload } = data;
  const [products, setProducts] = useState<StoredProduct[]>([]);
  const [movements, setMovements] = useState<StoredInventoryMovement[]>([]);
  const [suppliers, setSuppliers] = useState<StoredSupplier[]>([]);
  const [pid, setPid] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [payMode, setPayMode] = useState<'cash' | 'credit'>('cash'); // 现结 / 赊账
  const [payAcct, setPayAcct] = useState('');
  const [supId, setSupId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 盘点 / 库存调整（按商品内联）
  const [adjustFor, setAdjustFor] = useState<string | null>(null);
  const [aTarget, setATarget] = useState('');
  const [aReason, setAReason] = useState('');
  const [aDate, setADate] = useState(todayISO());
  const [aGainCost, setAGainCost] = useState('');

  async function refresh(): Promise<void> {
    const [ps, ms, ss] = await Promise.all([
      repo.listProducts({ bookId: book.id }),
      repo.listInventoryMovements({ bookId: book.id }),
      repo.listSuppliers({ bookId: book.id }),
    ]);
    setProducts(ps);
    setMovements(ms);
    setSuppliers(ss);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const stockProducts = products.filter((p) => !p.quoteOnly); // 统一库存模型：纯报价/服务不进库存
  // 库存为人民币本位：付款账户限 CNY 资产，排除应收/库存商品自管科目
  const payAccounts = accounts.filter(
    (a) => a.type === 'asset' && a.currency === 'CNY' && !a.name.startsWith('应收账款') && a.name !== '库存商品',
  );
  const effProd = stockProducts.some((p) => p.id === pid) ? pid : (stockProducts[0]?.id ?? '');
  const effPay = payAccounts.some((a) => a.id === payAcct) ? payAcct : (payAccounts[0]?.id ?? '');
  const effSup = suppliers.some((s) => s.id === supId) ? supId : (suppliers[0]?.id ?? '');
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
      setErr('还没有库存商品——去「商品」页添加（默认即库存追踪；纯报价/服务不进库存）');
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
    if (payMode === 'cash' && !effPay) {
      setErr('没有人民币付款账户（库存按人民币本位，进货需从 CNY 账户付）');
      return;
    }
    if (payMode === 'credit' && !effSup) {
      setErr('还没有供应商——去「供应商」页添加，再来赊账进货');
      return;
    }
    setSaving(true);
    try {
      if (payMode === 'credit') {
        const sup = suppliers.find((s) => s.id === effSup)!;
        await recordCreditStockIn(repo, book, { productId: effProd, qty: q, unitCost: toMinor(c), date, supplier: sup, note: '' });
      } else {
        await recordStockIn(repo, book, { productId: effProd, qty: q, unitCost: toMinor(c), date, payAccountId: effPay, note: '' });
      }
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

  function openAdjust(p: StoredProduct, currentQty: number): void {
    setErr(null);
    setAdjustFor(p.id);
    setATarget(String(currentQty));
    setAReason('');
    setADate(todayISO());
    setAGainCost('');
  }

  async function doAdjust(p: StoredProduct): Promise<void> {
    setErr(null);
    const target = Number(aTarget);
    if (!Number.isFinite(target) || target < 0) {
      setErr('请输入有效的实际数量');
      return;
    }
    if (!aReason.trim()) {
      setErr('请填写盘点 / 调整原因');
      return;
    }
    let gain: number | undefined;
    if (aGainCost.trim() !== '') {
      const g = Number(aGainCost);
      if (!Number.isFinite(g) || g < 0) {
        setErr('盘盈入账单价需为非负数');
        return;
      }
      gain = toMinor(g);
    }
    setSaving(true);
    try {
      await recordStockAdjust(repo, book, { productId: p.id, targetQty: target, reason: aReason.trim(), date: aDate, gainUnitCost: gain });
      setAdjustFor(null);
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
          <p className="muted">还没有库存商品。去「商品」页添加商品（默认即库存追踪），再来这里进货、查看在手与成本。</p>
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
                <div className="arow-btns">
                  <button className="lnk" onClick={() => openAdjust(p, st.qty)}>
                    盘点 / 调整
                  </button>
                </div>
              </div>
              {adjustFor === p.id && (
                <div className="collect">
                  <p className="muted small" style={{ marginTop: 0 }}>
                    把在手数调到实际盘点数；差额按当前均价 {fmtMoney(st.avgCost)} 计入「库存损溢」。盘盈可填入账单价。
                  </p>
                  <div className="qgrid">
                    <label>
                      实际数量
                      <input inputMode="decimal" value={aTarget} onChange={(e) => setATarget(e.target.value)} placeholder={String(st.qty)} />
                    </label>
                    <label>
                      原因（必填）
                      <input value={aReason} onChange={(e) => setAReason(e.target.value)} placeholder="盘点对差 / 报废 / 损耗" />
                    </label>
                    <label>
                      日期
                      <input type="date" value={aDate} onChange={(e) => setADate(e.target.value)} />
                    </label>
                    {Number(aTarget) > st.qty && (
                      <label>
                        盘盈入账单价（元，留空取均价）
                        <input inputMode="decimal" value={aGainCost} onChange={(e) => setAGainCost(e.target.value)} placeholder={String(fromMinor(st.avgCost))} />
                      </label>
                    )}
                  </div>
                  <div className="ord-foot">
                    <button className="lnk" onClick={() => setAdjustFor(null)}>
                      取消
                    </button>
                    <button className="btn btn-primary" onClick={() => void doAdjust(p)} disabled={saving}>
                      确认调整
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h3>进货 / 补库存</h3>
        {stockProducts.length === 0 ? (
          <p className="muted">先到「商品」页添加商品（默认即库存追踪）。</p>
        ) : (
          <>
            <p className="muted small">
              入库按进价计入「库存商品」。现结＝钱从所选账户付出；赊账＝记应付账款/供应商（之后到「供应商」页还款）。出库与成本结转在订单完成时自动发生。
            </p>
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
                付款方式
                <select value={payMode} onChange={(e) => setPayMode(e.target.value as 'cash' | 'credit')}>
                  <option value="cash">现结</option>
                  <option value="credit">赊账（记应付）</option>
                </select>
              </label>
              {payMode === 'cash' ? (
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
              ) : (
                <label>
                  供应商
                  <select value={effSup} onChange={(e) => setSupId(e.target.value)}>
                    {suppliers.length === 0 ? (
                      <option value="">（先到「供应商」页添加）</option>
                    ) : (
                      suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              )}
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
