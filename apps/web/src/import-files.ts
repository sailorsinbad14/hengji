import { parseAlipayFundFlow, parseWechatBill } from '@app/core';
import type { ImportParseResult } from '@app/core';

/**
 * 账单文件解析的 I/O 边界（增量1·②b）：把上传的文件读成解析器吃的形态——
 * 支付宝 CSV 走 GB18030 解码、微信 xlsx 走 SheetJS 抽单元格矩阵——再交 core 纯解析器。
 * 编码/xlsx 读取这些环境相关的脏活留在这里；解析逻辑全在 core（已单测）。
 */

export type ImportSource = 'alipay-fund-flow' | 'wechat-bill';

export const SOURCE_LABELS: Record<ImportSource, string> = {
  'alipay-fund-flow': '支付宝 · 资金流水（CSV）',
  'wechat-bill': '微信 · 账单（xlsx）',
};

/** 支付宝资金流水 CSV：GB18030 解码 → 纯解析器。 */
async function parseAlipay(file: File): Promise<ImportParseResult> {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder('gb18030').decode(buf);
  return parseAlipayFundFlow(text);
}

/** 微信账单 xlsx：SheetJS 抽成单元格矩阵（raw：日期=Excel 序列号、金额=数值、空="/"）→ 纯解析器。 */
async function parseWechat(file: File): Promise<ImportParseResult> {
  // 动态加载：SheetJS（~700KB）仅微信导入用得到，拆成独立异步 chunk，主包不背它。
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) throw new Error('xlsx 无可读工作表');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '/' });
  return parseWechatBill(matrix);
}

export function parseImportFile(source: ImportSource, file: File): Promise<ImportParseResult> {
  return source === 'alipay-fund-flow' ? parseAlipay(file) : parseWechat(file);
}
