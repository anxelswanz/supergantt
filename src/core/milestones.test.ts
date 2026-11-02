import { describe, expect, it } from "vitest";
import { groupMilestones, milestoneInfo, type MilestoneTask } from "./milestones";
import { isoToDay } from "../gantt/time";
import type { Milestone } from "../db/api";

const ms = (over: Partial<Milestone>): Milestone => ({
  id: 1,
  projectId: 7,
  name: "样机",
  date: "2026-11-10",
  color: "#000",
  description: "",
  sortOrder: 0,
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});
const task = (id: number, progress: number, end: string, actual: string | null = null): MilestoneTask => ({
  id,
  name: `任务${id}`,
  progress,
  endDay: isoToDay(end),
  actualEndDay: actual ? isoToDay(actual) : null,
});
const today = isoToDay("2026-10-30");

describe("milestoneInfo", () => {
  const tasks = new Map([
    [1, task(1, 1, "2026-11-05", "2026-11-03")],
    [2, task(2, 0.5, "2026-11-08")],
  ]);

  it("没做完、日期没到：倒计时；关联任务的平均进度", () => {
    const i = milestoneInfo(ms({ taskIds: [1, 2] }), tasks, today);
    expect(i.status).toEqual({ kind: "upcoming", daysLeft: 11 });
    expect(i.done).toBe(1);
    expect(i.progress).toBe(0.75);
  });

  it("就是今天：还有 0 天", () => {
    expect(milestoneInfo(ms({ date: "2026-10-30" }), tasks, today).status).toEqual({ kind: "upcoming", daysLeft: 0 });
  });

  it("没做完、日期过了：逾期", () => {
    expect(milestoneInfo(ms({ date: "2026-10-25", taskIds: [1, 2] }), tasks, today).status).toEqual({
      kind: "overdue",
      daysLate: 5,
    });
  });

  it("全做完：达成，达成日取最晚的实际完成日（没有就用计划结束日）", () => {
    const all = new Map([...tasks, [2, task(2, 1, "2026-11-12")]]);
    expect(milestoneInfo(ms({ taskIds: [1, 2] }), all, today).status).toEqual({
      kind: "hit",
      reachedDay: isoToDay("2026-11-12"),
      delta: 2,
    });
    // 只关联提前做完的那条：提前 7 天
    expect(milestoneInfo(ms({ taskIds: [1] }), all, today).status).toMatchObject({ kind: "hit", delta: -7 });
  });

  it("没关联任务：只看日期", () => {
    expect(milestoneInfo(ms({ date: "2026-10-20" }), tasks, today).status).toMatchObject({ kind: "hit", delta: 0 });
    expect(milestoneInfo(ms({ date: "2026-10-20" }), tasks, today).progress).toBeNull();
  });

  it("被删掉的任务不算", () => {
    const i = milestoneInfo(ms({ taskIds: [1, 99] }), tasks, today);
    expect(i.tasks.map((t) => t.id)).toEqual([1]);
    expect(i.status.kind).toBe("hit");
  });
});

it("分组：逾期最久的在前、接下来最近的在前、已达成最近的在前", () => {
  const t = new Map([[2, task(2, 0, "2026-11-08")]]);
  const list = [
    ms({ id: 1, date: "2026-12-01" }),
    ms({ id: 2, date: "2026-11-05" }),
    ms({ id: 3, date: "2026-10-01", taskIds: [2] }),
    ms({ id: 4, date: "2026-10-20", taskIds: [2] }),
    ms({ id: 5, date: "2026-09-01" }),
    ms({ id: 6, date: "2026-10-15" }),
  ].map((m) => milestoneInfo(m, t, today));
  const g = groupMilestones(list);
  expect(g.overdue.map((i) => i.milestone.id)).toEqual([3, 4]);
  expect(g.upcoming.map((i) => i.milestone.id)).toEqual([2, 1]);
  expect(g.hit.map((i) => i.milestone.id)).toEqual([6, 5]);
  expect(g.next?.milestone.id).toBe(2);
});
