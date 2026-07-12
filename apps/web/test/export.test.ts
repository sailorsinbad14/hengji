import { afterEach, describe, expect, it } from 'vitest';
import type { StoredAccount, StoredTransaction } from '@app/store';
import { buildExportRow, buildExportRows, exportFileName, minorToPlain, toCsv, toMarkdown } from '../src/export';
import { setCurrencyRegistry } from '../src/format';

/**
 * 流水导出纯函数测试。钉死的红线：
 * - CSV 以 BOM 开头、CRLF 行结束（简中 Excel 兼容）；
 * - 金额列 = 主单位纯数字 + ASCII 负号（U+2212 / ¥ / 千分位任何一样混入都会让 Excel 无法求和）；
 * - RFC 4180 转义 + 公式注入防护（payee/note 可来自 OCR/导入的任意文本）；
 * - 行分类与流水页 describeTxn 同口径（支出/收入/期初/转账/换汇/兜底）。
 */

const META = { createdAt: '2026-07-07T00:00:00Z', updatedAt: '2026-07-07T00:00:00Z', deleted: false };

function acc(id: string, name: string, type: StoredAccount['type'], currency = 'CNY'): StoredAccount {
  return { ...META, id, bookId: 'b1', name, type, parentId: null, currency, archived: false };
}

function txn(
  postings: Array<{ accountId: string; amount: number; currency?: string }>,
  over: Partial<StoredTransaction> = {},
): StoredTransaction {
  return {
    ...META,
    id: 't1',
    bookId: 'b1',
    date: '2026-07-01',
    payee: '',
    note: '',
    tags: [],
    postings: postings.map((p, i) => ({ id: `p${i}`, txnId: 't1', accountId: p.accountId, amount: p.amount, currency: p.currency ?? 'CNY' })),
    ...over,
  };
}

const ACCTS = new Map(
  [
    acc('cash', '现金', 'asset'),
    acc('bank', '银行卡', 'asset'),
    acc('usd', '美元账户', 'asset', 'USD'),
    acc('food', '餐饮', 'expense'),
    acc('salary', '工资', 'income'),
    acc('opening', '期初余额', 'equity'),
  ].map((a) => [a.id, a]),
);

afterEach(() => setCurrencyRegistry([])); // 复位模块级币种注册表（JPY 用例会注册）

describe('minorToPlain（整数运算、纯数字）', () => {
  it('正负与补零', () => {
    expect(minorToPlain(3380, 2)).toBe('33.80');
    expect(minorToPlain(-3380, 2)).toBe('-33.80');
    expect(minorToPlain(5, 2)).toBe('0.05');
    expect(minorToPlain(0, 2)).toBe('0.00');
  });
  it('0 位小数（JPY）不带小数点', () => {
    expect(minorToPlain(-1200, 0)).toBe('-1200');
  });
});

