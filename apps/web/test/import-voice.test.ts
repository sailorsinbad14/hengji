import { describe, it, expect } from 'vitest';
import { parseVoiceRows, buildVoiceSystemPrompt, VOICE_SOURCE } from '../src/import-voice';

/**
 * 语音结构化输出的硬校验测试（增量4·4d）。LLM 产物不可信：金额/方向/日期/币种/控制字符全部过闸，
 * 拿不准一律 unknown 留复核台（红线）。音频解码（AudioContext）无法在 Node 测，留桌面真机。
 */

const TODAY = '2026-07-06';
const SALT = 'S1';
const wrap = (rows: unknown[]): string => JSON.stringify({ rows });
const parse = (rows: unknown[]): ReturnType<typeof parseVoiceRows> => parseVoiceRows(wrap(rows), TODAY, SALT);

describe('parseVoiceRows（LLM 输出硬校验）', () => {
  it('正常行：金额转分、相对日期已由 LLM 换算、kind→suggestion、键含批次盐', () => {
    const r = parse([{ date: '2026-07-05', amount: 3200, direction: 'out', kind: 'expense', payee: '老王家', note: '进货' }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      source: VOICE_SOURCE,
      date: '2026-07-05',
      amountMinor: 320000,
      direction: 'out',
      suggestion: 'expense',
      payee: '老王家',
      note: '进货',
    });
    expect(r.rows[0]!.bizNo).toMatch(/^voice:S1:/);
  });

  it('批次盐进键：同内容不同批次（盐不同）键必不同——跨批次去重不吞同天第二笔真交易', () => {
    const row = [{ amount: 35, direction: 'out', kind: 'expense', payee: '星巴克' }];
    const k1 = parseVoiceRows(wrap(row), TODAY, 'A1').rows[0]!.bizNo;
    const k2 = parseVoiceRows(wrap(row), TODAY, 'B2').rows[0]!.bizNo;
    expect(k1).not.toBe(k2);
  });

  it('金额非法（0/负/非数字/超安全整数量级）→ 跳过并告警', () => {
    const r = parse([
      { amount: 0, direction: 'out' },
      { amount: -5, direction: 'out' },
      { amount: 'abc', direction: 'out' },
      { amount: 1234567890123456, direction: 'out', kind: 'expense' },
    ]);
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.filter((w) => w.includes('金额无效'))).toHaveLength(4);
  });

  it('方向缺失 → 跳过；日期非法/缺省 → 回落今天并告警（历法终门）；未来日期 → 提示', () => {
    const r = parse([
      { amount: 10, kind: 'expense' },
      { amount: 10, direction: 'out', date: '2026-13-45' },
      { amount: 10, direction: 'out' },
      { amount: 10, direction: 'out', date: '2027-01-01' },
    ]);
    expect(r.rows).toHaveLength(3);
    expect(r.warnings.some((w) => w.includes('方向缺失'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('日期无法识别'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('日期在未来'))).toBe(true);
  });

  it('外币线索 → 强制 unknown + 告警（绝不静默按人民币记）', () => {
    const r = parse([{ amount: 300, direction: 'out', kind: 'expense', foreignCurrency: true, payee: 'supplier' }]);
    expect(r.rows[0]!.suggestion).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('非人民币'))).toBe(true);
  });

  it('kind 与方向矛盾 → unknown；transfer 按方向折 in/out；未知 kind → unknown', () => {
    const r = parse([
      { amount: 10, direction: 'out', kind: 'income' },
      { amount: 10, direction: 'in', kind: 'transfer' },
      { amount: 10, direction: 'out', kind: 'magic' },
    ]);
    expect(r.rows.map((x) => x.suggestion)).toEqual(['unknown', 'transfer-in', 'unknown']);
    expect(r.warnings.some((w) => w.includes('矛盾'))).toBe(true);
  });

  it('行数封顶 20 + payee/note 截断（防 LLM 注水）', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ amount: i + 1, direction: 'out', kind: 'expense', payee: 'x'.repeat(200), note: 'y'.repeat(500) }));
    const r = parse(many);
    expect(r.rows).toHaveLength(20);
    expect(r.warnings.some((w) => w.includes('仅取前 20 行'))).toBe(true);
    expect(r.rows[0]!.payee.length).toBeLessThanOrEqual(64);
    expect(r.rows[0]!.note.length).toBeLessThanOrEqual(200);
  });

  it('payee 控制字符被剥掉：不可与消歧后缀字面相撞（同批三行全保留、键互异）', () => {
    const evil = '公交' + String.fromCharCode(1) + '2'; // LLM 可经 JSON 转义注入 U+0001
    const r = parse([
      { amount: 15, direction: 'out', kind: 'expense', payee: '公交' },
      { amount: 15, direction: 'out', kind: 'expense', payee: '公交' },
      { amount: 15, direction: 'out', kind: 'expense', payee: evil },
    ]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[2]!.payee).toBe('公交2'); // 控制字符已剥
    expect(new Set(r.rows.map((x) => x.bizNo)).size).toBe(3);
  });

  it('同批重复内容行 → 不可见分隔符消歧（两笔一样的都保留）', () => {
    const row = { amount: 15, direction: 'out', kind: 'expense', payee: '公交' };
    const r = parse([row, row]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]!.bizNo).toBe(r.rows[0]!.bizNo + String.fromCharCode(1) + '2');
  });

  it('非 JSON / 缺 rows 数组 → 抛人话错误；容忍围栏', () => {
    expect(() => parseVoiceRows('not json', TODAY, SALT)).toThrow(/有效 JSON/);
    expect(() => parseVoiceRows('{"foo":1}', TODAY, SALT)).toThrow(/rows/);
    const r = parseVoiceRows('```json\n{"rows":[{"amount":8,"direction":"out","kind":"expense"}]}\n```', TODAY, SALT);
    expect(r.rows).toHaveLength(1);
  });

  it('system 提示词内嵌今天日期（相对日期换算基准）', () => {
    expect(buildVoiceSystemPrompt(TODAY)).toContain(TODAY);
  });
});
