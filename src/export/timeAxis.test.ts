import { describe, expect, it } from "vitest";
import { barCells, buildBuckets, flatten, pickUnit } from "./timeAxis";
import { isoToDay } from "../gantt/time";

const never = () => false;

describe("pickUnit", () => {
  it("按跨度降档，保证列数不失控", () => {
    expect(pickUnit(30)).toBe("day");
    expect(pickUnit(120)).toBe("day");
    expect(pickUnit(121)).toBe("week");
    expect(pickUnit(630)).toBe("week");
    expect(pickUnit(631)).toBe("month");
    expect(pickUnit(3650)).toBe("month");
  });
});

describe("buildBuckets", () => {
  it("日粒度一天一桶，并标出非工作日", () => {
    const from = isoToDay("2026-08-07"); // 周五
    const buckets = buildBuckets(from, from + 3, "day", (d) => d >= from + 1 && d <= from + 2);

    expect(buckets).toHaveLength(4);
    expect(buckets.map((b) => b.label)).toEqual(["7", "8", "9", "10"]);
    expect(buckets.map((b) => b.rest)).toEqual([false, true, true, false]);
    expect(buckets[0].group).toBe("2026年8月");
  });

  it("跨月时 group 跟着换，供上行合并单元格用", () => {
    const from = isoToDay("2026-08-30");
    const buckets = buildBuckets(from, from + 3, "day", never);
    expect(buckets.map((b) => b.group)).toEqual([
      "2026年8月",
      "2026年8月",
      "2026年9月",
      "2026年9月",
    ]);
  });

  it("周粒度向前对齐到周一 —— 每列宽度含义必须一致", () => {
    const wed = isoToDay("2026-08-05"); // 周三
    const buckets = buildBuckets(wed, wed + 13, "week", never);

    expect(buckets[0].startDay).toBe(isoToDay("2026-08-03")); // 回退到周一
    expect(buckets[0].endDay).toBe(isoToDay("2026-08-09"));
    for (const b of buckets) expect(b.endDay - b.startDay).toBe(6);
    expect(buckets.map((b) => b.label)).toEqual(["8/3", "8/10", "8/17"]);
  });

  it("周粒度跨周日不会漏桶（0=周日的回退方向）", () => {
    const sun = isoToDay("2026-08-09"); // 周日
    const buckets = buildBuckets(sun, sun, "week", never);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].startDay).toBe(isoToDay("2026-08-03"));
  });

  it("月粒度按真实月长切桶，覆盖闰年二月", () => {
    const from = isoToDay("2024-01-15");
    const buckets = buildBuckets(from, isoToDay("2024-04-02"), "month", never);

    expect(buckets.map((b) => b.label)).toEqual(["1月", "2月", "3月", "4月"]);
    expect(buckets[0].startDay).toBe(isoToDay("2024-01-01"));
    expect(buckets[1].endDay - buckets[1].startDay + 1).toBe(29); // 2024 是闰年
    expect(buckets[2].startDay).toBe(isoToDay("2024-03-01"));
    expect(buckets[0].group).toBe("2024年");
  });

  it("空区间返回空数组，不抛异常", () => {
    expect(buildBuckets(100, 99, "day", never)).toEqual([]);
  });
});

