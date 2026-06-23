import { toMinor } from '../money';
import { normalizeDateString, parseAmountCell } from './shared';
import type { DraftSuggestion, Direction, ImportDraftRow, ImportMeta, ImportParseResult } from './types';

/**
 * 支付宝「资金流水（账务组合查询）」CSV 解析器（增量1 第一根进料）。
 *
 * 选型理由（见设计讨论）：资金流水一次导出即涵盖收/支/退款/内部划转，且有「对方名称」「账务类型」
 * 「ISO 日期」「交易号」——分账、去重、内部划转识别所需字段最全。
 *
 * 输入是**已解码的文本**（GB18030 解码由 I/O 边界负责：浏览器 `new TextDecoder('gbk')`、
 * 桌面 Rust 侧解码）。本函数纯逻辑、无 I/O，便于测试与复用。
 *
 * 关键认知：「账务类型」只决定「真实收支 vs 内部划转 vs 退款」；具体是收还是支由「收入/支出」两列定。
 * 例：同为「在线支付」，收款方（收钱码收款）记入账=收入，付款方记出账=支出。
 *
 * 安全基调（红线）：宁可把行标 `unknown`/告警跳过留人工，也绝不静默记错。已知但语义双关的类型
 * （如「转账」可能是转给自己的内部划转）一律保守归 `ambiguous` → 复核台确认。
 */

const SOURCE = 'alipay-fund-flow';

/** 账务类型语义大类。`ambiguous`=已知但自转/他转双关，保守留人工。 */
type TypeKind = 'real' | 'transfer' | 'refund' | 'ambiguous';

/**
 * 支付宝「账务类型」→ 语义大类映射（起步版，随真实账单逐步补厚）。
 * `transfer` = 自有账户间内部划转（理财/余额宝/提现/充值/还款），**不计真实收支**。
 * 未在表中的类型 → `suggestion='unknown'`（红线：不静默记错）。
 */
export const ALIPAY_TYPE_KIND: Readonly<Record<string, TypeKind>> = {
  // 真实收支（收 / 支由「收入/支出」列定）：
  在线支付: 'real',
  消费: 'real',
  快捷支付: 'real',
  扫码付款: 'real',
  生活缴费: 'real',
  缴费: 'real',
  // 自有账户间内部划转（绝不计真实收支）：
  理财申购: 'transfer',
  理财赎回: 'transfer',
  基金申购: 'transfer',
  基金赎回: 'transfer',
  '余额宝-转入': 'transfer',
  '余额宝-转出': 'transfer',
  '余额宝-自动转入': 'transfer',
  '余额宝-自动转出': 'transfer',
  提现: 'transfer',
  提现到银行卡: 'transfer',
  转账到银行卡: 'transfer',
  充值: 'transfer',
  信用卡还款: 'transfer',
  花呗还款: 'transfer',
  // 退款（冲账方向看本行 direction）：
  退款: 'refund',
  // 已知但语义双关（可能转自己=内部划转，也可能转他人=真实收支）→ 保守留人工：
  转账: 'ambiguous',
  红包: 'ambiguous',
};

/** 由「账务类型 + 方向」推出记账建议。未识别或语义双关 → unknown（进复核台人工确认）。 */
export function suggestFromType(accountingType: string, direction: Direction): DraftSuggestion {
  const kind = ALIPAY_TYPE_KIND[accountingType];
  switch (kind) {
    case 'refund':
      return 'refund';
    case 'transfer':
      return direction === 'in' ? 'transfer-in' : 'transfer-out';
    case 'real':
      return direction === 'in' ? 'income' : 'expense';
    default: // 'ambiguous' 或未映射
      return 'unknown';
  }
}

/** 引号感知的 CSV 行切分（RFC4180：支持 "…" 包裹、""转义、字段内逗号）。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 剥除行/文档首的 UTF-8 BOM（U+FEFF）；解码/重存环节易混入，会让首行 `#`/表头失配。 */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 在表头里按「列名前缀」定位列下标（对列顺序/新增列鲁棒）。找不到返回 -1。 */
function findCol(header: string[], prefix: string): number {
  return header.findIndex((c) => c.replace(/\s/g, '').startsWith(prefix));
}

/** 解析 `#` 元数据行（账号 / 查询区间 / 导出时间）。 */
function parseMetaLine(line: string, meta: ImportMeta): void {
  let m = /账号[：:]\s*(.+?)\s*$/.exec(line);
  if (m) {
    meta.account = m[1];
    return;
  }
  m = /起始日期[：:]\s*([\d-]+\s[\d:]+).*?终止日期[：:]\s*([\d-]+\s[\d:]+)/.exec(line);
  if (m) {
    meta.rangeStart = m[1];
    meta.rangeEnd = m[2];
    return;
  }
  m = /导出时间[：:]\s*([\d-]+\s[\d:]+)/.exec(line);
  if (m) meta.exportedAt = m[1];
}

/** 表头列名 → 列下标（按列名定位，对列顺序/新增列鲁棒；缺列为 -1）。 */
interface ColMap {
  date: number;
  bizNo: number;
  type: number;
  income: number;
  expense: number;
  oppName: number;
  oppAccount: number;
  product: number;
  remark: number;
  bizDesc: number;
}

