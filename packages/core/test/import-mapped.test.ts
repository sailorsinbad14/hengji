import { describe, it, expect } from 'vitest';
import { parseMappedCsv, parseMappedMatrix, validateMappedSpec, normalizeMappedDate, MAPPED_SOURCE } from '../src/index';
import type { MappedImportSpec } from '../src/index';

/**
 * 声明式映射解析器测试（增量4 · 4a）。
 * 无真实银行脱敏 fixture（用户尚未提供陌生银行导出），先以手搓典型银行流水覆盖三种金额模式
 * 与全部护栏；真实账单 fixture 待 4c 端到端时补。畸形 spec 护栏是本解析器独有维度（LLM 产物不可信）。
 */

/** 典型银行流水：带符号单金额列 + 摘要列 + 无交易号列 + YYYY-MM-DD 纯日期 + # 注释头。 */
const BANK_SPEC: MappedImportSpec = {
  version: 1,
  bankName: '测试银行',
  columns: { date: '交易日期', type: '摘要', payee: '对方户名', counterpartyAccount: '对方账号', note: ['附言'] },
  amount: { mode: 'signed', amountCol: '交易金额', negativeIs: 'out' },
  typeRules: [
    { match: '还款', kind: 'transfer' },
    { match: '转存', kind: 'transfer' },
    { match: '退款', kind: 'refund' },
    { match: '工资', kind: 'real' },
    { match: '消费', kind: 'real' },
  ],
  skipLinePrefixes: ['#'],
};

const bankCsv = (...dataRows: string[]): string =>
  ['# 测试银行交易明细', '交易日期,摘要,交易金额,对方户名,对方账号,附言', ...dataRows].join('\n');

describe('mapped · signed 模式（银行流水形态）', () => {
  it('负数=支出、正数=收入，方向与金额正确', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,-32.50,某超市,6222***1234,日用', '2026-07-02,工资,8000.00,某公司,,7月'), BANK_SPEC);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      source: MAPPED_SOURCE,
      date: '2026-07-01',
      datetime: '2026-07-01 00:00:00',
      amountMinor: 3250,
      direction: 'out',
      suggestion: 'expense',
      payee: '某超市',
      counterpartyAccount: '6222***1234',
      note: '日用',
      accountingType: '消费',
    });
    expect(r.rows[1]).toMatchObject({ amountMinor: 800000, direction: 'in', suggestion: 'income' });
  });

  it('negativeIs=in 时符号语义反转', () => {
    const spec: MappedImportSpec = { ...BANK_SPEC, amount: { mode: 'signed', amountCol: '交易金额', negativeIs: 'in' } };
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,-10.00,甲,,'), spec);
    expect(r.rows[0]).toMatchObject({ direction: 'in', suggestion: 'income' });
  });

  it('typeRules 首个命中生效：还款→transfer、退款→refund、无命中→unknown（汇总告警）', () => {
    const r = parseMappedCsv(
      bankCsv('2026-07-01,信用卡还款,-500.00,本人,,', '2026-07-02,商户退款,15.00,某店,,', '2026-07-03,利息结算,0.35,,,'),
      BANK_SPEC,
    );
    expect(r.rows.map((x) => x.suggestion)).toEqual(['transfer-out', 'refund', 'unknown']);
    expect(r.warnings.some((w) => w.includes('1 行类型/摘要未命中'))).toBe(true);
  });

  it('无交易号列 → 确定性合成 bizNo；同文件重复内容行追加序号消歧（不吞真交易）', () => {
    const line = '2026-07-01,消费,-15.00,公交,,';
    const r1 = parseMappedCsv(bankCsv(line, line), BANK_SPEC);
    expect(r1.rows).toHaveLength(2);
    expect(r1.rows[0]!.bizNo).toMatch(/^syn:/);
    expect(r1.rows[1]!.bizNo).toBe(`${r1.rows[0]!.bizNo}\u00012`);
    // 同文件重解析 → 键确定性一致（去重键跨导入稳定的前提）
    const r2 = parseMappedCsv(bankCsv(line, line), BANK_SPEC);
    expect(r2.rows.map((x) => x.bizNo)).toEqual(r1.rows.map((x) => x.bizNo));
  });

  it('skipLinePrefixes 跳注释行；引号内分隔符与 "" 转义正确切分', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,-8.00,"某店,分号内",,"备注""引号"""'), BANK_SPEC);
    expect(r.rows[0]).toMatchObject({ payee: '某店,分号内', note: '备注"引号"' });
  });

  it('列数与表头不符 → 告警跳过不错位', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,-8.00,甲', '2026-07-02,消费,-9.00,乙,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.payee).toBe('乙');
    expect(r.warnings.some((w) => w.includes('列数与表头不符'))).toBe(true);
  });

  it('金额 NaN / 0 → 告警跳过；带币符千分位可解', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,abc,甲,,', '2026-07-02,消费,0.00,乙,,', '2026-07-03,工资,"¥1,234.56",丙,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.amountMinor).toBe(123456);
    expect(r.warnings.filter((w) => w.includes('跳过')).length).toBe(2);
  });

  it('外币符号（$）不硬解 → NaN 告警跳过（导入线恒 CNY，不静默错记）', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,$12.00,甲,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('金额无法解析'))).toBe(true);
  });

  it('日期无法识别 / 越界（13月）→ 跳过，绝不落错日期', () => {
    const r = parseMappedCsv(bankCsv('2026-13-01,消费,-8.00,甲,,', 'garbage,消费,-9.00,乙,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.filter((w) => w.includes('日期无法识别')).length).toBe(2);
  });

  it('表头找不到（spec 列名与账单不符）→ 0 行 + 告警，不抛', () => {
    const r = parseMappedCsv('时间,说明,钱\n2026-07-01,消费,-8.00', BANK_SPEC);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('未找到表头行'))).toBe(true);
  });

  it('BOM 剥除 + 分隔符 ; 支持', () => {
    const spec: MappedImportSpec = { ...BANK_SPEC, delimiter: ';', skipLinePrefixes: undefined };
    const text = '\uFEFF交易日期;摘要;交易金额;对方户名;对方账号;附言\n2026-07-01;消费;-8.00;甲;;';
    const r = parseMappedCsv(text, spec);
    expect(r.rows).toHaveLength(1);
  });
});

