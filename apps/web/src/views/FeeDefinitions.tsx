import { useEffect, useState } from 'react';
import { fromMinor, toMinor } from '@app/core';
import type { FeeCalcType, FeeTier } from '@app/core';
import type { StoredFeeDefinition } from '@app/store';
import type { AppData } from '../App';
import { genId } from '../db';
import { fmtMoney } from '../format';

const CALC_LABEL: Record<FeeCalcType, string> = { percent: '百分比', fixed: '固定金额', perQty: '按数量' };

/** 各计算方式下阶梯档位的「阈值 / 值」输入单位与标签。 */
function tierLabels(calc: FeeCalcType): { th: string; val: string } {
  if (calc === 'perQty') return { th: '数量阈值（件）', val: '单位额（元/件）' };
  if (calc === 'fixed') return { th: '金额阈值（元）', val: '固定额（元）' };
  return { th: '金额阈值（元）', val: '百分比（%）' };
}

interface TierDraft {
  key: string;
  threshold: string;
  value: string;
}

/** 一档显示文案：如 "≥¥600 → 4%" / "≥10 件 → ¥1.50/件" / "≥¥0 → ¥10"。 */
function tierText(calc: FeeCalcType, t: FeeTier): string {
  const th = calc === 'perQty' ? `≥${t.threshold} 件` : `≥${fmtMoney(t.threshold)}`;
  const v = calc === 'percent' ? `${t.value}%` : calc === 'perQty' ? `${fmtMoney(t.value)}/件` : fmtMoney(t.value);
  return `${th} → ${v}`;
}

/** 把 UI 输入的档位（元/件/百分数）解析为存储单位（金额阈值/固定/单位额→分，百分比→数；数量阈值→件数）。 */
function parseTiers(calc: FeeCalcType, drafts: TierDraft[]): FeeTier[] | null {
  const out: FeeTier[] = [];
  for (const d of drafts) {
    const thNum = Number(d.threshold.trim() === '' ? '0' : d.threshold);
    const vNum = Number(d.value);
    // 阈值（分组合计）须非负；数值允许为负——满减/折扣等优惠（如满 300 减 20 = 固定额 −20）。
    if (!Number.isFinite(thNum) || thNum < 0 || !Number.isFinite(vNum)) return null;
    const threshold = calc === 'perQty' ? thNum : toMinor(thNum);
    const value = calc === 'percent' ? vNum : toMinor(vNum);
    out.push({ threshold, value });
  }
  return out.sort((a, b) => a.threshold - b.threshold);
}

/** 反解析（存储单位 → UI 元/件）供编辑回填。 */
function toDrafts(calc: FeeCalcType, tiers: FeeTier[]): TierDraft[] {
  return tiers.map((t) => ({
    key: genId(),
    threshold: String(calc === 'perQty' ? t.threshold : fromMinor(t.threshold)),
    value: String(calc === 'percent' ? t.value : fromMinor(t.value)),
  }));
}

