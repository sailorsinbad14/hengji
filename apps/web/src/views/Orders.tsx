import { useEffect, useMemo, useState } from 'react';
import { agingBuckets, convertAmount, fromMinor, orderTotal, purchaseTotal, toMinor } from '@app/core';
import type { OrderLine, OrderPaymentStatus, OrderStatus } from '@app/core';
import type { StoredCustomer, StoredInventoryMovement, StoredOrder, StoredProduct, StoredPurchase, StoredSettlement, StoredSupplier } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { currencyDef, currencyList, fmtMoney, todayISO } from '../format';
import { completeOrder, customerOrderStatus, receivableSummary, recordCollection, recordOrderPurchase } from '../biz';

const STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  pending_purchase: { label: '待采购', cls: '' },
  pending_ship: { label: '待发货', cls: '' },
  shipped: { label: '已发货', cls: '' },
  completed: { label: '已完成', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'off' },
};

interface LineDraft {
  key: string;
  productId: string;
  name: string;
  qty: string;
  price: string;
}

const emptyLine = (): LineDraft => ({ key: genId(), productId: '', name: '', qty: '1', price: '' });

export default function Orders({ data }: { data: AppData }) {
  const { repo, book, accounts, txns, reload, convert, mcEnabled } = data;
  const [customers, setCustomers] = useState<StoredCustomer[]>([]);
  const [suppliers, setSuppliers] = useState<StoredSupplier[]>([]);
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [products, setProducts] = useState<StoredProduct[]>([]);
  const [settlements, setSettlements] = useState<StoredSettlement[]>([]);
  const [movements, setMovements] = useState<StoredInventoryMovement[]>([]);
  const [purchases, setPurchases] = useState<StoredPurchase[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // 新建订单表单
  const [custId, setCustId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [oCur, setOCur] = useState('CNY'); // 订单结算币种（多币种开启时可选）
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [note, setNote] = useState('');

  // 收款表单（按订单展开）
  const [collectFor, setCollectFor] = useState<string | null>(null);
  const [cAmount, setCAmount] = useState('');
  const [cDate, setCDate] = useState(todayISO());
  const [cAcct, setCAcct] = useState('');

  // 为此单采购表单（代采，按订单展开）
  const [purchaseFor, setPurchaseFor] = useState<string | null>(null);
  const [pSup, setPSup] = useState('');
  const [pMode, setPMode] = useState<'cash' | 'credit'>('credit');
  const [pAcct, setPAcct] = useState('');
  const [pDate, setPDate] = useState(todayISO());
  const [pCosts, setPCosts] = useState<Record<string, string>>({});

  async function refresh(): Promise<void> {
    const [cs, sup, os, ps, ss, ms, pu] = await Promise.all([
      repo.listCustomers({ bookId: book.id, includeArchived: true }),
      repo.listSuppliers({ bookId: book.id }),
      repo.listOrders({ bookId: book.id }),
      repo.listProducts({ bookId: book.id }),
      repo.listSettlements({ bookId: book.id }),
      repo.listInventoryMovements({ bookId: book.id }),
      repo.listPurchases({ bookId: book.id }),
    ]);
    setCustomers(cs);
    setSuppliers(sup);
    setOrders(os);
    setProducts(ps);
    setSettlements(ss);
    setMovements(ms);
    setPurchases(pu);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const custName = (id: string): string => customers.find((c) => c.id === id)?.name ?? '（已删客户）';
  const activeCustomers = customers.filter((c) => !c.archived);
  const cashAccounts = accounts.filter((a) => a.type === 'asset' && !a.name.startsWith('应收账款'));
  const effCust = activeCustomers.some((c) => c.id === custId) ? custId : (activeCustomers[0]?.id ?? '');
  const oDecimals = currencyDef(oCur).decimals; // 新建订单按所选币种的精度解析单价

  const draftTotal = useMemo(
    () => lines.reduce((s, l) => s + Math.round((Number(l.qty) || 0) * toMinorSafe(l.price, oDecimals)), 0),
    [lines, oDecimals],
  );

  // 按「单据归属」把每笔收款摊到已完成订单（指定单优先，多付/未指定才 FIFO 顺延）
  // → 每单收款状态 + 未收清订单（账龄/逾期）+ 应收/预收概览。FIFO/账期编排在 biz.customerOrderStatus。
  const { payStatus, summary, outstanding } = useMemo(() => {
    const { payStatus, outstanding } = customerOrderStatus(orders, customers, settlements, todayISO());
    return { payStatus, outstanding, summary: receivableSummary(accounts, txns, convert) };
  }, [orders, customers, settlements, accounts, txns, convert]);

  // 应收账龄分桶：每笔欠款按账龄归桶，金额折算到展示币种（混合币种可比）。
  const aging = useMemo(
    () => agingBuckets(outstanding.map((o) => ({ amount: convertAmount(o.owed, o.order.currency, convert), days: o.days }))),
    [outstanding, convert],
  );

  // 每单库存成本（人民币）= 该单 out 出库流水的 Σ|数量|×均价。
  const cogsByOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const mv of movements) {
      if (mv.kind !== 'out' || !mv.orderId) continue;
      m.set(mv.orderId, (m.get(mv.orderId) ?? 0) + Math.round(-mv.qty * mv.unitCost));
    }
    return m;
  }, [movements]);
  // 每单代采成本（人民币）= 该单各采购单总额之和（成本直挂订单，不过库存）。
  const dropshipCostByOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of purchases) m.set(p.orderId, (m.get(p.orderId) ?? 0) + purchaseTotal(p.lines));
    return m;
  }, [purchases]);
  // 毛利按人民币本位：订单收入折人民币 − 总成本（库存 + 代采，恒 CNY）。
  const cnyCtx = { rates: convert.rates, scales: convert.scales, display: 'CNY' };
  const costOf = (o: StoredOrder): number => (cogsByOrder.get(o.id) ?? 0) + (dropshipCostByOrder.get(o.id) ?? 0);
  const marginOf = (o: StoredOrder): number => convertAmount(orderTotal(o.lines), o.currency, cnyCtx) - costOf(o);

  // 毛利汇总（人民币本位）：已完成订单按客户 / 按商品聚合收入、成本、毛利。
  const margins = useMemo(() => {
    const cny = { rates: convert.rates, scales: convert.scales, display: 'CNY' };
    const byCust = new Map<string, { rev: number; cost: number }>();
    const prodRev = new Map<string, number>();
    const prodCost = new Map<string, number>();
    const completedIds = new Set<string>();
    for (const o of orders) {
      if (o.status !== 'completed') continue;
      completedIds.add(o.id);
      const cur = byCust.get(o.customerId) ?? { rev: 0, cost: 0 };
      cur.rev += convertAmount(orderTotal(o.lines), o.currency, cny);
      cur.cost += (cogsByOrder.get(o.id) ?? 0) + (dropshipCostByOrder.get(o.id) ?? 0);
      byCust.set(o.customerId, cur);
      for (const l of o.lines) {
        if (!l.productId) continue;
        prodRev.set(l.productId, (prodRev.get(l.productId) ?? 0) + convertAmount(Math.round(l.qty * l.unitPrice), o.currency, cny));
      }
    }
    for (const mv of movements) {
      if (mv.kind !== 'out') continue; // 库存品成本：出库流水按商品
      prodCost.set(mv.productId, (prodCost.get(mv.productId) ?? 0) + Math.round(-mv.qty * mv.unitCost));
    }
    for (const p of purchases) {
      if (!completedIds.has(p.orderId)) continue; // 代采品成本：已完成订单的采购单行按商品
      for (const l of p.lines) {
        if (!l.productId) continue;
        prodCost.set(l.productId, (prodCost.get(l.productId) ?? 0) + Math.round(l.qty * l.unitCost));
      }
    }
    const cust = [...byCust.entries()]
      .map(([id, v]) => ({ id, rev: v.rev, cost: v.cost, margin: v.rev - v.cost }))
      .sort((a, b) => b.margin - a.margin);
    const prodIds = new Set([...prodRev.keys(), ...prodCost.keys()]);
    const prod = [...prodIds]
      .map((id) => ({ id, rev: prodRev.get(id) ?? 0, cost: prodCost.get(id) ?? 0, margin: (prodRev.get(id) ?? 0) - (prodCost.get(id) ?? 0) }))
      .sort((a, b) => b.margin - a.margin);
    return { cust, prod };
  }, [orders, movements, purchases, cogsByOrder, dropshipCostByOrder, convert]);

  const prodName = (id: string): string => products.find((p) => p.id === id)?.name ?? '（已删商品）';

  function setLine(key: string, patch: Partial<LineDraft>): void {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickProduct(key: string, productId: string): void {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      setLine(key, { productId: '' });
      return;
    }
    // 商品售价存人民币；订单结算币种非人民币时，按设置里的汇率折算后填入（用户可再手改）。
    const priceMinor = convertAmount(p.salePrice, 'CNY', { rates: convert.rates, scales: convert.scales, display: oCur });
    setLine(key, { productId, name: p.name, price: String(fromMinor(priceMinor, oDecimals)) });
  }

  async function save(): Promise<void> {
    setErr(null);
    if (!effCust) {
      setErr('请先选择客户（没有客户先去「客户」页添加）');
      return;
    }
    const valid = lines.filter((l) => l.name.trim() && Number(l.qty) > 0 && l.price.trim() !== '' && Number(l.price) >= 0);
    if (valid.length === 0) {
      setErr('请至少填写一行有效的商品（名称 + 数量 + 单价）');
      return;
    }
    const orderId = genId();
    const orderLines: OrderLine[] = valid.map((l) => ({
      id: genId(),
      orderId,
      name: l.name.trim(),
      qty: Number(l.qty),
      unitPrice: toMinor(Number(l.price), oDecimals),
      productId: l.productId || null,
    }));
    // 含代采品 → 初始「待采购」（须先为此单采购才能发货/完成）；否则直接「待发货」。
    const hasDropship = orderLines.some((l) => l.productId && products.find((p) => p.id === l.productId)?.dropship);
    try {
      await repo.addOrder({
        id: orderId,
        bookId: book.id,
        customerId: effCust,
        date,
        currency: oCur,
        status: hasDropship ? 'pending_purchase' : 'pending_ship',
        note: note.trim(),
        revenueTxnId: null,
        lines: orderLines,
      });
      setLines([emptyLine()]);
      setNote('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doComplete(order: StoredOrder): Promise<void> {
    setErr(null);
    const cust = customers.find((c) => c.id === order.customerId);
    if (!cust) {
      setErr('订单客户已不存在，无法完成');
      return;
    }
    try {
      await completeOrder(repo, book, order, cust);
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doCancel(order: StoredOrder): Promise<void> {
    if (purchases.some((p) => p.orderId === order.id)) {
      setErr('本单已为此单采购，不能直接取消（采购已产生账务，需手动反向处理）');
      return;
    }
    if (!confirm(`取消订单（${custName(order.customerId)} · ${fmtMoney(orderTotal(order.lines), order.currency)}）？未采购订单无账务影响。`)) return;
    await repo.updateOrder(order.id, { status: 'cancelled' });
    await refresh();
  }

  function openCollect(order: StoredOrder): void {
    // 预填这张单自己还欠的金额（不是客户总欠款），避免在某张单上误收走别单的钱
    const p = payStatus.get(order.id);
    const owed = p ? p.total - p.collected : orderTotal(order.lines);
    setCollectFor(order.id);
    setCAmount(owed > 0 ? String(fromMinor(owed, currencyDef(order.currency).decimals)) : '');
    setCDate(todayISO());
    setCAcct('');
    setErr(null);
  }

  function openPurchase(order: StoredOrder): void {
    setErr(null);
    setPurchaseFor(order.id);
    setPSup(suppliers[0]?.id ?? '');
    setPMode('credit');
    setPAcct('');
    setPDate(todayISO());
    // 预填各代采行采购价 = 商品进价（人民币）
    const costs: Record<string, string> = {};
    for (const l of order.lines) {
      const prod = l.productId ? products.find((p) => p.id === l.productId) : undefined;
      if (prod?.dropship) costs[l.id] = String(fromMinor(prod.costPrice));
    }
    setPCosts(costs);
  }

  async function submitPurchase(order: StoredOrder, dsLines: OrderLine[], payAcctId: string): Promise<void> {
    setErr(null);
    const sup = suppliers.find((s) => s.id === (pSup || suppliers[0]?.id));
    if (!sup) {
      setErr('请先到「供应商」页添加供应商');
      return;
    }
    if (pMode === 'cash' && !payAcctId) {
      setErr('现结采购需选人民币付款账户');
      return;
    }
    const lines = dsLines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, unitCost: toMinor(Number(pCosts[l.id] ?? 0)) }));
    if (lines.some((l) => !Number.isFinite(l.unitCost) || l.unitCost < 0)) {
      setErr('请为每个代采品填写有效采购价');
      return;
    }
    try {
      await recordOrderPurchase(repo, book, {
        order,
        supplier: sup,
        lines,
        date: pDate,
        payMode: pMode,
        payAccountId: pMode === 'cash' ? payAcctId : undefined,
        note: '',
      });
      setPurchaseFor(null);
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doCollect(order: StoredOrder): Promise<void> {
    setErr(null);
    const cust = customers.find((c) => c.id === order.customerId);
    if (!cust) {
      setErr('订单客户已不存在');
      return;
    }
    const amt = Number(cAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('请输入有效的收款金额');
      return;
    }
    // 收款只能进与订单同币种的资产账户（跨币种收款属换汇，超出本期范围）
    const collectAccts = cashAccounts.filter((a) => a.currency === order.currency);
    const acctId = collectAccts.some((a) => a.id === cAcct) ? cAcct : (collectAccts[0]?.id ?? '');
    if (!acctId) {
      setErr(`没有 ${currencyDef(order.currency).name} 收款账户，请先到「账户」页建一个该币种资产账户`);
      return;
    }
    try {
      await recordCollection(repo, book, {
        customer: cust,
        orderId: order.id,
        currency: order.currency,
        amount: toMinor(amt, currencyDef(order.currency).decimals),
        date: cDate,
        assetAccountId: acctId,
        note: '',
      });
      setCollectFor(null);
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 订单</h2>
      </div>

      {(summary.receivable > 0 || summary.prepaid > 0 || outstanding.length > 0) && (
        <div className="card">
          <div className="recv-head">
            <h3 style={{ margin: 0 }}>应收概览</h3>
            <span className="recv-sums">
              <span className={summary.receivable > 0 ? 'neg' : 'muted'}>应收 {fmtMoney(summary.receivable, convert.display)}</span>
              {summary.prepaid > 0 && <span className="recv-pre">预收 {fmtMoney(summary.prepaid, convert.display)}</span>}
            </span>
          </div>
          {outstanding.length > 0 && (
            <div className="aging" title="按欠款账龄（自下单日起）分桶，金额已折算到展示币种">
              {[
                { label: '0–30 天', amt: aging.d0_30, cls: '' },
                { label: '31–60 天', amt: aging.d31_60, cls: '' },
                { label: '61–90 天', amt: aging.d61_90, cls: 'warn' },
                { label: '90 天以上', amt: aging.over90, cls: 'danger' },
              ].map((c) => (
                <div className={`aging-cell ${c.cls}`} key={c.label}>
                  <span className="aging-amt">{fmtMoney(c.amt, convert.display)}</span>
                  <span className="aging-label">{c.label}</span>
                </div>
              ))}
            </div>
          )}
          {outstanding.length === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>所有已完成订单均已收清 🎉</p>
          ) : (
            outstanding.map(({ order, owed, days, overdue }) => (
              <div className="recv-row" key={order.id}>
                <span className="bname">
                  {custName(order.customerId)} <span className="muted">· {order.date} · {days}天前</span>
                  {overdue && <span className="chip danger"> 逾期</span>}
                </span>
                <span className="bnum neg">欠 {fmtMoney(owed, order.currency)}</span>
              </div>
            ))
          )}
        </div>
      )}

      {margins.cust.length > 0 && (
        <div className="card">
          <h3>毛利汇总</h3>
          <p className="muted small" style={{ marginTop: 0 }}>已完成订单按客户 / 商品聚合（人民币本位：收入折人民币 − 成本）。</p>
          <div className="margin-sub muted">按客户</div>
          {margins.cust.map((c) => (
            <div className="recv-row" key={c.id}>
              <span className="bname">{custName(c.id)}</span>
              <span className="bnum">
                <strong className={c.margin >= 0 ? 'pos' : 'neg'}>{fmtMoney(c.margin)}</strong>
                <span className="muted"> · 收 {fmtMoney(c.rev)} 本 {fmtMoney(c.cost)}</span>
              </span>
            </div>
          ))}
          <div className="margin-sub muted">按商品</div>
          {margins.prod.map((p) => (
            <div className="recv-row" key={p.id}>
              <span className="bname">{prodName(p.id)}</span>
              <span className="bnum">
                <strong className={p.margin >= 0 ? 'pos' : 'neg'}>{fmtMoney(p.margin)}</strong>
                <span className="muted"> · 收 {fmtMoney(p.rev)} 本 {fmtMoney(p.cost)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>新建订单</h3>
        {activeCustomers.length === 0 ? (
          <p className="muted">还没有客户，请先到「客户」页添加，再来开单。</p>
        ) : (
          <>
            <div className="qgrid">
              <label>
                客户
                <select value={effCust} onChange={(e) => setCustId(e.target.value)}>
                  {activeCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                下单日期
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              {mcEnabled && (
                <label>
                  结算币种
                  <select value={oCur} onChange={(e) => setOCur(e.target.value)}>
                    {currencyList().map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} {c.code}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="ord-lines">
              {lines.map((l) => (
                <div className="ord-line" key={l.key}>
                  {products.length > 0 && (
                    <select className="ord-pick" value={l.productId} onChange={(e) => pickProduct(l.key, e.target.value)}>
                      <option value="">自由输入</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* 手改名称即视为自由文本行，断开商品关联（改价不断开：同一商品的自定义售价是合理的） */}
                  <input placeholder="商品名称" value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value, productId: '' })} />
                  <input
                    className="ord-qty"
                    inputMode="decimal"
                    placeholder="数量"
                    value={l.qty}
                    onChange={(e) => setLine(l.key, { qty: e.target.value })}
                  />
                  <input
                    className="ord-price"
                    inputMode="decimal"
                    placeholder={`单价(${currencyDef(oCur).symbol})`}
                    value={l.price}
                    onChange={(e) => setLine(l.key, { price: e.target.value })}
                  />
                  <span className="ord-sub">{fmtMoney(Math.round((Number(l.qty) || 0) * toMinorSafe(l.price, oDecimals)), oCur)}</span>
                  {lines.length > 1 && (
                    <button className="del" title="删除此行" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="lnk" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              ＋ 添加一行
            </button>
            <div className="qgrid" style={{ marginTop: 10 }}>
              <label className="full">
                备注（可选）
                <input placeholder="订单备注" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
            <div className="ord-foot">
              <span className="ord-total">合计 {fmtMoney(draftTotal, oCur)}</span>
              <button className="btn btn-primary" onClick={() => void save()}>
                保存订单
              </button>
            </div>
          </>
        )}
        {err && <p className="form-err" style={{ marginTop: 8 }}>{err}</p>}
      </div>

      <div className="card">
        <h3>订单</h3>
        {orders.length === 0 && <p className="muted">还没有订单。</p>}
        {orders.map((o) => {
          const st = STATUS[o.status];
          const pay = o.status === 'completed' ? payBadge(payStatus.get(o.id), o.currency) : null;
          return (
            <div className="brow" key={o.id}>
              <div className="bhead">
                <span className="bname">
                  {custName(o.customerId)} <span className="muted">· {o.date}</span>
                  {o.currency !== 'CNY' && <span className="chip"> {o.currency}</span>}
                </span>
                <span className={`chip ${st.cls}`}>{st.label}</span>
                {pay && <span className={`chip ${pay.cls}`}>{pay.label}</span>}
                <span className="bnum">{fmtMoney(orderTotal(o.lines), o.currency)}</span>
              </div>
              <div className="ord-items">{o.lines.map((l) => `${l.name}×${l.qty}`).join('，')}</div>
              {o.status === 'completed' && costOf(o) > 0 && (
                <div className="ord-margin">
                  毛利 <strong className={marginOf(o) >= 0 ? 'pos' : 'neg'}>{fmtMoney(marginOf(o))}</strong>
                  <span className="muted"> · 成本 {fmtMoney(costOf(o))}{o.currency !== 'CNY' ? '（收入已折人民币）' : ''}</span>
                </div>
              )}
              <div className="arow-btns">
                {o.status === 'pending_purchase' && (
                  <>
                    <button className="lnk" onClick={() => openPurchase(o)}>
                      为此单采购
                    </button>
                    <button className="lnk danger" onClick={() => void doCancel(o)}>
                      取消
                    </button>
                  </>
                )}
                {o.status === 'pending_ship' && (
                  <>
                    <button className="lnk" onClick={() => void doComplete(o)}>
                      完成（确认收入）
                    </button>
                    <button className="lnk danger" onClick={() => void doCancel(o)}>
                      取消
                    </button>
                  </>
                )}
                {o.status === 'completed' && (
                  <button className="lnk" onClick={() => openCollect(o)}>
                    收款
                  </button>
                )}
              </div>
              {purchaseFor === o.id && (() => {
                const dsLines = o.lines.filter((l) => l.productId && products.find((p) => p.id === l.productId)?.dropship);
                const purAccts = cashAccounts.filter((a) => a.currency === 'CNY' && a.name !== '库存商品' && a.name !== '代采在途成本');
                const effPurAcct = purAccts.some((a) => a.id === pAcct) ? pAcct : (purAccts[0]?.id ?? '');
                return (
                  <div className="collect">
                    <p className="muted small" style={{ marginTop: 0 }}>为此单代采品采购，录入采购价。成本直挂订单，完成时结转。</p>
                    <div className="qgrid">
                      <label>
                        供应商
                        {suppliers.length === 0 ? (
                          <span className="muted small">无供应商，请先去「供应商」页添加</span>
                        ) : (
                          <select value={pSup || suppliers[0]?.id} onChange={(e) => setPSup(e.target.value)}>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                      <label>
                        付款方式
                        <select value={pMode} onChange={(e) => setPMode(e.target.value as 'cash' | 'credit')}>
                          <option value="credit">赊账（记应付）</option>
                          <option value="cash">现结</option>
                        </select>
                      </label>
                      {pMode === 'cash' && (
                        <label>
                          付款账户
                          <select value={effPurAcct} onChange={(e) => setPAcct(e.target.value)}>
                            {purAccts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        日期
                        <input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} />
                      </label>
                    </div>
                    <div className="ds-lines">
                      {dsLines.map((l) => (
                        <label key={l.id} className="ds-line">
                          <span>{l.name} ×{l.qty} · 采购价(¥)</span>
                          <input
                            inputMode="decimal"
                            value={pCosts[l.id] ?? ''}
                            onChange={(e) => setPCosts((c) => ({ ...c, [l.id]: e.target.value }))}
                            placeholder="0.00"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="ord-foot">
                      <button className="lnk" onClick={() => setPurchaseFor(null)}>
                        取消
                      </button>
                      <button className="btn btn-primary" onClick={() => void submitPurchase(o, dsLines, effPurAcct)}>
                        确认采购
                      </button>
                    </div>
                  </div>
                );
              })()}
              {collectFor === o.id && (() => {
                // 收款账户限同币种（跨币种收款属换汇，不在此处理）
                const collectAccts = cashAccounts.filter((a) => a.currency === o.currency);
                const effAcct = collectAccts.some((a) => a.id === cAcct) ? cAcct : (collectAccts[0]?.id ?? '');
                return (
                <div className="collect">
                  <div className="qgrid">
                    <label>
                      收款金额（{currencyDef(o.currency).symbol}）
                      <input inputMode="decimal" value={cAmount} onChange={(e) => setCAmount(e.target.value)} placeholder="0.00" />
                    </label>
                    <label>
                      日期
                      <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
                    </label>
                    <label>
                      收款账户
                      {collectAccts.length === 0 ? (
                        <span className="muted small">无 {currencyDef(o.currency).name} 账户，请先去「账户」页建一个</span>
                      ) : (
                        <select value={effAcct} onChange={(e) => setCAcct(e.target.value)}>
                          {collectAccts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  </div>
                  <div className="ord-foot">
                    <button className="lnk" onClick={() => setCollectFor(null)}>
                      取消
                    </button>
                    <button className="btn btn-primary" onClick={() => void doCollect(o)}>
                      确认收款
                    </button>
                  </div>
                </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** 解析单价（主单位）为最小单位（按币种小数位）；空/非法按 0 处理，仅用于实时小计预览。 */
function toMinorSafe(price: string, decimals: number): number {
  const n = Number(price);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10 ** decimals) : 0;
}

/** 完成订单的收款状态徽章（金额按订单币种）。 */
function payBadge(
  p: { status: OrderPaymentStatus; collected: number; total: number } | undefined,
  currency: string,
): { label: string; cls: string } | null {
  if (!p) return null;
  if (p.status === 'paid') return { label: '已收清', cls: 'ok' };
  if (p.status === 'partial') return { label: `部分收 ${fmtMoney(p.collected, currency)}/${fmtMoney(p.total, currency)}`, cls: 'warn' };
  return { label: '未收款', cls: 'danger' };
}