describe('mapped · dual 模式（收/支两列形态）', () => {
  const DUAL_SPEC: MappedImportSpec = {
    version: 1,
    columns: { date: '记账日期', bizNo: '流水号', type: '业务类型', payee: '对方' },
    amount: { mode: 'dual', incomeCol: '收入金额', expenseCol: '支出金额' },
    typeRules: [{ match: '转账', kind: 'ambiguous' }],
  };
  const csv = (...rows: string[]): string => ['记账日期,流水号,业务类型,收入金额,支出金额,对方', ...rows].join('\n');

  it('谁有值定方向；两列同值/全空 → 告警跳过', () => {
    const r = parseMappedCsv(
      csv('2026-07-01,TXA00001,消费,,32.50,甲', '2026-07-02,TXA00002,收款,100.00,,乙', '2026-07-03,TXA00003,冲正,5.00,5.00,丙', '2026-07-04,TXA00004,调整,,,丁'),
      DUAL_SPEC,
    );
    expect(r.rows.map((x) => [x.bizNo, x.direction])).toEqual([
      ['TXA00001', 'out'],
      ['TXA00002', 'in'],
    ]);
    expect(r.warnings.some((w) => w.includes('收支两列同时有值'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('收支金额全空'))).toBe(true);
  });

  it('ambiguous 规则 → unknown（双关不猜）；提供 bizNo 列则原样用', () => {
    const r = parseMappedCsv(csv('2026-07-01,BIZ00007,转账支取,,50.00,甲'), DUAL_SPEC);
    expect(r.rows[0]).toMatchObject({ bizNo: 'BIZ00007', suggestion: 'unknown' });
  });
});

describe('mapped · direction 模式（金额+标记列形态，xlsx 矩阵入口）', () => {
  const DIR_SPEC: MappedImportSpec = {
    version: 1,
    columns: { date: '交易时间', bizNo: '单号', type: '类型', payee: '对方' },
    amount: { mode: 'direction', amountCol: '金额', directionCol: '借贷', inValues: ['贷', '收入'], outValues: ['借', '支出'] },
    typeRules: [{ match: '消费', kind: 'real' }],
    placeholder: '/',
  };
  const HEADER = ['交易时间', '单号', '类型', '借贷', '金额', '对方'];

  it('标记值集合定方向；Excel 序列号日期可解（矩阵路径）', () => {
    const r = parseMappedMatrix(
      [['对账单'], HEADER, [45838.5, 'T1', '消费', '借', 25, '甲'], ['2026-07-02 08:30:00', 'T2', '消费', '贷', 12.5, '乙']],
      DIR_SPEC,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ direction: 'out', suggestion: 'expense', amountMinor: 2500 });
    expect(r.rows[0]!.datetime).toMatch(/^2025-06-30 12:00:00$/);
    expect(r.rows[1]).toMatchObject({ direction: 'in', suggestion: 'income' });
  });

  it('标记值不在集合（中性/污染）→ 告警跳过，绝不造方向落草稿（红线）', () => {
    const r = parseMappedMatrix([HEADER, ['2026-07-01 10:00:00', 'T3', '消费', '/', 30, '甲']], DIR_SPEC);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('收支标记未识别'))).toBe(true);
  });

  it('placeholder 清洗 payee/note；数字型单号（精度已丢）不作键 → 合成键兜底', () => {
    const r = parseMappedMatrix([HEADER, ['2026-07-01 10:00:00', 4.2e27, '消费', '借', 30, '/']], DIR_SPEC);
    expect(r.rows[0]!.payee).toBe('');
    expect(r.rows[0]!.bizNo).toMatch(/^syn:/);
  });

  it('无类型列 → 全部 unknown + 单条汇总告警', () => {
    const spec: MappedImportSpec = { ...DIR_SPEC, columns: { date: '交易时间', bizNo: '单号', payee: '对方' }, typeRules: undefined };
    const r = parseMappedMatrix([HEADER, ['2026-07-01 10:00:00', 'T4', '消费', '借', 30, '甲']], spec);
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('未提供类型/摘要列'))).toBe(true);
  });
});

