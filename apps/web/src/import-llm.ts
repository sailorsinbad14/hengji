import type { ImportParseResult, MappedImportSpec } from '@app/core';
import { parseMappedCsv, parseMappedMatrix, validateMappedSpec } from '@app/core';
import type { Repository } from '@app/store';
import { llmComplete } from '@app/store/llm';
import type { AiConfig } from './settings';
import { APP_SCOPE, LLM_SPECS_KEY, parseAiConfig, AI_CONFIG_KEY } from './settings';

/**
 * AI 认列编排（增量4·4c）：陌生银行账单（CSV/xlsx）→ 采样 → 云 LLM 产「列映射 spec」→
 * core 确定性引擎按 spec 解析全部行 → 汇入同一复核台。
 *
 * 分层兜底：**先重放记忆 spec（纯本地、零上云）**，全都解不出才走云；云认列成功的 spec 存入记忆。
 * 隐私：上云的只有「表头+前 N 行样本」，且必须 AI 开关已开 + 每次弹窗确认（在调用方 ImportReview）。
 * 红线：LLM 只出映射；金额/日期逐行解析、去重、落库全在本地（core mapped.ts + 复核台三道闸）。
 */

/** 上云采样规模：足够 LLM 认列（表头+值形），又把外发内容压到最小。 */
const SAMPLE_LINES = 25;
const SAMPLE_LINE_LEN = 400;
/** spec 记忆容量（最新在前）。 */
const SPECS_CAP = 8;

/** 统一的账单输入：CSV 已解码文本 或 xlsx 单元格矩阵。 */
export type BillInput = { kind: 'csv'; text: string } | { kind: 'xlsx'; matrix: unknown[][] };

/** 一次认列的结果：解析产物 + 所用 spec + 是否来自本地记忆（零上云）。 */
export interface RecognizeOutcome {
  result: ImportParseResult;
  spec: MappedImportSpec;
  fromMemory: boolean;
}

const countBad = (s: string): number => {
  let n = 0;
  for (const ch of s) if (ch === '�') n++;
  return n;
};

/**
 * 编码嗅探解码：UTF-16 BOM 直判（部分银行/券商导出是 UTF-16 文本，交给 GB18030 会解成乱码）；
 * 否则先 UTF-8、出现替换符再试 GB18030，取替换符更少的一版。
 * （UTF-8 文本在 UTF-8 下零替换符 → 恒选 UTF-8；GB18030 文本在 UTF-8 下大量替换符 → 换道。）
 */
export function decodeSmart(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const badUtf8 = countBad(utf8);
  // 极少量替换符（如尾部截断半个多字节字符）→ 保留 UTF-8：GB18030 几乎能解任何字节流成
  // 「零替换符的乱码」，阈值防止一个坏字节把整份 UTF-8 文件翻成 GBK 乱码
  if (badUtf8 <= 2) return utf8;
  try {
    const gbk = new TextDecoder('gb18030').decode(buf);
    return countBad(gbk) < badUtf8 ? gbk : utf8;
  } catch {
    return utf8;
  }
}

/** 读文件 → BillInput（xlsx 走 SheetJS 矩阵；其余按文本解码）。 */
export async function readBillInput(file: File): Promise<BillInput> {
  const buf = await file.arrayBuffer();
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import('xlsx'); // 动态 import：xlsx 独立 chunk，主包不背
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    const first = wb.SheetNames[0];
    if (!first) throw new Error('xlsx 无可读工作表');
    // defval:'' —— 空单元格保持空串（不同于微信路径的 '/'：陌生银行的占位符由 spec.placeholder 声明）
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first]!, { header: 1, raw: true, defval: '' });
    return { kind: 'xlsx', matrix };
  }
  return { kind: 'csv', text: decodeSmart(buf) };
}

/** CSV 采样：前 N 非空行、每行截断（含表头与足够的值形样例）。 */
export function sampleCsvText(text: string, maxLines = SAMPLE_LINES, maxLen = SAMPLE_LINE_LEN): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, maxLines)
    .map((l) => (l.length > maxLen ? l.slice(0, maxLen) : l))
    .join('\n');
}

