import { adjustBalanceEntry, defaultChartOfAccounts, expandEntry, toMinor } from '@app/core';
import type { EntryInput } from '@app/core';
import { InMemoryRepository } from '@app/store';
import type { Repository } from '@app/store';
import { localISO } from './format';

export const genId = (): string => crypto.randomUUID();

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

/** 模块级单例：StrictMode 双调 effect 也只 seed 一次。内存仓库，刷新即重置（真持久化随 Tauri 壳接入）。 */
export const ready: Promise<Repository> = bootstrap();

async function bootstrap(): Promise<Repository> {
  const repo = new InMemoryRepository();
  const accounts = defaultChartOfAccounts(genId);
  for (const a of accounts) await repo.addAccount(a);
  const id = (name: string): string => accounts.find((a) => a.name === name)!.id;

  // 期初余额（对方科目 = 期初余额 equity）
  const opening: Array<[string, number]> = [
    ['招商银行', toMinor(20000)],
    ['支付宝', toMinor(3000)],
    ['微信钱包', toMinor(300)],
    ['现金', toMinor(500)],
  ];
  for (const [name, target] of opening) {
    await repo.addTransaction(
      adjustBalanceEntry(
        { date: daysAgo(40), accountId: id(name), currentBalance: 0, targetValue: target, counterAccountId: id('期初余额'), note: '期初余额' },
        genId,
      ),
    );
  }

  // 样本流水（相对今天，保证「本月」报表有数据）
  const entries: EntryInput[] = [
    { kind: 'income', date: daysAgo(9), amount: toMinor(12000), accountId: id('招商银行'), categoryId: id('工资'), payee: '工资', tags: ['personal'] },
    { kind: 'transfer', date: daysAgo(7), amount: toMinor(5000), fromAccountId: id('招商银行'), toAccountId: id('投资账户') },
    { kind: 'expense', date: daysAgo(8), amount: toMinor(36.5), accountId: id('微信钱包'), categoryId: id('餐饮'), payee: '午餐', tags: ['personal'] },
    { kind: 'expense', date: daysAgo(6), amount: toMinor(28), accountId: id('支付宝'), categoryId: id('交通'), payee: '打车', tags: ['personal'] },
    { kind: 'expense', date: daysAgo(5), amount: toMinor(326), accountId: id('信用卡'), categoryId: id('购物'), payee: '超市采购', tags: ['personal'] },
    { kind: 'income', date: daysAgo(4), amount: toMinor(2000), accountId: id('支付宝'), categoryId: id('营业收入'), payee: '客户收款', tags: ['business'] },
    { kind: 'expense', date: daysAgo(3), amount: toMinor(800), accountId: id('信用卡'), categoryId: id('进货成本'), payee: '进货', tags: ['business'] },
    { kind: 'expense', date: daysAgo(2), amount: toMinor(88), accountId: id('招商银行'), categoryId: id('娱乐'), payee: '电影', tags: ['personal'] },
    { kind: 'expense', date: daysAgo(1), amount: toMinor(45.8), accountId: id('微信钱包'), categoryId: id('餐饮'), payee: '晚餐', tags: ['personal'] },
  ];
  for (const e of entries) await repo.addTransaction(expandEntry(e, genId));

  // 投资浮盈：现值 5000 → 5230（差额自动记入投资盈亏）
  await repo.addTransaction(
    adjustBalanceEntry(
      { date: daysAgo(1), accountId: id('投资账户'), currentBalance: toMinor(5000), targetValue: toMinor(5230), counterAccountId: id('投资盈亏'), note: '更新投资现值' },
      genId,
    ),
  );

  // 预算（购物限额 300、已花 326 → 演示超支提醒）
  await repo.addBudget({ id: genId(), accountId: id('餐饮'), monthlyLimit: toMinor(1000) });
  await repo.addBudget({ id: genId(), accountId: id('交通'), monthlyLimit: toMinor(300) });
  await repo.addBudget({ id: genId(), accountId: id('购物'), monthlyLimit: toMinor(300) });

  return repo;
}
