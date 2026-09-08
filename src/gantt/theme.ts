/**
 * Canvas 绘制用的颜色 token。
 *
 * DOM 层走 Tailwind / CSS 变量，但 Canvas 拿不到 CSS 变量，所以这里维护一份
 * 平行的 JS 常量，按 prefers-color-scheme 切换。两边的语义名保持一致。
 */

export interface Theme {
  surface: string;
  surfaceAlt: string;
  weekend: string;
  holiday: string;
  gridMinor: string;
  gridMajor: string;
  axisText: string;
  axisTextDim: string;
  axisRule: string;
  rowHover: string;
  rowStripe: string;
  today: string;
  todayGlow: string;
  /** 对照模式：实施超出计划 */
  overdue: string;
  /** 对照模式：实施落在计划之内 */
  onTime: string;
  bar: string;
  barTrack: string;
  barParent: string;
  barText: string;
  milestone: string;
}

const light: Theme = {
  surface: "#ffffff",
  surfaceAlt: "#fafafa",
  weekend: "rgba(15, 23, 42, 0.035)",
  holiday: "rgba(244, 63, 94, 0.07)",
  gridMinor: "rgba(15, 23, 42, 0.06)",
  gridMajor: "rgba(15, 23, 42, 0.12)",
  axisText: "#0f172a",
  axisTextDim: "#64748b",
  axisRule: "rgba(15, 23, 42, 0.10)",
  rowHover: "rgba(15, 23, 42, 0.035)",
  rowStripe: "rgba(15, 23, 42, 0.018)",
  today: "#f43f5e",
  todayGlow: "rgba(244, 63, 94, 0.10)",
  overdue: "#dc2626",
  onTime: "#059669",
  bar: "#6366f1",
  barTrack: "rgba(99, 102, 241, 0.22)",
  barParent: "#334155",
  barText: "#ffffff",
  milestone: "#f59e0b",
};

const dark: Theme = {
  surface: "#0b1020",
  surfaceAlt: "#0f1629",
  weekend: "rgba(255, 255, 255, 0.035)",
  holiday: "rgba(251, 113, 133, 0.11)",
  gridMinor: "rgba(255, 255, 255, 0.06)",
  gridMajor: "rgba(255, 255, 255, 0.13)",
  axisText: "#e2e8f0",
  axisTextDim: "#7c8aa5",
  axisRule: "rgba(255, 255, 255, 0.10)",
  rowHover: "rgba(255, 255, 255, 0.05)",
  rowStripe: "rgba(255, 255, 255, 0.022)",
  today: "#fb7185",
  todayGlow: "rgba(251, 113, 133, 0.14)",
  overdue: "#f87171",
  onTime: "#34d399",
  bar: "#818cf8",
  barTrack: "rgba(129, 140, 248, 0.24)",
  barParent: "#94a3b8",
  barText: "#0b1020",
  milestone: "#fbbf24",
};

export function getTheme(isDark: boolean): Theme {
  return isDark ? dark : light;
}

/** 紧急程度色标（DESIGN.md §1.7）：只画条子左端 3px 竖标，不整条染色。 */
export const PRIORITY_COLORS = ["#ef4444", "#f97316", "#3b82f6", "#94a3b8"];
export const PRIORITY_LABELS = ["P0 紧急", "P1 高", "P2 中", "P3 低"];

/**
 * 行高档位。
 *
 * 不做成任意数值的滑块：行高只有「一屏能看多少行」和「点得准不准」两个诉求，
 * 三档已经覆盖，而连续可调会让用户在 31px 和 32px 之间纠结。
 */
export const ROW_HEIGHTS = { compact: 26, normal: 32, roomy: 42 } as const;
export type RowHeightKey = keyof typeof ROW_HEIGHTS;
export const ROW_HEIGHT_LABELS: Record<RowHeightKey, string> = {
  compact: "紧凑",
  normal: "标准",
  roomy: "宽松",
};

/** 默认行高。仍然导出常量，是因为很多地方只需要一个合理初值 */
export const ROW_HEIGHT = ROW_HEIGHTS.normal;

/**
 * 甘特条的高度随行高走 —— 行高改了条子不跟着变，行距会显得空旷失衡。
 * 父任务条固定比叶子任务细一半，这个比例在各档位下都成立。
 */
export function barHeights(rowHeight: number): { leaf: number; parent: number } {
  const leaf = Math.max(10, Math.min(26, rowHeight - 14));
  return { leaf, parent: Math.max(6, Math.round(leaf / 2)) };
}
/** 时间轴高度。三条信息：上下文（月/年）、星期、日期 —— 星期那行只在日视图出现 */
export const AXIS_HEIGHT = 60;
