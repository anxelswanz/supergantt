import { describe, expect, it } from "vitest";
import { formatRange, wholeMonths, wholeYears } from "./RangeFilter";
import { isoToDay } from "../gantt/time";

const r = (from: string, to: string) => ({ from: isoToDay(from), to: isoToDay(to) });

describe("按月、按年的区间", () => {
  it("整月：月初到月末，闰年二月也认", () => {
    expect(wholeMonths(r("2028-02-01", "2028-02-29"))).not.toBeNull();
    expect(wholeMonths(r("2026-10-01", "2026-10-30"))).toBeNull();
  });

  it("整年：1 月 1 日到 12 月 31 日", () => {
    expect(wholeYears(r("2024-01-01", "2025-12-31"))).toEqual({ from: 2024, to: 2025 });
    expect(wholeYears(r("2024-01-01", "2024-11-30"))).toBeNull();
  });

  it("显示成人话", () => {
    expect(formatRange(r("2024-01-01", "2024-12-31"))).toBe("2024 年");
    expect(formatRange(r("2023-01-01", "2024-12-31"))).toBe("2023–2024 年");
    expect(formatRange(r("2024-03-01", "2024-05-31"))).toBe("2024 年 3–5 月");
    expect(formatRange(r("2024-11-01", "2025-02-28"))).toBe("2024-11 – 2025-02");
  });
});
