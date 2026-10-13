/**
 * 项目快照：把一个项目此刻的样子拼成一份能原样交给模型的数据。
 *
 * 纯函数。数字全部来自 core/review.ts —— 复盘页、Excel、AI 复盘文档里的
 * 「晚 6 天、其中 3 天等料」必须是同一份计算（那个文件开头说过为什么）。
 *
 * ## 超量时只留重要的
 *
 * 模型看得越多不等于问得越好。一个跑了半年的项目可能有上百条阻碍和事项，
 * 全塞进去，真正该被追问的那三件事就淹在里面了。所以每一类都有上限，
 * 超过上限时**按重要性排序、只留前面的**，并在 `omitted` 里记下丢了几条 ——
 * 页面上会注明，模型也会被告知「你看到的不是全部」。
 *
 * 汇总数字（总受阻天数、受阻归因、超期条数）**始终按全量算**，不受上限影响：
 * 被省掉的只是明细，不是它们对总数的贡献。
 */

import type { DailyNote, ItemKind, ItemNote, Person, Risk } from "../db/api";
import { describeBlocked, reasonLabel } from "../core/blocked";
import { kindLabel } from "../core/items";
import { attribution, deviations, milestones, summarize, type Deviation } from "../core/review";
import { riskLevelLabel } from "../core/risks";
import type { ResolvedTask } from "../gantt/model";
import { dayToIso, isoToDay } from "../gantt/time";
import type {
  SnapBlocker,
  SnapItem,
  SnapNote,
  SnapRisk,
  SnapSpan,
  SnapTask,
  Snapshot,
} from "./types";

/** 每一类最多带多少条明细 */
export const LIMITS = { tasks: 40, blockers: 25, risks: 25, items: 25, notes: 30 } as const;

/** 单段自由文本最多多少字。一条粘贴进来的会议纪要不该挤掉另外二十条记录 */
const TEXT_MAX = 300;

const clip = (s: string | null | undefined): string => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
};

const unixToIso = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

const span = (s: { startDay: number; endDay: number } | null): SnapSpan | null =>
  s ? { start: dayToIso(s.startDay), end: dayToIso(s.endDay) } : null;

const priorityTag = (p: number | null | undefined): string | null =>
  p == null ? null : `P${Math.min(3, Math.max(0, Math.round(p)))}`;

/** 取前 n 个，并报告丢了几个 */
function take<T>(sorted: T[], limit: number): { kept: T[]; dropped: number } {
  return { kept: sorted.slice(0, limit), dropped: Math.max(0, sorted.length - limit) };
}

/* ------------------------------------------------------------------ */
/* 重要性                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一条任务值不值得在复盘里被提到。
 *
 * 偏差取绝对值：**提前完成的也重要** —— 成功归因要问的就是「这条为什么比
 * 计划快」。受阻天数直接相加，里程碑和没做完的各加一点分：它们即使偏差
 * 不大，也是汇报时一定会被问到的。
 */
export function taskWeight(d: Deviation): number {
  return (
    Math.abs(d.endDelta) +
    Math.abs(d.startDelta) * 0.5 +
    d.blockedDays +
    (d.task.milestone ? 3 : 0) +
    (d.task.progress < 1 ? 2 : 0)
  );
}

/**
 * 一段阻碍有多重要：卡了几天是主体，还卡着的和标了高优先级的往前提。
 *
 * 不用「优先级优先」的字典序：大部分阻碍是 ⌥ 在甘特条上拖出来的，没有
 * 优先级 —— 那样排的话，一段没标优先级的 20 天停工会排在一段 P1 的半天
 * 小卡顿后面，而复盘最该问的恰恰是前者。
 */
