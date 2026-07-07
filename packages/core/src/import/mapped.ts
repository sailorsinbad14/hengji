import { toMinor } from '../money';
import { normalizeDateCell, splitCsvLine, stripBom } from './shared';
import type { DraftSuggestion, Direction, ImportDraftRow, ImportMeta, ImportParseResult } from './types';

/**
 * 声明式「列映射」通用解析器（增量4 · AI 认列的确定性引擎侧）。
 *
 * 陌生银行账单（CSV/xlsx）没有专用解析器时，由云 LLM **只负责**把样本（表头+前若干行）翻译成
 * 一份 `MappedImportSpec`（纯 JSON 数据，经 `validateMappedSpec` 白名单硬校验），本模块再按 spec
 * **确定性地**解析全部行——同一文件同一 spec 永远得到同一结果，可单测、可审计。
 * 红线：LLM 只出映射、不碰数字；未映射的语义一律 unknown 留复核台；解析器**绝不造值**
 * （方向不明→跳过并告警，而不是编一个方向落草稿——假方向会被核销等下游当事实消费）。
 *
 * 列定位用「表头列名前缀」而非死下标，且解析全部角色做唯一性/互斥检查：LLM 幻觉出不存在的
 * 列名得到「未找到表头」、过泛/歧义的列名得到明确报错，而不是错位读数。
 */

/** 固定 source 串（去重键是 (source, biz_no) 复合键，跨导入必须稳定，勿改）。 */
export const MAPPED_SOURCE = 'llm-csv';

/** 与既有解析器一致的语义大类。`ambiguous`=自/他转双关，保守留人工。 */
export type MappedTypeKind = 'real' | 'transfer' | 'refund' | 'ambiguous';

/**
 * 金额表达模式（真实账单的三种形态，spec 三选一）：
 * - `dual`：收入/支出两列，谁有值定方向（支付宝式）；
 * - `direction`：单金额列 + 收/支标记列，标记值集合定方向（微信式）；
 * - `signed`：带符号单金额列，`negativeIs` 声明负数含义（银行流水常见）。
 */
export type MappedAmountSpec =
  | { mode: 'dual'; incomeCol: string; expenseCol: string }
  | { mode: 'direction'; amountCol: string; directionCol: string; inValues: string[]; outValues: string[] }
  | { mode: 'signed'; amountCol: string; negativeIs: Direction };

/**
 * 日期串格式：`auto`=年月日（ISO 含/不含时间、YYYYMMDD、Excel 序列号、Date）；
 * `dmy`/`mdy`=日-月-年 / 月-日-年（银行单常见，两者串形无法自辨，由 LLM 看样本值指定）。
 */
export type MappedDateFormat = 'auto' | 'dmy' | 'mdy';

/** 「类型/摘要」分类规则：`match` 子串命中即取 `kind`（多条异 kind 同时命中＝双关 → unknown）。 */
export interface MappedTypeRule {
  match: string;
  kind: MappedTypeKind;
}

/** LLM 产出的声明式列映射（纯数据；先过 `validateMappedSpec` 再用）。 */
export interface MappedImportSpec {
  version: 1;
  /** 人读来源名（如「招商银行」），仅供展示/批次 label */
  bankName?: string;
  /** 字段 → 表头列名关键词（前缀匹配定位，鲁棒于列顺序/新增列） */
  columns: {
    date: string;
    /** 交易号/流水号列；缺省或值过短（疑似序号列）时引擎按行内容确定性合成去重键 */
    bizNo?: string;
    /** 交易类型/摘要列（typeRules 的匹配对象；缺省则所有行 unknown 待复核） */
    type?: string;
    payee?: string;
    counterpartyAccount?: string;
    /** 备注可由多列合成（join ' · '），最多 8 列 */
    note?: string[];
  };
  amount: MappedAmountSpec;
  dateFormat?: MappedDateFormat;
  /** 类型/摘要 → 语义大类 子串规则（最多 64 条；无命中或多 kind 双关 → unknown） */
  typeRules?: MappedTypeRule[];
  /** 空占位符（如微信式 '/'），命中清成空串 */
  placeholder?: string;
  /** CSV 行首前缀命中即跳过（注释/元数据行，如 '#'；仅对 CSV 文本行生效） */
  skipLinePrefixes?: string[];
  /** CSV 分隔符，默认 ','（xlsx 矩阵输入忽略此字段） */
  delimiter?: ',' | ';' | '\t' | '|';
}

