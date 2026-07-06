import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseWechatBill, classifyWechat, WECHAT_TYPE_KIND, excelSerialToDatetime } from '../src/index';

type Cell = unknown;

/** fixture：真实微信账单脱敏后、经 SheetJS(raw) 抽成的单元格矩阵（日期=序列号、金额=数值、空="/"）。 */
function loadMatrix(name: string): Cell[][] {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const HEADER: Cell[] = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
const matrixOf = (...dataRows: Cell[][]): Cell[][] => [['微信支付账单明细'], ['微信昵称：[demo_user]'], HEADER, ...dataRows];
const wrow = (o: { date?: unknown; type?: unknown; payee?: unknown; product?: unknown; shouZhi?: unknown; amount?: unknown; bizNo?: unknown; remark?: unknown }): Cell[] => [
  o.date ?? '2026-06-01 10:00:00',
  o.type ?? '商户消费',
  o.payee ?? '某商户',
  o.product ?? '某商品',
  o.shouZhi ?? '支出',
  o.amount ?? 50,
  '零钱',
  '支付成功',
  o.bizNo ?? 'TX1',
  '/',
  o.remark ?? '/',
];

describe('微信账单解析器（真实脱敏矩阵 fixture）', () => {
  const result = parseWechatBill(loadMatrix('wechat-bill.matrix.json'));

  it('抽出元数据：昵称 / 查询区间 / 导出时间', () => {
    expect(result.meta.source).toBe('wechat-bill');
    expect(result.meta.account).toBe('demo_user');
    expect(result.meta.rangeStart).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(result.meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('解析出 24 条数据行（跳过元数据/表头）', () => {
    expect(result.rows.length).toBe(24);
  });

  it('每行字段齐备，且 Excel 序列号日期落在账单区间内（序列号转换正确）', () => {
    for (const r of result.rows) {
      expect(r.bizNo).toBeTruthy();
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(Number.isInteger(r.amountMinor)).toBe(true);
      expect(r.amountMinor).toBeGreaterThan(0);
      expect(['in', 'out']).toContain(r.direction);
      // 账单区间 2026-05-22 ~ 2026-06-22（含边界余量）
      expect(r.date >= '2026-05-20' && r.date <= '2026-06-24').toBe(true);
    }
  });

  it('去重键（交易单号）唯一', () => {
    const ids = result.rows.map((r) => r.bizNo);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('分账：商户消费=expense、二维码收款=income、零钱提现(中性)=transfer-out、转账=unknown', () => {
    const byType = (t: string) => result.rows.filter((r) => r.accountingType === t);
    expect(byType('商户消费').every((r) => r.suggestion === 'expense')).toBe(true);
    if (byType('二维码收款').length) expect(byType('二维码收款').every((r) => r.suggestion === 'income')).toBe(true);
    if (byType('零钱提现').length) expect(byType('零钱提现').every((r) => r.suggestion === 'transfer-out')).toBe(true);
    if (byType('转账').length) expect(byType('转账').every((r) => r.suggestion === 'unknown')).toBe(true);
  });
});

describe('classifyWechat 纯函数（方向 + 建议）', () => {
  it('收入/支出 + 类型 → 收支 / 划转 / unknown', () => {
    expect(classifyWechat('商户消费', '支出')).toEqual({ direction: 'out', suggestion: 'expense' });
    expect(classifyWechat('二维码收款', '收入')).toEqual({ direction: 'in', suggestion: 'income' });
    expect(classifyWechat('信用卡还款', '支出')).toEqual({ direction: 'out', suggestion: 'transfer-out' });
    expect(classifyWechat('转账', '支出')).toEqual({ direction: 'out', suggestion: 'unknown' });
    expect(classifyWechat('天外飞仙', '支出')).toEqual({ direction: 'out', suggestion: 'unknown' });
  });

  it('中性("/") → 一律 transfer，方向按类型关键词猜', () => {
    expect(classifyWechat('零钱提现', '/')).toEqual({ direction: 'out', suggestion: 'transfer-out' });
    expect(classifyWechat('零钱通转出-到零钱', '/')).toEqual({ direction: 'out', suggestion: 'transfer-out' });
    expect(classifyWechat('转入零钱通-来自零钱', '/')).toEqual({ direction: 'in', suggestion: 'transfer-in' });
    expect(classifyWechat('充值', '/')).toEqual({ direction: 'in', suggestion: 'transfer-in' });
  });

  it('映射表覆盖（消费=real / 提现=transfer / 转账=ambiguous）', () => {
    expect(WECHAT_TYPE_KIND['商户消费']).toBe('real');
    expect(WECHAT_TYPE_KIND['零钱提现']).toBe('transfer');
    expect(WECHAT_TYPE_KIND['转账']).toBe('ambiguous');
  });
});

describe('Excel 序列号转换', () => {
  it('正序列号 → 合法日期；非正 → null', () => {
    const r = excelSerialToDatetime(45292);
    expect(r?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r?.datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(excelSerialToDatetime(0)).toBeNull();
    expect(excelSerialToDatetime(-5)).toBeNull();
  });
});

describe('微信解析 · 边界与记账安全', () => {
  it('「转账」语义双关 → unknown + 专门告警', () => {
    const r = parseWechatBill(matrixOf(wrow({ type: '转账', shouZhi: '支出' })));
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('转账') && w.includes('内部划转'))).toBe(true);
  });

  it('未识别类型 → unknown + 告警', () => {
    const r = parseWechatBill(matrixOf(wrow({ type: '某新奇类型', shouZhi: '支出' })));
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('某新奇类型'))).toBe(true);
  });

  it('¥ 前缀金额字符串正确解析（¥38.00 → 3800 分）', () => {
    const r = parseWechatBill(matrixOf(wrow({ amount: '¥38.00' })));
    expect(r.rows[0]!.amountMinor).toBe(3800);
  });

  it('Excel 序列号日期（数字单元格）正常转换', () => {
    const r = parseWechatBill(matrixOf(wrow({ date: 45292, amount: 10 })));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('"/" 空占位清成空串（商品/备注），中性走 transfer', () => {
    const r = parseWechatBill(matrixOf(wrow({ type: '零钱提现', shouZhi: '/', product: '/', remark: '/' })));
    expect(r.rows[0]!.suggestion).toBe('transfer-out');
    expect(r.rows[0]!.note).toBe('');
  });

  it('金额为 0 / 空 → 告警跳过', () => {
    const r = parseWechatBill(matrixOf(wrow({ amount: 0 })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('金额'))).toBe(true);
  });

  it('表头缺必需列（无金额）→ 抛错', () => {
    const badHeader: Cell[] = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
    const m: Cell[][] = [['微信支付账单明细'], badHeader, wrow({})];
    expect(() => parseWechatBill(m)).toThrow();
  });

  it('空矩阵 → 无行 +「未找到表头」告警', () => {
    const r = parseWechatBill([]);
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('未找到表头'))).toBe(true);
  });
});

describe('review 修复回归（防崩 / 中性收紧 / 表头 / 方向）', () => {
  it('非 string|number 单元格（boolean / Date）不崩：坏日期/金额→跳过，文本字段→不崩', () => {
    expect(parseWechatBill(matrixOf(wrow({ date: true }))).rows.length).toBe(0);
    expect(parseWechatBill(matrixOf(wrow({ amount: new Date(Date.UTC(2026, 5, 1)) }))).rows.length).toBe(0);
    expect(parseWechatBill(matrixOf(wrow({ payee: true }))).rows.length).toBe(1);
  });

  it('日期列里的纯数字串不当 Excel 序列号（防幽灵日期）→ 跳过 + 告警', () => {
    const r = parseWechatBill(matrixOf(wrow({ date: '45292' })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('日期'))).toBe(true);
  });

  it('Date 对象日期单元格正常解析（兼容 cellDates:true）', () => {
    const r = parseWechatBill(matrixOf(wrow({ date: new Date(Date.UTC(2026, 5, 1, 10, 30, 0)) })));
    expect(r.rows[0]!.date).toBe('2026-06-01');
    expect(r.rows[0]!.datetime).toBe('2026-06-01 10:30:00');
  });

  it('slash 日期串解析（兼容 raw:false 格式化输出）', () => {
    const r = parseWechatBill(matrixOf(wrow({ date: '2026/06/01 10:05:00' })));
    expect(r.rows[0]!.date).toBe('2026-06-01');
  });

  it('中性收紧（红线）：真实/未知类型落在非「收入/支出」列 → unknown，不静默吞成 transfer', () => {
    expect(parseWechatBill(matrixOf(wrow({ type: '商户消费', shouZhi: '中性' }))).rows[0]!.suggestion).toBe('unknown');
    expect(parseWechatBill(matrixOf(wrow({ type: '商户消费', shouZhi: '' }))).rows[0]!.suggestion).toBe('unknown');
    expect(parseWechatBill(matrixOf(wrow({ type: '商户消费', shouZhi: '/' }))).rows[0]!.suggestion).toBe('unknown');
    expect(classifyWechat('商户消费', '中性').suggestion).toBe('unknown');
    expect(classifyWechat('商户消费', '').suggestion).toBe('unknown');
  });

  it('中性方向修复：理财通购买 / 零钱通存入 = transfer-out（钱离开可用余额）', () => {
    expect(classifyWechat('理财通购买', '/')).toEqual({ direction: 'out', suggestion: 'transfer-out' });
    expect(classifyWechat('零钱通存入', '/')).toEqual({ direction: 'out', suggestion: 'transfer-out' });
  });

  it('classifyWechat 内部 trim 收/支（pure 函数与 parser 行为一致）', () => {
    expect(classifyWechat('商户消费', ' 支出 ').suggestion).toBe('expense');
  });

  it('交易单号被读成数字 → 告警跳过（防去重键精度坍缩）', () => {
    const r = parseWechatBill(matrixOf(wrow({ bizNo: 1.7523272603883789e27 })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('精度'))).toBe(true);
  });

  it('含签名词的前言整句不被误判为表头（真表头在后仍被找到）', () => {
    const preamble = '说明：本明细包含交易时间、交易类型、交易单号等字段';
    const m: Cell[][] = [['微信支付账单明细'], [preamble], HEADER, wrow({ amount: 50 })];
    expect(parseWechatBill(m).rows.length).toBe(1);
  });
});
