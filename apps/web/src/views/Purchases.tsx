import { useEffect, useState } from 'react';
import { fromMinor, purchaseTotal, toMinor } from '@app/core';
import type { PurchaseKind } from '@app/core';
import type { StoredProduct, StoredPurchase, StoredSupplier } from '@app/store';
import type { AppData } from '../App';
import { fmtMoney, todayISO } from '../format';
import { recordCreditStockIn, recordExpensePurchase, recordStockIn } from '../biz';

const KIND_LABEL: Record<PurchaseKind, string> = { stock: '入库存', dropship: '代采', expense: '费用' };

/**
 * 采购页（C2 模型重构 Step 3）：采购一等公民——统一查看所有采购单（补库存进货 / 为某单代采 / 费用采购），
 * 并新建「入库存」「费用」采购（代采从订单页「为此单采购」生成）。库存/费用人民币本位。
 */
export default function Purchases({ data }: { data: AppData }) {
  const { repo, book, accounts, reload } = data;
  const [purchases, setPurchases] = useState<StoredPurchase[]>([]);
  const [suppliers, setSuppliers] = useState<StoredSupplier[]>([]);
  const [products, setProducts] = useState<StoredProduct[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 新建采购单表单
  const [kind, setKind] = useState<'stock' | 'expense'>('stock'); // 代采（dropship）在订单页「为此单采购」生成
  const [payMode, setPayMode] = useState<'cash' | 'credit'>('cash');
  const [supId, setSupId] = useState('');
  const [payAcct, setPayAcct] = useState('');
  const [date, setDate] = useState(todayISO());
  // 入库存
  const [pid, setPid] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  // 费用
  const [destAcct, setDestAcct] = useState('');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');

  async function refresh(): Promise<void> {
    const [pu, sup, ps] = await Promise.all([
      repo.listPurchases({ bookId: book.id }),
      repo.listSuppliers({ bookId: book.id }),
      repo.listProducts({ bookId: book.id }),
    ]);
    setPurchases(pu);
    setSuppliers(sup);
    setProducts(ps);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const supName = (id: string): string => suppliers.find((s) => s.id === id)?.name ?? '';
  // 库存/费用人民币本位：付款账户限 CNY 资产，排除应收/库存商品/代采在途自管科目
  const payAccounts = accounts.filter(
    (a) => a.type === 'asset' && a.currency === 'CNY' && !a.name.startsWith('应收账款') && a.name !== '库存商品' && a.name !== '代采在途成本',
  );
  const expenseAccounts = accounts.filter((a) => a.type === 'expense' && a.name !== '营业成本');
  const stockProducts = products.filter((p) => !p.quoteOnly);
  const effSup = suppliers.some((s) => s.id === supId) ? supId : (suppliers[0]?.id ?? '');
  const effPay = payAccounts.some((a) => a.id === payAcct) ? payAcct : (payAccounts[0]?.id ?? '');
  const effProd = stockProducts.some((p) => p.id === pid) ? pid : (stockProducts[0]?.id ?? '');
  const effDest = expenseAccounts.some((a) => a.id === destAcct) ? destAcct : (expenseAccounts[0]?.id ?? '');
  const selProd = stockProducts.find((p) => p.id === effProd);

  async function submit(): Promise<void> {
    setErr(null);
    if (payMode === 'cash' && !effPay) {
      setErr('没有人民币付款账户（采购按人民币本位，需从 CNY 账户付）');
      return;
    }
    if (payMode === 'credit' && !effSup) {
      setErr('还没有供应商——去「供应商」页添加，再来赊账采购');
      return;
    }
    setSaving(true);
    try {
      if (kind === 'stock') {
        if (!effProd) {
          setErr('还没有库存商品——去「商品」页添加');
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
        if (payMode === 'credit') {
          await recordCreditStockIn(repo, book, { productId: effProd, qty: q, unitCost: toMinor(c), date, supplier: suppliers.find((s) => s.id === effSup)!, note: '' });
        } else {
          await recordStockIn(repo, book, { productId: effProd, qty: q, unitCost: toMinor(c), date, payAccountId: effPay, note: '' });
        }
      } else {
        if (!effDest) {
          setErr('没有费用科目——去「账户」页添加一个支出科目');
          return;
        }
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          setErr('请输入有效采购金额');
          return;
        }
        if (!desc.trim()) {
          setErr('请填写费用说明');
          return;
        }
        await recordExpensePurchase(repo, book, {
          destAccountId: effDest,
          amount: toMinor(amt),
          description: desc.trim(),
          date,
          payMode,
          payAccountId: payMode === 'cash' ? effPay : undefined,
          supplier: payMode === 'credit' ? suppliers.find((s) => s.id === effSup) : undefined,
          note: '',
        });
      }
      setQty('');
      setCost('');
      setAmount('');
      setDesc('');
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
        <h2>{book.name} · 采购</h2>
      </div>

      <div className="card">
        <h3>新建采购单</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          入库存＝进货补库存（进移动加权均价池）；费用＝直接计入费用科目（运费 / 办公用品等）。代采请到「订单」页「为此单采购」。
        </p>
        <div className="qgrid">
          <label>
            去向
            <select value={kind} onChange={(e) => setKind(e.target.value as 'stock' | 'expense')}>
              <option value="stock">入库存</option>
              <option value="expense">费用</option>
            </select>
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
              {suppliers.length === 0 ? (
                <span className="muted small">（先到「供应商」页添加）</span>
              ) : (
                <select value={effSup} onChange={(e) => setSupId(e.target.value)}>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
          <label>
            日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {kind === 'stock' ? (
            <>
              <label>
                商品
                {stockProducts.length === 0 ? (
                  <span className="muted small">（先到「商品」页添加）</span>
                ) : (
                  <select value={effProd} onChange={(e) => setPid(e.target.value)}>
                    {stockProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label>
                数量
                <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
              </label>
              <label>
                进价（元/单位）
                <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={selProd ? String(fromMinor(selProd.costPrice)) : '0.00'} />
              </label>
            </>
          ) : (
            <>
              <label>
                费用科目
                {expenseAccounts.length === 0 ? (
                  <span className="muted small">（先到「账户」页添加支出科目）</span>
                ) : (
                  <select value={effDest} onChange={(e) => setDestAcct(e.target.value)}>
                    {expenseAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label>
                金额（元）
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              </label>
              <label className="full">
                说明
                <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="如：快递费 / 办公用品" />
              </label>
            </>
          )}
        </div>
        {err && <p className="form-err">{err}</p>}
        <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => void submit()} disabled={saving}>
          新建采购
        </button>
      </div>

      <div className="card">
        <h3>采购单</h3>
        {purchases.length === 0 && <p className="muted">还没有采购单。在上方可新建「入库存 / 费用」采购；代采在订单页「为此单采购」生成。</p>}
        {purchases.map((p) => {
          const total = purchaseTotal(p.lines);
          const draft = !p.txnId;
          const who = p.supplierId ? supName(p.supplierId) : p.payMode === 'cash' ? '现结' : '—';
          return (
            <div className="brow" key={p.id}>
              <div className="bhead">
                <span className="bname">
                  <span className="chip">{KIND_LABEL[p.kind]}</span> {who} <span className="muted">· {p.date}</span>
                  {draft && <span className="chip warn"> 草稿</span>}
                </span>
                <span className="chip">{p.payMode === 'credit' ? '赊账' : '现结'}</span>
                <span className="bnum">{fmtMoney(total)}</span>
              </div>
              <div className="ord-items">{p.lines.map((l) => `${l.name}×${l.qty}`).join('，')}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
