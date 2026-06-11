import type { AccountingBasis } from '@app/core';
import type { StoredSetting } from '@app/store';

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
