import { useEffect, useMemo, useState } from 'react';
import { toMinor } from '@app/core';
import type { StoredFeeDefinition, StoredPluginDocument } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney } from '../format';
import { PLATFORM_SALE } from '../documents/registry';
import { previewDocument, saveDocument, voidDocument } from '../docs';

interface LineDraft {
  key: string;
  name: string;
  qty: string;
  price: string; // 单价（元）
}

const newLine = (): LineDraft => ({ key: genId(), name: '', qty: '1', price: '' });

/** 平台销售单填单视图（插件地基 Step 1）。表单字段由注册表 PLATFORM_SALE.fields 驱动。 */
export default function Documents({ data }: { data: AppData }) {
  const { repo, book, reload } = data;
  const docType = PLATFORM_SALE;
  const feeFields = useMemo(() => docType.fields.filter((f) => f.type === 'fee'), [docType]);

  const [feeDefs, setFeeDefs] = useState<StoredFeeDefinition[]>([]);
  const [list, setList] = useState<StoredPluginDocument[]>([]);
  const [shop, setShop] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [feeSel, setFeeSel] = useState<Record<string, string>>({}); // 费用字段 key → 选中的 FeeDefinition id
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [fd, ds] = await Promise.all([
      repo.listFeeDefinitions({ bookId: book.id }),
      repo.listPluginDocuments({ bookId: book.id, docType: 'platformSale' }),
    ]);
    setFeeDefs(fd);
    setList(ds);
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);

  function buildData(): Record<string, unknown> {
    return {
      shop,
      date,
      lines: lines.map((l) => ({ name: l.name.trim(), qty: Number(l.qty) || 0, unitPrice: toMinor(Number(l.price) || 0) })),
      ...feeSel,
    };
  }

  const preview = useMemo(() => previewDocument(docType, buildData(), feeDefs), [shop, date, lines, feeSel, feeDefs, docType]);

  function resetForm(): void {
    setShop('');
    setDate(new Date().toISOString().slice(0, 10));
    setLines([newLine()]);
    setFeeSel({});
    setErr(null);
  }

  async function save(): Promise<void> {
    setErr(null);
    try {
      await saveDocument(repo, book, docType, buildData());
      resetForm();
      await refresh();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onVoid(doc: StoredPluginDocument): Promise<void> {
    if (!confirm('作废这张单？将撤销它生成的记账分录（余额回退）。')) return;
    await voidDocument(repo, doc);
    await refresh();
    await reload();
  }

  const feeOptions = feeDefs.filter((f) => !f.archived);

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · {docType.name}</h2>
        <span className="muted">平台卖货：商品额计收入、佣金/物流计费用、差额进「平台应收款」——一张单自动配平</span>
      </div>

      <div className="card">
        <h3>开单</h3>
        <div className="qgrid">
          <label>
            店铺 / 平台
            <input placeholder="如 拼多多旗舰店" value={shop} onChange={(e) => setShop(e.target.value)} />
          </label>
          <label>
            日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>

        <p className="muted small" style={{ margin: '10px 0 4px' }}>商品</p>
        <div className="ds-lines">
          {lines.map((l, i) => (
            <div className="ord-line" key={l.key}>
              <label className="tier-f" style={{ flex: 2 }}>
                名称
                <input placeholder="商品名" value={l.name} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, name: e.target.value } : x)))} />
              </label>
              <label className="tier-f">
                数量
                <input inputMode="decimal" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} />
              </label>
              <label className="tier-f">
                单价(元)
                <input inputMode="decimal" placeholder="0" value={l.price} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, price: e.target.value } : x)))} />
              </label>
              {lines.length > 1 && (
                <button className="del" title="删除此行" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  ×
                </button>
              )}
              {i === lines.length - 1 && (
                <button className="lnk" onClick={() => setLines((ls) => [...ls, newLine()])}>
                  ＋ 加一行
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="qgrid" style={{ marginTop: 8 }}>
          {feeFields.map((f) => (
            <label key={f.key}>
              {f.label}
              <select value={feeSel[f.key] ?? ''} onChange={(e) => setFeeSel((s) => ({ ...s, [f.key]: e.target.value }))}>
                <option value="">不收</option>
                {feeOptions.map((fd) => (
                  <option key={fd.id} value={fd.id}>
                    {fd.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {feeOptions.length === 0 && (
          <p className="muted small" style={{ marginTop: 6 }}>
            还没有可选的费用。到「费用」tab 先建好平台佣金 / 物流费（声明式阶梯），这里就能勾选。
          </p>
        )}

        {/* 实时分录预览 + 借贷平衡校验（把防火墙画在 UI 上） */}
        <div className="doc-preview" style={{ marginTop: 14, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, padding: '10px 12px' }}>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 8 }}>系统将自动记的分录</p>
          {preview.legs.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>填入商品后这里显示分录预览。</p>
          ) : (
            <>
              {preview.legs.map((leg, i) => (
                <div key={i} className="brow" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <span className="chip">{leg.side === 'debit' ? '借' : '贷'}</span>
                  <span>{leg.name}</span>
                  <span className="bnum" style={{ marginLeft: 'auto' }}>{fmtMoney(leg.amount)}</span>
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                {preview.balanced ? (
                  <span className="chip" style={{ background: 'var(--ok-bg, #e8f5e9)', color: 'var(--ok, #2e7d32)' }}>
                    借方 {fmtMoney(preview.debit)} ＝ 贷方 {fmtMoney(preview.credit)} · 自动平衡 ✓
                  </span>
                ) : (
                  <span className="chip" style={{ background: 'var(--warn-bg, #fdecea)', color: 'var(--warn, #c62828)' }}>
                    借方 {fmtMoney(preview.debit)} ≠ 贷方 {fmtMoney(preview.credit)} · 未平衡
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {err && <p className="form-err" style={{ marginTop: 8 }}>{err}</p>}
        <div className="arow-btns" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" disabled={!preview.balanced || preview.lineTotal <= 0} onClick={() => void save()}>
            保存单据
          </button>
        </div>
      </div>

      <div className="card">
        <h3>已开单据</h3>
        {list.length === 0 && <p className="muted">还没有平台销售单。上面开一张试试。</p>}
        {list.map((doc) => {
          const p = previewDocument(docType, doc.data, feeDefs);
          const shopName = typeof doc.data.shop === 'string' && doc.data.shop ? doc.data.shop : '（未填店铺）';
          const docDate = typeof doc.data.date === 'string' ? doc.data.date : '';
          const recv = p.legs.find((l) => l.name === '平台应收款');
          return (
            <div className="brow" key={doc.id}>
              <div className="bhead">
                <span className="bname">
                  {shopName}
                  <span className="chip"> {docDate}</span>
                </span>
                <span className="bnum muted">
                  商品 {fmtMoney(p.lineTotal)} · 实收 {fmtMoney(recv?.amount ?? p.lineTotal)}
                </span>
                <div className="arow-btns">
                  <button className="lnk danger" onClick={() => void onVoid(doc)}>
                    作废
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
