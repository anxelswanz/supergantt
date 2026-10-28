/**
 * 复盘：把「计划与实际的差」算成可交付的结果。纯函数，不碰 UI / 数据库；
 * 复盘视图与 Excel 导出必须共用这份计算，否则两边数字会对不上。
 */

import { mergeRanges, reasonLabel, type BlockReason } from "./blocked";
import { actualSpan, planSpan, type Span } from "./viewMode";
import { durationOf, type ResolvedTask } from "../gantt/model";

export interface Deviation {
  task: ResolvedTask;
  plan: Span;
  actual: Span | null;
  /** 实际开始比计划晚几天。正数=晚，负数=早 */
  startDelta: number;
  /** 实际结束比计划晚几天。正数=晚 */
  endDelta: number;
  /** 实际工期比计划长几天 */
  durationDelta: number;
  /** 累计受阻天数，重叠段只算一次 */
  blockedDays: number;
}

/** 区间天数，含首尾 */
const daysIn = (from: number, to: number) => Math.max(0, to - from + 1);

/** 受阻总天数，重叠段先合并 */
export function blockedDaysOf(task: Pick<ResolvedTask, "blocked">): number {
  return mergeRanges(task.blocked).reduce((sum, [f, t]) => sum + daysIn(f, t), 0);
}

/** 逐条任务的偏差。只算叶子任务，父任务的日期是汇总值，计入会重复。 */
export function deviations(tasks: ResolvedTask[]): Deviation[] {
  return tasks
    .filter((t) => !t.hasChildren)
    .map((task) => {
      const plan = planSpan(task);
      const actual = actualSpan(task);
      return {
        task,
        plan,
        actual,
        startDelta: actual ? actual.startDay - plan.startDay : 0,
        endDelta: actual ? actual.endDay - plan.endDay : 0,
        durationDelta: actual ? durationOf(actual) - durationOf(plan) : 0,
        blockedDays: blockedDaysOf(task),
      };
    });
}

/** 排序：延得最狠的在前；已完成的排在未完成之后。 */
export const byUrgency = (a: Deviation, b: Deviation): number => {
  const done = (d: Deviation) => (d.task.progress >= 1 ? 1 : 0);
  return done(a) - done(b) || b.endDelta - a.endDelta || b.blockedDays - a.blockedDays;
};

export interface Attribution {
  reason: BlockReason;
  label: string;
  /** 该原因累计天数，同原因内的重叠段已合并 */
  days: number;
  /** 涉及任务数 */
  taskCount: number;
}

/**
 * 受阻归因：丢失的天数都丢在什么原因上。各原因分别合并区间，
 * 故天数之和可能大于日历天数（同一天可同时等料和返工）。
 */
export function attribution(tasks: ResolvedTask[]): Attribution[] {
  const byReason = new Map<BlockReason, { ranges: [number, number][]; tasks: Set<number> }>();

  for (const task of tasks) {
    if (task.hasChildren) continue; // 受阻只记叶子
    for (const b of task.blocked) {
      const slot = byReason.get(b.reason) ?? { ranges: [], tasks: new Set<number>() };
      slot.ranges.push([b.from, b.to]);
      slot.tasks.add(task.id);
      byReason.set(b.reason, slot);
    }
  }

  return [...byReason.entries()]
    .map(([reason, { ranges, tasks: ids }]) => ({
      reason,
      label: reasonLabel(reason),
      // 同原因重叠段合并：同一段停机不该算两次
      days: mergeRanges(
        ranges.map(([from, to]) => ({ id: "", from, to, reason })),
      ).reduce((sum, [f, t]) => sum + daysIn(f, t), 0),
      taskCount: ids.size,
    }))
    .sort((a, b) => b.days - a.days);
}

export interface ReviewSummary {
  leafCount: number;
  doneCount: number;
  /** 已开工（有实施日期或进度 > 0）未完成 */
  runningCount: number;
  /** 没填实施日期的条数 */
  untouchedCount: number;
  /** 工期加权总进度 */
  progress: number;
  /** 计划/实际区间（实际只统计填过实施日期的任务） */
  plan: Span | null;
  actual: Span | null;
  /** 收尾偏差：最晚实际结束 − 最晚计划结束 */
  endDelta: number;
  /** 累计受阻天数（跨任务不合并） */
  blockedDays: number;
  /** 晚于计划结束的任务条数 */
  lateCount: number;
}

export function summarize(tasks: ResolvedTask[]): ReviewSummary {
  const leaves = tasks.filter((t) => !t.hasChildren);

  let planFrom = Infinity, planTo = -Infinity;
  let actFrom = Infinity, actTo = -Infinity;
  let weight = 0, weighted = 0;
  let done = 0, running = 0, untouched = 0, late = 0, blockedDays = 0;

  for (const t of leaves) {
    const p = planSpan(t);
    planFrom = Math.min(planFrom, p.startDay);
    planTo = Math.max(planTo, p.endDay);

    const a = actualSpan(t);
    if (a) {
      actFrom = Math.min(actFrom, a.startDay);
      actTo = Math.max(actTo, a.endDay);
      if (a.endDay > p.endDay) late++;
    } else {
      untouched++;
    }

    const w = t.weight ?? durationOf(p);
    weight += w;
    weighted += w * t.progress;

    if (t.progress >= 1) done++;
    else if (a || t.progress > 0) running++;

    blockedDays += blockedDaysOf(t);
  }

  const plan = planFrom <= planTo ? { startDay: planFrom, endDay: planTo } : null;
  const actual = actFrom <= actTo ? { startDay: actFrom, endDay: actTo } : null;

  return {
    leafCount: leaves.length,
    doneCount: done,
    runningCount: running,
    untouchedCount: untouched,
    progress: weight > 0 ? weighted / weight : 0,
    plan,
    actual,
    // 两端都有才谈得上偏差，否则会显示"提前了 N 天"
    endDelta: plan && actual ? actual.endDay - plan.endDay : 0,
    blockedDays,
    lateCount: late,
  };
}

/** 只挑里程碑，按计划开始日排 */
export function milestones(tasks: ResolvedTask[]): Deviation[] {
  return deviations(tasks)
    .filter((d) => d.task.milestone)
    .sort((a, b) => a.plan.startDay - b.plan.startDay);
}

/**
 * 里程碑此刻的处境，需要 today 才能区分逾期与未到期
 * （只比计划与实际的话，过了计划日未达成会算成 0 偏差）。
 * hit: delta=实际−计划；undated: 进度 100% 但无实施日期；
 * overdue: 逾期天数；upcoming: 还有几天。
 */
export type MilestoneState =
  | { kind: "hit"; delta: number }
  | { kind: "undated" }
  | { kind: "overdue"; days: number }
  | { kind: "upcoming"; days: number };

export interface MilestoneMark extends Deviation {
  state: MilestoneState;
}

export function milestoneMarks(tasks: ResolvedTask[], today: number): MilestoneMark[] {
  return milestones(tasks).map((d) => {
    const due = d.plan.startDay;
    const state: MilestoneState = d.actual
      ? { kind: "hit", delta: d.startDelta }
      : d.task.progress >= 1
        ? { kind: "undated" }
        : due < today
          ? { kind: "overdue", days: today - due }
          : { kind: "upcoming", days: due - today };
    return { ...d, state };
  });
}
