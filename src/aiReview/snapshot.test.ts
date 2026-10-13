import { describe, expect, it } from "vitest";
import type { DailyNote, ItemNote, Risk } from "../db/api";
import type { BlockReason } from "../core/blocked";
import { BUILTIN_KINDS } from "../core/items";
import { attribution, summarize } from "../core/review";
import { resolve, type Task } from "../gantt/model";
import { dayToIso, isoToDay } from "../gantt/time";
import { blockerWeight, buildSnapshot, LIMITS, omittedNote, type SnapshotInput } from "./snapshot";

const D = isoToDay("2026-09-01");
const unix = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: D,
  endDay: D + 4,
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

const block = (from: number, to: number, reason: BlockReason = "material", over = {}) => ({
  id: `b${from}-${to}-${reason}`,
  from,
  to,
  reason,
  ...over,
});

const risk = (id: number, over: Partial<Risk> = {}): Risk => ({
  id,
  taskId: 1,
  content: `风险${id}`,
  level: 1,
  resolved: false,
  createdAt: unix("2026-09-02"),
  resolvedAt: null,
  resolution: null,
  priority: null,
  ...over,
});

const item = (id: number, over: Partial<ItemNote> = {}): ItemNote => ({
  id,
  projectId: 7,
  name: `事项${id}`,
  kind: "todo",
  priority: 2,
  personId: null,
  taskId: null,
  promotedKind: null,
  promotedRef: null,
  closedAt: null,
  resolution: null,
  createdAt: unix("2026-09-02") + id,
  updatedAt: unix("2026-09-02") + id,
  ...over,
});

const note = (id: number, day: string, taskId: number | null, content = `记录${id}`): DailyNote => ({
  id,
  projectId: 7,
  taskId,
  day,
  content,
  createdAt: 0,
  updatedAt: 0,
});

const input = (tasks: Task[], over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  projectName: "产线改造",
  tasks: resolve(tasks),
  people: [{ id: 1, name: "张三", color: "#000", avatar: null, sortOrder: 0 }],
  risks: [],
  dailyNotes: [],
  itemNotes: [],
  itemKinds: BUILTIN_KINDS,
  today: D + 30,
  ...over,
});

describe("快照里的数字", () => {
  /**
   * 这是整个功能的地基：AI 文档里的数据表读快照，「复盘」视图读 review.ts。
   * 两边对不上的那一刻，这份文档就没人信了。
   */
  it("和 core/review.ts 是同一份计算", () => {
    const tasks = [
      task(1, { actualStartDay: D, actualEndDay: D + 10, progress: 1, blocked: [block(D + 2, D + 4)] }),
      task(2, { actualStartDay: D + 1, actualEndDay: D + 3, progress: 0.5, blocked: [block(D + 1, D + 1, "rework")] }),
      task(3),
    ];
    const snap = buildSnapshot(input(tasks));
    const resolved = resolve(tasks);
    const s = summarize(resolved);

    expect(snap.summary).toMatchObject({
      leafCount: s.leafCount,
      doneCount: s.doneCount,
      runningCount: s.runningCount,
      untouchedCount: s.untouchedCount,
      lateCount: s.lateCount,
      endDelta: s.endDelta,
      blockedDays: s.blockedDays,
      progress: Math.round(s.progress * 100),
    });
    expect(snap.attribution).toEqual(
      attribution(resolved).map((a) => ({ reason: a.label, days: a.days, taskCount: a.taskCount })),
    );
    expect(snap.tasks.find((t) => t.name === "任务1")).toMatchObject({
      endDelta: 6,
      blockedDays: 3,
      plan: { start: dayToIso(D), end: dayToIso(D + 4) },
      actual: { start: dayToIso(D), end: dayToIso(D + 10) },
    });
  });

  it("只有名字和日期，没有 id —— 半年后任务改名、删掉，快照还得自己说得清", () => {
    const snap = buildSnapshot(
      input(
        [
          task(1, { name: "土建" }),
          task(2, { parentId: 1, name: "打地基", personId: 1 }),
        ],
        { risks: [risk(1, { taskId: 2 })], itemNotes: [item(1, { taskId: 2, personId: 1 })] },
      ),
    );
    expect(snap.tasks).toHaveLength(1); // 只有叶子
    expect(snap.tasks[0]).toMatchObject({ name: "打地基", group: "土建", owner: "张三" });
    expect(snap.risks[0].task).toBe("打地基");
    expect(snap.items[0]).toMatchObject({ task: "打地基", owner: "张三", kind: "代办" });
    expect(JSON.stringify(snap)).not.toMatch(/"(id|taskId|personId)"/);
  });

  it("已经分拣成阻碍或风险的事项不再列一遍", () => {
    const snap = buildSnapshot(
      input([task(1)], {
        itemNotes: [item(1), item(2, { promotedKind: "risk", promotedRef: "5" })],
      }),
    );
    expect(snap.items.map((i) => i.title)).toEqual(["事项1"]);
  });
});

