import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseAlipayFundFlow, suggestFromType, ALIPAY_TYPE_KIND } from '../src/index';

/** fixture 是真实导出脱敏后的 GB18030 文件；解码由调用方负责（此处模拟 I/O 边界）。 */
function loadFixture(name: string): string {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return new TextDecoder('gb18030').decode(buf);
}

/** 手搓一行最小 CSV（默认 15 列），方便针对单一账务类型断言。 */
function oneRow(accountingType: string, dir: 'in' | 'out', amount = '50.00'): string {
  const header =
    '序号,入账时间,支付宝交易号,支付宝流水号,商户订单号,账务类型,收入（+元）,支出（-元）,账户余额（元）,对方账户,对方名称,银行订单号,商品名称,备注,业务描述';
  const inc = dir === 'in' ? amount : ' ';
  const exp = dir === 'out' ? amount : ' ';
  const row = `1,2026-06-01 10:00:00,TX1,SN1, ,${accountingType},${inc},${exp},0.00,acc***@x,某人, ,某商品, , `;
  return ['#账号：demo***@example.com[2088000000000000]', header, row].join('\n');
}

describe('支付宝资金流水解析器（真实脱敏 fixture）', () => {
  const result = parseAlipayFundFlow(loadFixture('alipay-fund-flow.csv'));

  it('抽出元数据：账号 / 查询区间 / 导出时间', () => {
    expect(result.meta.source).toBe('alipay-fund-flow');
    expect(result.meta.account).toContain('2088000000000000');
    expect(result.meta.rangeStart).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(result.meta.rangeEnd).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(result.meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('解析出全部 40 条数据行（跳过 # 元数据、表头、空尾行）', () => {
    expect(result.rows.length).toBe(40);
  });

  it('每行字段齐备：去重键 / 日期 / 正整数分 / 方向 / 账务类型', () => {
    for (const r of result.rows) {
      expect(r.bizNo).toBeTruthy();
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(Number.isInteger(r.amountMinor)).toBe(true);
      expect(r.amountMinor).toBeGreaterThan(0);
      expect(['in', 'out']).toContain(r.direction);
      expect(r.accountingType).toBeTruthy();
    }
  });

  it('去重键（支付宝交易号）唯一', () => {
    const ids = result.rows.map((r) => r.bizNo);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('核心分账：「在线支付」收款=income，「理财申购」=transfer-out（内部划转不当支出）', () => {
    const online = result.rows.filter((r) => r.accountingType === '在线支付');
    const licai = result.rows.filter((r) => r.accountingType === '理财申购');
    expect(online.length).toBeGreaterThan(0);
    expect(licai.length).toBeGreaterThan(0);
    expect(online.every((r) => r.direction === 'in' && r.suggestion === 'income')).toBe(true);
    expect(licai.every((r) => r.direction === 'out' && r.suggestion === 'transfer-out')).toBe(true);
  });

  it('fixture 全为已知类型 → 无 unknown 告警', () => {
    expect(result.rows.every((r) => r.suggestion !== 'unknown')).toBe(true);
  });
});

describe('账务类型映射 + 未知类型安全网（红线：不静默记错）', () => {
  it('未识别账务类型 → suggestion=unknown + 产生告警', () => {
    const r = parseAlipayFundFlow(oneRow('某新奇类型', 'in'));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('某新奇类型'))).toBe(true);
  });

  it('已知类型映射：消费→expense / 退款→refund / 提现→transfer-out / 在线支付收款→income', () => {
    expect(parseAlipayFundFlow(oneRow('消费', 'out')).rows[0]!.suggestion).toBe('expense');
    expect(parseAlipayFundFlow(oneRow('退款', 'in')).rows[0]!.suggestion).toBe('refund');
    expect(parseAlipayFundFlow(oneRow('提现', 'out')).rows[0]!.suggestion).toBe('transfer-out');
    expect(parseAlipayFundFlow(oneRow('在线支付', 'in')).rows[0]!.suggestion).toBe('income');
  });

  it('suggestFromType 纯函数：方向影响真实收支与划转方向', () => {
    expect(suggestFromType('在线支付', 'in')).toBe('income');
    expect(suggestFromType('在线支付', 'out')).toBe('expense');
    expect(suggestFromType('理财申购', 'out')).toBe('transfer-out');
    expect(suggestFromType('理财赎回', 'in')).toBe('transfer-in');
    expect(suggestFromType('天外飞仙', 'in')).toBe('unknown');
  });

  it('金额按分换算：50.00 元 → 5000 分', () => {
    expect(parseAlipayFundFlow(oneRow('消费', 'out', '50.00')).rows[0]!.amountMinor).toBe(5000);
    expect(parseAlipayFundFlow(oneRow('消费', 'out', '600.57')).rows[0]!.amountMinor).toBe(60057);
  });

  it('映射表覆盖常见类型（理财/提现/退款/还款）', () => {
    expect(ALIPAY_TYPE_KIND['理财申购']).toBe('transfer');
    expect(ALIPAY_TYPE_KIND['提现']).toBe('transfer');
    expect(ALIPAY_TYPE_KIND['退款']).toBe('refund');
    expect(ALIPAY_TYPE_KIND['信用卡还款']).toBe('transfer');
  });
});

describe('review 修复回归（解析鲁棒 + 记账安全）', () => {
  const HEADER =
    '序号,入账时间,支付宝交易号,支付宝流水号,商户订单号,账务类型,收入（+元）,支出（-元）,账户余额（元）,对方账户,对方名称,银行订单号,商品名称,备注,业务描述';
  const csvOf = (...dataLines: string[]): string => ['#账号：demo[2088]', HEADER, ...dataLines].join('\n');
  /** 15 列数据行：传 {type,inc,exp,...} 覆盖默认。 */
  const dataRow = (o: { type?: string; inc?: string; exp?: string; opp?: string; oppAcc?: string; prod?: string; date?: string }): string =>
    [
      '1',
      o.date ?? '2026-06-01 10:00:00',
      'TX1',
      'SN1',
      ' ',
      o.type ?? '消费',
      o.inc ?? ' ',
      o.exp ?? ' ',
      '0.00',
      o.oppAcc ?? 'acc***@x',
      o.opp ?? '某人',
      ' ',
      o.prod ?? '某商品',
      ' ',
      ' ',
    ].join(',');

  it('负号金额：支出列带负号仍记为支出（abs，防漏单）', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ type: '消费', exp: '-50.00' })));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.direction).toBe('out');
    expect(r.rows[0]!.amountMinor).toBe(5000);
    expect(r.rows[0]!.suggestion).toBe('expense');
  });

  it('「转账」语义双关 → unknown + 专门告警（不静默记成支出）', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ type: '转账', exp: '50.00' })));
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('转账') && w.includes('内部划转'))).toBe(true);
  });

  it('扩充映射：余额宝-转出 / 提现=transfer-out，扫码付款=expense', () => {
    expect(parseAlipayFundFlow(csvOf(dataRow({ type: '余额宝-转出', exp: '9' }))).rows[0]!.suggestion).toBe('transfer-out');
    expect(parseAlipayFundFlow(csvOf(dataRow({ type: '提现', exp: '9' }))).rows[0]!.suggestion).toBe('transfer-out');
    expect(parseAlipayFundFlow(csvOf(dataRow({ type: '扫码付款', exp: '9' }))).rows[0]!.suggestion).toBe('expense');
  });

  it('非数字金额 → 告警跳过，不当 0 吞', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ inc: 'abc', exp: '5.00' })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('无法解析'))).toBe(true);
  });

  it('收支双列同时有值 → 专门告警跳过（区分于全空）', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ inc: '10.00', exp: '0.50' })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('同时有值'))).toBe(true);
  });

  it('金额过小四舍五入为 0（0.001 元）→ 跳过，不产出 0 额交易', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ exp: '0.001' })));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('四舍五入'))).toBe(true);
  });

  it('引号包裹的字段内逗号正确解析（不错位）', () => {
    const line = '1,2026-06-01 10:00:00,TX,SN, ,消费, ,50.00,0,acc,"某店A,B分店", ,"A,B套餐", , ';
    const r = parseAlipayFundFlow(csvOf(line));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.payee).toBe('某店A,B分店');
    expect(r.rows[0]!.note).toContain('A,B套餐');
  });

  it('未加引号的字段内逗号 → 列数不符，告警跳过（不静默错位）', () => {
    const line = '1,2026-06-01 10:00:00,TX,SN, ,消费, ,50.00,0,acc,某店,A,分店, ,prod, , ';
    const r = parseAlipayFundFlow(csvOf(line));
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('列数与表头不符'))).toBe(true);
  });

  it('CRLF 行尾正常解析', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ exp: '50.00' })).replace(/\n/g, '\r\n'));
    expect(r.rows.length).toBe(1);
  });

  it('UTF-8 BOM 前缀不影响元数据与解析', () => {
    const r = parseAlipayFundFlow('﻿' + csvOf(dataRow({ exp: '50.00' })));
    expect(r.rows.length).toBe(1);
    expect(r.meta.account).toBeTruthy();
  });

  it('日期带 T 分隔 → 归一为空格；单位月日补零', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ date: '2026-6-1T09:05', exp: '50.00' })));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.date).toBe('2026-06-01');
    expect(r.rows[0]!.datetime).toBe('2026-06-01 09:05:00');
  });

  it('空输入 → 无行 +「未找到表头」告警', () => {
    const r = parseAlipayFundFlow('');
    expect(r.rows.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('未找到表头'))).toBe(true);
  });

  it('表头缺必需列（无收入/支出）→ 抛错', () => {
    const badHeader = '序号,入账时间,支付宝交易号,账务类型,对方名称';
    const csv = ['#x', badHeader, '1,2026-06-01 10:00:00,TX,消费,某人'].join('\n');
    expect(() => parseAlipayFundFlow(csv)).toThrow();
  });

  it('保留对方账户原始串供落库 / 自转判定', () => {
    const r = parseAlipayFundFlow(csvOf(dataRow({ exp: '50.00', oppAcc: 'self***@bank' })));
    expect(r.rows[0]!.counterpartyAccount).toBe('self***@bank');
  });
});
