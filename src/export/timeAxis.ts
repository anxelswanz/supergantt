/**
 * 导出用的时间轴分桶。
 *
 * 屏幕上的时间轴是**连续**的：pxPerDay 是浮点数，刻度层随缩放淡入淡出，
 * 一根条子可以从某天的 37% 处开始。Excel 给不了这些 —— 单元格是离散的格子，
 * 一个格子要么属于这根条子要么不属于。
 *
 * 所以导出不能复用 viewport/scale，得先把时间**分桶**：一列 = 一个桶。
 * 桶的粒度按项目总跨度选，让列数永远落在一屏能看完的范围内 ——
 * 一个三年的项目摊成 1095 列，横向拉到天荒地老，等于没导出。
 *
 * 这个文件是纯函数，不碰 exceljs 也不碰 DOM，因为分桶和填充判定正是最容易
 * 出差一天错误的地方，必须能单测。
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

/** 列数的上限。超过这个数就降一档粒度 —— 见文件头的理由。 */
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
 * 把 [fromDay, toDay] 切成桶。
 *
 * 两端会**外扩到桶边界**：周粒度下项目从周三开始，那一列仍然是完整的一周，
 * 否则第一列的宽度含义和其他列不一样，条子的长度就不可比了。
 *
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
 * 求一根条子在每个桶里占什么。
 *
 * 进度用「已完成边界日」表达：边界 = 开始 + 工期 × 进度。落在边界之前的桶画实心，
 * 之后的画轨道 —— 和屏幕上「实心比例 = 进度」是同一个语义，只是量化到了格子。
 *
 * 判定用的是**桶与条子交集**的中点，不是桶自己的中点：月粒度下条子只占某月
 * 最后三天时，拿整月中点去比会把它判成未开始，条子会整根变成轨道色。
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

/**
 * 把带透明度的颜色压平成实色。
 *
 * Excel 的填充色是 ARGB，但绝大多数渲染器（含 Excel 自己）忽略 A 通道 ——
 * 直接把 rgba 塞进去，18% 的淡色轨道会变成 100% 的实色，整张图糊成一片。
 * 所以透明度必须在这里就与白纸合成掉。
 */
export function flatten(hex: string, alpha: number, over = [255, 255, 255]): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * alpha + over[i] * (1 - alpha)));
  return mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}
