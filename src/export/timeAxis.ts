/**
 * 导出用的时间轴分桶：Excel 单元格是离散的，不能复用连续的 viewport/scale，一列 = 一个桶。
 * 粒度按项目总跨度选，保证列数一屏看得完。纯函数，便于单测差一天的错误。
 */

import { dayToDate } from "../gantt/time";

export type AxisUnit = "day" | "week" | "month";

export interface Bucket {
  /** 桶覆盖的第一天（含） */
  startDay: number;
  /** 桶覆盖的最后一天（含） */
  endDay: number;
  /** 列头下行：日期号 / 周首日 / 月份 */
  label: string;
  /** 列头上行：用于合并同组单元格的键，如 "2026年9月" */
  group: string;
  /** 整桶都不干活（只有日粒度才可能为 true） */
  rest: boolean;
}

/** 列数上限，超过就降一档粒度 */
const MAX_DAY_COLUMNS = 120;
const MAX_WEEK_COLUMNS = 90;

export function pickUnit(totalDays: number): AxisUnit {
  if (totalDays <= MAX_DAY_COLUMNS) return "day";
  if (totalDays <= MAX_WEEK_COLUMNS * 7) return "week";
  return "month";
}

/** 该天所在周的周一。0 = 周日，所以周日要往回退 6 天而不是 1 天。 */
function mondayOf(day: number): number {
  const wd = dayToDate(day).getUTCDay();
  return day - ((wd + 6) % 7);
}

/** 该天所在月的 1 号 */
function firstOfMonth(day: number): number {
  const d = dayToDate(day);
  return day - (d.getUTCDate() - 1);
}

function daysInMonth(day: number): number {
  const d = dayToDate(day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * 把 [fromDay, toDay] 切成桶。两端外扩到桶边界，保证每列宽度含义一致。
 * @param isRest 判断某天是否不干活；只在日粒度下会被调用
 */
export function buildBuckets(
  fromDay: number,
  toDay: number,
  unit: AxisUnit,
  isRest: (day: number) => boolean,
): Bucket[] {
  const buckets: Bucket[] = [];
  if (toDay < fromDay) return buckets;

  if (unit === "day") {
    for (let d = fromDay; d <= toDay; d++) {
      const date = dayToDate(d);
      buckets.push({
        startDay: d,
        endDay: d,
        label: String(date.getUTCDate()),
        group: `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`,
        rest: isRest(d),
      });
    }
    return buckets;
  }

  if (unit === "week") {
    for (let d = mondayOf(fromDay); d <= toDay; d += 7) {
      const date = dayToDate(d);
      buckets.push({
        startDay: d,
        endDay: d + 6,
        label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
        group: `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`,
        rest: false,
      });
    }
    return buckets;
  }

  let d = firstOfMonth(fromDay);
  while (d <= toDay) {
    const len = daysInMonth(d);
    const date = dayToDate(d);
    buckets.push({
      startDay: d,
      endDay: d + len - 1,
      label: `${date.getUTCMonth() + 1}月`,
      group: `${date.getUTCFullYear()}年`,
      rest: false,
    });
    d += len;
  }
  return buckets;
}

/** 一个格子相对于某根条子的角色 */
export type CellKind = "none" | "track" | "fill" | "milestone";

/**
 * 求一根条子在每个桶里占什么。边界 = 开始 + 工期 × 进度，之前画实心、之后画轨道。
 * 判定用桶与条子交集的中点，不是桶中点：否则月粒度下只占月末三天的条子会被判成未开始。
 */
export function barCells(
  task: { startDay: number; endDay: number; progress: number; milestone: boolean },
  buckets: Bucket[],
): CellKind[] {
  const out: CellKind[] = new Array(buckets.length).fill("none");

  if (task.milestone) {
    // 里程碑是时间点不是区间，只点亮它所在的那一格
    const i = buckets.findIndex(
      (b) => b.startDay <= task.startDay && task.startDay <= b.endDay,
    );
    if (i >= 0) out[i] = "milestone";
    return out;
  }

  const duration = Math.max(1, task.endDay - task.startDay + 1);
  const boundary = task.startDay + duration * clamp01(task.progress);

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.endDay < task.startDay || task.endDay < b.startDay) continue;
    const s = Math.max(b.startDay, task.startDay);
    const e = Math.min(b.endDay, task.endDay);
    out[i] = (s + e + 1) / 2 <= boundary ? "fill" : "track";
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 把带透明度的颜色与白纸合成为实色：Excel 等渲染器忽略 ARGB 的 A 通道。 */
export function flatten(hex: string, alpha: number, over = [255, 255, 255]): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * alpha + over[i] * (1 - alpha)));
  return mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}
