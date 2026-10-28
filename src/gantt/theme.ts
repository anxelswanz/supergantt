/**
 * Canvas 绘制用的颜色 token。
 *
 * Canvas 读不到 CSS 变量，所以这里维护一份与之语义同名的 JS 常量。
 * 改色时两边必须一起改（DOM 侧见 src/styles.css）。
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
  surface: "#fbfcfc",
  surfaceAlt: "#f1f4f3",
  weekend: "rgba(23, 41, 45, 0.03)",
  holiday: "rgba(168, 62, 62, 0.06)",
  gridMinor: "rgba(23, 41, 45, 0.05)",
  gridMajor: "rgba(23, 41, 45, 0.11)",
  axisText: "#17292d",
  axisTextDim: "#6a7a7d",
  axisRule: "rgba(23, 41, 45, 0.09)",
  rowHover: "rgba(23, 41, 45, 0.035)",
  rowStripe: "rgba(23, 41, 45, 0.016)",
  today: "#b4442f",
  todayGlow: "rgba(180, 68, 47, 0.09)",
  overdue: "#a83e3e",
  onTime: "#366f5a",
  bar: "#2f6d5e",
  barTrack: "rgba(47, 109, 94, 0.18)",
  barParent: "#3a4a49",
  barText: "#fbfcfc",
  milestone: "#b0752a",
};

const dark: Theme = {
  surface: "#0c1416",
  surfaceAlt: "#111d20",
  weekend: "rgba(233, 240, 236, 0.03)",
  holiday: "rgba(217, 122, 105, 0.09)",
  gridMinor: "rgba(233, 240, 236, 0.05)",
  gridMajor: "rgba(233, 240, 236, 0.11)",
  axisText: "#e9f0ec",
  axisTextDim: "#8a9b9c",
  axisRule: "rgba(233, 240, 236, 0.09)",
  rowHover: "rgba(233, 240, 236, 0.045)",
  rowStripe: "rgba(233, 240, 236, 0.02)",
  today: "#d97a69",
  todayGlow: "rgba(217, 122, 105, 0.12)",
  overdue: "#d97a69",
  onTime: "#7aad96",
  bar: "#4e9b86",
  barTrack: "rgba(78, 155, 134, 0.22)",
  barParent: "#9fb0ae",
  barText: "#0c1416",
  milestone: "#d8a24a",
};

export function getTheme(isDark: boolean): Theme {
  return isDark ? dark : light;
}

/** 紧急程度色标（DESIGN.md §1.7）：只画条子左端 3px 竖标，不整条染色。 */
export const PRIORITY_COLORS = ["#b23a32", "#c2693a", "#3f7da0", "#8a9a9c"];
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