/** 一行 fields 是否像表头：须有三个**独立单元格**分别 startsWith 入账时间/账务类型/支付宝交易号（防含这些词的前言整句被误判）。 */
function looksLikeHeader(fields: string[]): boolean {
  const hasCol = (kw: string) => fields.some((f) => f.replace(/\s/g, '').startsWith(kw));
  return hasCol('入账时间') && hasCol('账务类型') && hasCol('支付宝交易号');
}

/**
 * 解析支付宝资金流水 CSV（已解码文本）→ 标准化草稿行。
 * 流程：剥 BOM → 逐行 → `#` 行抽元数据 → 定位表头 → 数据行映射成 `ImportDraftRow`。
 * 不抛业务异常（坏行进 warnings，绝不静默错位/漏记）；仅当表头缺必需列（格式变更）时抛错。
 */
export function parseAlipayFundFlow(text: string): ImportParseResult {
  const warnings: string[] = [];
  const meta: ImportMeta = { source: SOURCE };
  const rows: ImportDraftRow[] = [];

  let cols: ColMap | null = null;
  let headerLen = 0;

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = stripBom(rawLine);
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      parseMetaLine(line, meta);
      continue;
    }

    const fields = splitCsvLine(line);

    // 尚未定位到表头：寻找含三个签名列的表头行
    if (cols === null) {
      if (looksLikeHeader(fields)) {
        const header = fields.map((f) => f.trim());
        headerLen = header.length;
        const built: ColMap = {
          date: findCol(header, '入账时间'),
          bizNo: findCol(header, '支付宝交易号'),
          type: findCol(header, '账务类型'),
          income: findCol(header, '收入'),
          expense: findCol(header, '支出'),
          oppName: findCol(header, '对方名称'),
          oppAccount: findCol(header, '对方账户'),
          product: findCol(header, '商品名称'),
          remark: findCol(header, '备注'),
          bizDesc: findCol(header, '业务描述'),
        };
        const required: Array<keyof ColMap> = ['date', 'bizNo', 'type', 'income', 'expense'];
        const missing = required.filter((k) => built[k] < 0);
        if (missing.length) {
          throw new Error(`支付宝资金流水缺少必需列：${missing.join(', ')}（导出格式可能已变）`);
        }
        cols = built;
      }
      continue;
    }

    // 列数护栏：字段含未转义逗号会整行错位 → 宁可告警跳过也不静默错位映射
    if (fields.length !== headerLen) {
      warnings.push(`列数与表头不符（${fields.length}≠${headerLen}），疑似字段含逗号，跳过：${line.slice(0, 48)}`);
      continue;
    }

    const get = (i: number): string => (i >= 0 ? (fields[i] ?? '').trim() : '');

    const bizNo = get(cols.bizNo);
    const dt = normalizeDateString(get(cols.date));
    if (!bizNo || !dt) {
      warnings.push(`跳过无交易号 / 日期形态不符的行：${bizNo || line.slice(0, 40)}`);
      continue;
    }

    const incomeVal = parseAmountCell(get(cols.income));
    const expenseVal = parseAmountCell(get(cols.expense));
    if (Number.isNaN(incomeVal) || Number.isNaN(expenseVal)) {
      warnings.push(`收/支金额无法解析，跳过：${bizNo}`);
      continue;
    }

    let direction: Direction;
    let major: number;
    if (incomeVal > 0 && expenseVal === 0) {
      direction = 'in';
      major = incomeVal;
    } else if (expenseVal > 0 && incomeVal === 0) {
      direction = 'out';
      major = expenseVal;
    } else if (incomeVal > 0 && expenseVal > 0) {
      warnings.push(`收支两列同时有值（疑似含手续费 / 冲正），需人工核对，跳过：${bizNo}`);
      continue;
    } else {
      warnings.push(`收支金额全空（可能纯余额调整），跳过：${bizNo}`);
      continue;
    }

    const amountMinor = toMinor(major);
    if (amountMinor <= 0) {
      warnings.push(`金额过小四舍五入为 0，跳过：${bizNo}`);
      continue;
    }

    const accountingType = get(cols.type);
    const suggestion = suggestFromType(accountingType, direction);
    if (suggestion === 'unknown') {
      warnings.push(
        ALIPAY_TYPE_KIND[accountingType] === 'ambiguous'
          ? `「${accountingType}」可能是内部划转或对外收支，待复核台确认收付对象：${bizNo}`
          : `未识别账务类型「${accountingType}」，待复核台确认：${bizNo}`,
      );
    }

    const oppAccount = get(cols.oppAccount);
    const payee = get(cols.oppName) || oppAccount;
    const note = [get(cols.product), get(cols.remark), get(cols.bizDesc)].filter((s) => s !== '').join(' · ');

    rows.push({
      source: SOURCE,
      bizNo,
      date: dt.date,
      datetime: dt.datetime,
      amountMinor,
      direction,
      payee,
      counterpartyAccount: oppAccount || undefined,
      note,
      accountingType,
      suggestion,
    });
  }

  if (cols === null) warnings.push('未找到表头行，未解析出任何数据');
  return { rows, meta, warnings };
}
