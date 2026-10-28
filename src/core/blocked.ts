/**
 * 受阻时段，存为任务行里的 JSON 字段（因此走命令栈、可 ⌘Z）。
 * `open: true` 的跨天推到今天并顺延任务（不进撤销栈，见 store.extendOpenBlockers）。
 */

import { dayToIso, isoToDay } from "../gantt/time";

export type BlockReason =
  | "quality"
  | "equipment"
  | "material"
  | "dependency"
  | "rework"
  | "other";

export const BLOCK_REASONS: { key: BlockReason; label: string }[] = [
  { key: "quality", label: "质量问题" },
  { key: "equipment", label: "设备故障" },
  { key: "material", label: "等料" },
  { key: "dependency", label: "外部依赖" },
  { key: "rework", label: "返工" },
  { key: "other", label: "其他" },
];

const REASON_KEYS = new Set(BLOCK_REASONS.map((r) => r.key));

export const reasonLabel = (key: BlockReason): string =>
  BLOCK_REASONS.find((r) => r.key === key)?.label ?? "其他";

export interface BlockedPeriod {
  /** 本地生成的稳定标识，用于列表 key 与删除 */
  id: string;
  /** 起止天序号，含首尾 */
  from: number;
  to: number;
  reason: BlockReason;
  /** 自由文本，优先于归类标签显示 */
  note?: string;
  /** 还卡着。缺省一律当已关闭，不能让新字段的默认值改写既有排期 */
  open?: boolean;
  /** 累计自动顺延天数，只由 extendOpenBlocks 写入；关闭后保留 */
  pushed?: number;
  /** P0–P3，可不填；空着就显示空槽，不伪造「中」 */
  priority?: 0 | 1 | 2 | 3;
  /** 如何解决，可不填（与风险强制填刻意相反） */
  resolution?: string;
}

/** 显示文案：自己写的说明优先于归类标签 */
export function describeBlocked(period: BlockedPeriod): string {
  return period.note?.trim() || reasonLabel(period.reason);
}

export function newBlockId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 裁到任务区间内；完全落在区间外返回 null */
export function clampToTask(
  period: BlockedPeriod,
  task: { startDay: number; endDay: number },
): BlockedPeriod | null {
  const from = Math.max(Math.floor(period.from), task.startDay);
  const to = Math.min(Math.floor(period.to), task.endDay);
  if (to < from) return null;
  return { ...period, from, to };
}

/** 任务日期变了之后重裁，丢掉落空的。持续中的不裁，否则拖一下就会静默丢失。 */
export function reclamp(
  periods: BlockedPeriod[],
  task: { startDay: number; endDay: number },
): BlockedPeriod[] {
  return periods.flatMap((p) => {
    if (p.open === true) return [p];
    const clamped = clampToTask(p, task);
    return clamped ? [clamped] : [];
  });
}

/** 合并重叠/相邻区间，避免半透明斜纹叠出深色糊斑 */
export function mergeRanges(periods: BlockedPeriod[]): [number, number][] {
  if (periods.length === 0) return [];

  const sorted = [...periods].sort((a, b) => a.from - b.from);
  const out: [number, number][] = [[sorted[0].from, sorted[0].to]];

  for (const p of sorted.slice(1)) {
    const last = out[out.length - 1];
    // +1：紧挨着的两段也并起来，否则凭空多一道断口
    if (p.from <= last[1] + 1) last[1] = Math.max(last[1], p.to);
    else out.push([p.from, p.to]);
  }
  return out;
}

/** 去重后的受阻天数 */
export function blockedDays(periods: BlockedPeriod[]): number {
  return mergeRanges(periods).reduce((sum, [from, to]) => sum + (to - from + 1), 0);
}

export function isBlockedOn(ranges: [number, number][], day: number): boolean {
  return ranges.some(([from, to]) => from <= day && day <= to);
}

export const openBlocks = (periods: BlockedPeriod[]): BlockedPeriod[] =>
  periods.filter((p) => p.open === true);

/** daysOf 的别名，两个名字都在用 */
export const blockedSpanDays = (period: BlockedPeriod, today: number): number =>
  daysOf(period, today);

/* ------------------------------------------------------------------ */
/* 未关闭的受阻：每日延长与手动关闭                                     */
/* ------------------------------------------------------------------ */

export interface BlockedHost {
  blocked: BlockedPeriod[];
  endDay: number;
  actualEndDay: number | null;
}

/**
 * 跨天：未关闭的段推到今天并顺延任务；无变化返回 null（每分钟调用，不写库）。
 * 顺延取各段最大值而非求和 —— 并开的段卡的是同一批日子。
 */
export function extendOpenBlocks(task: BlockedHost, today: number): Partial<BlockedHost> | null {
  let push = 0;

  const blocked = task.blocked.map((p) => {
    if (p.open !== true || p.to >= today) return p;
    const delta = today - p.to;
    push = Math.max(push, delta);
    return { ...p, to: today, pushed: (p.pushed ?? 0) + delta };
  });

  if (push === 0) return null;

  const out: Partial<BlockedHost> = { blocked, endDay: task.endDay + push };
  if (task.actualEndDay != null && task.actualEndDay < today) {
    out.actualEndDay = today;
  }
  return out;
}

