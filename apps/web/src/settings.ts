import type { AccountingBasis, ConvertCtx } from '@app/core';
import type { StoredSetting } from '@app/store';
import { localISO } from './format';

/**
 * 设置读取助手（web 层）：把通用 KV 设置翻译成有类型的取值。
 * 设置存储是 per-book（scope = 账本 id）或 app 级（scope = 'app'）。
 */

/** 记账口径设置 key（per-book）。 */
export const BASIS_KEY = 'accountingBasis';

/** 默认口径：权责发生制——保持现状（确认即收入），切换前行为不变。 */
export const DEFAULT_BASIS: AccountingBasis = 'accrual';

/** 取某账本的记账口径；未设置则回落默认。 */
export function basisOf(settings: StoredSetting[], bookId: string): AccountingBasis {
  const row = settings.find((s) => s.scope === bookId && s.key === BASIS_KEY);
  return row?.value === 'cash' ? 'cash' : DEFAULT_BASIS;
}

// —— 对账提醒（per-book）——
/** 对账日：''=关闭 / 'last'=每月最后一天 / '1'..'28'=每月该日。 */
export const RECON_DAY_KEY = 'reconcileDay';
/** 提前提醒天数。 */
export const RECON_LEAD_KEY = 'reconcileLead';
export const DEFAULT_RECON_LEAD = 3;

export function reconcileDayOf(settings: StoredSetting[], bookId: string): string {
  return settings.find((s) => s.scope === bookId && s.key === RECON_DAY_KEY)?.value ?? '';
}

export function reconcileLeadOf(settings: StoredSetting[], bookId: string): number {
  const v = settings.find((s) => s.scope === bookId && s.key === RECON_LEAD_KEY)?.value;
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

// —— 多币种汇率表（app 级，全局共用）——
/** 各币种对展示币种(CNY)的汇率，存 app 级 JSON：{ "USD": 7.1, ... }。 */
export const FX_RATES_KEY = 'fxRates';
/** Phase 1 展示币种固定 CNY（切换留 Phase 2）。 */
export const DISPLAY_CURRENCY = 'CNY';

/** 读汇率表（含展示币种自身=1）；坏数据降级为仅 {CNY:1}。 */
export function fxRatesOf(settings: StoredSetting[]): Record<string, number> {
  const rates: Record<string, number> = { [DISPLAY_CURRENCY]: 1 };
  const row = settings.find((s) => s.scope === 'app' && s.key === FX_RATES_KEY);
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) rates[k] = n;
      }
    } catch {
      /* 坏 JSON 忽略 */
    }
  }
  return rates;
}

/** 折算上下文（展示币种 + 汇率表）。 */
export function convertCtxOf(settings: StoredSetting[]): ConvertCtx {
  return { rates: fxRatesOf(settings), display: DISPLAY_CURRENCY };
}
