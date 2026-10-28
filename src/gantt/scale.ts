/**
 * 刻度阶梯：把 pxPerDay 映射成一套连续演化的时间刻度，没有「日/周/月视图」模式判断。
 * 上下两行固定：上行 = context（如「2026年8月」），下行 = detail（如「1 2 3 4 …」）。
 *
 * 谁出现在下行按权重连续插值：
 *   detailWeight(u) = vis(u) × Π(1 − vis(v))   // v 是所有比 u 更细的单位
 * 权重总和恒为 1，因此切换处是淡入淡出而非硬切，上行也不会闪烁。
 */

import { dayToDate, MS_PER_DAY } from "./time";

export type UnitName = "day" | "week" | "month" | "quarter" | "year";

interface UnitDef {
  name: UnitName;
  /** 平均天数，只用于估算格宽，不用于刻度定位 */
  approxDays: number;
  /** 标签能读清所需的最小格宽（px），决定各档位切换点 */
  minPx: number;
  /** 上行显示的单位 */
  context: UnitName | null;
}

/** 必须保持从细到粗排序，detailWeight 的连乘依赖这个顺序。 */
const UNITS: UnitDef[] = [
  { name: "day", approxDays: 1, minPx: 24, context: "month" },
  { name: "week", approxDays: 7, minPx: 56, context: "month" },
  { name: "month", approxDays: 30.44, minPx: 60, context: "year" },
  { name: "quarter", approxDays: 91.31, minPx: 46, context: "year" },
  { name: "year", approxDays: 365.25, minPx: 60, context: null },
];

/** 三次平滑插值，避免线性插值在端点处「顿一下」。 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface TickLayer {
  unit: UnitName;
  /** 在下行的显示权重 0–1 */
  detail: number;
  /** 在上行的显示权重 0–1 */
  context: number;
}

/** 给定 pxPerDay 算出每个单位在上下两行的权重，按细到粗排列。 */
export function computeTickLayers(pxPerDay: number): TickLayer[] {
  // vis：格子是否宽到能放下标签，minPx 的 0.8–1.25 倍区间内平滑淡入
  const vis = UNITS.map((u) =>
    smoothstep(u.minPx * 0.8, u.minPx * 1.25, u.approxDays * pxPerDay),
  );

  const detail = UNITS.map((_, i) => {
    let w = vis[i];
    for (let j = 0; j < i; j++) w *= 1 - vis[j];
    return w;
  });

  const context = new Map<UnitName, number>();
  UNITS.forEach((u, i) => {
    if (u.context && detail[i] > 0) {
      context.set(u.context, (context.get(u.context) ?? 0) + detail[i]);
    }
  });

  return UNITS.map((u, i) => ({
    unit: u.name,
    detail: detail[i],
    context: context.get(u.name) ?? 0,
  }));
}

/**
 * 枚举 [dayFrom, dayTo] 内某单位的刻度起点（dayIndex）。
 * 月/季/年按真实日历推进，用 approxDays 近似会让刻度线慢慢漂移。
 */
export function* ticksOf(
  unit: UnitName,
  dayFrom: number,
  dayTo: number,
): Generator<number> {
  const EPOCH = Date.UTC(2000, 0, 1);
  const toDay = (ms: number) => (ms - EPOCH) / MS_PER_DAY;

  if (unit === "day") {
    for (let d = Math.floor(dayFrom); d <= dayTo; d++) yield d;
    return;
  }

  if (unit === "week") {
    // 周一为一周之首
    let d = Math.floor(dayFrom);
    while (dayToDate(d).getUTCDay() !== 1) d--;
    for (; d <= dayTo; d += 7) yield d;
    return;
  }

  const start = dayToDate(Math.floor(dayFrom));
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();

  if (unit === "month") {
    for (;;) {
      const day = toDay(Date.UTC(y, m, 1));
      if (day > dayTo) return;
      if (day >= dayFrom - 31) yield day;
      m++;
      if (m > 11) (m = 0), y++;
    }
  }

  if (unit === "quarter") {
    m = Math.floor(m / 3) * 3;
    for (;;) {
      const day = toDay(Date.UTC(y, m, 1));
      if (day > dayTo) return;
      if (day >= dayFrom - 92) yield day;
      m += 3;
      if (m > 11) (m = 0), y++;
    }
  }

  if (unit === "year") {
    for (;;) {
      const day = toDay(Date.UTC(y, 0, 1));
      if (day > dayTo) return;
      if (day >= dayFrom - 366) yield day;
      y++;
    }
  }
}

/** 刻度标签。日/月在跨年时补上年份，避免滚远了不知道自己在哪一年。 */
export function tickLabel(unit: UnitName, day: number): string {
  const d = dayToDate(day);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const dt = d.getUTCDate();

  switch (unit) {
    case "day":
      return String(dt);
    case "week":
      return `${mo}/${dt}`;
    case "month":
      return mo === 1 ? `${y}年1月` : `${mo}月`;
    case "quarter":
      return `Q${Math.floor((mo - 1) / 3) + 1}`;
    case "year":
      return `${y}`;
  }
}
