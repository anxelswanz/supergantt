/**
 * 里程碑的状态：给里程碑页的倒计时、逾期、达成用。纯函数。
 *
 * 规则：
 * - 关联了任务：**全部做完**（进度 100%）就算达成，达成那天取这些任务里最晚的实际完成日
 *   （没记实际完成日的退回计划结束日）。没做完：日期还没到是倒计时，过了是逾期
 * - 没关联任务：没有东西能告诉我们做没做完，只看日期 —— 还没到是倒计时，到了就算达成
 *
 * 天数是日历天，不扣周末：倒计时回答的是「离那天还有几天」，不是「还有几个工作日」。
 */

import type { Milestone } from "../db/api";
import { isoToDay } from "../gantt/time";

/** 判状态只要这几样，ResolvedTask 天然满足 */
export interface MilestoneTask {
  id: number;
  name: string;
  progress: number;
  endDay: number;
  actualEndDay: number | null;
}

export type MilestoneStatus =
  | { kind: "upcoming"; daysLeft: number }
  | { kind: "overdue"; daysLate: number }
  /** delta：达成日 - 计划日。负数 = 提前，0 = 当天，正数 = 晚了 */
  | { kind: "hit"; reachedDay: number; delta: number };

export interface MilestoneInfo {
  milestone: Milestone;
  day: number;
  status: MilestoneStatus;
  /** 关联任务里还在的那些（被删的任务不算） */
  tasks: MilestoneTask[];
  done: number;
  /** 关联任务的平均进度 0–1；没关联任务时为 null */
  progress: number | null;
}

export function milestoneInfo(
  m: Milestone,
  taskById: Map<number, MilestoneTask>,
  today: number,
): MilestoneInfo {
  const day = isoToDay(m.date);
  const tasks = m.taskIds.map((id) => taskById.get(id)).filter((t): t is MilestoneTask => !!t);
  const done = tasks.filter((t) => t.progress >= 1).length;
  const progress = tasks.length ? tasks.reduce((s, t) => s + Math.min(1, Math.max(0, t.progress)), 0) / tasks.length : null;

  let status: MilestoneStatus;
  if (tasks.length > 0 && done === tasks.length) {
    const reachedDay = Math.max(...tasks.map((t) => t.actualEndDay ?? t.endDay));
    status = { kind: "hit", reachedDay, delta: reachedDay - day };
  } else if (day >= today) {
    status = { kind: "upcoming", daysLeft: day - today };
  } else if (tasks.length === 0) {
    status = { kind: "hit", reachedDay: day, delta: 0 };
  } else {
    status = { kind: "overdue", daysLate: today - day };
  }
  return { milestone: m, day, status, tasks, done, progress };
}

/**
 * 页面上的分组：逾期的（拖得最久的在前）→ 接下来的（最近的在前）→ 已达成（最近达成的在前）。
 * next 是最近的那个还没到的 —— 页面顶上的大倒计时
 */
export function groupMilestones(list: MilestoneInfo[]) {
  const overdue = list
    .filter((i) => i.status.kind === "overdue")
    .sort((a, b) => a.day - b.day);
  const upcoming = list
    .filter((i) => i.status.kind === "upcoming")
    .sort((a, b) => a.day - b.day || a.milestone.sortOrder - b.milestone.sortOrder);
  const hit = list
    .filter((i) => i.status.kind === "hit")
    .sort((a, b) => b.day - a.day);
  return { overdue, upcoming, hit, next: upcoming[0] ?? null };
}
