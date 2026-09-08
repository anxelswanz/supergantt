import { describe, expect, it } from "vitest";
import { attribution, blockedDaysOf, byUrgency, deviations, milestones, summarize } from "./review";
import { resolve, type Task } from "../gantt/model";
import type { BlockReason } from "./blocked";

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: 100,
  endDay: 104, // 计划 5 天
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: id,
  blocked: [],
  actualStartDay: null,
  actualEndDay: null,
  ...over,
});

const block = (from: number, to: number, reason: BlockReason = "material") => ({
  id: `b${from}-${reason}`,
  from,
  to,
  reason,
});

describe("受阻天数", () => {
  it("重叠的两段只算一次 —— 各三天但完全重叠，丢的是三天不是六天", () => {
    const t = task(1, { blocked: [block(100, 102), block(100, 102, "rework")] });
    expect(blockedDaysOf(t)).toBe(3);
  });

  it("不相连的两段相加", () => {
    const t = task(1, { blocked: [block(100, 101), block(104, 104)] });
    expect(blockedDaysOf(t)).toBe(3);
  });
});

describe("逐条偏差", () => {
  it("实施晚开工晚收尾，两端偏差都记正数", () => {
    const [d] = deviations(resolve([task(1, { actualStartDay: 103, actualEndDay: 109 })]));
    expect(d.startDelta).toBe(3);
    expect(d.endDelta).toBe(5);
    expect(d.durationDelta).toBe(2); // 7 天 vs 计划 5 天
  });

  it("还没实施的偏差记 0，而不是负数 —— 没开工不等于提前", () => {
    const [d] = deviations(resolve([task(1)]));
    expect(d.actual).toBe(null);
    expect(d.endDelta).toBe(0);
  });

  /**
   * 父任务的日期是子任务汇总出来的，把它也算进偏差表等于把同一份延期数两遍。
   */
  it("父任务不进偏差表", () => {
    const out = deviations(resolve([task(1), task(2, { parentId: 1 })]));
    expect(out).toHaveLength(1);
    expect(out[0].task.id).toBe(2);
  });
});

describe("排序：最该被解释的排最前", () => {
  it("延得越狠越靠前，做完的让位给没做完的", () => {
    const tasks = resolve([
      task(1, { actualStartDay: 100, actualEndDay: 114, progress: 1 }), // 晚 10 天但已完成
      task(2, { actualStartDay: 100, actualEndDay: 108 }), // 晚 4 天，未完成
      task(3, { actualStartDay: 100, actualEndDay: 110 }), // 晚 6 天，未完成
    ]);
    const order = deviations(tasks).sort(byUrgency).map((d) => d.task.id);
    expect(order).toEqual([3, 2, 1]);
  });
});

describe("受阻归因", () => {
  it("按原因聚合天数，多的排前面", () => {
    const tasks = resolve([
      task(1, { blocked: [block(100, 104, "material")] }), // 等料 5 天
      task(2, { blocked: [block(100, 101, "rework")] }), // 返工 2 天
    ]);
    const out = attribution(tasks);
    expect(out[0]).toMatchObject({ reason: "material", days: 5, taskCount: 1 });
    expect(out[1]).toMatchObject({ reason: "rework", days: 2 });
  });

  it("同一原因下重叠的段合并 —— 两条工单记的是同一次停机", () => {
    const tasks = resolve([
      task(1, { blocked: [block(100, 103, "equipment")] }),
      task(2, { blocked: [block(102, 105, "equipment")] }),
    ]);
    const [out] = attribution(tasks);
    expect(out.days).toBe(6); // 100–105，不是 4+4
    expect(out.taskCount).toBe(2);
  });

  it("不同原因各算各的 —— 同一天既等料又返工是真实存在的", () => {
    const tasks = resolve([
      task(1, { blocked: [block(100, 102, "material"), block(100, 102, "rework")] }),
    ]);
    const out = attribution(tasks);
    expect(out.map((a) => a.days)).toEqual([3, 3]);
  });
});

describe("整体摘要", () => {
  it("统计完成、在做、还没动过的条数", () => {
    const tasks = resolve([
      task(1, { progress: 1, actualStartDay: 100, actualEndDay: 104 }),
      task(2, { progress: 0.5, actualStartDay: 100, actualEndDay: 106 }),
      task(3),
    ]);
    const s = summarize(tasks);
    expect(s).toMatchObject({ leafCount: 3, doneCount: 1, runningCount: 1, untouchedCount: 1 });
  });

  it("收尾偏差取最晚实际结束与最晚计划结束之差", () => {
    const tasks = resolve([
      task(1, { actualStartDay: 100, actualEndDay: 104 }),
      task(2, { startDay: 100, endDay: 110, actualStartDay: 100, actualEndDay: 118 }),
    ]);
    expect(summarize(tasks).endDelta).toBe(8);
    expect(summarize(tasks).lateCount).toBe(1);
  });

  it("一条都没开工时不显示偏差 —— 没开工不是提前", () => {
    expect(summarize(resolve([task(1)])).endDelta).toBe(0);
  });

  it("总进度按工期加权，和甘特父任务用的是同一套规则", () => {
    const tasks = resolve([
      task(1, { startDay: 100, endDay: 100, progress: 1 }), // 1 天，做完
      task(2, { startDay: 101, endDay: 119, progress: 0 }), // 19 天，没动
    ]);
    expect(summarize(tasks).progress).toBeCloseTo(0.05, 5);
  });
});

describe("里程碑", () => {
  it("只挑里程碑，按计划日期排", () => {
    const tasks = resolve([
      task(1, { milestone: true, startDay: 110, endDay: 110 }),
      task(2),
      task(3, { milestone: true, startDay: 100, endDay: 100 }),
    ]);
    expect(milestones(tasks).map((d) => d.task.id)).toEqual([3, 1]);
  });
});
