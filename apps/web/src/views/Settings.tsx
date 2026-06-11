import { useState } from 'react';
import type { AccountingBasis } from '@app/core';
import type { AppData } from '../App';
import { BASIS_KEY, basisOf } from '../settings';

const OPTIONS: Array<{ value: AccountingBasis; label: string; desc: string }> = [
  { value: 'accrual', label: '权责发生制', desc: '订单完成即确认收入（含未收的赊账）。正规、贴资产负债表。' },
  { value: 'cash', label: '收付实现制', desc: '只把实际到账算收入，赊账等收到钱才计。直观、贴日常现金流。' },
];

export default function Settings({ data }: { data: AppData }) {
  const { repo, book, settings, reload } = data;
  const basis = basisOf(settings, book.id);
  const [saving, setSaving] = useState(false);

  async function pick(v: AccountingBasis): Promise<void> {
    if (v === basis || saving) return;
    setSaving(true);
    try {
      await repo.setSetting(book.id, BASIS_KEY, v);
      await reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{book.name} · 设置</h2>
      </div>

      <div className="card">
        <h3>记账口径</h3>
        <p className="muted small">
          切换「本月收入 / 利润」的计算口径。底层分录始终按权责发生制记账，这里只改报表的呈现方式，不改动任何已记的交易。
        </p>
        <div className="opt-list">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`opt-card${basis === o.value ? ' on' : ''}`}
              onClick={() => void pick(o.value)}
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
        {book.type === 'business' ? (
          <p className="muted small">两种口径在本账本会得出不同的「本月收入 / 利润」——差异来自赊销与回款的时间差。</p>
        ) : (
          <p className="muted small">
            本账本收入本就是收到即记（无应收账款），两种口径结果一致。此设置主要用于有赊账的生意账本。
          </p>
        )}
      </div>
    </>
  );
}
