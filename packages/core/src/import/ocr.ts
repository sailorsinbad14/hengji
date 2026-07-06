import { toMinor } from '../money';
import type { Direction, DraftSuggestion, ImportDraftRow, ImportMeta, ImportParseResult } from './types';

/**
 * 本地 OCR 账单解析器（增量2·2a-2）：把 Windows.Media.Ocr 识别出的**词 + 词级边界框**
 * 解析成标准化草稿行，汇入与增量1 同一复核台（`source='ocr'`）。
 *
 * 范式同其它解析器：**纯函数、无 I/O**（WinRT 识别在 desktop Rust 侧 `ocr.rs`，是另一道 I/O 边界）。
 *
 * 本步（2a）只解析**单笔详情截图**（支付/收款详情页 → 一行草稿）。关键认知（见 Spike）：
 * 引擎自带的分行会把列表右列金额拆离原行，所以这里**抛开引擎分行、按 bbox 自建视觉行**
 * （Y 聚行、行内按 X 排序）——这是详情与（后续 2b）列表共用的复用原语。
 *
 * 红线不变：OCR 粗、只起草，**算账 / 落库走确定性引擎、复核台人工逐笔定稿**。金额符号是直接读到的
 * （非按方向兜底），故 `+/−` → income/expense 仅作建议预选，用户在复核台仍逐笔核对。
 * 多笔金额截图（列表 / 含明细的票据）在本步**不硬解析**：识别为多笔则返回 0 行 + 提示走账单文件（2b 再做列表）。
 */

const SOURCE = 'ocr';

/** OCR 识别出的一个词 + 其在图片中的边界框（像素，左上原点）。Rust `ocr_image` 命令的产物之一。 */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一张图片的 OCR 结果（喂给解析器的形态；Rust 侧另含 `text`/`line` 字段，这里用不到）。 */
export interface OcrImage {
  width: number;
  height: number;
  words: OcrWord[];
}

/** 一条 bbox 重建出的「视觉行」：行内词按 X 排序拼出的文本 + 几何。 */
interface VisualLine {
  text: string;
  words: OcrWord[];
  /** 行顶 y（最小）。 */
  y: number;
  /** 行内最大字高（金额是最大字号的关键依据）。 */
  maxH: number;
}

function pad2(s: string): string {
  return s.padStart(2, '0');
}

/** 取中位数（用于行高估计，抗单个超大/超小 token）。 */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * 按 bbox 把词聚成视觉行：词按行顶 y 升序，若其垂直中心与当前行**均值中心**之差 ≤ 容差（0.7×行内中位字高）
 * 则并入，否则起新行。用「均值中心 + 中位字高容差」而非「落入累计 [minY,maxY] 区间」——后者会被行内单个
 * 超大 token 把 maxY 单调撑大、把下一行吸进来（review: groupRows creep）。行内按 X 排序拼文本。
 */
function groupRows(words: OcrWord[]): VisualLine[] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const rows: OcrWord[][] = [];
  let meanCy = 0;
  let tol = 0;
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const cur = rows[rows.length - 1];
    if (cur && Math.abs(cy - meanCy) <= tol) {
      cur.push(w);
      meanCy = cur.reduce((s, x) => s + (x.y + x.h / 2), 0) / cur.length;
      tol = 0.7 * median(cur.map((x) => x.h));
    } else {
      rows.push([w]);
      meanCy = cy;
      tol = 0.7 * w.h;
    }
  }
  return rows.map((row) => {
    const ws = [...row].sort((a, b) => a.x - b.x);
    return {
      text: ws.map((x) => x.text).join(''),
      words: ws,
      y: Math.min(...ws.map((x) => x.y)),
      maxH: Math.max(...ws.map((x) => x.h)),
    };
  });
}

