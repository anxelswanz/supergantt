/**
 * 时间线：把记录按「发生在哪一天」并成流水。来源有 daily_notes、开工/完工、
 * 受阻段、风险。受阻只在起始日产出一条（带天数），不逐天铺开。
 */

import { blockedDays, describeBlocked, type BlockedPeriod } from "./blocked";
import { dayToIso, isoToDay } from "../gantt/time";
import type { ResolvedTask } from "../gantt/model";
import type { DailyNote, Risk } from "../db/api";

export type EventKind = "note" | "start" | "finish" | "blocked" | "risk";

export interface TimelineEvent {
  kind: EventKind;
  /** 同一天内排序用的稳定键 */
  key: string;
  /** 挂在哪条任务上；项目级记录为 null */
  task: ResolvedTask | null;
  text: string;
  /** 受阻事件的持续天数 */
  days?: number;
  /** 只有 carriedBlocks 产出的受阻才有：卡住的起始日 */
  since?: number;
  /** 阻碍还没关，天数还会涨 */
  unresolved?: boolean;
  /** 风险等级 0 高 / 1 中 / 2 低 */
  level?: number;
  /** 手写记录才有，用于编辑与删除 */
  note?: DailyNote;
  /** 这条记录是不是事后补记的（写下的日子晚于它所说的日子） */
  backdated?: boolean;
}

export interface TimelineDay {
  day: number;
  iso: string;
  events: TimelineEvent[];
}

/**
 * 同一天内的先后：先事实（开工/完工），再问题（受阻/风险），最后解释（手记）。
 * 按写入时间排会让解释飘在它解释的事前面。
 */
const ORDER: Record<EventKind, number> = {
  start: 0,
  finish: 1,
  blocked: 2,
  risk: 3,
  note: 4,
};

const unixToDay = (seconds: number): number =>
  isoToDay(new Date(seconds * 1000).toISOString().slice(0, 10));

export function buildTimeline(
  tasks: ResolvedTask[],
  notes: DailyNote[],
  risks: Risk[],
): TimelineDay[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const buckets = new Map<number, TimelineEvent[]>();

  const push = (day: number, event: TimelineEvent) => {
    const list = buckets.get(day);
    if (list) list.push(event);
    else buckets.set(day, [event]);
  };

  for (const task of tasks) {
    // 父任务日期是汇总值，记进时间线等于同一件事说两遍
    if (task.hasChildren) continue;

    if (task.actualStartDay != null) {
      push(task.actualStartDay, {
        kind: "start",
        key: `s${task.id}`,
        task,
        text: "开工",
      });
    }
    // 进度未满不算完工：那天只是排到这儿，不是干完了
    if (task.actualEndDay != null && task.progress >= 1) {
      push(task.actualEndDay, {
        kind: "finish",
        key: `f${task.id}`,
        task,
        text: "完成",
      });
    }

    for (const b of task.blocked as BlockedPeriod[]) {
      push(b.from, {
        kind: "blocked",
        key: `b${task.id}-${b.id}`,
        task,
        text: describeBlocked(b),
        days: b.to - b.from + 1,
        // 没关掉要标出来：天数还会涨，不是最终结果
        ...(b.open === true ? { unresolved: true } : {}),
      });
    }
  }

  for (const r of risks) {
    const task = byId.get(r.taskId);
    if (!task) continue;
    push(unixToDay(r.createdAt), {
      kind: "risk",
      key: `r${r.id}`,
      task,
      text: r.content,
      level: r.level,
    });
  }

  for (const n of notes) {
    const day = isoToDay(n.day);
    push(day, {
      kind: "note",
      key: `n${n.id}`,
      task: n.taskId != null ? (byId.get(n.taskId) ?? null) : null,
      text: n.content,
      note: n,
      // 写下日 > 记录日 = 事后补记，复盘时要看得见
      backdated: unixToDay(n.createdAt) > day,
    });
  }

  return [...buckets.entries()]
    .map(([day, events]) => ({
      day,
      iso: dayToIso(day),
      events: events.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key)),
    }))
    // 倒序：最近的一天在最上面
    .sort((a, b) => b.day - a.day);
}

/** 日期筛选区间，首尾都含 */
export interface DayRange {
  from: number;
  to: number;
}

/** 两次点选不保证先后，这里摆正 */
export const normalizeRange = (a: number, b: number): DayRange =>
  a <= b ? { from: a, to: b } : { from: b, to: a };

/** 只留区间内的天；不传区间原样返回 */
export const clipTimeline = (days: TimelineDay[], range: DayRange | null): TimelineDay[] =>
  range ? days.filter((d) => d.day >= range.from && d.day <= range.to) : days;

/**
 * 区间开始前就卡住、区间内仍未解除的受阻。按日期裁剪会把它们整条裁掉，
 * 于是单独捞出：界面置顶显示，不混进具体某天。
 */
export function carriedBlocks(tasks: ResolvedTask[], range: DayRange | null): TimelineEvent[] {
  if (!range) return [];
  const out: (TimelineEvent & { since: number })[] = [];
  for (const task of tasks) {
    if (task.hasChildren) continue;
    for (const b of task.blocked as BlockedPeriod[]) {
      if (b.from >= range.from || b.to < range.from) continue;
      out.push({
        kind: "blocked",
        key: `c${task.id}-${b.id}`,
        task,
        text: describeBlocked(b),
        days: b.to - b.from + 1,
        since: b.from,
        ...(b.open === true ? { unresolved: true } : {}),
      });
    }
  }
  // 卡得最久的排最前
  return out.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

/** 一件活的履历：把流水里的「开工」和「完成」配成一对。 */
export interface Career {
  task: ResolvedTask;
  start: number;
  /** 完成日，还在干为 null。判据与「完成」事件一致 */
  end: number | null;
  /** 画到哪天为止：完成日或今天 */
  until: number;
  /** 从开工到 until 的自然日数，含首尾 */
  days: number;
  /** 落在 [start, until] 内的受阻段，已夹到区间内 */
  blocked: { from: number; to: number }[];
  /** 去重后的受阻天数 */
  blockedDays: number;
}

export function buildCareers(
  tasks: ResolvedTask[],
  now: number,
  range: DayRange | null = null,
): Career[] {
  const out: Career[] = [];
  for (const task of tasks) {
    // 同 buildTimeline：父任务日期是汇总值
    if (task.hasChildren || task.actualStartDay == null) continue;

    const start = task.actualStartDay;
    const end = task.actualEndDay != null && task.progress >= 1 ? task.actualEndDay : null;
    const until = Math.max(start, end ?? now);
    if (range && (start > range.to || until < range.from)) continue;

    const clipped = (task.blocked as BlockedPeriod[])
      .filter((b) => b.to >= start && b.from <= until)
      .map((b) => ({ ...b, from: Math.max(b.from, start), to: Math.min(b.to, until) }));

    out.push({
      task,
      start,
      end,
      until,
      days: until - start + 1,
      blocked: clipped.map(({ from, to }) => ({ from, to })),
      blockedDays: blockedDays(clipped),
    });
  }
  // 还在干的在前（最近开工在上），然后是做完的（最近完成在上）
  return out.sort(
    (a, b) =>
      Number(a.end != null) - Number(b.end != null) ||
      (a.end != null ? b.until - a.until : b.start - a.start) ||
      a.task.id - b.task.id,
  );
}

/** 有内容的日子 —— 甘特据此在日期轴上打点 */
export const daysWithEvents = (days: TimelineDay[]): Set<number> =>
  new Set(days.map((d) => d.day));
