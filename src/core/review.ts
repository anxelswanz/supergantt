/**
 * 复盘：把「计划与实际的差」算成可以交出去的东西。
 *
 * 这个文件是产品的高光时刻背后的算术 —— 月底那句"这活为什么比计划晚了六天、
 * 其中三天是等料"，就是下面这几个函数的输出。
 *
 * 全部是纯函数：不碰 UI、不碰数据库。复盘视图和 Excel 导出必须读同一份计算，
 * 否则屏幕上写偏差 6 天、发出去的文件写 5 天，这份东西就一文不值了。
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
  /** 实际结束比计划晚几天 */
  endDelta: number;
  /** 实际工期比计划长几天 */
  durationDelta: number;
  /** 这条任务累计受阻多少天（同一天被多段覆盖只算一次） */
  blockedDays: number;
}

/** 一段区间里有多少天（含首尾） */
const daysIn = (from: number, to: number) => Math.max(0, to - from + 1);

/** 受阻总天数，重叠的段先合并 —— 两段各三天但完全重叠，丢的是三天不是六天 */
export function blockedDaysOf(task: Pick<ResolvedTask, "blocked">): number {
  return mergeRanges(task.blocked).reduce((sum, [f, t]) => sum + daysIn(f, t), 0);
}

/**
 * 逐条任务的偏差。
 *
 * 只算叶子任务。父任务的日期是子任务汇总出来的，它的"偏差"是派生量 ——
 * 列进去等于把同一份延期数了两遍，总数立刻失真。
 */
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

/**
 * 排序：**最该被解释的排最前**。
 *
 * 不是按时间排也不是按名字排 —— 月底汇报时你从上往下讲，讲到没时间为止，
 * 那么排在最上面的必须是延得最狠的那几条。已经做完的排在未完成之后：
 * 一件晚了三天但交付了的活，不如一件晚了三天还没交的活值得说。
 */
export const byUrgency = (a: Deviation, b: Deviation): number => {
  const done = (d: Deviation) => (d.task.progress >= 1 ? 1 : 0);
  return done(a) - done(b) || b.endDelta - a.endDelta || b.blockedDays - a.blockedDays;
};

export interface Attribution {
  reason: BlockReason;
  label: string;
  /** 这个原因累计占了多少天（同一原因内部重叠的段已合并） */
  days: number;
  /** 涉及多少条任务 */
  taskCount: number;
}

/**
 * 受阻归因：这段时间丢掉的天数，都丢在什么上。
 *
 * 按原因分别合并区间，所以**各原因天数之和可能大于日历天数** —— 同一天
 * 既在等料又在返工是完全可能的，把它压成一天反而抹掉了信息。这里回答的是
 * "等料一共拖了多少天"，不是"日历上有多少天是废的"。
 */
export function attribution(tasks: ResolvedTask[]): Attribution[] {
  const byReason = new Map<BlockReason, { ranges: [number, number][]; tasks: Set<number> }>();

  for (const task of tasks) {
    if (task.hasChildren) continue; // 受阻记在叶子上，父任务不重复计
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
      // 同一原因下重叠的段合并：三号机连着两条工单都记了「设备故障」，
      // 那是同一段停机，不是两段
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
  /** 已经开工（有实施日期或进度 > 0）但没做完 */
  runningCount: number;
  /** 还没填过实施日期的条数 —— 复盘里这批是"计划里有、现实中还没影"的 */
  untouchedCount: number;
  /** 工期加权总进度 */
  progress: number;
  /** 计划区间与实际区间（实际区间只统计填过实施日期的任务） */
  plan: Span | null;
  actual: Span | null;
  /** 项目层面的收尾偏差：最晚实际结束 − 最晚计划结束 */
  endDelta: number;
  /** 全项目累计受阻天数（跨任务不合并，各算各的） */
  blockedDays: number;
  /** 结束日晚于计划的任务条数 */
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
    // 两端都要有才谈得上偏差 —— 一个还没开工的项目不该显示"提前了 N 天"
    endDelta: plan && actual ? actual.endDay - plan.endDay : 0,
    blockedDays,
    lateCount: late,
  };
}

/** 里程碑单独拎出来：汇报现场真正被追问的就是这几个点 */
export function milestones(tasks: ResolvedTask[]): Deviation[] {
  return deviations(tasks)
    .filter((d) => d.task.milestone)
    .sort((a, b) => a.plan.startDay - b.plan.startDay);
}
