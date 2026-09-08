import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline";
import { resolve, type Task } from "../gantt/model";
import { dayToIso, isoToDay } from "../gantt/time";
import type { DailyNote, Risk } from "../db/api";

const D0 = isoToDay("2026-08-10");

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: D0,
  endDay: D0 + 4,
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

/** 把 dayIndex 变成当天中午的 Unix 秒，避免时区把日期推到前后一天 */
const unixOf = (day: number) => Date.parse(`${dayToIso(day)}T12:00:00Z`) / 1000;

const note = (over: Partial<DailyNote> = {}): DailyNote => ({
  id: 1,
  projectId: 1,
  taskId: null,
  day: dayToIso(D0),
  content: "今天全场停工",
  createdAt: unixOf(D0),
  updatedAt: unixOf(D0),
  ...over,
});

const risk = (over: Partial<Risk> = {}): Risk => ({
  id: 1,
  taskId: 1,
  content: "供应商说下周才能到",
  level: 0,
  resolved: false,
  createdAt: unixOf(D0),
  resolvedAt: null,
  resolution: null,
  ...over,
});

describe("时间线聚合", () => {
  it("最近的一天排最上面 —— 时间线是用来回顾的", () => {
    const days = buildTimeline(
      resolve([task(1, { actualStartDay: D0, actualEndDay: D0 + 2, progress: 1 })]),
      [],
      [],
    );
    expect(days.map((d) => d.iso)).toEqual([dayToIso(D0 + 2), dayToIso(D0)]);
  });

  it("开工与完工各落在它们发生的那天", () => {
    const days = buildTimeline(
      resolve([task(1, { actualStartDay: D0, actualEndDay: D0 + 3, progress: 1 })]),
      [],
      [],
    );
    expect(days.find((d) => d.day === D0)!.events[0].kind).toBe("start");
    expect(days.find((d) => d.day === D0 + 3)!.events[0].kind).toBe("finish");
  });

  /**
   * 「实施结束日到了」和「这天做完了」是两件事。前者只是排期，后者会被
   * 写进汇报 —— 靠日期猜出来的完成事实，经不起追问。
   */
  it("进度没满就不产生完工事件", () => {
    const days = buildTimeline(
      resolve([task(1, { actualStartDay: D0, actualEndDay: D0 + 3, progress: 0.8 })]),
      [],
      [],
    );
    expect(days.flatMap((d) => d.events).some((e) => e.kind === "finish")).toBe(false);
  });

  it("受阻只在起始日出现一条，持续天数写进事件里", () => {
    const days = buildTimeline(
      resolve([
        task(1, {
          actualStartDay: D0,
          actualEndDay: D0 + 6,
          blocked: [{ id: "b1", from: D0 + 1, to: D0 + 5, reason: "material" }],
        }),
      ]),
      [],
      [],
    );
    const blocked = days.flatMap((d) => d.events).filter((e) => e.kind === "blocked");
    // 五天的等料只产生一条，否则它会把真正发生了事的那几天淹掉
    expect(blocked).toHaveLength(1);
    expect(blocked[0].days).toBe(5);
    expect(days.find((d) => d.day === D0 + 1)!.events.some((e) => e.kind === "blocked")).toBe(true);
  });

  it("父任务不产生开工/完工 —— 那是子任务汇总出来的", () => {
    const days = buildTimeline(
      resolve([
        task(1),
        task(2, { parentId: 1, actualStartDay: D0, actualEndDay: D0 + 1, progress: 1 }),
      ]),
      [],
      [],
    );
    expect(days.flatMap((d) => d.events).filter((e) => e.kind === "start")).toHaveLength(1);
  });

  it("项目级记录（不挂任务）也能落到那一天", () => {
    const days = buildTimeline(resolve([task(1)]), [note()], []);
    const e = days[0].events[0];
    expect(e.kind).toBe("note");
    expect(e.task).toBe(null);
  });

  /**
   * 周五补记周三的事：记录要落在**周三**，同时标出它是事后补的。
   * 用 created_at 归位的话，时间线从第一天起就是错的。
   */
  it("按「说的哪天」归位，并标出事后补记", () => {
    const days = buildTimeline(
      resolve([task(1)]),
      [note({ day: dayToIso(D0), createdAt: unixOf(D0 + 2) })],
      [],
    );
    expect(days[0].day).toBe(D0);
    expect(days[0].events[0].backdated).toBe(true);
  });

  it("当天写当天的不算补记", () => {
    const days = buildTimeline(resolve([task(1)]), [note()], []);
    expect(days[0].events[0].backdated).toBe(false);
  });

  it("同一天里：先事件，后解释", () => {
    const days = buildTimeline(
      resolve([
        task(1, {
          actualStartDay: D0,
          actualEndDay: D0 + 3,
          blocked: [{ id: "b1", from: D0, to: D0, reason: "rework" }],
        }),
      ]),
      [note({ day: dayToIso(D0) })],
      [risk()],
    );
    expect(days[0].events.map((e) => e.kind)).toEqual(["start", "blocked", "risk", "note"]);
  });

  it("挂在已删任务上的风险不进时间线 —— 它没有落点", () => {
    const days = buildTimeline(resolve([task(1)]), [], [risk({ taskId: 999 })]);
    expect(days).toHaveLength(0);
  });

  it("什么都没有就是空的，不造出一堆空日子", () => {
    expect(buildTimeline(resolve([task(1)]), [], [])).toEqual([]);
  });
});
