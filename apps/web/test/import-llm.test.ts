import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '@app/store';
import type { MappedImportSpec } from '@app/core';
import {
  decodeSmart,
  extractJsonObject,
  loadLlmSpecs,
  rememberLlmSpec,
  sampleCsvText,
  tryRememberedSpecs,
  loadAiConfig,
} from '../src/import-llm';
import { AI_CONFIG_KEY, APP_SCOPE, LLM_SPECS_KEY } from '../src/settings';

/**
 * AI 认列编排的纯函数/存取层测试（增量4·4c）。云调用（llmComplete）是 Tauri IPC、桌面真机验；
 * 这里钉住：编码嗅探、采样截断、JSON 抽取、记忆重放的命中判定、spec 记忆的去重/封顶/坏数据防御。
 */

const BANK_SPEC: MappedImportSpec = {
  version: 1,
  bankName: '甲银行',
  columns: { date: '交易日期', type: '摘要', payee: '对方户名' },
  amount: { mode: 'signed', amountCol: '交易金额', negativeIs: 'out' },
};

const OTHER_SPEC: MappedImportSpec = {
  version: 1,
  bankName: '乙银行',
  columns: { date: '记账时间' },
  amount: { mode: 'dual', incomeCol: '收入', expenseCol: '支出' },
};

const bankCsv = '交易日期,摘要,交易金额,对方户名\n2026-07-01,消费,-8.00,某店';

describe('decodeSmart（编码嗅探）', () => {
  it('UTF-8 文本恒走 UTF-8；GB18030 字节自动换道', () => {
    const utf8 = new TextEncoder().encode('交易日期,金额\n2026-07-01,-8.00');
    expect(decodeSmart(utf8.buffer as ArrayBuffer)).toContain('交易日期');
    // 「交易」的 GBK/GB18030 编码字节（用 UTF-8 解会出替换符）
    const gbk = new Uint8Array([0xbd, 0xbb, 0xd2, 0xd7, 0x2c, 0x31, 0x32]); // 交易,12
    const decoded = decodeSmart(gbk.buffer as ArrayBuffer);
    expect(decoded).toBe('交易,12');
  });

  it('UTF-16 BOM 直判（部分银行导出是 UTF-16，不能交给 GB18030 解成乱码）', () => {
    const s = '交易,12';
    const le = new Uint8Array(2 + s.length * 2);
    le[0] = 0xff;
    le[1] = 0xfe;
    [...s].forEach((ch, i) => {
      const c = ch.charCodeAt(0);
      le[2 + i * 2] = c & 0xff;
      le[3 + i * 2] = c >> 8;
    });
    expect(decodeSmart(le.buffer as ArrayBuffer)).toBe(s);
  });
});

describe('sampleCsvText / extractJsonObject', () => {
  it('采样限行数、截长行、剔空行', () => {
    const text = Array.from({ length: 40 }, (_, i) => (i === 5 ? '' : `行${i},${'x'.repeat(500)}`)).join('\n');
    const s = sampleCsvText(text, 10, 100);
    const lines = s.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(lines.some((l) => l === '')).toBe(false);
  });

  it('抽取 JSON：容忍围栏与前后解说；无对象时原样返回', () => {
    expect(extractJsonObject('```json\n{"version":1}\n```')).toBe('{"version":1}');
    expect(extractJsonObject('好的，映射如下：{"a":{"b":2}} 请查收')).toBe('{"a":{"b":2}}');
    expect(extractJsonObject('no json here')).toBe('no json here');
  });
});

