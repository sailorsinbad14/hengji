import { describe, it, expect } from 'vitest';
import { monthGridDates, shiftMonth } from '../src/calendar';

describe('shiftMonth', () => {
  it('同年内平移', () => {
    expect(shiftMonth('2026-07', 1)).toBe('2026-08');
  });

  it('跨年：负偏移', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('跨年：正偏移', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('多年负偏移（避免负数取模陷阱）', () => {
    expect(shiftMonth('2026-07', -13)).toBe('2025-06');
  });
});

describe('monthGridDates', () => {
  it('固定 42 格', () => {
    expect(monthGridDates('2026-07').length).toBe(42);
    expect(monthGridDates('2024-02').length).toBe(42);
  });

  it('2026-07（周三开头）：留白 2 格 + 31 个日期格', () => {
    const cells = monthGridDates('2026-07');
    expect(cells.slice(0, 2)).toEqual([null, null]);
    expect(cells[2]).toBe('2026-07-01');
    expect(cells[32]).toBe('2026-07-31');
    expect(cells.filter((c) => c !== null).length).toBe(31);
  });

  it('闰年 2 月 29 天', () => {
    const cells = monthGridDates('2024-02');
    expect(cells.filter((c) => c !== null).length).toBe(29);
    expect(cells.includes('2024-02-29')).toBe(true);
  });

  it('非闰年 2 月 28 天', () => {
    const cells = monthGridDates('2023-02');
    expect(cells.filter((c) => c !== null).length).toBe(28);
    expect(cells.includes('2023-02-29')).toBe(false);
  });
});
