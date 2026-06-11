import { fromMinor } from '@app/core';
import type { StoredAccount, StoredTransaction } from '@app/store';

/** Phase 1 支持的币种（均 2 位小数）；可变精度（JPY/BTC）留 Phase 2。 */
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'GBP'] as const;
export const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', GBP: '£' };
export const CURRENCY_LABEL: Record<string, string> = {
  CNY: '人民币 CNY',
  USD: '美元 USD',
  EUR: '欧元 EUR',
  HKD: '港币 HKD',
  GBP: '英镑 GBP',
};

/** 金额格式化；默认人民币。币种决定符号（Phase 1 统一 2 位小数）。 */
export function fmtMoney(minor: number, currency = 'CNY'): string {
  const sign = minor < 0 ? '−' : '';
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const v = Math.abs(fromMinor(minor)).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${sym}${v}`;
}

/** 本地时区的 YYYY-MM-DD（不能用 toISOString——那是 UTC，晚上会跨天） */
export function localISO(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO(): string {
  return localISO(new Date());
}

export function currentMonth(): string {
  return todayISO().slice(0, 7);
}

export const CATEGORY_EMOJI: Record<string, string> = {
  餐饮: '🍜',
  交通: '🚕',
  购物: '🛒',
  居住: '🏠',
  娱乐: '🎮',
  医疗: '💊',
  进货成本: '📦',
  其他支出: '💳',
  工资: '💰',
  营业收入: '🧾',
  投资盈亏: '📈',
  其他收入: '💼',
};

export interface TxnView {
  emoji: string;
  title: string;
  sub: string;
  amountText: string;
  tone: 'pos' | 'neg' | 'neutral';
  tags: string[];
}

/** 把一笔复式交易渲染成用户视角的单式描述（分类/账户/带符号金额）。 */
export function describeTxn(t: StoredTransaction, accounts: Map<string, StoredAccount>): TxnView {
  const enriched = t.postings.map((p) => ({ p, acc: accounts.get(p.accountId) }));
  const cat = enriched.find(
    (x) => x.acc && (x.acc.type === 'income' || x.acc.type === 'expense' || x.acc.type === 'equity'),
  );
  const real = enriched.filter((x) => x.acc && (x.acc.type === 'asset' || x.acc.type === 'liability'));

  if (cat?.acc?.type === 'expense' && real[0]) {
    return {
      emoji: CATEGORY_EMOJI[cat.acc.name] ?? '💸',
      title: t.payee || cat.acc.name,
      sub: `${cat.acc.name} · ${real[0].acc!.name} · ${t.date}`,
      amountText: fmtMoney(-cat.p.amount, cat.p.currency),
      tone: 'neg',
      tags: t.tags,
    };
  }
  if (cat?.acc?.type === 'income' && real[0]) {
    const amt = -cat.p.amount; // 收入 posting 为负 → 翻正；投资下调时为负（浮亏）
    return {
      emoji: CATEGORY_EMOJI[cat.acc.name] ?? '💰',
      title: t.payee || cat.acc.name,
      sub: `${cat.acc.name} · ${real[0].acc!.name} · ${t.date}`,
      amountText: (amt > 0 ? '+' : '') + fmtMoney(amt, cat.p.currency),
      tone: amt >= 0 ? 'pos' : 'neg',
      tags: t.tags,
    };
  }
  if (cat?.acc?.type === 'equity' && real[0]) {
    return {
      emoji: '🏁',
      title: t.note || '期初余额',
      sub: `${real[0].acc!.name} · ${t.date}`,
      amountText: fmtMoney(real[0].p.amount, real[0].p.currency),
      tone: 'neutral',
      tags: t.tags,
    };
  }
  if (real.length === 2) {
    const from = real.find((x) => x.p.amount < 0);
    const to = real.find((x) => x.p.amount > 0);
    if (from && to) {
      return {
        emoji: '🔁',
        title: `转账 → ${to.acc!.name}`,
        sub: `${from.acc!.name} → ${to.acc!.name} · ${t.date}`,
        amountText: fmtMoney(to.p.amount, to.p.currency),
        tone: 'neutral',
        tags: t.tags,
      };
    }
  }
  return { emoji: '📄', title: t.payee || t.note || '交易', sub: t.date, amountText: '', tone: 'neutral', tags: t.tags };
}