describe('tryRememberedSpecs（本地记忆重放，零上云）', () => {
  it('首个解出行的 spec 命中；表头对不上的 spec 自然落空', () => {
    const hit = tryRememberedSpecs([OTHER_SPEC, BANK_SPEC], { kind: 'csv', text: bankCsv });
    expect(hit).not.toBeNull();
    expect(hit!.fromMemory).toBe(true);
    expect(hit!.spec.bankName).toBe('甲银行');
    expect(hit!.result.rows).toHaveLength(1);
  });

  it('全部落空 → null（该上云了）；坏 spec（列冲突抛错）不拦路', () => {
    expect(tryRememberedSpecs([OTHER_SPEC], { kind: 'csv', text: bankCsv })).toBeNull();
    const clashing: MappedImportSpec = {
      version: 1,
      columns: { date: '交易' },
      amount: { mode: 'signed', amountCol: '交易', negativeIs: 'out' },
    };
    const hit = tryRememberedSpecs([clashing, BANK_SPEC], { kind: 'csv', text: bankCsv });
    expect(hit!.spec.bankName).toBe('甲银行');
  });

  it('signed 记忆重放全部行同向 → 亮告警（误配「借贷标记列」银行的强信号）', () => {
    const csv = '交易日期,摘要,交易金额,对方户名\n2026-07-01,消费,8.00,甲\n2026-07-02,消费,9.00,乙\n2026-07-03,消费,10.00,丙';
    const hit = tryRememberedSpecs([BANK_SPEC], { kind: 'csv', text: csv });
    expect(hit!.result.rows).toHaveLength(3);
    expect(hit!.result.warnings.some((w) => w.includes('全部行方向一致'))).toBe(true);
  });

  it('xlsx 矩阵路径同样可重放', () => {
    const matrix = [
      ['交易日期', '摘要', '交易金额', '对方户名'],
      ['2026-07-01', '消费', -8, '某店'],
    ];
    const hit = tryRememberedSpecs([BANK_SPEC], { kind: 'xlsx', matrix });
    expect(hit!.result.rows[0]).toMatchObject({ amountMinor: 800, direction: 'out' });
  });
});

describe('spec 记忆存取（settings 表 JSON）', () => {
  it('记忆去重挪前、容量封顶 8、坏项丢弃', async () => {
    const repo = new InMemoryRepository();
    for (let i = 0; i < 9; i++) {
      await rememberLlmSpec(repo, { ...BANK_SPEC, bankName: `行${i}` });
    }
    let specs = await loadLlmSpecs(repo);
    expect(specs).toHaveLength(8);
    expect(specs[0]!.bankName).toBe('行8'); // 最新在前，最旧（行0）被挤出

    await rememberLlmSpec(repo, { ...BANK_SPEC, bankName: '行5' }); // 重复 → 挪前不重复占位
    specs = await loadLlmSpecs(repo);
    expect(specs).toHaveLength(8);
    expect(specs[0]!.bankName).toBe('行5');
    expect(specs.filter((s) => s.bankName === '行5')).toHaveLength(1);
  });

  it('坏 JSON / 数组里的非法 spec 防御性丢弃', async () => {
    const repo = new InMemoryRepository();
    await repo.setSetting(APP_SCOPE, LLM_SPECS_KEY, 'not-json');
    expect(await loadLlmSpecs(repo)).toEqual([]);
    await repo.setSetting(APP_SCOPE, LLM_SPECS_KEY, JSON.stringify([{ version: 99 }, BANK_SPEC]));
    const specs = await loadLlmSpecs(repo);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.bankName).toBe('甲银行');
  });
});

describe('loadAiConfig（repo 直读，防御性解析）', () => {
  it('未配置 → 默认关；坏 JSON → 默认关；正常配置读回', async () => {
    const repo = new InMemoryRepository();
    expect((await loadAiConfig(repo)).enabled).toBe(false);
    await repo.setSetting(APP_SCOPE, AI_CONFIG_KEY, '{bad');
    expect((await loadAiConfig(repo)).enabled).toBe(false);
    await repo.setSetting(APP_SCOPE, AI_CONFIG_KEY, JSON.stringify({ enabled: true, protocol: 'anthropic', baseUrl: ' https://x ', model: 'm' }));
    const cfg = await loadAiConfig(repo);
    expect(cfg).toEqual({ enabled: true, protocol: 'anthropic', baseUrl: 'https://x', model: 'm' });
  });
});
