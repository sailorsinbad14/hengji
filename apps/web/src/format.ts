import type { StoredAccount, StoredTransaction } from '@app/store';

/** 一个币种的展示定义：代码 / 符号 / 名称 / 小数位 / 对人民币汇率。 */
export interface CurrencyDef {
  code: string;
  symbol: string;
  name: string;
  /** 最小单位小数位（CNY/USD=2、JPY=0、BTC=8…） */
  decimals: number;
  /** 1 单位该币种 = 多少人民币（CNY 自身=1） */
  rate: number;
}

/** 本位/展示币种：人民币（恒在、不可删、汇率=1）。 */
export const CNY_BASE: CurrencyDef = { code: 'CNY', symbol: '¥', name: '人民币', decimals: 2, rate: 1 };

/**
 * 模块级币种注册表（用户自管，存全局设置）。App 在加载设置后调用 setCurrencyRegistry 注入，
 * 使 fmtMoney 等纯展示函数无需层层传参即可拿到符号/小数位。单客户端、改动罕见，可接受模块状态。
 */
let REGISTRY: Record<string, CurrencyDef> = { CNY: CNY_BASE };

export function setCurrencyRegistry(defs: CurrencyDef[]): void {
  const m: Record<string, CurrencyDef> = { CNY: CNY_BASE };
  for (const d of defs) if (d.code !== 'CNY') m[d.code] = d;
  REGISTRY = m;
}

/** 取币种定义；未注册的代码兜底为「代码当符号、2 位小数、汇率 1」。 */
export function currencyDef(code: string): CurrencyDef {
  return REGISTRY[code] ?? { code, symbol: `${code} `, name: code, decimals: 2, rate: 1 };
}

/** 当前全部币种（CNY 在首）。 */
export function currencyList(): CurrencyDef[] {
  return Object.values(REGISTRY);
}

/** 金额格式化；按币种符号 + 小数位（默认人民币）。 */
export function fmtMoney(minor: number, currency = 'CNY'): string {
  const d = currencyDef(currency);
  const sign = minor < 0 ? '−' : '';
  const v = Math.abs(minor / 10 ** d.decimals).toLocaleString('zh-CN', {
    minimumFractionDigits: d.decimals,
    maximumFractionDigits: d.decimals,
  });
  return `${sign}${d.symbol}${v}`;
}

/** 本地时区的 YYYY-MM-DD（不能用 toISOString——那是 UTC，晚上会跨天） */
export function localISO(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO(): string {
  return localISO(new Date());
}

/** 两个 YYYY-MM-DD 间的天数（to − from），按 UTC 解析避免夏令时差一天。 */
export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
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
      const forex = from.p.currency !== to.p.currency;
      return {
        emoji: forex ? '💱' : '🔁',
        title: `${forex ? '换汇' : '转账'} → ${to.acc!.name}`,
        sub: forex
          ? `${from.acc!.name} ${fmtMoney(from.p.amount, from.p.currency)} → ${to.acc!.name} · ${t.date}`
          : `${from.acc!.name} → ${to.acc!.name} · ${t.date}`,
        amountText: fmtMoney(to.p.amount, to.p.currency),
        tone: 'neutral',
        tags: t.tags,
      };
    }
  }
  return { emoji: '📄', title: t.payee || t.note || '交易', sub: t.date, amountText: '', tone: 'neutral', tags: t.tags };
}