const KEYWORD_MAX = 64;
const DELIMITERS = [',', ';', '\t', '|'] as const;
const TYPE_KINDS: readonly MappedTypeKind[] = ['real', 'transfer', 'refund', 'ambiguous'];
const DATE_FORMATS: readonly MappedDateFormat[] = ['auto', 'dmy', 'mdy'];

function isKeyword(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= KEYWORD_MAX;
}

/**
 * spec 白名单硬校验（LLM 产物不可信：结构错/越界/超限一律拒，报可读原因供上层重试）。
 * 只读已知字段、多余字段忽略；返回**规整后的新对象**（关键词 trim、剔除未知字段）。
 */
export function validateMappedSpec(raw: unknown): MappedImportSpec {
  // 函数声明（非箭头 const）：显式 never 返回才参与 TS 控制流收窄
  function fail(why: string): never {
    throw new Error(`映射 spec 非法：${why}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('必须是 JSON 对象');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) fail('version 必须为 1');

  if (typeof o.columns !== 'object' || o.columns === null || Array.isArray(o.columns)) fail('columns 必须是对象');
  const c = o.columns as Record<string, unknown>;
  if (!isKeyword(c.date)) fail('columns.date 必须是非空列名关键词');
  const optCol = (key: 'bizNo' | 'type' | 'payee' | 'counterpartyAccount'): string | undefined => {
    const v = c[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (!isKeyword(v)) fail(`columns.${key} 必须是列名关键词`);
    return (v as string).trim();
  };
  let note: string[] | undefined;
  if (c.note !== undefined && c.note !== null) {
    if (!Array.isArray(c.note) || c.note.length > 8 || !c.note.every(isKeyword)) {
      fail('columns.note 必须是最多 8 个列名关键词的数组');
    }
    note = (c.note as string[]).map((s) => s.trim());
  }

  if (typeof o.amount !== 'object' || o.amount === null) fail('amount 必须是对象');
  const a = o.amount as Record<string, unknown>;
  let amount: MappedAmountSpec;
  if (a.mode === 'dual') {
    if (!isKeyword(a.incomeCol) || !isKeyword(a.expenseCol)) fail('dual 模式需 incomeCol/expenseCol 列名');
    amount = { mode: 'dual', incomeCol: (a.incomeCol as string).trim(), expenseCol: (a.expenseCol as string).trim() };
  } else if (a.mode === 'direction') {
    if (!isKeyword(a.amountCol) || !isKeyword(a.directionCol)) fail('direction 模式需 amountCol/directionCol 列名');
    const values = (key: 'inValues' | 'outValues'): string[] => {
      const v = a[key];
      if (!Array.isArray(v) || v.length === 0 || v.length > 8 || !v.every(isKeyword)) {
        fail(`direction 模式的 ${key} 必须是 1–8 个非空标记值`);
      }
      return (v as string[]).map((s) => s.trim());
    };
    const inValues = values('inValues');
    const outValues = values('outValues');
    // 同一标记值挂两侧＝双关（如「转账」），解析时会静默偏向 in——必须拒，双关值该留给 unknown 路径
    if (inValues.some((v) => outValues.includes(v))) fail('direction 模式的 inValues/outValues 含相同标记值（双关值不可静默定向）');
    amount = {
      mode: 'direction',
      amountCol: (a.amountCol as string).trim(),
      directionCol: (a.directionCol as string).trim(),
      inValues,
      outValues,
    };
  } else if (a.mode === 'signed') {
    if (!isKeyword(a.amountCol)) fail('signed 模式需 amountCol 列名');
    const neg = a.negativeIs;
    if (neg !== 'in' && neg !== 'out') fail('signed 模式需 negativeIs: in|out');
    amount = { mode: 'signed', amountCol: (a.amountCol as string).trim(), negativeIs: neg };
  } else {
    return fail('amount.mode 必须是 dual|direction|signed');
  }

  let dateFormat: MappedDateFormat = 'auto';
  if (o.dateFormat !== undefined && o.dateFormat !== null) {
    if (!DATE_FORMATS.includes(o.dateFormat as MappedDateFormat)) fail('dateFormat 必须是 auto|dmy|mdy');
    dateFormat = o.dateFormat as MappedDateFormat;
  }

  let typeRules: MappedTypeRule[] | undefined;
  if (o.typeRules !== undefined && o.typeRules !== null) {
    if (!Array.isArray(o.typeRules) || o.typeRules.length > 64) fail('typeRules 最多 64 条规则');
    typeRules = (o.typeRules as unknown[]).map((r) => {
      if (typeof r !== 'object' || r === null) return fail('typeRules 每条须为对象');
      const { match, kind } = r as Record<string, unknown>;
      if (!isKeyword(match)) return fail('typeRules.match 必须是非空子串');
      if (!TYPE_KINDS.includes(kind as MappedTypeKind)) return fail('typeRules.kind 必须是 real|transfer|refund|ambiguous');
      return { match: (match as string).trim(), kind: kind as MappedTypeKind };
    });
  }

  let placeholder: string | undefined;
  if (o.placeholder !== undefined && o.placeholder !== null && o.placeholder !== '') {
    if (typeof o.placeholder !== 'string' || o.placeholder.length > 4) fail('placeholder 须为 ≤4 字符的字符串');
    placeholder = o.placeholder;
  }

  let skipLinePrefixes: string[] | undefined;
  if (o.skipLinePrefixes !== undefined && o.skipLinePrefixes !== null) {
    const v = o.skipLinePrefixes;
    // 数字/符号开头的前缀（'2026-06-'、'-'、'"'、'¥'…）与数据行行首同形，能无声吞掉整段流水——一律拒
    if (!Array.isArray(v) || v.length > 4 || !v.every((p) => typeof p === 'string' && p !== '' && p.length <= 8 && !/^[\d\-+"'¥￥.,;|\t ]/.test(p))) {
      fail('skipLinePrefixes 最多 4 个、每个 ≤8 字符，且不得以数字或金额/分隔符号开头');
    }
    skipLinePrefixes = v as string[];
  }

  let delimiter: MappedImportSpec['delimiter'];
  if (o.delimiter !== undefined && o.delimiter !== null) {
    if (!DELIMITERS.includes(o.delimiter as (typeof DELIMITERS)[number])) fail('delimiter 必须是 , ; \\t | 之一');
    delimiter = o.delimiter as MappedImportSpec['delimiter'];
  }

  return {
    version: 1,
    bankName: isKeyword(o.bankName) ? (o.bankName as string).trim() : undefined,
    columns: {
      date: c.date.trim(),
      bizNo: optCol('bizNo'),
      type: optCol('type'),
      payee: optCol('payee'),
      counterpartyAccount: optCol('counterpartyAccount'),
      note,
    },
    amount,
    dateFormat,
    typeRules,
    placeholder,
    skipLinePrefixes,
    delimiter,
  };
}

/** 与既有解析器同款：按「列名前缀」定位（两侧去空白字符再比）。找不到返回 -1。 */
function findCol(header: string[], keyword: string): number {
  const kw = keyword.replace(/\s/g, '');
  return header.findIndex((cell) => cell.replace(/\s/g, '').startsWith(kw));
}

function cellStr(c: unknown): string {
  return String(c ?? '').trim();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 纯格式组装（合法性交给 checkCalendar 终门统一判）。 */
function buildDate(y: string, mo: string, d: string, hh?: string, mi?: string, ss?: string): { date: string; datetime: string } {
  const date = `${y}-${pad2(parseInt(mo, 10))}-${pad2(parseInt(d, 10))}`;
  return { date, datetime: `${date} ${pad2(hh ? parseInt(hh, 10) : 0)}:${mi ?? '00'}:${ss ?? '00'}` };
}

/**
 * 历法终门：所有成功路径统一过——年 1900–2100、月/日在真实历法上存在（含月长/闰年）、时分秒范围合法。
 * 陌生源+LLM 映射的组合下，'2025-13-45 10:30:00' 这类形状合格的假日期能穿过 staging 的
 * `^\d{4}-\d{2}-\d{2}$` 落库、再从所有月度视图静默消失——这里必须比既有解析器更严。
 */
function checkCalendar(dt: { date: string; datetime: string } | null): { date: string; datetime: string } | null {
  if (!dt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dt.datetime);
  if (!m) return null;
  const [Y, M, D, H, Mi, S] = [1, 2, 3, 4, 5, 6].map((i) => parseInt(m[i]!, 10)) as [number, number, number, number, number, number];
  if (Y < 1900 || Y > 2100 || H > 23 || Mi > 59 || S > 59) return null;
  const rt = new Date(Date.UTC(Y, M - 1, D));
  if (rt.getUTCFullYear() !== Y || rt.getUTCMonth() !== M - 1 || rt.getUTCDate() !== D) return null;
  return dt;
}

/**
 * 陌生源日期归一：
 * - number：落在 19000101–21001231 的 8 位整数按 `YYYYMMDD` 解（真实序列号不会到千万级，两域不重叠）；
 *   其余走 Excel 序列号，但设 20000（≈1954 年）地板——序号/期数/年份等小整数会被解成 1900 年段
 *   「历法合法」日期且窄带数值连跨度告警都不触发，真实账单序列号 ≥ ~33000（1990 年）。
 * - Date：直接取（UTC 口径）。
 * - 字符串 `dmy`/`mdy`：`D-M-YYYY` / `M-D-YYYY`（-/. 或 / 分隔，时间可缺）；
 * - 字符串 `auto`：ISO±时间（**全串锚定**，'…Z'/'…PM' 等尾缀直接拒——shared 的宽松正则会静默丢
 *   尾缀导致跨天/差 12 小时）→ 纯日期 `YYYY-M-D` → 8 位 `YYYYMMDD`。
 * 纯日期的 datetime 补 `00:00:00`。全部过 `checkCalendar` 历法终门。失败 null（上层告警跳过，不落错日期）。
 */
export function normalizeMappedDate(cell: unknown, format: MappedDateFormat): { date: string; datetime: string } | null {
  return checkCalendar(rawMappedDate(cell, format));
}

function rawMappedDate(cell: unknown, format: MappedDateFormat): { date: string; datetime: string } | null {
  if (typeof cell === 'number') {
    if (Number.isInteger(cell) && cell >= 19000101 && cell <= 21001231) {
      const s = String(cell);
      return buildDate(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8));
    }
    if (cell < 20000) return null;
    return normalizeDateCell(cell);
  }
  if (cell instanceof Date) return normalizeDateCell(cell);
  if (typeof cell !== 'string') return null;
  const t = cell.trim();
  if (t === '') return null;

  if (format === 'dmy' || format === 'mdy') {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    if (!m) return null;
    const [d, mo] = format === 'dmy' ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    return buildDate(m[3]!, mo, d, m[4], m[5], m[6]);
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return buildDate(m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]);
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return buildDate(m[1]!, m[2]!, m[3]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return buildDate(m[1]!, m[2]!, m[3]!);
  return null;
}

/**
 * 金额单元格（mapped 专用、**保留符号**，比 shared.parseAmountCell 严）：千分位逗号必须成组
 * （如 1,234.56），否则拒——欧式「小数逗号」（12,34）被静默剥掉＝金额 ×100 的静默错账
 * （delimiter ';' 正是为欧式 CSV 开的门，两者常伴生）。
 */
function mappedAmountCell(cell: unknown): number {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : NaN;
  if (typeof cell !== 'string') return NaN;
  let t = cell.replace(/[¥￥\s]/g, '');
  if (t === '') return 0;
  if (t.includes(',')) {
    if (!/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return NaN;
    t = t.replace(/,/g, '');
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return NaN;
  return parseFloat(t);
}

function suggestFrom(kind: MappedTypeKind | undefined, direction: Direction): DraftSuggestion {
  switch (kind) {
    case 'refund':
      return 'refund';
    case 'transfer':
      return direction === 'in' ? 'transfer-in' : 'transfer-out';
    case 'real':
      return direction === 'in' ? 'income' : 'expense';
    default:
      return 'unknown'; // 'ambiguous' 或无命中规则：不猜，留复核台
  }
}

interface ResolvedCols {
  date: number;
  bizNo: number;
  type: number;
  payee: number;
  cpAccount: number;
  note: number[];
  income: number;
  expense: number;
  amount: number;
  direction: number;
}

/** 表头是否命中：全部**必需**列关键词都各自命中独立单元格（防含关键词的前言整句误判）。 */
function requiredKeywords(spec: MappedImportSpec): string[] {
  const a = spec.amount;
  const cols =
    a.mode === 'dual' ? [a.incomeCol, a.expenseCol] : a.mode === 'direction' ? [a.amountCol, a.directionCol] : [a.amountCol];
  return [spec.columns.date, ...cols];
}

/**
 * 解析全部列并做两道互斥检查（err 非空＝该 spec 对此表头不可安全解析，只对真表头抛）：
 * ① 关键词命中多列＝歧义（首个静默生效会错位读数）；② 任意两个角色命中同一列＝冲突
 * （bizNo 撞列→去重键重复吞真交易；type 撞金额列→本应 unknown 的行获得假分类；一律拒）。
 */
function resolveColsStrict(header: string[], spec: MappedImportSpec): { cols: ResolvedCols; err: string | null } {
  const c = spec.columns;
  const a = spec.amount;
  const taken = new Map<number, string>();
  let err: string | null = null;
  const place = (role: string, kw: string | undefined): number => {
    if (!kw) return -1;
    const k = kw.replace(/\s/g, '');
    const hits: number[] = [];
    header.forEach((cell, i) => {
      if (cell.replace(/\s/g, '').startsWith(k)) hits.push(i);
    });
    if (hits.length === 0) return -1;
    if (!err && hits.length > 1) err = `关键词「${kw}」命中多列（第 ${hits.map((i) => i + 1).join('、')} 列），请用更精确的列名`;
    const idx = hits[0]!;
    const prev = taken.get(idx);
    if (!err && prev) err = `${prev} 与 ${role} 命中同一列`;
    taken.set(idx, role);
    return idx;
  };
  const cols: ResolvedCols = {
    date: place('date', c.date),
    income: a.mode === 'dual' ? place('incomeCol', a.incomeCol) : -1,
    expense: a.mode === 'dual' ? place('expenseCol', a.expenseCol) : -1,
    amount: a.mode !== 'dual' ? place('amountCol', a.amountCol) : -1,
    direction: a.mode === 'direction' ? place('directionCol', a.directionCol) : -1,
    bizNo: place('bizNo', c.bizNo),
    type: place('type', c.type),
    payee: place('payee', c.payee),
    cpAccount: place('counterpartyAccount', c.counterpartyAccount),
    note: (c.note ?? []).map((kw, i) => place(`note[${i}]`, kw)).filter((i) => i >= 0),
  };
  return { cols, err };
}

/** FNV-1a 32 位（确定性、无依赖）：表头指纹 + 行内容哈希，用于合成去重键。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 按已校验 spec 解析单元格矩阵 → 标准化草稿行（xlsx 路径直接用；CSV 走 `parseMappedCsv`）。
 * 坏行进 warnings（绝不静默错位/漏记）；未映射语义合计成单条告警（避免银行摘要自由文本刷屏）。
 */
export function parseMappedMatrix(matrix: ReadonlyArray<ReadonlyArray<unknown>>, rawSpec: MappedImportSpec, opts?: { strictRowLen?: boolean }): ImportParseResult {
  const spec = validateMappedSpec(rawSpec); // 纵深防御：入口再验一次，坏 spec 不进解析循环
  const warnings: string[] = [];
  const meta: ImportMeta = { source: MAPPED_SOURCE };
  const rows: ImportDraftRow[] = [];

  const required = requiredKeywords(spec);
  const fmt = spec.dateFormat ?? 'auto';
  let cols: ResolvedCols | null = null;
  let headerLen = 0;
  let headerFp = '';
  let unknownTypeCount = 0;
  let multiKindCount = 0;
  let dirUnmatchedCount = 0;
  let providedDupCount = 0;
  let weakRefCount = 0;
  let swapHintCount = 0;
  const keySeen = new Map<string, number>();

  const clean = (s: string): string => (spec.placeholder !== undefined && s === spec.placeholder ? '' : s);

  for (const fields of matrix) {
    if (cols === null) {
      const header = fields.map(cellStr);
      if (required.every((kw) => findCol(header, kw) >= 0)) {
        const { cols: cand, err } = resolveColsStrict(header, spec);
        // 值形关键词（如 '2026'、'5'）可让数据行被误认成表头整行吃掉：真表头的日期格是列名、
        // 解不出合法日期——解得出的候选行一律视为数据行跳过（最终走「未找到表头」而非静默吞首行）
        if (normalizeMappedDate(fields[cand.date], fmt) !== null) continue;
        if (err) throw new Error(`映射 spec 列冲突：${err}，请修正列名关键词`);
        cols = cand;
        headerLen = fields.length;
        headerFp = fnv1a(header.join('\u0001'));
      }
      continue;
    }

    if (opts?.strictRowLen && fields.length !== headerLen) {
      warnings.push(`列数与表头不符（${fields.length}≠${headerLen}），疑似字段含分隔符，跳过：${cellStr(fields[0]).slice(0, 32)}`);
      continue;
    }

    const raw = (i: number): string => (i >= 0 ? cellStr(fields[i]) : '');
    const get = (i: number): string => clean(raw(i));
    const amtRaw = (i: number): unknown => {
      const c = fields[i];
      return typeof c === 'string' && clean(c.trim()) === '' ? '' : c;
    };

    const dt = normalizeMappedDate(fields[cols.date], fmt);
    if (!dt) {
      // dmy/mdy 声明反了的强信号：本格式非法但月日互换后合法（day>12 的行才会暴露）
      if ((fmt === 'dmy' || fmt === 'mdy') && normalizeMappedDate(fields[cols.date], fmt === 'dmy' ? 'mdy' : 'dmy') !== null) swapHintCount++;
      warnings.push(`日期无法识别，跳过：${raw(cols.date).slice(0, 24) || '(空)'}`);
      continue;
    }

    let direction: Direction;
    let major: number;
    const a = spec.amount;
    if (a.mode === 'dual') {
      const incomeVal = mappedAmountCell(amtRaw(cols.income));
      const expenseVal = mappedAmountCell(amtRaw(cols.expense));
      if (Number.isNaN(incomeVal) || Number.isNaN(expenseVal)) {
        warnings.push(`收/支金额无法解析，跳过：${dt.datetime}`);
        continue;
      }
      // 收/支列出现负数＝列语义与符号冲突（银行冲正/退货常态），abs 会把资金流入记成支出——不猜，人工核对
      if (incomeVal < 0 || expenseVal < 0) {
        warnings.push(`收/支列出现负数（疑似冲正/退货），需人工核对，跳过：${dt.datetime}`);
        continue;
      }
      if (incomeVal > 0 && expenseVal === 0) {
        direction = 'in';
        major = incomeVal;
      } else if (expenseVal > 0 && incomeVal === 0) {
        direction = 'out';
        major = expenseVal;
      } else if (incomeVal > 0 && expenseVal > 0) {
        warnings.push(`收支两列同时有值（疑似含手续费/冲正），需人工核对，跳过：${dt.datetime}`);
        continue;
      } else {
        warnings.push(`收支金额全空（可能纯余额调整），跳过：${dt.datetime}`);
        continue;
      }
    } else if (a.mode === 'direction') {
      const amt = mappedAmountCell(amtRaw(cols.amount));
      if (Number.isNaN(amt)) {
        warnings.push(`金额无法解析，跳过：${dt.datetime}`);
        continue;
      }
      if (amt < 0) {
        warnings.push(`方向由标记列决定但金额为负（信号冲突），需人工核对，跳过：${dt.datetime}`);
        continue;
      }
      major = amt;
      const dirCell = raw(cols.direction);
      if (a.inValues.includes(dirCell)) direction = 'in';
      else if (a.outValues.includes(dirCell)) direction = 'out';
      else {
        // 标记不认识＝方向未知。绝不造方向落草稿：假 direction 会被核销出口等下游当事实消费（红线）
        dirUnmatchedCount++;
        continue;
      }
    } else {
      const val = mappedAmountCell(amtRaw(cols.amount));
      if (Number.isNaN(val)) {
        warnings.push(`金额无法解析，跳过：${dt.datetime}`);
        continue;
      }
      direction = val < 0 ? a.negativeIs : a.negativeIs === 'out' ? 'in' : 'out';
      major = Math.abs(val);
    }

    const amountMinor = toMinor(major);
    if (amountMinor <= 0) {
      warnings.push(`金额为 0 / 过小四舍五入为 0，跳过：${dt.datetime}`);
      continue;
    }

    const accountingType = get(cols.type);
    let suggestion: DraftSuggestion;
    if (cols.type < 0) {
      suggestion = 'unknown'; // 无类型列：一律待复核（汇总告警一次，见循环外）
    } else {
      const hits = (spec.typeRules ?? []).filter((r) => accountingType.includes(r.match));
      const kinds = new Set(hits.map((r) => r.kind));
      if (kinds.size > 1) {
        // 多条不同大类规则同时命中（如「退还款项」命中 还款→transfer 与 退还→refund）＝双关，不按顺序静默裁决
        suggestion = 'unknown';
        multiKindCount++;
      } else {
        suggestion = suggestFrom(hits[0]?.kind, direction);
        if (suggestion === 'unknown') unknownTypeCount++;
      }
    }

    const cpAccount = get(cols.cpAccount);
    const payee = get(cols.payee) || cpAccount;
    const note = cols.note
      .map((i) => get(i))
      .filter((s) => s !== '')
      .join(' · ');

    // 去重键（(source,biz_no) 复合键跨导入判「已导入」，键错=吞真交易，此处最谨慎）：
    // - 交易号列的值仅在「像真流水号」（≥8 字符）时采用——短号（每次导出重新计数的「序号」列）
    //   会让下月文件被整批误判已导入；数字型单元格＝精度已丢，同样不用。
    // - 否则合成内容寻址键：表头指纹（区分不同银行版式）+ 原始整行哈希——只含单元格原文、
    //   不含任何 spec 派生值，修 spec 重导时键不漂移；备注/对方账号不同的行天然不同键。
    //   字节相同的行追加序号消歧（它们本就不可区分，次序无关紧要）。
    // - 消歧分隔符用 \u0001（单元格里不会出现），杜绝与内容自带的 '#2' 之类字面相撞。
    const providedRaw = typeof fields[cols.bizNo] === 'number' ? '' : get(cols.bizNo);
    let provided = providedRaw;
    if (provided !== '' && provided.length < 8) {
      weakRefCount++;
      provided = '';
    }
    const base = provided || `syn:${headerFp}:${fnv1a(fields.map(cellStr).join('\u0001'))}`;
    const n = (keySeen.get(base) ?? 0) + 1;
    keySeen.set(base, n);
    if (n > 1 && provided) providedDupCount++;
    const bizNo = n === 1 ? base : `${base}\u0001${n}`;

    rows.push({
      source: MAPPED_SOURCE,
      bizNo,
      date: dt.date,
      datetime: dt.datetime,
      amountMinor,
      direction,
      payee,
      counterpartyAccount: cpAccount || undefined,
      note,
      accountingType,
      suggestion,
    });
  }

  if (cols === null) warnings.push('未找到表头行，未解析出任何数据（映射的列名可能与账单不符）');
  if (spec.columns.type === undefined && rows.length > 0) warnings.push('映射未提供类型/摘要列，全部行需在复核台人工确认类型');
  if (unknownTypeCount > 0) warnings.push(`${unknownTypeCount} 行类型/摘要未命中映射规则，待复核台确认`);
  if (multiKindCount > 0) warnings.push(`${multiKindCount} 行摘要同时命中多种类型规则（双关），待复核台确认`);
  if (dirUnmatchedCount > 0) warnings.push(`${dirUnmatchedCount} 行收支标记未识别（可能是中性划转或标记值缺漏），已跳过——请补全 inValues/outValues 后重新导入`);
  if (providedDupCount > 0) warnings.push(`${providedDupCount} 行交易号与文件内其它行重号，已追加序号消歧，请核对是否重复导出`);
  if (weakRefCount > 0) warnings.push(`${weakRefCount} 行交易号过短（疑似每次导出重新计数的序号列），已改用行内容合成去重键`);
  if (swapHintCount > 0) warnings.push(`${swapHintCount} 行日期在声明的格式下非法、但按月日互换后合法——dateFormat 可能声明反了，请核对已解析行的月份`);
  // 日期跨度异常 = 日期列大概率映射错（如命中余额列被当 Excel 序列号解出横跨几十年的「合法」日期）
  if (rows.length >= 2) {
    const years = rows.map((r) => parseInt(r.date.slice(0, 4), 10));
    const span = Math.max(...years) - Math.min(...years);
    if (span > 20) warnings.push(`解析出的日期跨度达 ${span} 年，映射的日期列可能不对，请逐行核对日期`);
  }
  return { rows, meta, warnings };
}

/** 按已校验 spec 解析 CSV **已解码文本**（编码留 I/O 边界）→ 标准化草稿行。 */
export function parseMappedCsv(text: string, rawSpec: MappedImportSpec): ImportParseResult {
  const spec = validateMappedSpec(rawSpec);
  const skip = spec.skipLinePrefixes ?? [];
  const matrix: string[][] = [];
  let skipped = 0;
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = stripBom(rawLine);
    if (line.trim() === '') continue;
    if (skip.some((p) => line.startsWith(p))) {
      skipped++;
      continue;
    }
    matrix.push(splitCsvLine(line, spec.delimiter ?? ','));
  }
  const res = parseMappedMatrix(matrix, spec, { strictRowLen: true });
  // 前缀跳过必须可见：投毒/误配的前缀会无声吞数据行，计数亮出来供人核对
  if (skipped > 0) res.warnings.push(`${skipped} 行命中行首前缀（注释/元数据），未参与解析`);
  return res;
}
