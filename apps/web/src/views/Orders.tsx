import { useEffect, useMemo, useState } from 'react';
import { allocateCustomerPayments, fromMinor, orderTotal, toMinor } from '@app/core';
import type { CustomerPayment, OrderLine, OrderPaymentStatus, OrderStatus } from '@app/core';
import type { StoredCustomer, StoredOrder, StoredProduct, StoredSettlement } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney, todayISO } from '../format';
import { completeOrder, receivableSummary, recordCollection } from '../biz';

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
  const { repo, book, accounts, txns, reload } = data;
  const [customers, setCustomers] = useState<StoredCustomer[]>([]);
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [products, setProducts] = useState<StoredProduct[]>([]);
  const [settlements, setSettlements] = useState<StoredSettlement[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // 新建订单表单
  const [custId, setCustId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [note, setNote] = useState('');

  // 收款表单（按订单展开）
  const [collectFor, setCollectFor] = useState<string | null>(null);
  const [cAmount, setCAmount] = useState('');
  const [cDate, setCDate] = useState(todayISO());
  const [cAcct, setCAcct] = useState('');

  async function refresh(): Promise<void> {
    const [cs, os, ps, ss] = await Promise.all([
      repo.listCustomers({ bookId: book.id, includeArchived: true }),
      repo.listOrders({ bookId: book.id }),
      repo.listProducts({ bookId: book.id }),
      repo.listSettlements({ bookId: book.id }),
    ]);
    setCustomers(cs);
    setOrders(os);
    setProducts(ps);
    setSettlements(ss);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  const custName = (id: string): string => customers.find((c) => c.id === id)?.name ?? '（已删客户）';
  const activeCustomers = customers.filter((c) => !c.archived);
  const cashAccounts = accounts.filter((a) => a.type === 'asset' && !a.name.startsWith('应收账款'));
  const effCust = activeCustomers.some((c) => c.id === custId) ? custId : (activeCustomers[0]?.id ?? '');
  const effCAcct = cashAccounts.some((a) => a.id === cAcct) ? cAcct : (cashAccounts[0]?.id ?? '');

  const draftTotal = useMemo(
    () => lines.reduce((s, l) => s + Math.round((Number(l.qty) || 0) * toMinorSafe(l.price)), 0),
    [lines],
  );

  // 按「单据归属」把每笔收款摊到已完成订单（指定单优先，多付/未指定才 FIFO 顺延）
  // → 每单收款状态 + 应收/预收概览。收款的 orderId 来自 settlements。
  const { payStatus, summary, outstanding } = useMemo(() => {
    const status = new Map<string, { status: OrderPaymentStatus; collected: number; total: number }>();
    const out: Array<{ order: StoredOrder; owed: number; days: number; overdue: boolean }> = [];
    const byCust = new Map<string, StoredOrder[]>();
    for (const o of orders) {
      if (o.status !== 'completed') continue;
      const arr = byCust.get(o.customerId) ?? [];
      arr.push(o);
      byCust.set(o.customerId, arr);
    }
    // 客户的收款明细（带 orderId）：只取收款方向、客户对手方
    const paysByCust = new Map<string, CustomerPayment[]>();
    for (const s of settlements) {
      if (s.direction !== 'in' || s.counterpartyType !== 'customer') continue;
      const arr = paysByCust.get(s.counterpartyId) ?? [];
      arr.push({ orderId: s.orderId, amount: s.amount });
      paysByCust.set(s.counterpartyId, arr);
    }
    const today = todayISO();
    for (const [custId2, custOrders] of byCust) {
      const cust = customers.find((c) => c.id === custId2);
      if (!cust) continue;
      const ledger = allocateCustomerPayments(
        custOrders.map((o) => ({ id: o.id, total: orderTotal(o.lines), date: o.date })),
        paysByCust.get(custId2) ?? [],
      );
      for (const a of ledger.allocations) {
        status.set(a.orderId, { status: a.status, collected: a.collected, total: a.total });
        if (a.status !== 'paid') {
          const ord = custOrders.find((o) => o.id === a.orderId)!;
          const days = daysBetween(ord.date, today);
          out.push({ order: ord, owed: a.total - a.collected, days, overdue: cust.dueDays > 0 && days > cust.dueDays });
        }
      }
    }
    out.sort((x, y) => y.days - x.days);
    return { payStatus: status, summary: receivableSummary(accounts, txns), outstanding: out };
  }, [orders, customers, settlements, accounts, txns]);

  function setLine(key: string, patch: Partial<LineDraft>): void {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickProduct(key: string, productId: string): void {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      setLine(key, { productId: '' });
      return;
    }
    setLine(key, { productId, name: p.name, price: String(fromMinor(p.salePrice)) });
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
      unitPrice: toMinor(Number(l.price)),
      productId: l.productId || null,
    }));
    try {
      await repo.addOrder({
        id: orderId,
        bookId: book.id,
        customerId: effCust,
        date,
        status: 'pending_ship',
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
    if (!confirm(`取消订单（${custName(order.customerId)} · ${fmtMoney(orderTotal(order.lines))}）？未完成订单无账务影响。`)) return;
    await repo.updateOrder(order.id, { status: 'cancelled' });
    await refresh();
  }

  function openCollect(order: StoredOrder): void {
    // 预填这张单自己还欠的金额（不是客户总欠款），避免在某张单上误收走别单的钱
    const p = payStatus.get(order.id);
    const owed = p ? p.total - p.collected : orderTotal(order.lines);
    setCollectFor(order.id);
    setCAmount(owed > 0 ? String(fromMinor(owed)) : '');
    setCDate(todayISO());
    setCAcct('');
    setErr(null);
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
    if (!effCAcct) {
      setErr('没有可收款的资产账户');
      return;
    }
    try {
      await recordCollection(repo, book, {
        customer: cust,
        orderId: order.id,
        amount: toMinor(amt),
        date: cDate,
        assetAccountId: effCAcct,
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
              <span className={summary.receivable > 0 ? 'neg' : 'muted'}>应收 {fmtMoney(summary.receivable)}</span>
              {summary.prepaid > 0 && <span className="recv-pre">预收 {fmtMoney(summary.prepaid)}</span>}
            </span>
          </div>
          {outstanding.length === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>所有已完成订单均已收清 🎉</p>
          ) : (
            outstanding.map(({ order, owed, days, overdue }) => (
              <div className="recv-row" key={order.id}>
                <span className="bname">
                  {custName(order.customerId)} <span className="muted">· {order.date} · {days}天前</span>
                  {overdue && <span className="chip danger"> 逾期</span>}
                </span>
                <span className="bnum neg">欠 {fmtMoney(owed)}</span>
              </div>
            ))
          )}
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
                    placeholder="单价(元)"
                    value={l.price}
                    onChange={(e) => setLine(l.key, { price: e.target.value })}
                  />
                  <span className="ord-sub">{fmtMoney(Math.round((Number(l.qty) || 0) * toMinorSafe(l.price)))}</span>
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
              <span className="ord-total">合计 {fmtMoney(draftTotal)}</span>
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
          const pay = o.status === 'completed' ? payBadge(payStatus.get(o.id)) : null;
          return (
            <div className="brow" key={o.id}>
              <div className="bhead">
                <span className="bname">
                  {custName(o.customerId)} <span className="muted">· {o.date}</span>
                </span>
                <span className={`chip ${st.cls}`}>{st.label}</span>
                {pay && <span className={`chip ${pay.cls}`}>{pay.label}</span>}
                <span className="bnum">{fmtMoney(orderTotal(o.lines))}</span>
              </div>
              <div className="ord-items">{o.lines.map((l) => `${l.name}×${l.qty}`).join('，')}</div>
              <div className="arow-btns">
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
              {collectFor === o.id && (
                <div className="collect">
                  <div className="qgrid">
                    <label>
                      收款金额（元）
                      <input inputMode="decimal" value={cAmount} onChange={(e) => setCAmount(e.target.value)} placeholder="0.00" />
                    </label>
                    <label>
                      日期
                      <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
                    </label>
                    <label>
                      收款账户
                      <select value={effCAcct} onChange={(e) => setCAcct(e.target.value)}>
                        {cashAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
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
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** 解析单价（元）为最小单位；空/非法按 0 处理，仅用于实时小计预览。 */
function toMinorSafe(price: string): number {
  const n = Number(price);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

/** 两个 YYYY-MM-DD 间的天数（to − from）。按 UTC 解析，避免夏令时导致差一天。 */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.floor(ms / 86400000);
}

/** 完成订单的收款状态徽章。 */
function payBadge(p?: { status: OrderPaymentStatus; collected: number; total: number }): { label: string; cls: string } | null {
  if (!p) return null;
  if (p.status === 'paid') return { label: '已收清', cls: 'ok' };
  if (p.status === 'partial') return { label: `部分收 ${fmtMoney(p.collected)}/${fmtMoney(p.total)}`, cls: 'warn' };
  return { label: '未收款', cls: 'danger' };
}
