/**
 * 账单导入 · 各解析器共享的纯助手（日期归一、Excel 序列号、金额单元格）。
 * 解析器吃「已解码 / 已抽成单元格」的输入；编码与 xlsx 读取留在 I/O 边界。
 * 单元格可能不是 string|number（xlsx 边界偶发 boolean/Date/空），助手一律防御性处理、绝不抛。
 */

/** 归一化时间戳字符串：接受 - 或 / 分隔日期、空格或 T 分隔时间、单/双位月日、秒可缺。失败返回 null。 */
export function normalizeDateString(s: string): { date: string; datetime: string } | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const pad = (x: string) => x.padStart(2, '0');
  const date = `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  const datetime = `${date} ${pad(m[4]!)}:${m[5]}:${m[6] ?? '00'}`;
  return { date, datetime };
}

/** Date 对象 → 用 UTC 各字段格式化（与 Excel 序列号同口径，避免本地时区漂移）。 */
function formatDate(d: Date): { date: string; datetime: string } | null {
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const datetime = `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { date, datetime };
}

/**
 * Excel 日期序列号（自 1899-12-30 起的天数，含小数=当日时刻）→ 本地 wall-clock。
 * 序列号是无时区的朴素值，用 UTC 取值法还原原始年月日时分秒。
 */
export function excelSerialToDatetime(serial: number): { date: string; datetime: string } | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  return formatDate(new Date(Math.round((serial - 25569) * 86400000))); // 25569 = 1899-12-30 → 1970-01-01
}

/**
 * 任意日期单元格 → 归一化。number=Excel 序列号；Date=对象；string=日期串。
 * **纯数字字符串不当序列号**（真实序列号是 number 类型；数字串多半是错位的单号/金额 → 交 normalizeDateString 判 null 后告警）。
 * 非 string|number|Date（boolean/对象/空）→ null（交上层告警，不抛）。
 */
export function normalizeDateCell(cell: unknown): { date: string; datetime: string } | null {
  if (cell instanceof Date) return formatDate(cell);
  if (typeof cell === 'number') return excelSerialToDatetime(cell);
  if (typeof cell !== 'string') return null;
  const t = cell.trim();
  if (t === '') return null;
  return normalizeDateString(t);
}

/**
 * 金额单元格 → 主单位**绝对值**。
 * 数字 → abs；空 / 单空格字符串 → 0（合法零）；非空但非数字字符串 → `NaN`；
 * 非 string|number（boolean/Date/空）→ `NaN`（交上层告警，不静默当 0、不抛）。
 * 剥 ¥/￥/千分位/空白；取绝对值（列名已隐含方向，负号无意义且不剥会漏单）。
 */
export function parseAmountCell(cell: unknown): number {
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.abs(cell) : NaN;
  if (typeof cell !== 'string') return NaN;
  const t = cell.replace(/[¥￥,\s]/g, '');
  if (t === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.abs(parseFloat(t));
}
