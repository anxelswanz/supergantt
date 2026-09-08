import { describe, expect, it } from "vitest";
import { activeSpan, actualSpan, canEdit, deviation, planSpan } from "./viewMode";
import { resolve, type Task } from "../gantt/model";
import { isoToDay } from "../gantt/time";

const d = isoToDay;

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: d("2026-08-13"),
  endDay: d("2026-08-17"),
  actualStartDay: null,
  actualEndDay: null,
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: id,
  blocked: [],
  ...over,
});

const one = (over: Partial<Task> = {}) => resolve([task(1, over)])[0];

describe("当前视图下画哪个区间", () => {
  it("计划视图永远画计划", () => {
    const t = one({ actualStartDay: d("2026-08-15"), actualEndDay: d("2026-08-22") });
    expect(activeSpan(t, "plan")).toEqual({
      span: { startDay: d("2026-08-13"), endDay: d("2026-08-17") },
      ghost: false,
    });
  });

  it("实施视图有实施日期就画实施", () => {
    const t = one({ actualStartDay: d("2026-08-15"), actualEndDay: d("2026-08-22") });
    const { span, ghost } = activeSpan(t, "actual");
    expect(span).toEqual({ startDay: d("2026-08-15"), endDay: d("2026-08-22") });
    expect(ghost).toBe(false);
  });

  /**
   * 「未来 / 过去」不看今天，只看实施日期填了没。
   * 用今天做分界的话，同一条任务会因为日子一天天过去，自己从「虚线预览」
   * 悄悄变成「固定实施」，而用户根本没做任何操作。
   */
  it("实施视图没填实施日期时，画计划位置的虚线影子", () => {
    const { span, ghost } = activeSpan(one(), "actual");
    expect(span).toEqual({ startDay: d("2026-08-13"), endDay: d("2026-08-17") });
    expect(ghost).toBe(true);
  });

  it("是不是影子和今天是哪天无关", () => {
    // 计划完全在过去
    const past = one({ startDay: d("2020-01-01"), endDay: d("2020-01-05") });
    expect(activeSpan(past, "actual").ghost).toBe(true);
    // 计划完全在未来
    const future = one({ startDay: d("2099-01-01"), endDay: d("2099-01-05") });
    expect(activeSpan(future, "actual").ghost).toBe(true);
  });

  it("半填状态视同没填 —— 库层有触发器，这里是第二道", () => {
    expect(actualSpan(one({ actualStartDay: d("2026-08-15") }))).toBe(null);
    expect(actualSpan(one({ actualEndDay: d("2026-08-15") }))).toBe(null);
  });
});

describe("偏差", () => {
  it("延后为正，提前为负", () => {
    const late = one({ actualStartDay: d("2026-08-15"), actualEndDay: d("2026-08-22") });
    expect(deviation(late)).toEqual({ start: 2, end: 5 });

    const early = one({ actualStartDay: d("2026-08-11"), actualEndDay: d("2026-08-15") });
    expect(deviation(early)).toEqual({ start: -2, end: -2 });
  });

  it("还没实施时没有偏差可言", () => {
    expect(deviation(one())).toBe(null);
  });
});

describe("父任务的实施区间由子任务汇总", () => {
  it("取已填实施的子任务的最早开始与最晚结束", () => {
    const out = resolve([
      task(1),
      task(2, {
        parentId: 1,
        actualStartDay: d("2026-08-15"),
        actualEndDay: d("2026-08-18"),
      }),
      task(3, {
        parentId: 1,
        actualStartDay: d("2026-08-12"),
        actualEndDay: d("2026-08-16"),
      }),
    ]);
    const parent = out.find((t) => t.id === 1)!;
    expect(parent.actualStartDay).toBe(d("2026-08-12"));
    expect(parent.actualEndDay).toBe(d("2026-08-18"));
  });

  it("只有部分子任务开工时，只汇总开工的那些", () => {
    const out = resolve([
      task(1),
      task(2, {
        parentId: 1,
        actualStartDay: d("2026-08-15"),
        actualEndDay: d("2026-08-18"),
      }),
      task(3, { parentId: 1 }), // 还没开工
    ]);
    const parent = out.find((t) => t.id === 1)!;
    expect(parent.actualStartDay).toBe(d("2026-08-15"));
    expect(parent.actualEndDay).toBe(d("2026-08-18"));
  });

  it("一个子任务都没开工时，父任务也是「还没开始」", () => {
    const out = resolve([task(1), task(2, { parentId: 1 }), task(3, { parentId: 1 })]);
    const parent = out.find((t) => t.id === 1)!;
    expect(parent.actualStartDay).toBe(null);
    expect(activeSpan(parent, "actual").ghost).toBe(true);
  });

  it("计划区间的汇总不受实施影响", () => {
    const out = resolve([
      task(1, { startDay: 0, endDay: 1 }),
      task(2, {
        parentId: 1,
        startDay: d("2026-08-13"),
        endDay: d("2026-08-17"),
        actualStartDay: d("2026-09-01"),
        actualEndDay: d("2026-09-30"),
      }),
    ]);
    const parent = out.find((t) => t.id === 1)!;
    expect(planSpan(parent)).toEqual({
      startDay: d("2026-08-13"),
      endDay: d("2026-08-17"),
    });
  });
});

describe("编辑权限", () => {
  it("计划日期只归计划侧", () => {
    expect(canEdit("planDates", "plan")).toBe(true);
    expect(canEdit("planDates", "actual")).toBe(false);
  });

  it("实施日期、进度、受阻/风险/评论只归实施侧", () => {
    for (const f of ["actualDates", "progress", "notes"] as const) {
      expect(canEdit(f, "actual")).toBe(true);
      expect(canEdit(f, "plan")).toBe(false);
    }
  });

  /**
   * 这条挡住的是多视图化最容易犯的错：把「计划/实施」这个甘特内部的开关
   * 拿去管全局操作。一旦这么做，用户在看板或时间线里就加不了任务、
   * 改不了名字 —— 而那两个视图里根本没有这个开关可切。
   */
  it("结构、紧急度、负责人不归任何一侧，两侧都能改", () => {
    for (const f of ["structure", "priority", "assignee"] as const) {
      expect(canEdit(f, "plan")).toBe(true);
      expect(canEdit(f, "actual")).toBe(true);
    }
  });
});

/**
 * 对照模式的配色规则。
 *
 * 甘特图上的计划条、网格的偏差列、导出的偏差列必须用同一条判据 ——
 * 三处不一致的话，图上标红而表里写绿，用户会以为程序坏了。
 */
describe("超出计划的判据", () => {
  const late = (over: Partial<Task>) => (deviation(one(over))?.end ?? 0) > 0;

  it("结束晚于计划 = 超出", () => {
    expect(late({ actualStartDay: d("2026-08-13"), actualEndDay: d("2026-08-22") })).toBe(true);
  });

  it("恰好按计划结束 = 没超出", () => {
    expect(late({ actualStartDay: d("2026-08-13"), actualEndDay: d("2026-08-17") })).toBe(false);
  });

  it("提前结束 = 没超出", () => {
    expect(late({ actualStartDay: d("2026-08-13"), actualEndDay: d("2026-08-15") })).toBe(false);
  });

  /** 看的是结束日 —— 「按时交付」说的就是这个，开始晚了但赶回来了不算超 */
  it("开始晚了但按时结束，不算超出", () => {
    expect(late({ actualStartDay: d("2026-08-16"), actualEndDay: d("2026-08-17") })).toBe(false);
  });
});