describe('mapped · 日期扩展 normalizeMappedDate', () => {
  it('auto：纯日期 / YYYYMMDD 串 / 8 位整数按 YYYYMMDD、序列号按序列号', () => {
    expect(normalizeMappedDate('2026-7-5', 'auto')).toEqual({ date: '2026-07-05', datetime: '2026-07-05 00:00:00' });
    expect(normalizeMappedDate('2026/07/05', 'auto')?.date).toBe('2026-07-05');
    expect(normalizeMappedDate('20260705', 'auto')?.date).toBe('2026-07-05');
    expect(normalizeMappedDate(20260705, 'auto')?.date).toBe('2026-07-05');
    expect(normalizeMappedDate(45838, 'auto')?.date).toBe('2025-06-30');
    expect(normalizeMappedDate('2026-07-05 09:30:00', 'auto')?.datetime).toBe('2026-07-05 09:30:00');
  });

  it('dmy / mdy：按声明消歧；越界即拒', () => {
    expect(normalizeMappedDate('05/07/2026', 'dmy')?.date).toBe('2026-07-05');
    expect(normalizeMappedDate('05/07/2026', 'mdy')?.date).toBe('2026-05-07');
    expect(normalizeMappedDate('31.12.2026 23:59', 'dmy')?.datetime).toBe('2026-12-31 23:59:00');
    expect(normalizeMappedDate('13/13/2026', 'dmy')).toBeNull();
    expect(normalizeMappedDate('2026-07-05', 'dmy')).toBeNull();
  });

  it('年份门 1900–2100：挡序列号/YYYYMMDD 混淆产生的离谱年份', () => {
    expect(normalizeMappedDate('1899-12-31', 'auto')).toBeNull();
    expect(normalizeMappedDate('21010101', 'auto')).toBeNull();
    expect(normalizeMappedDate(99999999, 'auto')).toBeNull();
  });
});

