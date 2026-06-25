import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseOcrBill, stagingRowToEntry } from '../src/index';
import type { OcrImage, OcrWord } from '../src/index';

/** fixture 是真实支付宝「账单详情」截图的 OCR 词 + bbox（无敏感信息：仅商户名/金额/日期）。 */
function loadFixture(name: string): OcrImage {
  const raw = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(raw) as OcrImage;
}

/** 造一个词（width 不参与聚行，给个占位）。 */
function W(text: string, x: number, y: number, h: number): OcrWord {
  return { text, x, y, w: text.length * 30, h };
}

describe('本地 OCR 解析器 · 单笔详情（真实截图 fixture）', () => {
  const r = parseOcrBill(loadFixture('ocr-detail-alipay.json'));

  it('一张详情截图 → 恰好 1 行草稿', () => {
    expect(r.rows.length).toBe(1);
  });

  it('金额：「一33·80」→ 3380 分、出账、建议 expense（一=负号、·=小数点）', () => {
    const row = r.rows[0]!;
    expect(row.amountMinor).toBe(3380);
    expect(row.direction).toBe('out');
    expect(row.suggestion).toBe('expense');
  });

  it('日期：拆开的数字「.1 7」「1 8：1 6」按 bbox 拼回 2026-06-17 18:16:55', () => {
    const row = r.rows[0]!;
    expect(row.date).toBe('2026-06-17');
    expect(row.datetime).toBe('2026-06-17 18:16:55');
  });

  it('对方 = 金额上方最近文本行「星巴克」；source=ocr', () => {
    const row = r.rows[0]!;
    expect(row.payee).toBe('星巴克');
    expect(row.source).toBe('ocr');
  });

  it('无可见交易单号 → 去重键内容派生含 datetime（再识别同图可去重、同日同额两笔不误吞）', () => {
    expect(r.rows[0]!.bizNo).toBe('ocr:2026-06-17 18:16:55:3380:星巴克');
  });
});

