import { describe, expect, it } from "vitest";
import { parseDate } from "./DatePicker";
import { dayToIso, isoToDay } from "../gantt/time";

/** 日期输入框要宽容 —— 但不能宽容到把非法日期悄悄接受。 */
describe("日期解析", () => {
  it("接受多种分隔符与紧凑写法", () => {
    const target = isoToDay("2026-08-20");
    for (const text of ["2026-08-20", "2026/8/20", "2026.8.20", "20260820", " 2026-8-20 "]) {
      expect(parseDate(text)).toBe(target);
    }
  });

  it("只写月日时补当年", () => {
    const year = new Date().getFullYear();
    expect(parseDate("8-20")).toBe(isoToDay(`${year}-08-20`));
  });

  it("拒绝越界日期，不静默进位", () => {
    // Date.UTC 会把 2026-13-01 悄悄变成 2027-01-01，必须挡掉
    for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10", "abc", "", "2026"]) {
      expect(parseDate(bad)).toBe(null);
    }
  });

  it("解析结果能原样往返", () => {
    const day = parseDate("2026-12-31")!;
    expect(dayToIso(day)).toBe("2026-12-31");
  });
});