describe("barCells", () => {
  const dayBuckets = (from: number, count: number) =>
    buildBuckets(from, from + count - 1, "day", never);

  it("60% 进度在 10 天的条子上正好填 6 格", () => {
    const buckets = dayBuckets(0, 12);
    const kinds = barCells(
      { startDay: 0, endDay: 9, progress: 0.6, milestone: false },
      buckets,
    );
    expect(kinds).toEqual([
      "fill", "fill", "fill", "fill", "fill", "fill",
      "track", "track", "track", "track",
      "none", "none",
    ]);
  });

  it("0% 全轨道，100% 全实心 —— 两端不能有半格误差", () => {
    const buckets = dayBuckets(0, 5);
    expect(
      barCells({ startDay: 0, endDay: 4, progress: 0, milestone: false }, buckets),
    ).toEqual(["track", "track", "track", "track", "track"]);
    expect(
      barCells({ startDay: 0, endDay: 4, progress: 1, milestone: false }, buckets),
    ).toEqual(["fill", "fill", "fill", "fill", "fill"]);
  });

  it("条子完全落在轴外时不画任何格子", () => {
    const buckets = dayBuckets(100, 5);
    expect(
      barCells({ startDay: 0, endDay: 9, progress: 0.5, milestone: false }, buckets),
    ).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("单天任务占且只占一格", () => {
    const buckets = dayBuckets(0, 4);
    expect(
      barCells({ startDay: 2, endDay: 2, progress: 1, milestone: false }, buckets),
    ).toEqual(["none", "none", "fill", "none"]);
  });

  /**
   * 这条挡的是「拿整桶中点去比进度边界」的写法：条子只占某月最后几天时，
   * 整月中点远在条子之前，会把一根 100% 完成的条子整根判成未开始。
   */
  it("粗粒度下只占桶尾几天的条子仍按自身进度着色", () => {
    const jan = isoToDay("2026-01-01");
    const buckets = buildBuckets(jan, isoToDay("2026-02-28"), "month", never);
    const kinds = barCells(
      {
        startDay: isoToDay("2026-01-29"),
        endDay: isoToDay("2026-01-31"),
        progress: 1,
        milestone: false,
      },
      buckets,
    );
    expect(kinds).toEqual(["fill", "none"]);
  });

  it("跨桶的条子按交集判定，不会整桶一刀切", () => {
    const jan = isoToDay("2026-01-01");
    const buckets = buildBuckets(jan, isoToDay("2026-03-31"), "month", never);
    // 1/1 – 3/31 共 90 天，进度 1/3 ≈ 正好第一个月
    const kinds = barCells(
      {
        startDay: jan,
        endDay: isoToDay("2026-03-31"),
        progress: 1 / 3,
        milestone: false,
      },
      buckets,
    );
    expect(kinds).toEqual(["fill", "track", "track"]);
  });

  it("里程碑只点亮所在的一格，不受进度影响", () => {
    const buckets = dayBuckets(0, 6);
    expect(
      barCells({ startDay: 3, endDay: 3, progress: 0, milestone: true }, buckets),
    ).toEqual(["none", "none", "none", "milestone", "none", "none"]);
  });

  it("越界的进度值不会溢出成额外的实心格", () => {
    const buckets = dayBuckets(0, 5);
    expect(
      barCells({ startDay: 0, endDay: 3, progress: 5, milestone: false }, buckets),
    ).toEqual(["fill", "fill", "fill", "fill", "none"]);
    expect(
      barCells({ startDay: 0, endDay: 3, progress: -2, milestone: false }, buckets),
    ).toEqual(["track", "track", "track", "track", "none"]);
  });
});

describe("flatten", () => {
  /**
   * Excel 会忽略 ARGB 里的 A 通道，所以 18% 的轨道色必须在这里就和白纸合成掉，
   * 否则导出件里轨道和实心一样深，进度信息整个消失。
   */
  it("把透明度合成到白底，得到可直接用的实色", () => {
    expect(flatten("#000000", 1)).toBe("000000");
    expect(flatten("#000000", 0)).toBe("FFFFFF");
    expect(flatten("#000000", 0.5)).toBe("808080");
    // 79×0.18 + 255×0.82 = 223 = DF，红分量最深也只到这里 —— 轨道必须明显浅于实心
    expect(flatten("#4F46E5", 0.18)).toBe("DFDEFA");
  });

  it("六位十六进制永远补齐，不产生 Excel 认不出的短串", () => {
    expect(flatten("#010203", 1)).toBe("010203");
    expect(flatten("#010203", 1)).toHaveLength(6);
  });
});
