import { describe, expect, it } from "vitest";
import {
  durationOf,
  moveBy,
  resizeEnd,
  resizeStart,
  setDuration,
  setEnd,
  setStart,
} from "./dateLink";
import { isoToDay } from "../gantt/time";

/** 2026-08-03 是周一，用它做基准，周末边界一目了然。 */
const MON = isoToDay("2026-08-03");
const span = (fromIso: string, toIso: string) => ({
  startDay: isoToDay(fromIso),
  endDay: isoToDay(toIso),
});

describe("工期计算", () => {
  it("含首尾两天", () => {
    expect(durationOf(span("2026-08-03", "2026-08-07"))).toBe(5);
    expect(durationOf(span("2026-08-03", "2026-08-03"))).toBe(1);
  });
});

describe("整体平移保持工期", () => {
  it("前后工期不变", () => {
    const s = span("2026-08-03", "2026-08-07");
    const moved = moveBy(s, 3);
    expect(durationOf(moved)).toBe(durationOf(s));
    expect(moved.startDay).toBe(MON + 3);
  });

  it("开启工作日吸附时，落在周六会推到下周一", () => {
    const s = span("2026-08-03", "2026-08-05"); // 周一 ~ 周三
    // +5 天落在周六 8/8
    const moved = moveBy(s, 5, { snapWorkday: true });
    expect(moved.startDay).toBe(isoToDay("2026-08-10")); // 周一
    expect(durationOf(moved)).toBe(3); // 工期仍然保持
  });

  it("不开吸附时绝对服从用户意图，允许排在周末", () => {
    const s = span("2026-08-03", "2026-08-05");
    expect(moveBy(s, 5).startDay).toBe(isoToDay("2026-08-08")); // 周六
  });
});

describe("拖动边缘改工期", () => {
  it("拖左缘保持结束日期", () => {
    const s = span("2026-08-03", "2026-08-07");
    const r = resizeStart(s, MON + 2);
    expect(r.endDay).toBe(s.endDay);
    expect(durationOf(r)).toBe(3);
  });

  it("拖右缘保持开始日期", () => {
    const s = span("2026-08-03", "2026-08-07");
    const r = resizeEnd(s, MON + 9);
    expect(r.startDay).toBe(s.startDay);
    expect(durationOf(r)).toBe(10);
  });

  it("左缘不能越过右缘，工期最小为 1", () => {
    const s = span("2026-08-03", "2026-08-07");
    expect(durationOf(resizeStart(s, MON + 99))).toBe(1);
    expect(durationOf(resizeEnd(s, MON - 99))).toBe(1);
  });
});

describe("表单编辑", () => {
  it("改开始日期保持工期（DESIGN.md §1.6 第 4 行）", () => {
    const s = span("2026-08-03", "2026-08-07"); // 5 天
    const r = setStart(s, isoToDay("2026-08-10"));
    expect(durationOf(r)).toBe(5);
    expect(r.endDay).toBe(isoToDay("2026-08-14"));
  });

  it("改结束日期改工期、不动开始", () => {
    const s = span("2026-08-03", "2026-08-07");
    const r = setEnd(s, isoToDay("2026-08-12"));
    expect(r.startDay).toBe(s.startDay);
    expect(durationOf(r)).toBe(10);
  });

  it("改工期保持开始日期", () => {
    const s = span("2026-08-03", "2026-08-07");
    const r = setDuration(s, 3);
    expect(r.startDay).toBe(s.startDay);
    expect(r.endDay).toBe(isoToDay("2026-08-05"));
  });

  it("工期不接受 0 或负数", () => {
    const s = span("2026-08-03", "2026-08-07");
    expect(durationOf(setDuration(s, 0))).toBe(1);
    expect(durationOf(setDuration(s, -5))).toBe(1);
  });
});
