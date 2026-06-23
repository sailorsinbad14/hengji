import { toMinor } from '../money';
import { normalizeDateCell, parseAmountCell } from './shared';
import type { DraftSuggestion, Direction, ImportDraftRow, ImportMeta, ImportParseResult } from './types';

/**
 * 微信支付账单（xlsx）解析器（增量1 · 第二根进料）。
 *
 * 微信导出是 .xlsx，故分两段：① xlsx → 单元格矩阵（I/O 边界：浏览器/桌面用 SheetJS-raw，
 * 日期为 Excel 序列号、金额为数值、空占位为 "/"）；② 本函数把矩阵纯函数地映射成 `ImportDraftRow`。
 * 与支付宝解析器产出同一契约，汇入同一复核台。
 *
 * 微信特性：
 * - 「收/支」列直接给 收入 / 支出 / 「/」(中性)。**中性交易=自有账户内部划转**（充值/提现/理财通/
 *   零钱通存取/信用卡还款，微信官方定义），一律记 transfer，绝不计真实收支。
 * - 「/」在非「收/支」列表示空占位，需清成空串。
 * - 「转账」「红包」自他转双关 → unknown 进复核台（红线：不静默记错）。
 */

const SOURCE = 'wechat-bill';

/** 账务（交易类型）语义大类。`ambiguous`=自/他转双关，保守留人工。 */
type TypeKind = 'real' | 'transfer' | 'refund' | 'ambiguous';

/**
 * 微信「交易类型」→ 语义大类（起步版，随真实账单补厚）。
 * 注：中性交易（收/支="/"）无论类型一律按 transfer 处理；本表用于「收入/支出」行的细分。
 */
export const WECHAT_TYPE_KIND: Readonly<Record<string, TypeKind>> = {
  商户消费: 'real',
  扫二维码付款: 'real',
  扫码支付: 'real',
  二维码收款: 'real',
  群收款: 'real',
  零钱提现: 'transfer',
  提现: 'transfer',
  充值: 'transfer',
  '转入零钱通-来自零钱': 'transfer',
  '零钱通转出-到零钱': 'transfer',
  零钱通存入: 'transfer',
  零钱通取出: 'transfer',
  理财通购买: 'transfer',
  理财通赎回: 'transfer',
  信用卡还款: 'transfer',
  转账: 'ambiguous',
  红包: 'ambiguous',
  微信红包: 'ambiguous',
  '微信红包（单发）': 'ambiguous',
};

/** 任意单元格 → 去空白字符串（防御性：boolean/Date/数字/空 都不抛）。 */
function cellStr(c: unknown): string {
  return String(c ?? '').trim();
}

/** 微信用 "/" 作空占位，清成空串（注意：「收/支」列的 "/" 表中性，不走此清洗）。 */
function clean(s: string): string {
  return s === '/' ? '' : s;
}

/** 内部划转的粗略方向 hint（钱是否离开可用余额；复核台最终定 from/to 账户）。 */
function transferDirection(type: string): Direction {
  return /提现|转出|取出|赎回|还款|扣|购买|存入|申购/.test(type) ? 'out' : 'in';
}

/**
 * 由「交易类型 + 收/支」推出方向与记账建议。
 * - 收/支=收入/支出：方向明确，按交易类型细分（transfer/real/refund；双关或未识别→unknown）。
 * - 收/支="/"（微信明确的中性标记）：自有账户内部划转；但真实/双关类型出现在中性列=信号冲突→unknown。
 * - 其余非 收入/支出 的值（空串/污染/列错位）**不猜**，归 unknown 交复核台（红线：绝不把真实收支静默吞成划转）。
 */
export function classifyWechat(type: string, shouZhi: string): { direction: Direction; suggestion: DraftSuggestion } {
  const sz = shouZhi.trim();
  const kind = WECHAT_TYPE_KIND[type];
  if (sz === '收入' || sz === '支出') {
    const direction: Direction = sz === '收入' ? 'in' : 'out';
    switch (kind) {
      case 'transfer':
        return { direction, suggestion: direction === 'in' ? 'transfer-in' : 'transfer-out' };
      case 'real':
        return { direction, suggestion: direction === 'in' ? 'income' : 'expense' };
      case 'refund':
        return { direction, suggestion: 'refund' };
      default: // 'ambiguous' 或未映射
        return { direction, suggestion: 'unknown' };
    }
  }
  if (sz === '/') {
    if (kind === 'real' || kind === 'ambiguous') return { direction: 'out', suggestion: 'unknown' };
    const direction = transferDirection(type);
    return { direction, suggestion: direction === 'in' ? 'transfer-in' : 'transfer-out' };
  }
  return { direction: 'out', suggestion: 'unknown' };
}

/** 表头列名 → 列下标（按列名定位；缺列为 -1）。 */
interface ColMap {
  date: number;
  type: number;
  payee: number;
  product: number;
  shouZhi: number;
  amount: number;
  bizNo: number;
  remark: number;
}

