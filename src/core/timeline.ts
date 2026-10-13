/**
 * 时间线：把散落在四处的记录，按「发生在哪一天」并成一条流水。
 *
 * 甘特图按**任务**组织（一行一件活），时间线按**日期**组织（一天一段）。
 * 同一批数据，问法不同：甘特问"这件活排在哪"，时间线问"那天到底怎么了"。
 *
 * 四个来源：
 *   · daily_notes  —— 手写的当日记录，可挂任务也可不挂（项目级）
 *   · 实施日期      —— 开工、完工这两个事件
 *   · 受阻时段      —— 只在**起始日**产生一条事件，带上持续天数
 *   · 风险          —— 按记下的那天落位
 *
 * 受阻为什么不逐天铺开：一段等料 5 天会变成 5 条一模一样的记录，把真正
 * 发生了什么的那几天淹掉。持续时间写在事件里（"等料 · 5 天"），信息不丢。
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
  /** 只有 carriedBlocks 捞出来的受阻才有：它是从哪天开始卡的 */
  since?: number;
  /** 受阻事件：这条阻碍到现在还没关掉，天数每天还在长 */
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
 * 同一天内的先后：**先说发生了什么事，再说人写了什么**。
 *
 * 开工/完工是客观事件，受阻和风险是问题，手写记录是解释。按这个顺序读下来
 * 才是一段能讲的话；按写入时间排的话，一段解释会飘在它解释的那件事前面。
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
    // 父任务的日期是汇总值，它的"开工/完工"是派生的，记进时间线等于
    // 把同一件事说两遍
    if (task.hasChildren) continue;

    if (task.actualStartDay != null) {
      push(task.actualStartDay, {
        kind: "start",
        key: `s${task.id}`,
        task,
        text: "开工",
      });
    }
    // 只有真做完了才算完工事件。实施结束日到了但进度没满，那是"排到这天"，
    // 不是"这天完成了" —— 后者是个会被写进汇报的事实，不能靠日期猜
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
        // 没关掉的那条要标出来：它的天数明天还会变，读的人得知道
        // 自己看到的是一个还在走的数，不是最终结果
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
      // 写下的那天晚于它说的那天 = 事后补记。复盘时这件事要看得见：
      // 当时的判断和事后的追认，分量不一样
      backdated: unixToDay(n.createdAt) > day,
    });
  }

  return [...buckets.entries()]
    .map(([day, events]) => ({
      day,
      iso: dayToIso(day),
      events: events.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key)),
    }))
    // 倒序：最近的一天在最上面。时间线是用来回顾的，而"最近"永远是
    // 被问得最多的那一段
    .sort((a, b) => b.day - a.day);
}

/** 日期筛选的区间，首尾都含。单日就是 from === to */
export interface DayRange {
  from: number;
  to: number;
}

/** 两次点选不保证先早后晚，这里统一摆正 */
export const normalizeRange = (a: number, b: number): DayRange =>
  a <= b ? { from: a, to: b } : { from: b, to: a };

/** 只留下落在区间里的那些天。不传区间就是原样 */
export const clipTimeline = (days: TimelineDay[], range: DayRange | null): TimelineDay[] =>
  range ? days.filter((d) => d.day >= range.from && d.day <= range.to) : days;

/**
 * 区间开始之前就卡住、到区间里还没放开的那些受阻。
 *
 * 受阻只在起始日落一条（见文件头），于是按日期裁剪会把它们整条裁掉 ——
 * 而筛「10 月 6 日那天怎么了」时，最要紧的答案恰恰可能是「那天正卡着」。
 * 所以单独捞出来，由界面置顶显示，不混进任何一天里：它确实不是那天发生的事。
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

/**
 * 一件活的履历：把流水里隔着几十行的「开工」和「完成」配成一对。
 *
 * 流水按天排，答得了「那天怎么了」，答不了「这件活从哪天干到哪天」——
 * 这两个事件之间可能隔着整整一个月的别的记录。
 */
export interface Career {
  task: ResolvedTask;
  start: number;
  /** 完成日。还在干就是 null —— 判据和时间线上的「完成」事件是同一条 */
  end: number | null;
  /** 画到哪天为止：完成日，或者今天 */
  until: number;
  /** 从开工到 until 的自然日数，含首尾 */
  days: number;
  /** 落在 [start, until] 里的受阻段，已经夹到这个区间内 */
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
    // 父任务的日期是汇总值，同 buildTimeline
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
  // 还在干的排前面（最近开工的在最上），然后是做完的（最近完成的在最上）
  return out.sort(
    (a, b) =>
      Number(a.end != null) - Number(b.end != null) ||
      (a.end != null ? b.until - a.until : b.start - a.start) ||
      a.task.id - b.task.id,
  );
}

/** 某一天有没有内容 —— 甘特上要据此在日期轴上打点 */
export const daysWithEvents = (days: TimelineDay[]): Set<number> =>
  new Set(days.map((d) => d.day));
