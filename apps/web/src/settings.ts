import type { AccountingBasis, ConvertCtx } from '@app/core';
import type { StoredSetting } from '@app/store';
import { CNY_BASE, localISO } from './format';
import type { CurrencyDef } from './format';

/**
 * 设置读取助手（web 层）：把通用 KV 设置翻译成有类型的取值。
 * 设置存储是 per-book（scope = 账本 id）或 app 级（scope = 'app'）。
 */

// 全局设置作用域（app 级，所有账本共用）。
export const APP_SCOPE = 'app';

/** 记账口径设置 key（全局）。 */
export const BASIS_KEY = 'accountingBasis';

/** 默认口径：权责发生制——保持现状（确认即收入），切换前行为不变。 */
export const DEFAULT_BASIS: AccountingBasis = 'accrual';

/** 取全局记账口径；未设置则回落默认。 */
export function basisOf(settings: StoredSetting[]): AccountingBasis {
  const row = settings.find((s) => s.scope === APP_SCOPE && s.key === BASIS_KEY);
  return row?.value === 'cash' ? 'cash' : DEFAULT_BASIS;
}

// —— 对账提醒（全局）——
/** 对账日：''=关闭 / 'last'=每月最后一天 / '1'..'28'=每月该日。 */
export const RECON_DAY_KEY = 'reconcileDay';
/** 提前提醒天数。 */
export const RECON_LEAD_KEY = 'reconcileLead';
export const DEFAULT_RECON_LEAD = 3;

export function reconcileDayOf(settings: StoredSetting[]): string {
  return settings.find((s) => s.scope === APP_SCOPE && s.key === RECON_DAY_KEY)?.value ?? '';
}

export function reconcileLeadOf(settings: StoredSetting[]): number {
  const v = settings.find((s) => s.scope === APP_SCOPE && s.key === RECON_LEAD_KEY)?.value;
  const n = v ? Number(v) : DEFAULT_RECON_LEAD;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECON_LEAD;
}

/** 本月对账目标日 YYYY-MM-DD；day='last'→当月最后一天，数字日超过当月天数则取最后一天。''→null。 */
export function reconcileTargetDate(today: Date, day: string): string | null {
  if (!day) return null;
  const y = today.getFullYear();
  const m = today.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const d = day === 'last' ? lastDay : Math.min(Math.max(Math.trunc(Number(day)), 1), lastDay);
  if (!Number.isFinite(d)) return null;
  return localISO(new Date(y, m, d));
}

/** 今天是否进入提醒窗口 [目标日−lead, 目标日]（闭区间，按本地日期比较）。 */
export function reconcileWindowOpen(today: Date, day: string, lead: number): boolean {
  const target = reconcileTargetDate(today, day);
  if (!target) return false;
  const [y, mo, d] = target.split('-').map(Number);
  const start = new Date(y!, mo! - 1, d! - lead); // 负日 JS 自动回退到上月，跨月窗口安全
  const end = new Date(y!, mo! - 1, d!);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return t >= start && t <= end;
}

// —— 应收到期提醒（全局）——
/** 提前天数：''/未设=默认提前 7 天；'off'=关闭；数字=提前该天数。 */
export const DUE_LEAD_KEY = 'dueSoonLead';
export const DEFAULT_DUE_LEAD = 7;

/** 取应收到期提醒提前天数；返回 null = 关闭（不提醒）。未设置默认提前 7 天（应收逾期天然刚需，默认开）。 */
export function dueLeadOf(settings: StoredSetting[]): number | null {
  const v = settings.find((s) => s.scope === APP_SCOPE && s.key === DUE_LEAD_KEY)?.value;
  if (v === 'off') return null;
  if (v === undefined || v === '') return DEFAULT_DUE_LEAD;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DUE_LEAD;
}

// —— 商家进阶功能开关（app 级）——默认关＝极简模式：生意账本只留 总览/流水/预算/账户，
// 隐藏进销存/采购/对账/多币种/记账口径等专业功能。需要的用户在设置里打开。 ——
export const ADVANCED_KEY = 'advancedFeatures';
export function advancedOn(settings: StoredSetting[]): boolean {
  return settings.find((s) => s.scope === APP_SCOPE && s.key === ADVANCED_KEY)?.value === 'on';
}

// —— 多币种开关（app 级）——默认关：纯人民币 UI，隐藏币种管理与账户币种选择 ——
export const MULTICURRENCY_KEY = 'multiCurrency';
export function multiCurrencyOn(settings: StoredSetting[]): boolean {
  return settings.find((s) => s.scope === APP_SCOPE && s.key === MULTICURRENCY_KEY)?.value === 'on';
}

// —— 多币种币种注册表（app 级，全局共用，用户自管）——
/** 自定义币种存 app 级 JSON 数组（不含 CNY）：[{code,symbol,name,decimals,rate}, …]。 */
export const CURRENCIES_KEY = 'currencies';

// —— 展示币种（app 级）——财务总表/净资产折算成该币种显示，默认人民币 ——
export const DISPLAY_CURRENCY_KEY = 'displayCurrency';
export const DEFAULT_DISPLAY_CURRENCY = 'CNY';

/** 取展示币种；未设置、指向 CNY、或指向已删除的币种都回落 CNY。 */
export function displayCurrencyOf(settings: StoredSetting[]): string {
  const v = settings.find((s) => s.scope === APP_SCOPE && s.key === DISPLAY_CURRENCY_KEY)?.value;
  if (!v || v === 'CNY') return DEFAULT_DISPLAY_CURRENCY;
  return currenciesOf(settings).some((c) => c.code === v) ? v : DEFAULT_DISPLAY_CURRENCY;
}

/** 读币种列表（CNY 在首 + 用户自定义）；逐项校验，坏数据丢弃。 */
export function currenciesOf(settings: StoredSetting[]): CurrencyDef[] {
  const custom: CurrencyDef[] = [];
  const row = settings.find((s) => s.scope === APP_SCOPE && s.key === CURRENCIES_KEY);
  if (row) {
    try {
      const arr = JSON.parse(row.value) as unknown;
      if (Array.isArray(arr)) {
        for (const c of arr as Array<Record<string, unknown>>) {
          const code = typeof c.code === 'string' ? c.code.trim() : '';
          if (!code || code === 'CNY') continue;
          const rate = Number(c.rate);
          const dec = Number(c.decimals);
          custom.push({
            code,
            symbol: typeof c.symbol === 'string' && c.symbol ? c.symbol : code,
            name: typeof c.name === 'string' && c.name ? c.name : code,
            decimals: Number.isInteger(dec) && dec >= 0 && dec <= 8 ? dec : 2,
            rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
          });
        }
      }
    } catch {
      /* 坏 JSON 忽略 */
    }
  }
  return [CNY_BASE, ...custom];
}

/**
 * 折算上下文（展示币种 + 各币种汇率/小数位），从币种注册表派生。
 * multiCurrency 传**生效值**（持有外币账户时强制为 true，见 App.mcEnabled）——未开启时强制人民币展示。
 */
export function convertCtxOf(settings: StoredSetting[], multiCurrency: boolean = multiCurrencyOn(settings)): ConvertCtx {
  const defs = currenciesOf(settings);
  const rates: Record<string, number> = {};
  const scales: Record<string, number> = {};
  for (const d of defs) {
    rates[d.code] = d.rate;
    scales[d.code] = d.decimals;
  }
  const display = multiCurrency ? displayCurrencyOf(settings) : DEFAULT_DISPLAY_CURRENCY;
  return { rates, scales, display };
}
