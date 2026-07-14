const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM' 平移 delta 个月（正负均可、正确跨年，避免负数取模陷阱）。 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return `${ny}-${pad2(nm)}`;
}

/**
 * 月历网格（周一起始，固定 6 行 42 格，避免切月时卡片高度跳动）：
 * 月初前置留白对齐星期，月末补 null 到 42 格。
 */
export function monthGridDates(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const startWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const leading = (startWeekday + 6) % 7; // 转周一=0..周日=6
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array(leading).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${y}-${pad2(m)}-${pad2(d)}`);
  while (cells.length < 42) cells.push(null);
  return cells;
}