/** xlsx 采样：前 N 行序列化成 JSON 行数组（保留 number/string 类型信息，供 LLM 判断序列号日期等）。 */
export function sampleMatrix(matrix: unknown[][], maxRows = SAMPLE_LINES): string {
  return matrix
    .slice(0, maxRows)
    .map((row) => JSON.stringify(row.map((c) => (typeof c === 'string' && c.length > SAMPLE_LINE_LEN ? c.slice(0, SAMPLE_LINE_LEN) : c))))
    .join('\n');
}

/** 从 LLM 回复里抽出首个 JSON 对象（容忍 ``` 围栏与前后解说文字）。抽不出返回原文（交 JSON.parse 报错）。 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** 按 spec 解析（分发 CSV/矩阵；CSV 走严格列数护栏）。 */
function parseWith(spec: MappedImportSpec, input: BillInput): ImportParseResult {
  return input.kind === 'csv' ? parseMappedCsv(input.text, spec) : parseMappedMatrix(input.matrix, spec);
}

/**
 * 记忆重放（纯本地、零上云）：逐个试记忆 spec，首个「解出 ≥1 行」的即命中。
 * 表头关键词匹配本身就是「这份 spec 适不适用」的判定（列名对不上→找不到表头→0 行）；
 * 误配残险由复核台 + 解析告警兜底。
 */
export function tryRememberedSpecs(specs: MappedImportSpec[], input: BillInput): RecognizeOutcome | null {
  for (const spec of specs) {
    try {
      const result = parseWith(spec, input);
      if (result.rows.length > 0) {
        // 误配盲区：signed 记忆 spec 撞上「全正金额+借贷标记列」的另一家银行时，全部行会被
        // 静默解成同一方向且零告警——全同向是强信号，亮出来供人核对（复核台仍是最终闸门）
        if (spec.amount.mode === 'signed' && result.rows.length >= 3 && result.rows.every((r) => r.direction === result.rows[0]!.direction)) {
          result.warnings.push('全部行方向一致（按带符号金额解析）——若该账单实际用「借/贷」标记列表示方向，请核对方向或换用 AI 重新认列');
        }
        return { result, spec, fromMemory: true };
      }
    } catch {
      // 单个坏 spec（列冲突等）不拦路，继续试下一份
    }
  }
  return null;
}