/** 一行是否像表头：须有三个**独立单元格**分别 startsWith 交易时间/交易类型/交易单号（防含这些词的前言整句被误判）。 */
function looksLikeHeader(fields: ReadonlyArray<unknown>): boolean {
  const hasCol = (kw: string) => fields.some((f) => typeof f === 'string' && f.replace(/\s/g, '').startsWith(kw));
  return hasCol('交易时间') && hasCol('交易类型') && hasCol('交易单号');
}

/** 解析元数据行（首列文本：微信昵称 / 起止时间 / 导出时间）。 */
function parseMetaCell(a: string, meta: ImportMeta): void {
  let m = /微信昵称[：:]\s*\[?(.*?)\]?\s*$/.exec(a);
  if (m) {
    meta.account = m[1];
    return;
  }
  m = /起始时间[：:]\s*\[?([\d-]+\s[\d:]+).*?终止时间[：:]\s*\[?([\d-]+\s[\d:]+)/.exec(a);
  if (m) {
    meta.rangeStart = m[1];
    meta.rangeEnd = m[2];
    return;
  }
  m = /导出时间[：:]\s*\[?([\d-]+\s[\d:]+)/.exec(a);
  if (m) meta.exportedAt = m[1];
}

/**
 * 解析微信账单单元格矩阵 → 标准化草稿行。
 * 矩阵由 I/O 边界从 xlsx 抽出（SheetJS raw：日期=序列号、金额=数值、空占位="/"）。
 * 坏行进 warnings（不静默错位/漏记）；仅当表头缺必需列时抛错。
 */
export function parseWechatBill(matrix: ReadonlyArray<ReadonlyArray<unknown>>): ImportParseResult {
  const warnings: string[] = [];
  const meta: ImportMeta = { source: SOURCE };
  const rows: ImportDraftRow[] = [];

  let cols: ColMap | null = null;

  for (const fields of matrix) {
    if (cols === null) {
      if (looksLikeHeader(fields)) {
        const header = fields.map(cellStr);
        const find = (kw: string) => header.findIndex((c) => c.replace(/\s/g, '').startsWith(kw));
        const built: ColMap = {
          date: find('交易时间'),
          type: find('交易类型'),
          payee: find('交易对方'),
          product: find('商品'),
          shouZhi: find('收/支'),
          amount: find('金额'),
          bizNo: find('交易单号'),
          remark: find('备注'),
        };
        const required: Array<keyof ColMap> = ['date', 'type', 'shouZhi', 'amount', 'bizNo'];
        const missing = required.filter((k) => built[k] < 0);
        if (missing.length) {
          throw new Error(`微信账单缺少必需列：${missing.join(', ')}（导出格式可能已变）`);
        }
        cols = built;
      } else {
        const a = cellStr(fields[0]);
        if (a) parseMetaCell(a, meta);
      }
      continue;
    }

    const raw = (i: number): string => cellStr(fields[i]);
    const get = (i: number): string => clean(raw(i));

    // 交易单号被读成数字 = SheetJS 丢精度（28+ 位 ID 须按文本读）→ 不静默坍缩去重键，告警跳过
    if (typeof fields[cols.bizNo] === 'number') {
      warnings.push(`交易单号被读成数字（精度丢失，请按文本导入），跳过：${cellStr(fields[cols.bizNo])}`);
      continue;
    }

    const bizNo = get(cols.bizNo);
    const dt = normalizeDateCell(fields[cols.date]);
    if (!bizNo || !dt) {
      warnings.push(`跳过无交易单号 / 日期形态不符的行：${bizNo || raw(cols.date).slice(0, 24)}`);
      continue;
    }

    const amt = parseAmountCell(fields[cols.amount]);
    if (Number.isNaN(amt)) {
      warnings.push(`金额无法解析，跳过：${bizNo}`);
      continue;
    }
    const amountMinor = toMinor(amt);
    if (amountMinor <= 0) {
      warnings.push(`金额为 0 / 过小四舍五入为 0，跳过：${bizNo}`);
      continue;
    }

    const accountingType = raw(cols.type);
    const shouZhi = raw(cols.shouZhi);
    const { direction, suggestion } = classifyWechat(accountingType, shouZhi);
    if (suggestion === 'unknown') {
      warnings.push(
        WECHAT_TYPE_KIND[accountingType] === 'ambiguous'
          ? `「${accountingType}」可能是内部划转或对外收支，待复核台确认：${bizNo}`
          : `未识别（类型「${accountingType}」/ 收支「${shouZhi}」），待复核台确认：${bizNo}`,
      );
    }

    const note = [get(cols.product), get(cols.remark)].filter((s) => s !== '').join(' · ');

    rows.push({
      source: SOURCE,
      bizNo,
      date: dt.date,
      datetime: dt.datetime,
      amountMinor,
      direction,
      payee: get(cols.payee),
      note,
      accountingType,
      suggestion,
    });
  }

  if (cols === null) warnings.push('未找到表头行，未解析出任何数据');
  return { rows, meta, warnings };
}
