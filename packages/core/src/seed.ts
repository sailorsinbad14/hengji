import type { Account, AccountType, BookType } from './types';

type Def = { name: string; type: AccountType };

const PERSONAL: ReadonlyArray<Def> = [
  { name: '现金', type: 'asset' },
  { name: '银行卡', type: 'asset' },
  { name: '支付宝', type: 'asset' },
  { name: '微信钱包', type: 'asset' },
  { name: '信用卡', type: 'liability' },
  { name: '花呗', type: 'liability' },
  { name: '期初余额', type: 'equity' },
  { name: '工资', type: 'income' },
  { name: '其他收入', type: 'income' },
  { name: '餐饮', type: 'expense' },
  { name: '交通', type: 'expense' },
  { name: '购物', type: 'expense' },
  { name: '居住', type: 'expense' },
  { name: '娱乐', type: 'expense' },
  { name: '医疗', type: 'expense' },
  { name: '其他支出', type: 'expense' },
];

const BUSINESS: ReadonlyArray<Def> = [
  { name: '对公账户', type: 'asset' },
  { name: '微信商户', type: 'asset' },
  { name: '支付宝商户', type: 'asset' },
  { name: '现金', type: 'asset' },
  { name: '应收账款', type: 'asset' },
  { name: '期初余额', type: 'equity' },
  { name: '营业收入', type: 'income' },
  { name: '其他收入', type: 'income' },
  { name: '进货成本', type: 'expense' },
  { name: '运费杂费', type: 'expense' },
  { name: '其他支出', type: 'expense' },
];

const INVESTMENT: ReadonlyArray<Def> = [
  { name: '投资账户', type: 'asset' },
  { name: '期初余额', type: 'equity' },
  { name: '投资盈亏', type: 'income' },
];

const CHARTS: Record<BookType, ReadonlyArray<Def>> = {
  personal: PERSONAL,
  business: BUSINESS,
  investment: INVESTMENT,
};

/**
 * 按账本类型生成默认科目表（开箱即用）。
 * - personal：纯个人收支科目，无生意元素
 * - business：经营科目（营业收入/进货成本/运费杂费…）；应收/应付/库存等由 v0.2 B/C 期单据流自动建
 * - investment：投资账户 + 投资盈亏（现值调整对方科目）+ 期初余额
 */
export function defaultChartFor(
  bookType: BookType,
  bookId: string,
  genId: () => string,
  currency = 'CNY',
): Account[] {
  return CHARTS[bookType].map((d) => ({
    id: genId(),
    bookId,
    name: d.name,
    type: d.type,
    parentId: null,
    currency,
    archived: false,
  }));
}