/**
 * 手动关掉一段：`to` 停在昨天，否则卡片会在受阻列里赖到明天。
 * 今天才开的整段丢掉，免得留下 from > to 的空区间。
 */
export function closeBlocked(
  periods: BlockedPeriod[],
  periodId: string,
  today: number,
): BlockedPeriod[] {
  return periods.flatMap((p) => {
    if (p.id !== periodId) return [p];
    return closeOne(p, today);
  });
}

/** 关掉今天仍在生效的所有段 */
export function closeOpenBlocks(periods: BlockedPeriod[], today: number): BlockedPeriod[] {
  return periods.flatMap((p) => {
    const live = p.open === true || (p.from <= today && today <= p.to);
    return live ? closeOne(p, today) : [p];
  });
}

/**
 * 改一条阻碍的区间或「持续中」开关，并让任务腾出位置。起始日夹回任务开始日；
 * 结束日越界时拉长任务而非裁回（裁回表现为「调了没反应」）；开 open 时 to 顶到今天。
 */
export function fitBlocked(
  task: { blocked: BlockedPeriod[]; startDay: number; endDay: number; actualEndDay: number | null },
  period: BlockedPeriod,
  today: number,
): { blocked: BlockedPeriod[]; endDay?: number; actualEndDay?: number } | null {
  if (!task.blocked.some((p) => p.id === period.id)) return null;

  const from = Math.max(Math.floor(period.from), task.startDay);
  let to = Math.max(from, Math.floor(period.to));
  if (period.open === true) to = Math.max(to, today);

  const fitted: BlockedPeriod = { ...period, from, to };
  const blocked = task.blocked.map((p) => (p.id === period.id ? fitted : p));

  const out: { blocked: BlockedPeriod[]; endDay?: number; actualEndDay?: number } = { blocked };
  if (to > task.endDay) out.endDay = to;
  if (task.actualEndDay != null && task.actualEndDay < to) out.actualEndDay = to;
  return out;
}

export interface BlockerEntry {
  taskId: number;
  taskName: string;
  period: BlockedPeriod;
  days: number;
  live: boolean;
}

/** 全项目阻碍（含已关闭）摊平：持续中的在前，其余按起始日倒序 */
export function collectBlockers(
  tasks: { id: number; name: string; blocked: BlockedPeriod[] }[],
  today: number,
): BlockerEntry[] {
  const out: BlockerEntry[] = [];
  for (const task of tasks) {
    for (const period of task.blocked) {
      out.push({
        taskId: task.id,
        taskName: task.name || "未命名",
        period,
        days: daysOf(period, today),
        live: period.open === true,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      b.period.from - a.period.from ||
      a.period.id.localeCompare(b.period.id),
  );
}

/** 天数（含首尾），持续中的算到今天 */
export const daysOf = (period: BlockedPeriod, today: number): number =>
  Math.max(1, (period.open === true ? Math.max(period.to, today) : period.to) - period.from + 1);

function closeOne(period: BlockedPeriod, today: number): BlockedPeriod[] {
  const { open: _open, ...rest } = period;
  if (period.from >= today) return [];
  return [{ ...rest, to: Math.min(period.to, today - 1) }];
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/** 落库用 ISO 日期串而非天序号（后者依赖纪元常量） */
interface StoredPeriod {
  id: string;
  from: string;
  to: string;
  reason: string;
  note?: string;
  open?: boolean;
  pushed?: number;
  priority?: number;
  resolution?: string;
}

export function serializeBlocked(periods: BlockedPeriod[]): string {
  const rows: StoredPeriod[] = periods.map((p) => ({
    id: p.id,
    from: dayToIso(p.from),
    to: dayToIso(p.to),
    reason: p.reason,
    ...(p.note ? { note: p.note } : {}),
    ...(p.open ? { open: true } : {}),
    ...(p.pushed ? { pushed: p.pushed } : {}),
    // 0 是 P0，不能用真值判断
    ...(p.priority != null ? { priority: p.priority } : {}),
    ...(p.resolution ? { resolution: p.resolution } : {}),
  }));
  return JSON.stringify(rows);
}

/** 解析不了的条目跳过，不让整个项目打不开 */
export function parseBlocked(raw: string): BlockedPeriod[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: BlockedPeriod[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<StoredPeriod>;
    if (typeof row.from !== "string" || typeof row.to !== "string") continue;

    let from: number;
    let to: number;
    try {
      from = isoToDay(row.from);
      to = isoToDay(row.to);
    } catch {
      continue;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;

    out.push({
      id: typeof row.id === "string" && row.id ? row.id : newBlockId(),
      from,
      to,
      reason:
        typeof row.reason === "string" && REASON_KEYS.has(row.reason as BlockReason)
          ? (row.reason as BlockReason)
          : "other",
      ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
      ...(row.open === true ? { open: true } : {}),
      ...(typeof row.pushed === "number" && row.pushed > 0
        ? { pushed: Math.floor(row.pushed) }
        : {}),
      ...(typeof row.priority === "number" && row.priority >= 0 && row.priority <= 3
        ? { priority: Math.round(row.priority) as 0 | 1 | 2 | 3 }
        : {}),
      ...(typeof row.resolution === "string" && row.resolution.trim()
        ? { resolution: row.resolution.trim() }
        : {}),
    });
  }
  return out;
}