describe("超量时只留重要的", () => {
  it("阻碍：留下卡得最久的，汇总天数仍按全量算", () => {
    // 40 条任务各卡一段：第 n 条卡 n 天
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task(i + 1, {
        endDay: D + 60,
        blocked: [block(D, D + i, "material", { note: `第${i + 1}段` })],
      }),
    );
    const snap = buildSnapshot(input(tasks));

    expect(snap.blockers).toHaveLength(LIMITS.blockers);
    expect(snap.omitted.blockers).toBe(40 - LIMITS.blockers);
    // 留下的是最长的那些，最短的被省掉
    expect(snap.blockers[0].days).toBe(40);
    expect(Math.min(...snap.blockers.map((b) => b.days))).toBe(40 - LIMITS.blockers + 1);
    // 被省掉的只是明细，不是它们对总数的贡献
    expect(snap.summary.blockedDays).toBe(summarize(resolve(tasks)).blockedDays);
    expect(snap.attribution[0].taskCount).toBe(40);
  });

  it("阻碍：还卡着的和高优先级的往前提，但压不过一段长得多的", () => {
    expect(blockerWeight({ days: 2, open: true, priority: null })).toBeGreaterThan(
      blockerWeight({ days: 5, open: false, priority: null }),
    );
    expect(blockerWeight({ days: 1, open: false, priority: "P0" })).toBeGreaterThan(
      blockerWeight({ days: 8, open: false, priority: null }),
    );
    // 没标优先级的 20 天停工，比标了 P1 的半天小卡顿重要
    expect(blockerWeight({ days: 20, open: false, priority: null })).toBeGreaterThan(
      blockerWeight({ days: 1, open: false, priority: "P1" }),
    );
  });

  it("风险：等级高的先留", () => {
    const risks = [
      ...Array.from({ length: 30 }, (_, i) => risk(i + 1, { level: 2 })),
      risk(100, { level: 0, content: "主轴供应商可能断供" }),
    ];
    const snap = buildSnapshot(input([task(1)], { risks }));
    expect(snap.risks).toHaveLength(LIMITS.risks);
    expect(snap.risks[0].content).toBe("主轴供应商可能断供");
    expect(snap.omitted.risks).toBe(31 - LIMITS.risks);
    // 开着的、关掉的条数仍是全量
    expect(snap.summary.openRisks).toBe(31);
  });

  it("事项：优先级高的先留，同优先级里「问题」排在代办前面", () => {
    const itemNotes = [
      ...Array.from({ length: 30 }, (_, i) => item(i + 1)),
      item(100, { priority: 0, name: "P0 的代办" }),
      item(101, { kind: "issue", name: "P2 的问题" }),
    ];
    const snap = buildSnapshot(input([task(1)], { itemNotes }));
    expect(snap.items).toHaveLength(LIMITS.items);
    expect(snap.items.slice(0, 2).map((i) => i.title)).toEqual(["P0 的代办", "P2 的问题"]);
  });

  it("逐日记录：挂在延期或受阻任务上的先留，留下的按日期正序", () => {
    const tasks = [
      task(1, { actualStartDay: D, actualEndDay: D + 10 }), // 晚了 6 天
      task(2, { actualStartDay: D, actualEndDay: D + 4 }), // 准时
    ];
    const dailyNotes = [
      note(1, "2026-08-01", 1, "很早以前、但挂在延期任务上"),
      ...Array.from({ length: 40 }, (_, i) => note(i + 2, dayToIso(D + i), 2)),
    ];
    const snap = buildSnapshot(input(tasks, { dailyNotes }));

    expect(snap.notes).toHaveLength(LIMITS.notes);
    expect(snap.notes.some((n) => n.content === "很早以前、但挂在延期任务上")).toBe(true);
    const days = snap.notes.map((n) => n.day);
    expect(days).toEqual([...days].sort());
  });

  it("任务：偏差大的先留，提前完成的也算偏差", () => {
    const tasks = [
      ...Array.from({ length: 50 }, (_, i) =>
        task(i + 1, { actualStartDay: D, actualEndDay: D + 4, progress: 1 }),
      ),
      task(100, { name: "晚了的", actualStartDay: D, actualEndDay: D + 14, progress: 1 }),
      task(101, { name: "提前的", endDay: D + 14, actualStartDay: D, actualEndDay: D + 4, progress: 1 }),
    ];
    const snap = buildSnapshot(input(tasks));
    expect(snap.tasks).toHaveLength(LIMITS.tasks);
    expect(snap.tasks.slice(0, 2).map((t) => t.name).sort()).toEqual(["提前的", "晚了的"]);
    expect(snap.summary.leafCount).toBe(52);
  });

  it("没超量就不省，也不提示", () => {
    const snap = buildSnapshot(input([task(1)], { risks: [risk(1)] }));
    expect(snap.omitted).toEqual({ tasks: 0, blockers: 0, risks: 0, items: 0, notes: 0 });
    expect(omittedNote(snap)).toBe(null);
  });

  it("省了什么要说得出来", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1, { blocked: [block(D, D + i)] }));
    expect(omittedNote(buildSnapshot(input(tasks)))).toBe(`阻碍 ${30 - LIMITS.blockers} 段`);
  });

  it("一条粘贴进来的长文不会挤掉别的记录", () => {
    const snap = buildSnapshot(
      input([task(1)], { dailyNotes: [note(1, "2026-09-02", null, "字".repeat(5000))] }),
    );
    expect(snap.notes[0].content.length).toBeLessThanOrEqual(301);
  });
});