describe('buildExportRow（与页面 describeTxn 同口径）', () => {
  it('支出：金额为负、分类/账户就位', () => {
    const r = buildExportRow(txn([{ accountId: 'food', amount: 3380 }, { accountId: 'cash', amount: -3380 }], { payee: '星巴克', tags: ['business'] }), ACCTS);
    expect(r).toMatchObject({ kind: '支出', category: '餐饮', amount: '-33.80', currency: 'CNY', account: '现金', payee: '星巴克', tags: 'business' });
  });
  it('收入：金额为正', () => {
    const r = buildExportRow(txn([{ accountId: 'salary', amount: -500000 }, { accountId: 'bank', amount: 500000 }]), ACCTS);
    expect(r).toMatchObject({ kind: '收入', category: '工资', amount: '5000.00', account: '银行卡' });
  });
  it('期初：金额取真实腿', () => {
    const r = buildExportRow(txn([{ accountId: 'opening', amount: -10000 }, { accountId: 'cash', amount: 10000 }]), ACCTS);
    expect(r).toMatchObject({ kind: '期初', category: '期初余额', amount: '100.00', account: '现金' });
  });
  it('转账：账户 A → B、金额=到账腿', () => {
    const r = buildExportRow(txn([{ accountId: 'bank', amount: -70000 }, { accountId: 'cash', amount: 70000 }]), ACCTS);
    expect(r).toMatchObject({ kind: '转账', category: '', amount: '700.00', account: '银行卡 → 现金' });
  });
  it('换汇：币种=到账腿、转出腿金额进账户列（否则换汇成本无处可寻）', () => {
    const r = buildExportRow(
      txn([{ accountId: 'bank', amount: -71000 }, { accountId: 'usd', amount: 10000, currency: 'USD' }]),
      ACCTS,
    );
    expect(r).toMatchObject({ kind: '换汇', amount: '100.00', currency: 'USD', account: '银行卡(-710.00 CNY) → 美元账户' });
  });
  it('收入 posting 为正（投资浮亏下调）→ 金额为负、与页面符号一致', () => {
    // format.ts describeTxn 对 income 恒取 -cat.p.amount：正的收入腿=浮亏→导出必须是负数，别被「收入恒正」直觉改坏。
    const r = buildExportRow(txn([{ accountId: 'salary', amount: 2000 }, { accountId: 'bank', amount: -2000 }]), ACCTS);
    expect(r).toMatchObject({ kind: '收入', amount: '-20.00' });
  });
  it('兜底（无法单式化 / 未知账户）：金额/账户为空、不报错', () => {
    const three = buildExportRow(txn([{ accountId: 'cash', amount: -100 }, { accountId: 'bank', amount: 50 }, { accountId: 'usd', amount: 50 }]), ACCTS);
    expect(three).toMatchObject({ kind: '其他', amount: '', currency: '', account: '' });
    // 悬空 accountId（accounts.get 返回 undefined）：cat/real 都落空 → 兜底，不抛。
    const dangling = buildExportRow(txn([{ accountId: 'ghost1', amount: 100 }, { accountId: 'ghost2', amount: -100 }]), ACCTS);
    expect(dangling).toMatchObject({ kind: '其他', amount: '', account: '' });
  });
  it('多个 tags join 为分号串', () => {
    const r = buildExportRow(txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { tags: ['business', '报销'] }), ACCTS);
    expect(r.tags).toBe('business;报销');
  });
  it('BTC（8 位小数）深补零', () => {
    setCurrencyRegistry([{ code: 'BTC', symbol: '₿', name: '比特币', decimals: 8, rate: 500000 }]);
    const btc = acc('btc', '比特币钱包', 'asset', 'BTC');
    const m = new Map(ACCTS);
    m.set('btc', btc);
    const r = buildExportRow(txn([{ accountId: 'btc', amount: -1, currency: 'BTC' }, { accountId: 'opening', amount: 1, currency: 'BTC' }]), m);
    expect(r.amount).toBe('-0.00000001'); // 1 聪：padStart(8) 深补零路径
  });
  it('JPY（0 位小数）按注册表精度', () => {
    setCurrencyRegistry([{ code: 'JPY', symbol: '¥', name: '日元', decimals: 0, rate: 0.05 }]);
    const jpyAcc = acc('jpy', '日元账户', 'asset', 'JPY');
    const m = new Map(ACCTS);
    m.set('jpy', jpyAcc);
    const r = buildExportRow(txn([{ accountId: 'food', amount: 1200, currency: 'JPY' }, { accountId: 'jpy', amount: -1200, currency: 'JPY' }]), m);
    expect(r.amount).toBe('-1200');
  });
});

