import { useState } from 'react';
import type { AccountingBasis } from '@app/core';
import type { Repository, StoredSetting } from '@app/store';
import { currencyDef } from '../format';
import type { CurrencyDef } from '../format';
import {
  APP_SCOPE,
  BASIS_KEY,
  CURRENCIES_KEY,
  DISPLAY_CURRENCY_KEY,
  MULTICURRENCY_KEY,
  RECON_DAY_KEY,
  RECON_LEAD_KEY,
  basisOf,
  currenciesOf,
  displayCurrencyOf,
  multiCurrencyOn,
  reconcileDayOf,
  reconcileLeadOf,
} from '../settings';

const OPTIONS: Array<{ value: AccountingBasis; label: string; desc: string }> = [
  { value: 'accrual', label: '权责发生制', desc: '订单完成即确认收入（含未收的赊账）。正规、贴资产负债表。' },
  { value: 'cash', label: '收付实现制', desc: '只把实际到账算收入，赊账等收到钱才计。直观、贴日常现金流。' },
];

const emptyNew = { code: '', symbol: '', name: '', decimals: '2', rate: '' };

/** 全局设置：记账口径 / 对账提醒 / 币种，全部应用于所有账本。 */
export default function Settings({
  repo,
  settings,
  usedCurrencies,
  reload,
}: {
  repo: Repository;
  settings: StoredSetting[];
  usedCurrencies: Set<string>;
  reload: () => Promise<void>;
}) {
  const basis = basisOf(settings);
  const reconDay = reconcileDayOf(settings);
  const reconLead = reconcileLeadOf(settings);
  // 持有外币账户 → 多币种锁定为开（关却仍显示外币=自相矛盾）；归档所有外币账户后才能切回纯人民币。
  const foreignInUse = [...usedCurrencies].filter((c) => c !== 'CNY');
  const hasForeignData = foreignInUse.length > 0;
  const mc = multiCurrencyOn(settings) || hasForeignData;
  const allCurrencies = currenciesOf(settings); // CNY 在首 + 自定义
  const custom = allCurrencies.filter((c) => c.code !== 'CNY');
  const displayCur = displayCurrencyOf(settings);
  const [saving, setSaving] = useState(false);
  const [nc, setNc] = useState(emptyNew);
  const [err, setErr] = useState<string | null>(null);

  async function save(key: string, value: string): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await repo.setSetting(APP_SCOPE, key, value);
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function persistCurrencies(defs: CurrencyDef[]): Promise<void> {
    setSaving(true);
    try {
      await repo.setSetting(APP_SCOPE, CURRENCIES_KEY, JSON.stringify(defs));
      await reload();
    } finally {
      setSaving(false);
    }
  }

  function updateCurrency(code: string, patch: Partial<CurrencyDef>): void {
    void persistCurrencies(custom.map((d) => (d.code === code ? { ...d, ...patch } : d)));
  }

  async function addCurrency(): Promise<void> {
    setErr(null);
    const code = nc.code.trim().toUpperCase();
    if (!code) return setErr('请输入币种代码（如 JPY、BTC）');
    if (code === 'CNY' || custom.some((c) => c.code === code)) return setErr(`币种「${code}」已存在`);
    const rate = Number(nc.rate);
    if (!Number.isFinite(rate) || rate <= 0) return setErr('请输入有效的对人民币汇率');
    const dec = parseInt(nc.decimals, 10);
    await persistCurrencies([
      ...custom,
      {
        code,
        symbol: nc.symbol.trim() || code,
        name: nc.name.trim() || code,
        decimals: Number.isInteger(dec) && dec >= 0 && dec <= 8 ? dec : 2,
        rate,
      },
    ]);
    setNc(emptyNew);
  }

  async function removeCurrency(c: CurrencyDef): Promise<void> {
    setErr(null);
    if (usedCurrencies.has(c.code)) return setErr(`「${c.code}」已有账户在用，不能删除（先归档/改用其他币种的账户）`);
    if (!confirm(`删除币种「${c.name} ${c.code}」？`)) return;
    await persistCurrencies(custom.filter((x) => x.code !== c.code));
  }

  const num = (s: string, fallback: number): number => {
    if (s.trim() === '') return fallback; // 清空输入按原值，避免误存 0
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <>
      <div className="main-head">
        <h2>设置</h2>
        <span className="muted">全局 · 应用于所有账本</span>
      </div>

      <div className="card">
        <h3>记账口径</h3>
        <p className="muted small">
          切换「本月收入 / 利润」的计算口径。底层分录始终按权责发生制记账，这里只改报表呈现，不改动任何已记交易。
          仅对有赊账的生意账本有差异，个人 / 投资账本两种口径结果一致。
        </p>
        <div className="opt-list">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`opt-card${basis === o.value ? ' on' : ''}`}
              onClick={() => void save(BASIS_KEY, o.value)}
              disabled={saving}
            >
              <span className="opt-radio" aria-hidden />
              <span className="opt-body">
                <span className="opt-label">{o.label}</span>
                <span className="muted small">{o.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>对账提醒</h3>
        <p className="muted small">设定每月对账日后，临近时在账本顶部提醒去「对账」页核对；某账本已全部核销则不打扰。</p>
        <div className="rec-setup">
          <label>
            对账日
            <select value={reconDay} onChange={(e) => void save(RECON_DAY_KEY, e.target.value)} disabled={saving}>
              <option value="">关闭提醒</option>
              <option value="last">每月最后一天</option>
              {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                <option key={d} value={d}>
                  每月 {d} 日
                </option>
              ))}
            </select>
          </label>
          {reconDay !== '' && (
            <label>
              提前提醒
              <select value={String(reconLead)} onChange={(e) => void save(RECON_LEAD_KEY, e.target.value)} disabled={saving}>
                {[0, 1, 2, 3, 5, 7].map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 0 ? '当天' : `提前 ${n} 天`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="card">
        <h3>多币种</h3>
        <label className="chkline" style={{ marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={mc}
            onChange={(e) => void save(MULTICURRENCY_KEY, e.target.checked ? 'on' : 'off')}
            disabled={saving || hasForeignData}
          />
          开启多币种（可添加美元 / 日元 / 比特币等币种，建账户时选币种）
        </label>
        {hasForeignData ? (
          <p className="muted small">
            已有外币账户在用（{foreignInUse.map((c) => currencyDef(c).name).join('、')}），多币种已锁定开启。
            要回到纯人民币，请先到「账户」页归档所有外币账户。
          </p>
        ) : (
          <p className="muted small">关闭时全部按人民币，账户与报表不出现币种选项。只用人民币的话保持关闭即可。</p>
        )}

        {mc && (
          <>
            <div className="rec-setup">
              <label>
                展示币种
                <select value={displayCur} onChange={(e) => void save(DISPLAY_CURRENCY_KEY, e.target.value)} disabled={saving}>
                  {allCurrencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} {c.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">财务总表与各账本的净资产、收支按所选币种折算显示（各账户余额、流水仍按原币）。</p>

            <p className="muted small">
              自定义币种（代码 / 符号 / 名称 / 小数位 / 对人民币汇率）。多币种账户在财务总表按币种分组、用汇率折合展示币种。
              人民币是本位币、固定不可改。
            </p>
            <div className="cur-table">
          <div className="cur-head">
            <span>代码</span>
            <span>符号</span>
            <span>名称</span>
            <span>小数位</span>
            <span>1 单位 = ¥</span>
            <span />
          </div>
          <div className="cur-row muted">
            <span>CNY</span>
            <span>¥</span>
            <span>人民币</span>
            <span>2</span>
            <span>1</span>
            <span className="small">本位币</span>
          </div>
          {custom.map((c) => (
            <div className="cur-row" key={c.code}>
              <span className="cur-code">{c.code}</span>
              <input defaultValue={c.symbol} onBlur={(e) => updateCurrency(c.code, { symbol: e.target.value.trim() || c.code })} disabled={saving} />
              <input defaultValue={c.name} onBlur={(e) => updateCurrency(c.code, { name: e.target.value.trim() || c.code })} disabled={saving} />
              <input
                inputMode="numeric"
                defaultValue={String(c.decimals)}
                onBlur={(e) => updateCurrency(c.code, { decimals: Math.min(8, Math.max(0, Math.trunc(num(e.target.value, c.decimals)))) })}
                disabled={saving || usedCurrencies.has(c.code)}
                title={usedCurrencies.has(c.code) ? '已有账户在用，小数位不可改（会错读已记金额）' : ''}
              />
              <input
                inputMode="decimal"
                defaultValue={String(c.rate)}
                onBlur={(e) => { const r = num(e.target.value, c.rate); if (r > 0) updateCurrency(c.code, { rate: r }); }}
                disabled={saving}
              />
              <button className="lnk danger" onClick={() => void removeCurrency(c)} disabled={saving}>
                删除
              </button>
            </div>
          ))}
        </div>

        <div className="cur-add">
          <input placeholder="代码 JPY" value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value })} />
          <input placeholder="符号 ¥" value={nc.symbol} onChange={(e) => setNc({ ...nc, symbol: e.target.value })} />
          <input placeholder="名称 日元" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} />
          <input placeholder="小数位 0" inputMode="numeric" value={nc.decimals} onChange={(e) => setNc({ ...nc, decimals: e.target.value })} />
          <input placeholder="汇率 0.05" inputMode="decimal" value={nc.rate} onChange={(e) => setNc({ ...nc, rate: e.target.value })} />
          <button className="btn btn-primary" onClick={() => void addCurrency()} disabled={saving}>
            添加
          </button>
        </div>
        {err && <p className="form-err">{err}</p>}
          </>
        )}
      </div>
    </>
  );
}