// 符号字符集（单一真源，拼出 MONEY_RE 的符号组与 NEG/POS 测试，杜绝两处漂移）。
// 负号含汉字「一」「减」（OCR 常把「−」读成它们）、各式连字符、Unicode U+2212「−」与 U+2796「➖」。
const NEG = '一\\-–—﹣－减−➖';
const POS = '+＋➕';
const NEG_SIGN = new RegExp(`[${NEG}]`);
const POS_SIGN = new RegExp(`[${POS}]`);
// 金额：左界(?<![\d.,，]) 防从数字/逗号中段重启匹配（否则「1,2345.00」会被前移截成「2345.00」=记成 1/10，
// 且对「12,34.00」等 OCR 误位千分位静默吞高位）；可选符号 + 整数(规整千分位或纯数字) + 小数点(各式) + **两位小数**。
const MONEY_RE = new RegExp(`(?<![\\d.,，])([${NEG}${POS}]?)\\s*(\\d{1,3}(?:[,，]\\d{3})+|\\d+)[.．。·・](\\d{2})(?!\\d)`);

/** 金额解析结果。 */
interface ParsedAmount {
  amountMinor: number;
  direction: Direction;
  /** 是否读到了 +/− 符号（无符号 → 方向只能默认、需复核）。 */
  hasSign: boolean;
}

/** 解析一行里的金额（两位小数）。无匹配 / 值非正 → null。 */
function parseAmount(rawLine: string): ParsedAmount | null {
  const s = rawLine.replace(/[¥￥\s]/g, '');
  const m = MONEY_RE.exec(s);
  if (!m) return null;
  const value = parseFloat(`${m[2]!.replace(/[,，]/g, '')}.${m[3]}`);
  if (!Number.isFinite(value) || value <= 0) return null;
  const amountMinor = toMinor(value);
  if (amountMinor <= 0) return null;
  const sign = m[1] ?? '';
  const hasSign = NEG_SIGN.test(sign) || POS_SIGN.test(sign);
  const direction: Direction = POS_SIGN.test(sign) ? 'in' : 'out'; // 默认出账（详情多为付款）
  return { amountMinor, direction, hasSign };
}

/** 是否像日期/时间行（含冒号或 年/月/日，或 yyyy 形态）——金额检测须先排除它，免把日期里的小数误当金额。 */
function isDateLine(text: string): boolean {
  return /[:：]/.test(text) || /[年月日]/.test(text) || /20\d{2}\D{1,2}\d{1,2}\D{1,2}\d{1,2}/.test(text.replace(/\s/g, ''));
}

/** 从日期行解析出 date/datetime。容忍数字被 OCR 拆开（按 X 已拼接）、全角标点、年月日分隔。失败 null。 */
function parseOcrDate(rawLine: string): { date: string; datetime: string } | null {
  const s = rawLine
    .replace(/\s/g, '')
    .replace(/[年月日]/g, '.')
    .replace(/[．。·・]/g, '.')
    .replace(/：/g, ':');
  const dm = /(20\d{2})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/.exec(s);
  if (!dm) return null;
  const mo = +dm[2]!;
  const day = +dm[3]!;
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  const date = `${dm[1]}-${pad2(dm[2]!)}-${pad2(dm[3]!)}`;
  const tm = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s);
  // 时间须在合法范围，否则（如余额数字+全角冒号被并进行）退回 00:00:00，不照搬 88:88 这种垃圾。
  if (tm && +tm[1]! <= 23 && +tm[2]! <= 59 && (tm[3] === undefined || +tm[3] <= 59)) {
    return { date, datetime: `${date} ${pad2(tm[1]!)}:${pad2(tm[2]!)}:${pad2(tm[3] ?? '00')}` };
  }
  return { date, datetime: `${date} 00:00:00` };
}

/** 详情页页眉等噪声词（不当对方名）。 */
const HEADER_DENY = new Set(['账单详情', '〈账单详情', '账单', '当前状态', '账单管理', '账单服务', '账单分类']);

/** 对方名候选：含中文、非纯数字/标点、非页眉。 */
function isPayeeText(t: string): boolean {
  const s = t.trim();
  if (s.length === 0 || HEADER_DENY.has(s)) return false;
  if (/^[\d\s¥￥.,，:：%+\-–—()（）]+$/.test(s)) return false;
  return /[一-鿿]/.test(s);
}

/** 对方 = 金额行上方最近的一条文本行（详情页商户名通常紧在金额上方）。找不到返回空串。 */
function findPayee(lines: VisualLine[], amountIdx: number): string {
  for (let i = amountIdx - 1; i >= 0; i--) {
    const t = lines[i]!.text.trim();
    if (isPayeeText(t)) return t;
  }
  return '';
}