describe('toCsv', () => {
  const plainRow = buildExportRows([txn([{ accountId: 'food', amount: 3380 }, { accountId: 'cash', amount: -3380 }], { payee: '星巴克' })], ACCTS);

  it('以 BOM 开头、CRLF 行结束、含表头', () => {
    const csv = toCsv(plainRow);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('日期,类型,分类,金额,币种,账户,对方,备注,标签');
    expect(csv.includes('\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
  it('金额列不含 U+2212 / ¥ / 千分位逗号（Excel 可求和红线）', () => {
    const big = buildExportRows([txn([{ accountId: 'food', amount: 123456789 }, { accountId: 'cash', amount: -123456789 }])], ACCTS);
    const line = toCsv(big).split('\r\n')[1];
    expect(line).toContain('-1234567.89');
    expect(line.includes('−')).toBe(false);
    expect(line.includes('¥')).toBe(false);
    expect(line.includes('"-1,234')).toBe(false);
  });
  it('RFC 4180：含逗号/引号/换行的字段加引号、内部引号翻倍', () => {
    const rows = buildExportRows(
      [txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { note: '含,逗号和"引号"\n还有换行' })],
      ACCTS,
    );
    const csv = toCsv(rows);
    expect(csv).toContain('"含,逗号和""引号""\n还有换行"');
  });
  it('公式注入：= @ - tab 开头的文本字段全部前置单引号；金额列负号不受影响', () => {
    const rows = buildExportRows(
      [txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { payee: '=cmd|whoami', note: '@AT开头' })],
      ACCTS,
    );
    const line = toCsv(rows).split('\r\n')[1];
    expect(line).toContain("'=cmd|whoami");
    expect(line).toContain("'@AT开头");
    expect(line).toContain(',-1.00,'); // 金额列原样，无前缀
    // '-' 与 tab 开头同属公式起手（金额列负号豁免恰恰依赖正则里的 \- 和 \t，别被误删）
    const dash = buildExportRows([txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { payee: '-2+3+cmd' })], ACCTS);
    expect(toCsv(dash).split('\r\n')[1]).toContain("'-2+3+cmd");
    const tab = buildExportRows([txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { note: '\t=HYPERLINK()' })], ACCTS);
    expect(toCsv(tab).split('\r\n')[1]).toContain("'\t=HYPERLINK()"); // 前缀单引号（tab 本身不触发 RFC 引号包裹）
  });
  it('币种代码含逗号不破坏 CSV 结构（币种列过 csvText）', () => {
    setCurrencyRegistry([{ code: 'US,D', symbol: 'US,D ', name: 'US,D', decimals: 2, rate: 7 }]);
    const weird = acc('weird', '怪币账户', 'asset', 'US,D');
    const m = new Map(ACCTS);
    m.set('weird', weird);
    const rows = buildExportRows([txn([{ accountId: 'food', amount: 100, currency: 'US,D' }, { accountId: 'weird', amount: -100, currency: 'US,D' }])], m);
    const line = toCsv(rows).split('\r\n')[1];
    expect(line).toContain('"US,D"'); // 整体加引号、内部逗号不当分隔符
  });
});

describe('toMarkdown', () => {
  it('标题含账本名与笔数、金额列右对齐、管道被转义', () => {
    const rows = buildExportRows(
      [txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { note: 'a|b' })],
      ACCTS,
    );
    const md = toMarkdown(rows, '外贸小生意', '2026-07-07');
    expect(md).toContain('# 衡记流水 · 外贸小生意');
    expect(md).toContain('共 1 笔');
    expect(md).toContain('| --- | --- | --- | ---: |');
    expect(md).toContain('a\\|b');
  });
  it('单元格内换行折为空格（不破坏表格行）', () => {
    const rows = buildExportRows([txn([{ accountId: 'food', amount: 100 }, { accountId: 'cash', amount: -100 }], { note: '第一行\n第二行' })], ACCTS);
    const md = toMarkdown(rows, '账本', '2026-07-07');
    expect(md).toContain('第一行 第二行');
    expect(md).not.toContain('第一行\n第二行');
  });
});

describe('exportFileName', () => {
  it('清洗 Windows 保留字符', () => {
    expect(exportFileName('生意/账本:测试', '2026-07-07', 'csv')).toBe('衡记流水_生意_账本_测试_2026-07-07.csv');
  });
});
