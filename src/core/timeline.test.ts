import { describe, expect, it } from "vitest";
import {
  buildCareers,
  buildTimeline,
  carriedBlocks,
  clipTimeline,
  normalizeRange,
} from "./timeline";
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
  autoRollover: false,
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
  priority: null,
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

  /** 「实施结束日到了」不等于「这天做完了」，完工事件要求进度满 */
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

  /** 补记落在它说的那天（不按 created_at），并标出是事后补的 */
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

describe("按日期筛选", () => {
  const days = buildTimeline(
    resolve([task(1)]),
    [
      note({ id: 1, day: dayToIso(D0) }),
      note({ id: 2, day: dayToIso(D0 + 3) }),
      note({ id: 3, day: dayToIso(D0 + 7) }),
    ],
    [],
  );

  it("不传区间就是原样", () => {
    expect(clipTimeline(days, null)).toBe(days);
  });

  it("单日：只剩那一天", () => {
    const got = clipTimeline(days, { from: D0 + 3, to: D0 + 3 });
    expect(got.map((d) => d.day)).toEqual([D0 + 3]);
  });

  it("区间首尾都含，顺序不变（仍是最近在前）", () => {
    const got = clipTimeline(days, { from: D0, to: D0 + 3 });
    expect(got.map((d) => d.day)).toEqual([D0 + 3, D0]);
  });

  it("先点晚的再点早的，区间也是正的", () => {
    expect(normalizeRange(D0 + 5, D0)).toEqual({ from: D0, to: D0 + 5 });
  });
});

describe("区间之前就卡住的受阻", () => {
  const tasks = resolve([
    task(1, {
      blocked: [
        { id: "early", from: D0, to: D0 + 6, reason: "material" },
        { id: "gone", from: D0, to: D0 + 2, reason: "rework" },
        { id: "inside", from: D0 + 5, to: D0 + 6, reason: "equipment", open: true },
      ],
    }),
  ]);

  it("起始日在区间前、覆盖到区间内的才算", () => {
    const got = carriedBlocks(tasks, { from: D0 + 4, to: D0 + 8 });
    expect(got.map((e) => e.key)).toEqual(["c1-early"]);
    expect(got[0].since).toBe(D0);
    expect(got[0].days).toBe(7);
  });

  it("起始日落在区间里的不重复捞 —— 它已经在那天显示了", () => {
    const got = carriedBlocks(tasks, { from: D0 + 5, to: D0 + 5 });
    expect(got.map((e) => e.key)).toEqual(["c1-early"]);
  });

  it("没在筛选时什么都不捞", () => {
    expect(carriedBlocks(tasks, null)).toEqual([]);
  });
});

describe("任务履历", () => {
  const NOW = D0 + 10;
  const tasks = resolve([
    task(1, { name: "做完的", actualStartDay: D0, actualEndDay: D0 + 4, progress: 1 }),
    task(2, {
      name: "在干的",
      actualStartDay: D0 + 6,
      actualEndDay: D0 + 20,
      progress: 0.4,
      blocked: [
        { id: "a", from: D0 + 7, to: D0 + 8, reason: "material" },
        { id: "b", from: D0 + 8, to: D0 + 30, reason: "rework" },
      ],
    }),
    task(3, { name: "没开工的" }),
  ]);

  it("没开工的不进来；在干的排在做完的前面", () => {
    expect(buildCareers(tasks, NOW).map((c) => c.task.name)).toEqual(["在干的", "做完的"]);
  });

  it("做完的：开工到完成，含首尾", () => {
    const done = buildCareers(tasks, NOW)[1];
    expect([done.start, done.end, done.days]).toEqual([D0, D0 + 4, 5]);
  });

  it("在干的：画到今天为止，实施结束日没到 100% 不算完成", () => {
    const live = buildCareers(tasks, NOW)[0];
    expect(live.end).toBeNull();
    expect(live.until).toBe(NOW);
    expect(live.days).toBe(5);
  });

  it("受阻段夹到今天，重叠的那天只算一次", () => {
    const live = buildCareers(tasks, NOW)[0];
    expect(live.blocked.at(-1)!.to).toBe(NOW);
    expect(live.blockedDays).toBe(4); // D0+7 ～ D0+10
  });

  it("筛日期时只留和区间有交集的", () => {
    const got = buildCareers(tasks, NOW, { from: D0 + 5, to: D0 + 7 });
    expect(got.map((c) => c.task.name)).toEqual(["在干的"]);
  });
});