/** 去重键：优先页面里最长的纯数字串（交易单号，≥12 位）；无则用内容派生（再识别同图可去重）。 */
function findBizNo(lines: VisualLine[], fallback: string): string {
  let best = '';
  for (const ln of lines) {
    for (const w of ln.words) {
      const m = /\d{12,}/.exec(w.text);
      if (m && m[0].length > best.length) best = m[0];
    }
  }
  return best || fallback;
}

/**
 * 解析单笔详情截图 → 草稿行（0 或 1 行）。
 * - 多笔金额（≥3 条且无主导金额，字号相近）→ 视作列表/多笔票据，不硬解析，返回 0 行 + 提示走账单文件导入（2b 再做）。
 * - 无金额 / 非账单图 → 0 行 + 提示。
 */
export function parseOcrBill(image: OcrImage): ImportParseResult {
  const warnings: string[] = [];
  const meta: ImportMeta = { source: SOURCE };
  const lines = groupRows(image.words).sort((a, b) => a.y - b.y);

  // 金额候选行（排除日期行）+ 携带解析结果与下标（避免重复解析、消掉非空断言与 indexOf 反查）。
  const moneyLines = lines.flatMap((line, idx) => {
    if (isDateLine(line.text)) return [];
    const amt = parseAmount(line.text);
    return amt ? [{ line, idx, amt }] : [];
  });
  if (moneyLines.length === 0) {
    warnings.push('未识别出金额，请确认上传的是账单 / 收款详情截图。');
    return { rows: [], meta, warnings };
  }

  // 主金额 = 字号最大的金额行（详情页主金额字号最大）。「主导」= 其字号显著大于次大金额行（≥1.4×）。
  const byHeight = [...moneyLines].sort((a, b) => b.line.maxH - a.line.maxH);
  const top = byHeight[0]!;
  const dominant = byHeight.length < 2 || top.line.maxH >= 1.4 * byHeight[1]!.line.maxH;
  // 多笔判定：≥3 条金额行且**无主导金额**（字号相近）= 列表/多笔票据，本步不硬解析（含主导金额则是「详情 + 小额奖励/优惠」，仍取主金额）。
  if (moneyLines.length >= 3 && !dominant) {
    warnings.push('这张图含多笔金额（像账单列表/明细票据）——单笔详情识别更准。多笔请用「上传账单文件」导入（更准、可去重），列表识别将在后续上线。');
    return { rows: [], meta, warnings };
  }

  const amt = top.amt;
  if (!amt.hasSign) warnings.push('未识别出金额正负号，已默认按支出；若为收入请在复核台改。');

  const dateLine = lines.find((l) => isDateLine(l.text) && parseOcrDate(l.text));
  const dt = dateLine ? parseOcrDate(dateLine.text) : null;
  if (!dt) warnings.push('未识别出日期，请在复核台补填后入账。');

  const payee = findPayee(lines, top.idx);
  // 内容派生去重键用 **datetime（到秒）** 而非仅 date：同图再识别→键相同仍去重；但同日同店同额的两笔真实交易
  // 秒级时间不同→键不同→不会被误判重复而静默吞掉（review: 同日同额碰撞漏单）。
  const bizNo = findBizNo(lines, `ocr:${dt?.datetime ?? ''}:${amt.amountMinor}:${payee}`);

  // 符号是直接读到的（非按方向兜底）→ 作建议预选；无符号则留 unknown 由人工定夺。
  const suggestion: DraftSuggestion = amt.hasSign ? (amt.direction === 'in' ? 'income' : 'expense') : 'unknown';
  warnings.push('OCR 为粗提取，请在复核台逐笔核对金额 / 日期 / 账本后入账。');
  const row: ImportDraftRow = {
    source: SOURCE,
    bizNo,
    date: dt?.date ?? '',
    datetime: dt?.datetime ?? '',
    amountMinor: amt.amountMinor,
    direction: amt.direction,
    payee,
    note: '',
    accountingType: '',
    suggestion,
  };
  return { rows: [row], meta, warnings };
}