export function blockerWeight(b: Pick<SnapBlocker, "days" | "open" | "priority">): number {
  const bonus = b.priority === "P0" ? 10 : b.priority === "P1" ? 5 : b.priority === "P3" ? -2 : 0;
  return b.days + (b.open ? 5 : 0) + bonus;
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

export interface SnapshotInput {
  projectName: string;
  /** 已汇总、**全部展开**的任务（折叠是浏览状态，不是项目内容） */
  tasks: ResolvedTask[];
  people: Person[];
  risks: Risk[];
  dailyNotes: DailyNote[];
  itemNotes: ItemNote[];
  itemKinds: ItemKind[];
  /** 今天的天序号 */
  today: number;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { tasks, people, risks, dailyNotes, itemNotes, itemKinds } = input;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const personName = (id: number | null): string | null =>
    id == null ? null : (people.find((p) => p.id === id)?.name ?? null);
  const taskName = (id: number | null | undefined): string | null => {
    if (id == null) return null;
    const t = byId.get(id);
    return t ? t.name || "未命名" : null;
  };
  /** 顶层祖先的名字：这条活属于哪个阶段。带环的脏数据最多走 64 层就停 */
  const groupOf = (t: ResolvedTask): string | null => {
    let cur = t;
    for (let i = 0; i < 64 && cur.parentId != null; i++) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur.id === t.id ? null : cur.name || "未命名";
  };

  const summary = summarize(tasks);
  const devs = deviations(tasks);

  /* ---- 任务 ---- */
  const rankedTasks = [...devs].sort((a, b) => taskWeight(b) - taskWeight(a) || a.task.id - b.task.id);
  const keptTasks = take(rankedTasks, LIMITS.tasks);
  /** 哪些任务「有事」：逐日记录按它决定先留谁 */
  const notable = new Set(
    devs.filter((d) => d.endDelta !== 0 || d.blockedDays > 0).map((d) => d.task.id),
  );

  const snapTasks: SnapTask[] = keptTasks.kept.map((d) => ({
    name: d.task.name || "未命名",
    group: groupOf(d.task),
    owner: personName(d.task.personId),
    plan: span(d.plan)!,
    actual: span(d.actual),
    startDelta: d.startDelta,
    endDelta: d.endDelta,
    durationDelta: d.durationDelta,
    blockedDays: d.blockedDays,
    progress: Math.round(d.task.progress * 100),
    milestone: d.task.milestone,
  }));

  /* ---- 阻碍 ---- */
  const allBlockers: SnapBlocker[] = [];
  for (const t of tasks) {
    if (t.hasChildren) continue; // 受阻记在叶子上，和 review.attribution 同一个口径
    for (const p of t.blocked) {
      allBlockers.push({
        task: t.name || "未命名",
        reason: reasonLabel(p.reason),
        // 自己写了说明才带；没写的话 describeBlocked 会退回归类标签，和 reason 重复
        note: p.note?.trim() ? clip(describeBlocked(p)) : "",
        from: dayToIso(p.from),
        to: dayToIso(p.to),
        days: Math.max(0, p.to - p.from + 1),
        open: p.open === true,
        pushed: p.pushed ?? 0,
        priority: priorityTag(p.priority),
        resolution: clip(p.resolution),
      });
    }
  }
  allBlockers.sort((a, b) => blockerWeight(b) - blockerWeight(a) || a.from.localeCompare(b.from));
  const keptBlockers = take(allBlockers, LIMITS.blockers);

  /* ---- 风险 ----
     等级高的在前，其次看优先级，再其次还没关的在前 —— 「高风险最后怎么收场的」
     是复盘里最有信息量的一类，不管它现在关没关 */
  const rankedRisks = [...risks].sort(
    (a, b) =>
      a.level - b.level ||
      (a.priority ?? 2) - (b.priority ?? 2) ||
      Number(a.resolved) - Number(b.resolved) ||
      a.createdAt - b.createdAt,
  );
  const keptRisks = take(rankedRisks, LIMITS.risks);
  const snapRisks: SnapRisk[] = keptRisks.kept.map((r) => ({
    task: taskName(r.taskId) ?? "（任务已删除）",
    content: clip(r.content),
    level: riskLevelLabel(r.level),
    priority: priorityTag(r.priority),
    resolved: r.resolved,
    resolution: clip(r.resolution),
    raisedOn: unixToIso(r.createdAt),
    resolvedOn: r.resolvedAt != null ? unixToIso(r.resolvedAt) : null,
  }));

  /* ---- 事项 ----
     已经分拣成阻碍或风险的不再列：那两类上面已经有了，再列一遍模型会当成两件事。
     优先级高的在前；同优先级里「问题」排在代办前面（复盘要的是出过的事，不是
     待办清单），再其次是还开着的、最近记的 */
  const rankedItems = itemNotes
    .filter((n) => n.promotedKind == null)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        Number(b.kind === "issue") - Number(a.kind === "issue") ||
        Number(a.closedAt != null) - Number(b.closedAt != null) ||
        b.createdAt - a.createdAt,
    );
  const keptItems = take(rankedItems, LIMITS.items);
  const snapItems: SnapItem[] = keptItems.kept.map((n) => ({
    title: clip(n.name),
    kind: kindLabel(n.kind, itemKinds),
    priority: priorityTag(n.priority)!,
    owner: personName(n.personId),
    task: taskName(n.taskId),
    closed: n.closedAt != null,
    resolution: clip(n.resolution),
    raisedOn: unixToIso(n.createdAt),
  }));

  /* ---- 逐日记录 ----
     挂在「有事」的任务上的先留 —— 那是当时的人对那次延期或受阻的第一手说法。
     其余按日期从近到远。留下来的再按日期正序排，读起来是一条时间线 */
  const rankedNotes = [...dailyNotes]
    .filter((n) => n.content.trim() !== "")
    .sort(
      (a, b) =>
        Number(b.taskId != null && notable.has(b.taskId)) -
          Number(a.taskId != null && notable.has(a.taskId)) ||
        isoToDay(b.day) - isoToDay(a.day) ||
        b.id - a.id,
    );
  const keptNotes = take(rankedNotes, LIMITS.notes);
  const snapNotes: SnapNote[] = keptNotes.kept
    .map((n) => ({ day: n.day, task: taskName(n.taskId), content: clip(n.content) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    version: 1,
    takenOn: dayToIso(input.today),
    projectName: input.projectName,
    summary: {
      leafCount: summary.leafCount,
      doneCount: summary.doneCount,
      runningCount: summary.runningCount,
      untouchedCount: summary.untouchedCount,
      lateCount: summary.lateCount,
      progress: Math.round(summary.progress * 100),
      plan: span(summary.plan),
      actual: span(summary.actual),
      endDelta: summary.endDelta,
      blockedDays: summary.blockedDays,
      openRisks: risks.filter((r) => !r.resolved).length,
      closedRisks: risks.filter((r) => r.resolved).length,
    },
    attribution: attribution(tasks).map((a) => ({
      reason: a.label,
      days: a.days,
      taskCount: a.taskCount,
    })),
    milestones: milestones(tasks).map((d) => ({
      name: d.task.name || "未命名",
      plan: dayToIso(d.plan.startDay),
      actual: d.actual ? dayToIso(d.actual.startDay) : null,
      delta: d.startDelta,
    })),
    tasks: snapTasks,
    blockers: keptBlockers.kept,
    risks: snapRisks,
    items: snapItems,
    notes: snapNotes,
    omitted: {
      tasks: keptTasks.dropped,
      blockers: keptBlockers.dropped,
      risks: keptRisks.dropped,
      items: keptItems.dropped,
      notes: keptNotes.dropped,
    },
  };
}

/** 「因为太多没全带上」的一句话说明；什么都没省就是 null */
export function omittedNote(s: Snapshot): string | null {
  const parts = [
    s.omitted.tasks > 0 && `任务 ${s.omitted.tasks} 条`,
    s.omitted.blockers > 0 && `阻碍 ${s.omitted.blockers} 段`,
    s.omitted.risks > 0 && `风险 ${s.omitted.risks} 条`,
    s.omitted.items > 0 && `事项 ${s.omitted.items} 条`,
    s.omitted.notes > 0 && `逐日记录 ${s.omitted.notes} 条`,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : null;
}
