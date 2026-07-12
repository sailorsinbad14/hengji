import type { StoredAccount, StoredTransaction } from '@app/store';
import { currencyDef } from './format';

/**
 * 流水导出（CSV / Markdown）纯函数层。
 *
 * 行分类刻意与 format.ts 的 describeTxn 同一套判定（分类腿=income/expense/equity 取首个、
 * 真实腿=asset/liability、双真实腿=转账/换汇），保证导出与流水页显示口径一致；
 * 改 describeTxn 的分支时这里要同步。
 *
 * 金额列输出「主单位、纯数字、ASCII 负号」——fmtMoney 的排版负号（U+2212）/ 币种符号 /
 * 千分位逗号任何一样混进金额列，Excel 都无法按数值求和。
 */

export interface ExportRow {
  date: string;
  kind: '支出' | '收入' | '期初' | '转账' | '换汇' | '其他';
  /** 分类腿账户名；转账/换汇/兜底为空。 */
  category: string;
  /** 主单位纯数字（ASCII 负号、按币种小数位）；兜底分支（无法单式化）为空串。 */
  amount: string;
  currency: string;
  /** 真实腿账户名；转账/换汇为 “A → B”。 */
  account: string;
  payee: string;
  note: string;
  /** 原始 tags 以 ';' 连接（'business' 即页面上的「生意」chip）。 */
  tags: string;
}

/** 最小单位 → 主单位纯数字串（整数运算，不走浮点/toLocaleString）。 */
export function minorToPlain(minor: number, decimals: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const scale = 10 ** decimals;
  const int = Math.floor(abs / scale);
  if (decimals === 0) return `${sign}${int}`;
  return `${sign}${int}.${String(abs % scale).padStart(decimals, '0')}`;
}

function plain(minor: number, currency: string): string {
  return minorToPlain(minor, currencyDef(currency).decimals);
}

export function buildExportRow(t: StoredTransaction, accounts: Map<string, StoredAccount>): ExportRow {
  const enriched = t.postings.map((p) => ({ p, acc: accounts.get(p.accountId) }));
  const cat = enriched.find(
    (x) => x.acc && (x.acc.type === 'income' || x.acc.type === 'expense' || x.acc.type === 'equity'),
  );
  const real = enriched.filter((x) => x.acc && (x.acc.type === 'asset' || x.acc.type === 'liability'));
  const base = { date: t.date, payee: t.payee, note: t.note, tags: t.tags.join(';') };

  if (cat?.acc?.type === 'expense' && real[0]) {
    return {
      ...base,
      kind: '支出',
      category: cat.acc.name,
      amount: plain(-cat.p.amount, cat.p.currency),
      currency: cat.p.currency,
      account: real[0].acc!.name,
    };
  }
  if (cat?.acc?.type === 'income' && real[0]) {
    return {
      ...base,
      kind: '收入',
      category: cat.acc.name,
      amount: plain(-cat.p.amount, cat.p.currency), // 收入 posting 为负 → 翻正；投资下调（浮亏）为负
      currency: cat.p.currency,
      account: real[0].acc!.name,
    };
  }
  if (cat?.acc?.type === 'equity' && real[0]) {
    return {
      ...base,
      kind: '期初',
      category: cat.acc.name,
      amount: plain(real[0].p.amount, real[0].p.currency),
      currency: real[0].p.currency,
      account: real[0].acc!.name,
    };
  }
  if (real.length === 2) {
    const from = real.find((x) => x.p.amount < 0);
    const to = real.find((x) => x.p.amount > 0);
    if (from && to) {
      const forex = from.p.currency !== to.p.currency;
      return {
        ...base,
        kind: forex ? '换汇' : '转账',
        category: '',
        amount: plain(to.p.amount, to.p.currency), // 金额=到账腿（与页面显示一致）
        currency: to.p.currency,
        // 换汇把转出腿金额带进账户列（页面 sub 同样显示转出额；否则换汇成本在导出里无处可寻）。
        account: forex
          ? `${from.acc!.name}(${plain(from.p.amount, from.p.currency)} ${from.p.currency}) → ${to.acc!.name}`
          : `${from.acc!.name} → ${to.acc!.name}`,
      };
    }
  }
  return { ...base, kind: '其他', category: '', amount: '', currency: '', account: '' };
}

export function buildExportRows(txns: StoredTransaction[], accounts: Map<string, StoredAccount>): ExportRow[] {
  return txns.map((t) => buildExportRow(t, accounts));
}

// ---- CSV ----

const CSV_HEADER = ['日期', '类型', '分类', '金额', '币种', '账户', '对方', '备注', '标签'];

/** RFC 4180：含逗号/引号/换行的字段整体加双引号、内部引号翻倍。 */
function csvQuote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 文本字段（用户可控：来自手输/OCR/导入账单）：先做公式注入防护——以 = + - @ 或制表符开头的值
 * Excel/WPS 会当公式执行（可构造外发数据的 payload），前置单引号让其恒为文本；再走 RFC 4180 转义。
 * 金额列是机器生成的纯数字，不经此函数（负号不能被前缀破坏）。
 */
function csvText(s: string): string {
  return csvQuote(/^[=+\-@\t]/.test(s) ? `'${s}` : s);
}

/** rows → CSV 全文。UTF-8 + BOM（简中 Excel 无 BOM 按 ANSI 解析必乱码）+ CRLF。 */
export function toCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.kind,
        csvText(r.category),
        r.amount, // 机器生成的纯数字（负号不能被注入前缀破坏），恒不过 csvText
        csvText(r.currency), // 币种代码可在设置自定义（无字符白名单），同样防结构破坏/注入
        csvText(r.account),
        csvText(r.payee),
        csvText(r.note),
        csvText(r.tags),
      ].join(','),
    );
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---- Markdown ----

/** 表格单元格：转义管道、换行折为空格。 */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** rows → GFM 表格（金额列右对齐）。定位=粘贴给微信/群/AI，不追求 Excel 兼容。 */
export function toMarkdown(rows: ExportRow[], bookName: string, exportedAt: string): string {
  const head = `# 衡记流水 · ${mdCell(bookName)}\n\n导出于 ${exportedAt} · 共 ${rows.length} 笔\n\n`;
  const th =
    '| 日期 | 类型 | 分类 | 金额 | 币种 | 账户 | 对方 | 备注 | 标签 |\n' +
    '| --- | --- | --- | ---: | --- | --- | --- | --- | --- |\n';
  const body = rows
    .map(
      (r) =>
        `| ${r.date} | ${r.kind} | ${mdCell(r.category)} | ${r.amount} | ${mdCell(r.currency)} | ` +
        `${mdCell(r.account)} | ${mdCell(r.payee)} | ${mdCell(r.note)} | ${mdCell(r.tags)} |`,
    )
    .join('\n');
  return head + th + body + '\n';
}

/** 导出默认文件名（账本名清洗掉 Windows 文件名保留字符）。 */
export function exportFileName(bookName: string, dateISO: string, ext: 'csv' | 'md'): string {
  const safe = bookName.replace(/[\\/:*?"<>|]/g, '_');
  return `衡记流水_${safe}_${dateISO}.${ext}`;
}