describe('mapped · review 修复回归（5 维对抗式 review）', () => {
  it('历法终门：带时间的假日期（13月/6月31/2月31/时分越界）在 auto 与 dmy 全被拒', () => {
    expect(normalizeMappedDate('2025-13-45 10:30:00', 'auto')).toBeNull();
    expect(normalizeMappedDate('2025-06-31 23:59:59', 'auto')).toBeNull();
    expect(normalizeMappedDate('31.02.2025', 'dmy')).toBeNull();
    expect(normalizeMappedDate(20250231, 'auto')).toBeNull();
    expect(normalizeMappedDate('29/02/2025', 'dmy')).toBeNull();
    expect(normalizeMappedDate('29/02/2024', 'dmy')?.date).toBe('2024-02-29');
    expect(normalizeMappedDate('2025-12-31 99:30:00', 'auto')).toBeNull();
    expect(normalizeMappedDate('31/12/2025 10:99', 'dmy')).toBeNull();
  });

  it('bizNo 命中其它列（去重键会重复）→ 解析拒绝', () => {
    const spec: MappedImportSpec = {
      version: 1,
      columns: { date: '交易时间', bizNo: '交易' },
      amount: { mode: 'dual', incomeCol: '收入', expenseCol: '支出' },
    };
    expect(() => parseMappedCsv('交易时间,收入金额,支出金额\n2026-06-30,100,', spec)).toThrow(/列冲突/);
  });

  it('值形关键词把数据行当表头 → 拒认表头、0 行 + 告警（首行不再被静默吃掉）', () => {
    const spec: MappedImportSpec = {
      version: 1,
      columns: { date: '2026' },
      amount: { mode: 'signed', amountCol: '5', negativeIs: 'out' },
    };
    const r = parseMappedCsv('2026-06-01,5.00,工资\n2026-06-02,3.50,餐饮', spec);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('未找到表头行'))).toBe(true);
  });

  it('inValues/outValues 交集（双关标记挂两侧）→ spec 拒绝', () => {
    expect(() =>
      validateMappedSpec({
        version: 1,
        columns: { date: '日期' },
        amount: { mode: 'direction', amountCol: '金额', directionCol: '收/支', inValues: ['收入', '转账'], outValues: ['支出', '转账'] },
      }),
    ).toThrow(/相同标记值/);
  });

  it('数字开头的跳过前缀（可吞数据行）→ spec 拒绝；命中前缀的行数可见', () => {
    expect(() =>
      validateMappedSpec({ version: 1, columns: { date: '日期' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' }, skipLinePrefixes: ['2026-06-'] }),
    ).toThrow(/数字/);
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,-8.00,甲,,'), BANK_SPEC);
    expect(r.warnings.some((w) => w.includes('1 行命中行首前缀'))).toBe(true);
  });

  it('提供的交易号列文件内重号 → #n 消歧 + 告警（不吞真交易）', () => {
    const spec: MappedImportSpec = {
      version: 1,
      columns: { date: '记账日期', bizNo: '流水号' },
      amount: { mode: 'dual', incomeCol: '收入金额', expenseCol: '支出金额' },
    };
    const r = parseMappedCsv('记账日期,流水号,收入金额,支出金额\n2026-07-01,REF000001,,10\n2026-07-02,REF000001,,20', spec);
    expect(r.rows.map((x) => x.bizNo)).toEqual(['REF000001', 'REF000001\u00012']);
    expect(r.warnings.some((w) => w.includes('重号'))).toBe(true);
  });

  it('合成键含表头指纹：不同表头（不同银行）同内容行 → 键不同，跨文件不误判重复', () => {
    const row = '2026-07-01,消费,-15.00,公交,,';
    const a = parseMappedCsv(bankCsv(row), BANK_SPEC);
    const b = parseMappedCsv(['交易日期,摘要,交易金额,对方户名,对方账号,附言,渠道', `${row},`].join('\n'), { ...BANK_SPEC, skipLinePrefixes: undefined });
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0]!.bizNo).not.toBe(b.rows[0]!.bizNo);
  });

  it('日期跨度异常（>20 年）→ 告警提示日期列可能映射错', () => {
    const r = parseMappedCsv(bankCsv('1990-07-01,消费,-8.00,甲,,', '2026-07-01,消费,-9.00,乙,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('日期跨度'))).toBe(true);
  });
});

describe('mapped · review 修复回归（第二轮 · 语义/去重/日期/注入）', () => {
  it('欧式小数逗号（12,34）不当千分位剥 → 拒并告警；成组千分位仍可解', () => {
    const r = parseMappedCsv(bankCsv('2026-07-01,消费,"12,34",甲,,', '2026-07-02,工资,"1,234.56",乙,,'), BANK_SPEC);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.amountMinor).toBe(123456);
    expect(r.warnings.some((w) => w.includes('金额无法解析'))).toBe(true);
  });

  it('dual 收/支列负数（冲正）→ 告警跳过不猜方向', () => {
    const spec: MappedImportSpec = { version: 1, columns: { date: '记账日期' }, amount: { mode: 'dual', incomeCol: '收入金额', expenseCol: '支出金额' } };
    const r = parseMappedCsv('记账日期,收入金额,支出金额\n2026-07-01,,-200.00', spec);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('负数'))).toBe(true);
  });

  it('direction 模式金额为负（与标记列信号冲突）→ 告警跳过', () => {
    const spec: MappedImportSpec = {
      version: 1,
      columns: { date: '日期' },
      amount: { mode: 'direction', amountCol: '金额', directionCol: '收支', inValues: ['收入'], outValues: ['支出'] },
    };
    const r = parseMappedCsv('日期,收支,金额\n2026-07-01,收入,-5.00', spec);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('信号冲突'))).toBe(true);
  });

  it('typeRules 多条不同大类同时命中（退还款项）→ unknown 不按顺序裁决', () => {
    const spec: MappedImportSpec = { ...BANK_SPEC, typeRules: [{ match: '还款', kind: 'transfer' }, { match: '退还', kind: 'refund' }] };
    const r = parseMappedCsv(bankCsv('2026-07-01,退还款项,15.00,某店,,'), spec);
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('多种类型规则'))).toBe(true);
  });

  it('短交易号（每次导出重计数的序号列）→ 降级内容合成键 + 告警，跨月文件不再互吞', () => {
    const spec: MappedImportSpec = { version: 1, columns: { date: '交易日期', bizNo: '序号' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' } };
    const jun = parseMappedCsv('交易日期,序号,金额\n2026-06-01,1,-10.00', spec);
    const jul = parseMappedCsv('交易日期,序号,金额\n2026-07-01,1,-30.00', spec);
    expect(jun.rows[0]!.bizNo).toMatch(/^syn:/);
    expect(jun.rows[0]!.bizNo).not.toBe(jul.rows[0]!.bizNo);
    expect(jun.warnings.some((w) => w.includes('交易号过短'))).toBe(true);
  });

  it('消歧分隔符不可见字符：内容自带「#2」不与消歧键字面相撞', () => {
    const rows = ['2026-07-01,消费,-15.00,公交,,', '2026-07-01,消费,-15.00,公交,,', '2026-07-01,消费,-15.00,公交#2,,'];
    const r = parseMappedCsv(bankCsv(...rows), BANK_SPEC);
    expect(r.rows).toHaveLength(3);
    expect(new Set(r.rows.map((x) => x.bizNo)).size).toBe(3);
  });

  it('合成键不含 spec 派生值：改 typeRules 重导同文件键不漂移（修 spec 不致重复入账）', () => {
    const csv = bankCsv('2026-07-01,消费,-8.00,甲,,');
    const k1 = parseMappedCsv(csv, BANK_SPEC).rows[0]!.bizNo;
    const k2 = parseMappedCsv(csv, { ...BANK_SPEC, typeRules: [] }).rows[0]!.bizNo;
    expect(k1).toBe(k2);
  });

  it('Excel 序列号地板：序号/年份等小整数不当日期', () => {
    expect(normalizeMappedDate(400, 'auto')).toBeNull();
    expect(normalizeMappedDate(2026, 'auto')).toBeNull();
    expect(normalizeMappedDate(45838, 'auto')?.date).toBe('2025-06-30');
  });

  it('auto ISO 全串锚定：Z/PM 等尾缀不再被静默丢弃', () => {
    expect(normalizeMappedDate('2026-07-05T18:30:00Z', 'auto')).toBeNull();
    expect(normalizeMappedDate('2026-07-05 9:30:00 PM', 'auto')).toBeNull();
    expect(normalizeMappedDate('2026-07-05T18:30:00', 'auto')?.datetime).toBe('2026-07-05 18:30:00');
  });

  it('dmy/mdy 可能声明反了 → 聚合提示（day>12 的行提供反证）', () => {
    const spec: MappedImportSpec = { version: 1, columns: { date: '日期' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' }, dateFormat: 'mdy' };
    const r = parseMappedCsv('日期,金额\n13/06/2026,-8.00\n05/06/2026,-9.00', spec);
    expect(r.warnings.some((w) => w.includes('声明反了'))).toBe(true);
  });

  it('关键词命中多列 / 可选列撞必需列 → 拒绝', () => {
    const multi: MappedImportSpec = { version: 1, columns: { date: '交易' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' } };
    expect(() => parseMappedCsv('交易日期,交易金额,金额\n2026-07-01,x,-8.00', multi)).toThrow(/命中多列/);
    const clash: MappedImportSpec = { version: 1, columns: { date: '交易日期', type: '交易金额' }, amount: { mode: 'signed', amountCol: '交易金额', negativeIs: 'out' } };
    expect(() => parseMappedCsv('交易日期,交易金额\n2026-07-01,-8.00', clash)).toThrow(/列冲突/);
  });

  it('值形 skip 前缀（-/引号等）→ spec 拒绝', () => {
    expect(() =>
      validateMappedSpec({ version: 1, columns: { date: '日期' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' }, skipLinePrefixes: ['-'] }),
    ).toThrow(/skipLinePrefixes/);
  });

  it('覆盖缺口：dmy 全链路 / dual 金额列 placeholder / tab 分隔符', () => {
    const dmySpec: MappedImportSpec = { version: 1, columns: { date: '日期' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' }, dateFormat: 'dmy' };
    expect(parseMappedCsv('日期,金额\n05/07/2026,-8.00', dmySpec).rows[0]!.date).toBe('2026-07-05');
    const ph: MappedImportSpec = { version: 1, columns: { date: '记账日期' }, amount: { mode: 'dual', incomeCol: '收入', expenseCol: '支出' }, placeholder: '/' };
    const r = parseMappedCsv('记账日期,收入,支出\n2026-07-01,/,20.00', ph);
    expect(r.rows[0]).toMatchObject({ direction: 'out', amountMinor: 2000 });
    const tabSpec: MappedImportSpec = { version: 1, columns: { date: '日期' }, amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' }, delimiter: '\t' };
    expect(parseMappedCsv('日期\t金额\n2026-07-01\t-8.00', tabSpec).rows).toHaveLength(1);
  });
});

describe('mapped · 畸形 spec 护栏（LLM 产物不可信）', () => {
  const base = (): Record<string, unknown> => ({
    version: 1,
    columns: { date: '日期' },
    amount: { mode: 'signed', amountCol: '金额', negativeIs: 'out' },
  });

  it('合法最小 spec 通过并规整（trim + 剔除未知字段）', () => {
    const s = validateMappedSpec({ ...base(), columns: { date: ' 日期 ' }, junk: 'x' });
    expect(s.columns.date).toBe('日期');
    expect('junk' in s).toBe(false);
  });

  it('非对象 / version 错 / 缺 date / 缺 amount → 拒', () => {
    expect(() => validateMappedSpec(null)).toThrow(/JSON 对象/);
    expect(() => validateMappedSpec([])).toThrow(/JSON 对象/);
    expect(() => validateMappedSpec({ ...base(), version: 2 })).toThrow(/version/);
    expect(() => validateMappedSpec({ ...base(), columns: {} })).toThrow(/columns\.date/);
    expect(() => validateMappedSpec({ ...base(), amount: { mode: 'magic' } })).toThrow(/amount\.mode/);
  });

  it('direction 模式缺标记值集合 / signed 缺 negativeIs → 拒', () => {
    expect(() => validateMappedSpec({ ...base(), amount: { mode: 'direction', amountCol: '金额', directionCol: '借贷', inValues: [], outValues: ['借'] } })).toThrow(/inValues/);
    expect(() => validateMappedSpec({ ...base(), amount: { mode: 'signed', amountCol: '金额' } })).toThrow(/negativeIs/);
  });

  it('越界拒：typeRules>64 / note>8 / 关键词超长 / 非法 kind / 非法 delimiter', () => {
    const rules = Array.from({ length: 65 }, (_, i) => ({ match: `m${i}`, kind: 'real' }));
    expect(() => validateMappedSpec({ ...base(), typeRules: rules })).toThrow(/64/);
    expect(() => validateMappedSpec({ ...base(), typeRules: [{ match: 'x', kind: 'evil' }] })).toThrow(/kind/);
    expect(() => validateMappedSpec({ ...base(), columns: { date: '日期', note: Array(9).fill('a') } })).toThrow(/note/);
    expect(() => validateMappedSpec({ ...base(), columns: { date: 'x'.repeat(65) } })).toThrow(/columns\.date/);
    expect(() => validateMappedSpec({ ...base(), delimiter: '::' })).toThrow(/delimiter/);
  });

  it('必需字段命中同一列（关键词过泛）→ 解析时拒，绝不错位读数', () => {
    const spec: MappedImportSpec = {
      version: 1,
      columns: { date: '交易' },
      amount: { mode: 'signed', amountCol: '交易', negativeIs: 'out' },
    };
    expect(() => parseMappedCsv('交易日期,交易金额\n2026-07-01,-8.00', spec)).toThrow(/列冲突/);
  });
});
