import { describe, expect, it } from "vitest";
import {
  blockedDays,
  describeBlocked,
  clampToTask,
  mergeRanges,
  parseBlocked,
  reclamp,
  serializeBlocked,
  type BlockedPeriod,
} from "./blocked";
import { isoToDay } from "../gantt/time";

const d = isoToDay;
const p = (from: string, to: string, over: Partial<BlockedPeriod> = {}): BlockedPeriod => ({
  id: `${from}_${to}`,
  from: d(from),
  to: d(to),
  reason: "equipment",
  ...over,
});

/** 用户给的原始场景：8.13–8.17 是 robot testing，8.15–8.17 设备坏了 */
const TASK = { startDay: d("2026-08-13"), endDay: d("2026-08-17") };

describe("裁到任务区间内", () => {
  it("区间内的原样保留", () => {
    expect(clampToTask(p("2026-08-15", "2026-08-17"), TASK)).toMatchObject({
      from: d("2026-08-15"),
      to: d("2026-08-17"),
    });
  });

  it("超出任务尾部的被裁掉 —— 要记录超期得先把任务拖长", () => {
    expect(clampToTask(p("2026-08-15", "2026-08-25"), TASK)?.to).toBe(d("2026-08-17"));
  });

  it("超出任务头部的同样被裁", () => {
    expect(clampToTask(p("2026-08-01", "2026-08-14"), TASK)?.from).toBe(d("2026-08-13"));
  });

  it("完全落在任务之外的直接丢弃", () => {
    expect(clampToTask(p("2026-09-01", "2026-09-03"), TASK)).toBe(null);
  });

  it("任务日期改短之后，重新裁一遍并丢掉落空的", () => {
    const periods = [p("2026-08-13", "2026-08-14"), p("2026-08-16", "2026-08-17")];
    const shrunk = { startDay: d("2026-08-13"), endDay: d("2026-08-14") };
    const out = reclamp(periods, shrunk);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(d("2026-08-14"));
  });
});

describe("多段合并", () => {
  it("重叠的两段并成一段", () => {
    const out = mergeRanges([p("2026-08-13", "2026-08-15"), p("2026-08-14", "2026-08-17")]);
    expect(out).toEqual([[d("2026-08-13"), d("2026-08-17")]]);
  });

  it("紧挨着的两段也并起来，不留凭空的断口", () => {
    // 8/13–8/14 和 8/15–8/16 中间没有正常推进的日子
    const out = mergeRanges([p("2026-08-13", "2026-08-14"), p("2026-08-15", "2026-08-16")]);
    expect(out).toEqual([[d("2026-08-13"), d("2026-08-16")]]);
  });

  it("中间隔着正常日子的两段保持分开", () => {
    const out = mergeRanges([p("2026-08-13", "2026-08-14"), p("2026-08-17", "2026-08-18")]);
    expect(out).toHaveLength(2);
  });

  it("输入顺序不影响结果", () => {
    const a = mergeRanges([p("2026-08-16", "2026-08-17"), p("2026-08-13", "2026-08-14")]);
    const b = mergeRanges([p("2026-08-13", "2026-08-14"), p("2026-08-16", "2026-08-17")]);
    expect(a).toEqual(b);
  });
});

describe("受阻天数", () => {
  it("用户的原始场景：8.15–8.17 是 3 天", () => {
    expect(blockedDays([p("2026-08-15", "2026-08-17")])).toBe(3);
  });

  it("重叠的两段不重复计数", () => {
    expect(
      blockedDays([p("2026-08-13", "2026-08-15"), p("2026-08-14", "2026-08-17")]),
    ).toBe(5);
  });

  it("没有记录时是 0", () => {
    expect(blockedDays([])).toBe(0);
  });
});

describe("自己写的说明", () => {
  it("有说明时优先显示说明 —— 类型是给统计用的，人要看具体的话", () => {
    expect(
      describeBlocked(p("2026-08-15", "2026-08-17", { note: "三号机主轴异响" })),
    ).toBe("三号机主轴异响");
  });

  it("没写说明就退回类型标签", () => {
    expect(describeBlocked(p("2026-08-15", "2026-08-17"))).toBe("设备故障");
  });

  it("说明只有空白时视同没写", () => {
    expect(describeBlocked(p("2026-08-15", "2026-08-17", { note: "   " }))).toBe("设备故障");
  });

  it("自己写的说明能存进库再读回来", () => {
    const one = p("2026-08-15", "2026-08-17", { reason: "other", note: "供应商延迟发货" });
    expect(parseBlocked(serializeBlocked([one]))[0].note).toBe("供应商延迟发货");
  });
});

describe("与数据库的往返", () => {
  it("序列化后再解析得到等价数据", () => {
    const periods = [
      p("2026-08-15", "2026-08-17", { reason: "quality", note: "第三批件超差" }),
      p("2026-08-13", "2026-08-13", { reason: "material" }),
    ];
    const back = parseBlocked(serializeBlocked(periods));
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({
      from: d("2026-08-15"),
      to: d("2026-08-17"),
      reason: "quality",
      note: "第三批件超差",
    });
  });

  it("存的是 ISO 日期串，不是只有本程序读得懂的天序号", () => {
    const json = JSON.parse(serializeBlocked([p("2026-08-15", "2026-08-17")]));
    expect(json[0].from).toBe("2026-08-15");
    expect(json[0].to).toBe("2026-08-17");
  });

  it("库里的值坏掉时跳过坏的那条，不让整个项目打不开", () => {
    const raw = JSON.stringify([
      { id: "ok", from: "2026-08-15", to: "2026-08-17", reason: "equipment" },
      { id: "bad", from: "不是日期", to: "2026-08-17", reason: "equipment" },
      { id: "reversed", from: "2026-08-17", to: "2026-08-15", reason: "equipment" },
      "根本不是对象",
    ]);
    const out = parseBlocked(raw);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ok");
  });

  it("整段 JSON 坏掉时退回空数组", () => {
    for (const bad of ["", "не json", "{}", "null"]) {
      expect(parseBlocked(bad)).toEqual([]);
    }
  });

  it("不认识的原因退回「其他」，不丢掉整条记录", () => {
    const raw = JSON.stringify([
      { id: "x", from: "2026-08-15", to: "2026-08-16", reason: "外星人" },
    ]);
    expect(parseBlocked(raw)[0].reason).toBe("other");
  });
});
