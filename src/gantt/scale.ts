/**
 * 刻度阶梯：把单一状态量 pxPerDay 映射成一套连续演化的时间刻度。
 *
 * 关键设计（DESIGN.md §6.3）——这里没有任何「日/周/月视图」的模式判断。
 * 时间轴永远是固定两行：
 *
 *   上行 = context（上下文单位，如「2026年8月」）
 *   下行 = detail （细节单位，如「1 2 3 4 …」）
 *
 * 谁出现在下行，是按权重连续插值出来的，不是 if/else 切出来的：
 *
 *   detailWeight(u) = vis(u) × Π(1 − vis(v))   // v 是所有比 u 更细的单位
 *
 * 即「我自己够宽了，而且比我更细的单位都还没够宽」。
 * pxPerDay 从 15 连续变到 30 的过程中，week 的权重从 1 平滑降到 0，
 * day 的权重从 0 平滑升到 1 —— 两者在下行交叉淡入淡出，永远不会硬切。
 *
 * 上行同理：每个 detail 单位有一个配对的 context 单位，权重直接继承过去累加，
 * 因为权重总和恒为 1，上行不会闪烁。
 */

import { dayToDate, MS_PER_DAY } from "./time";

export type UnitName = "day" | "week" | "month" | "quarter" | "year";

interface UnitDef {
  name: UnitName;
  /** 平均天数，只用于估算格宽，不用于实际刻度定位 */
  approxDays: number;
  /** 该单位的标签能读得清所需的最小格宽（px）。这套数值决定了各档位的切换点 */
  minPx: number;
  /** 上行显示哪个单位作为上下文 */
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

/** 三次平滑插值，避免线性插值在端点处的速度突变（观感上会「顿一下」）。 */
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

/**
 * 给定 pxPerDay，算出每个单位在上下两行的权重。
 * 返回的层按细到粗排列，权重为 0 的层调用方可以直接跳过。
 */
export function computeTickLayers(pxPerDay: number): TickLayer[] {
  // vis：该单位的格子是否已经宽到能放下标签。±25% 区间内平滑淡入
  const vis = UNITS.map((u) =>
    smoothstep(u.minPx * 0.8, u.minPx * 1.25, u.approxDays * pxPerDay),
  );

  // detail：自己够宽，且比自己更细的单位都还不够宽
  const detail = UNITS.map((_, i) => {
    let w = vis[i];
    for (let j = 0; j < i; j++) w *= 1 - vis[j];
    return w;
  });

  // context：把每个 detail 单位的权重转记到它配对的上下文单位上
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
 * 枚举 [dayFrom, dayTo] 区间内某个单位的所有刻度起点（dayIndex）。
 * 月/季/年按真实日历推进，不用 approxDays 近似 —— 近似会让刻度线慢慢漂移。
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