/** 读 spec 记忆（settings 表 JSON 数组；逐份过 validateMappedSpec，坏的丢弃）。 */
export async function loadLlmSpecs(repo: Repository): Promise<MappedImportSpec[]> {
  const row = await repo.getSetting(APP_SCOPE, LLM_SPECS_KEY);
  if (!row) return [];
  try {
    const arr = JSON.parse(row.value) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: MappedImportSpec[] = [];
    for (const item of arr) {
      try {
        out.push(validateMappedSpec(item));
      } catch {
        /* 坏 spec 丢弃 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 记一份 spec 进记忆：按 JSON 相等去重、挪到最前、容量封顶（读-改-写整个数组）。
 * 入记忆前先过 validateMappedSpec **规整**（键序/默认字段与 loadLlmSpecs 读回的同构），否则去重永不相等。
 */
export async function rememberLlmSpec(repo: Repository, spec: MappedImportSpec): Promise<void> {
  const norm = validateMappedSpec(spec);
  const cur = await loadLlmSpecs(repo);
  const key = JSON.stringify(norm);
  const rest = cur.filter((s) => JSON.stringify(s) !== key);
  const next = [norm, ...rest].slice(0, SPECS_CAP);
  await repo.setSetting(APP_SCOPE, LLM_SPECS_KEY, JSON.stringify(next));
}

/** 读 AI 配置（repo 直读版；设置页用 settings 数组版 aiConfigOf）。 */
export async function loadAiConfig(repo: Repository): Promise<AiConfig> {
  const row = await repo.getSetting(APP_SCOPE, AI_CONFIG_KEY);
  return parseAiConfig(row?.value);
}

/** 认列提示词（system）：只出映射 JSON、绝不解析数字——与 core validateMappedSpec 的白名单一一对应。 */
export function buildMappingSystemPrompt(): string {
  return [
    '你是账单列映射器。用户给你一份陌生账单文件的样本（表头+若干数据行），你输出一个 JSON 对象（映射 spec），',
    '描述「哪一列是什么」；全部行的具体解析由本地确定性引擎按 spec 完成，你绝不解析具体数字。',
    '只输出 JSON 对象本身：不要 markdown 围栏、不要任何解释文字。',
    '',
    'spec 结构：',
    '{',
    '  "version": 1,',
    '  "bankName": "银行/来源名（可选）",',
    '  "columns": {',
    '    "date": "日期列名（必填，取表头单元格原文的前缀、精确到不与其它列混淆）",',
    '    "bizNo": "交易号/流水号列（可选；仅当值是全局唯一流水号才填，每次导出从 1 重数的序号列不要填）",',
    '    "type": "交易类型/摘要列（可选，强烈建议提供）",',
    '    "payee": "对方名称列（可选）",',
    '    "counterpartyAccount": "对方账号列（可选）",',
    '    "note": ["备注类列名（可选，最多 8 个）"]',
    '  },',
    '  "amount": 按样本形态三选一：',
    '    {"mode":"dual","incomeCol":"收入列名","expenseCol":"支出列名"}（收入/支出分两列）',
    '    {"mode":"direction","amountCol":"金额列名","directionCol":"收支标记列名","inValues":["收入侧标记值"],"outValues":["支出侧标记值"]}（单金额列+标记列）',
    '    {"mode":"signed","amountCol":"金额列名","negativeIs":"out"}（带符号单列；negativeIs=负数含义，out=支出 in=收入）,',
    '  "dateFormat": "auto|dmy|mdy"（auto=年月日/Excel 序列号；dmy=日/月/年；mdy=月/日/年——看样本值定，默认 auto）,',
    '  "typeRules": [{"match":"类型列子串","kind":"real|transfer|refund|ambiguous"}]（可选，最多 64 条：',
    '    real=对外真实收支；transfer=自有账户互转（还款/理财/转存/提现/充值）；refund=退款；ambiguous=看不出来）,',
    '  "placeholder": "空占位符（如 \\"/\\"，可选）",',
    '  "skipLinePrefixes": ["注释/元数据行的行首前缀（如 \\"#\\"，可选；不得以数字或符号开头）"],',
    '  "delimiter": "CSV 分隔符（\\",\\" \\";\\" \\"\\\\t\\" \\"|\\"，默认逗号；xlsx 忽略）"',
    '}',
    '',
    '规则：',
    '- 列名关键词必须取自样本表头原文（前缀匹配），不要发明不存在的列名。',
    '- 同一标记值不得同时出现在 inValues 与 outValues。',
    '- 语义拿不准就给 ambiguous 或不给规则（引擎会标为待人工确认），不要猜。',
  ].join('\n');
}

export function buildMappingUserPrompt(fileName: string, input: BillInput): string {
  const sample = input.kind === 'csv' ? sampleCsvText(input.text) : sampleMatrix(input.matrix);
  const shape = input.kind === 'csv' ? 'CSV 文本行' : 'xlsx 单元格矩阵（每行一个 JSON 数组，number=原生数值/日期序列号）';
  return `文件名：${fileName}\n样本（${shape}）：\n${sample}`;
}

/**
 * 云认列（调用方已过 开关+Key+逐次确认 三道门）：发样本 → 收 spec → 白名单硬校验 → 本地解析全部行。
 * 失败抛带人话的 Error（JSON 坏 / spec 非法 / 解析 0 行由调用方按 result 判断）。
 */
export async function recognizeWithCloud(cfg: AiConfig, fileName: string, input: BillInput): Promise<RecognizeOutcome> {
  if (!cfg.baseUrl || !cfg.model) throw new Error('AI 服务商配置不完整（缺地址或模型），请到设置页补全。');
  const resp = await llmComplete({
    protocol: cfg.protocol,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: buildMappingSystemPrompt(),
    user: buildMappingUserPrompt(fileName, input),
    maxTokens: 2000,
    temperature: 0,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(resp.text));
  } catch {
    throw new Error('AI 返回的不是有效 JSON 映射，请重试一次。');
  }
  const spec = validateMappedSpec(raw); // 抛「映射 spec 非法：…」
  return { result: parseWith(spec, input), spec, fromMemory: false };
}