describe('本地 OCR 解析器 · 合成用例', () => {
  /** 收款详情：「+114．00」→ 收入。 */
  it('收款：+114．00 → 11400 分、进账、建议 income', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('小卖部', 480, 380, 40),
        W('+', 410, 470, 60), W('114', 450, 460, 66), W('．', 560, 510, 10), W('00', 580, 460, 66),
        W('交易成功', 460, 580, 38),
        W('2026', 340, 710, 30), W('年', 430, 708, 30), W('6', 470, 710, 30), W('月', 495, 708, 30),
        W('1', 535, 710, 30), W('8', 555, 710, 30), W('日', 580, 708, 30),
        W('10', 640, 710, 30), W('：', 685, 712, 26), W('30', 700, 710, 30), W('：', 745, 712, 26), W('00', 760, 710, 30),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.amountMinor).toBe(11400);
    expect(res.rows[0]!.direction).toBe('in');
    expect(res.rows[0]!.suggestion).toBe('income');
    expect(res.rows[0]!.date).toBe('2026-06-18');
    expect(res.rows[0]!.payee).toBe('小卖部');
  });

  /** 列表截图（≥3 条金额行）→ 不硬解析，0 行 + 提示走账单文件。 */
  it('列表截图 → 0 行 + 「列表」提示（详情/列表区分）', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('收钱码收款', 70, 300, 36), W('+', 900, 300, 36), W('114', 930, 300, 36), W('．', 1000, 320, 10), W('00', 1015, 300, 36),
        W('超市', 70, 500, 36), W('一', 900, 500, 8), W('107', 930, 500, 36), W('．', 1000, 520, 10), W('00', 1015, 500, 36),
        W('余额宝收益', 70, 700, 36), W('0', 930, 700, 36), W('．', 960, 720, 10), W('39', 975, 700, 36),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(0);
    expect(res.warnings.some((w) => w.includes('列表'))).toBe(true);
  });

  /** 非账单图（无金额）→ 0 行 + 提示。 */
  it('无金额的图 → 0 行 + 提示', () => {
    const img: OcrImage = { width: 800, height: 600, words: [W('风景照', 100, 100, 40), W('你好', 100, 200, 40)] };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(0);
    expect(res.warnings.some((w) => w.includes('未识别出金额'))).toBe(true);
  });

  /** 可见交易单号（≥12 位）→ 去重键取它（再导同图被去重）。 */
  it('可见长交易单号 → 去重键取该数字串', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('某商户', 480, 380, 40),
        W('一', 410, 470, 8), W('33', 450, 460, 66), W('·', 560, 510, 12), W('80', 580, 460, 66),
        W('2026', 340, 710, 30), W('．', 430, 720, 8), W('06', 450, 710, 30), W('．', 500, 720, 8), W('03', 520, 710, 30),
        W('100000000000123456', 100, 900, 30),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.bizNo).toBe('100000000000123456');
    expect(res.rows[0]!.date).toBe('2026-06-03');
  });

  /** 无符号金额 → 默认出账 + unknown + 提示（不按方向兜底成 expense）。 */
  it('无 +/− 符号的金额 → 默认出账、suggestion=unknown、给提示', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('商店', 480, 380, 40),
        W('50', 450, 460, 66), W('．', 560, 510, 10), W('00', 580, 460, 66),
        W('2026', 340, 710, 30), W('年', 430, 708, 30), W('6', 470, 710, 30), W('月', 495, 708, 30), W('1', 535, 710, 30), W('日', 560, 708, 30),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.direction).toBe('out');
    expect(res.rows[0]!.suggestion).toBe('unknown');
    expect(res.warnings.some((w) => w.includes('正负号'))).toBe(true);
  });

  /** Unicode 真负号 U+2212（−）也认作负号 → 支出，不退化成 unknown。 */
  it('U+2212 真负号 −33.80 → 出账、建议 expense', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('商店', 480, 380, 40),
        W('−33', 450, 460, 66), W('．', 560, 510, 10), W('80', 580, 460, 66),
        W('2026', 340, 710, 30), W('年', 430, 708, 30), W('6', 470, 710, 30), W('月', 495, 708, 30), W('1', 535, 710, 30), W('日', 560, 708, 30),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows[0]!.amountMinor).toBe(3380);
    expect(res.rows[0]!.direction).toBe('out');
    expect(res.rows[0]!.suggestion).toBe('expense');
  });

  /** 规整千分位 12,345.00 → 1234500 分（不被误截）。 */
  it('规整千分位金额 一12,345.00 → 1234500 分', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [W('房租', 480, 380, 40), W('一12,345.00', 450, 460, 66), W('2026', 340, 710, 30), W('年', 430, 708, 30), W('6', 470, 710, 30), W('月', 495, 708, 30), W('1', 535, 710, 30), W('日', 560, 708, 30)],
    };
    const res = parseOcrBill(img);
    expect(res.rows[0]!.amountMinor).toBe(1234500);
  });

  /** OCR 把千分位识歪（1,2345.00）→ 拒绝该金额（不静默截成 2345.00），返 0 行 + 提示。 */
  it('误位千分位 一1,2345.00 → 拒绝（不截断）、0 行 + 未识别金额提示', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [W('房租', 480, 380, 40), W('一1,2345.00', 450, 460, 66)],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(0);
    expect(res.warnings.some((w) => w.includes('未识别出金额'))).toBe(true);
  });

  /** 3 条金额行但有主导金额（详情 + 小额优惠/明细）→ 仍取主金额、不误判列表。 */
  it('含主导金额的 3 行（详情 + 小额）→ 取主金额、非列表', () => {
    const img: OcrImage = {
      width: 1080,
      height: 2400,
      words: [
        W('商户', 480, 300, 40),
        W('一88.00', 450, 400, 70),
        W('商品', 70, 600, 30), W('88.00', 900, 600, 30),
        W('优惠', 70, 700, 30), W('2.00', 900, 700, 30),
      ],
    };
    const res = parseOcrBill(img);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.amountMinor).toBe(8800);
    expect(res.rows[0]!.direction).toBe('out');
  });
});

describe('落库红线 · stagingRowToEntry 拒绝非法日期（OCR 可能 date=空）', () => {
  const decision = { kind: 'expense' as const, bookId: 'b1', accountId: 'cat1' };
  it('空日期 → throw（防无日期交易在月度视图静默漏记）', () => {
    expect(() => stagingRowToEntry({ amountMinor: 100, date: '', payee: 'x', note: '' }, decision, 'src1')).toThrow(/日期/);
  });
  it('合法 YYYY-MM-DD → 正常映射', () => {
    const e = stagingRowToEntry({ amountMinor: 100, date: '2026-06-17', payee: 'x', note: '' }, decision, 'src1');
    expect(e.date).toBe('2026-06-17');
  });
});