export default function FeeDefinitions({ data }: { data: AppData }) {
  const { repo, book, reload } = data;
  const [list, setList] = useState<StoredFeeDefinition[]>([]);
  const [editId, setEditId] = useState<string | null>(null); // null=新增模式
  const [name, setName] = useState('');
  const [calc, setCalc] = useState<FeeCalcType>('percent');
  const [tiers, setTiers] = useState<TierDraft[]>([{ key: genId(), threshold: '0', value: '' }]);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setList(await repo.listFeeDefinitions({ bookId: book.id, includeArchived: true }));
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);
  // 表单在列表上方：点列表里的「编辑」时，把表单滚入视野（否则在长列表下方点编辑、上方表单看不见）
  useEffect(() => {
    if (editId) document.getElementById('fee-edit-form')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [editId]);

  function resetForm(): void {
    setEditId(null);
    setName('');
    setCalc('percent');
    setTiers([{ key: genId(), threshold: '0', value: '' }]);
    setErr(null);
  }

  function openEdit(f: StoredFeeDefinition): void {
    setEditId(f.id);
    setName(f.name);
    setCalc(f.calcType);
    setTiers(f.tiers.length ? toDrafts(f.calcType, f.tiers) : [{ key: genId(), threshold: '0', value: '' }]);
    setErr(null);
  }

  async function save(): Promise<void> {
    setErr(null);
    const nm = name.trim();
    if (!nm) {
      setErr('请输入费用名称');
      return;
    }
    const parsed = parseTiers(calc, tiers);
    if (!parsed || parsed.length === 0) {
      setErr('阈值需为非负数（数值可为负，如满减优惠）');
      return;
    }
    if (parsed[0]!.threshold !== 0) {
      setErr('需有一档阈值为 0（最低档，覆盖最小分组合计）');
      return;
    }
    if (editId) {
      await repo.updateFeeDefinition(editId, { name: nm, calcType: calc, tiers: parsed });
    } else {
      await repo.addFeeDefinition({ id: genId(), bookId: book.id, name: nm, calcType: calc, tiers: parsed, archived: false });
    }
    resetForm();
    await refresh();
    await reload();
  }

  async function toggleArchive(f: StoredFeeDefinition): Promise<void> {
    if (!f.archived && !confirm(`归档「${f.name}」？归档后开单不再可选，历史订单已记的费用不受影响。`)) return;
    await repo.updateFeeDefinition(f.id, { archived: !f.archived });
    if (editId === f.id) resetForm();
    await refresh();
    await reload();
  }

  const labels = tierLabels(calc);
  const rows = list.slice().sort((a, b) => Number(a.archived) - Number(b.archived));

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 额外费用</h2>
        <span className="muted">佣金 / 运费 / 包装费等——开单按行勾选，都计入收入</span>
      </div>

      <div className="card" id={editId ? 'fee-edit-form' : undefined}>
        <h3>{editId ? '编辑费用' : '新增费用'}</h3>
        <div className="qgrid">
          <label>
            名称
            <input placeholder="如 佣金 / 运费" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            计算方式
            <select value={calc} onChange={(e) => setCalc(e.target.value as FeeCalcType)}>
              <option value="percent">百分比（行金额 ×%）</option>
              <option value="fixed">固定金额（一次性）</option>
              <option value="perQty">按数量（数量 × 单位额）</option>
            </select>
          </label>
        </div>
        <p className="muted small" style={{ marginBottom: 6 }}>
          声明式阶梯：按「应用本费用的商品行」分组合计落在哪档，整组用该档。单档则填一行（阈值 0）。
        </p>
        <div className="ds-lines">
          {tiers.map((t, i) => (
            <div className="ord-line" key={t.key}>
              <label className="tier-f">
                {labels.th}
                <input inputMode="decimal" value={t.threshold} onChange={(e) => setTiers((ts) => ts.map((x) => (x.key === t.key ? { ...x, threshold: e.target.value } : x)))} />
              </label>
              <label className="tier-f">
                {labels.val}
                <input inputMode="decimal" value={t.value} onChange={(e) => setTiers((ts) => ts.map((x) => (x.key === t.key ? { ...x, value: e.target.value } : x)))} placeholder="0" />
              </label>
              {tiers.length > 1 && (
                <button className="del" title="删除此档" onClick={() => setTiers((ts) => ts.filter((x) => x.key !== t.key))}>
                  ×
                </button>
              )}
              {i === tiers.length - 1 && (
                <button className="lnk" onClick={() => setTiers((ts) => [...ts, { key: genId(), threshold: '', value: '' }])}>
                  ＋ 加一档
                </button>
              )}
            </div>
          ))}
        </div>
        {err && <p className="form-err" style={{ marginTop: 8 }}>{err}</p>}
        <div className="arow-btns" style={{ marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => void save()}>
            {editId ? '保存' : '添加'}
          </button>
          {editId && (
            <button className="lnk" onClick={resetForm}>
              取消编辑
            </button>
          )}
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <p className="muted">还没有额外费用。在上方添加后，开单时可在每个商品行勾选应用。</p>}
        {rows.map((f) => (
          <div className="brow" key={f.id}>
            <div className="bhead">
              <span className={`bname${f.archived ? ' muted' : ''}`}>
                {f.name}
                <span className="chip"> {CALC_LABEL[f.calcType]}</span>
                {f.archived && <span className="chip"> 已归档</span>}
              </span>
              <span className="bnum muted">{f.tiers.map((t) => tierText(f.calcType, t)).join(' · ')}</span>
              <div className="arow-btns">
                <button className="lnk" onClick={() => openEdit(f)}>
                  编辑
                </button>
                <button className={`lnk${f.archived ? '' : ' danger'}`} onClick={() => void toggleArchive(f)}>
                  {f.archived ? '恢复' : '归档'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
