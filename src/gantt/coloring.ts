/**
 * 甘特条着色。
 *
 * 核心约束：**每一个颜色都必须能被解释**。
 *
 * 所以色相不由「行号」决定 —— 那种「保证相邻不同色」的做法看着热闹，
 * 但用户看到一根橙条时无从判断它是「延后了」还是「只是轮到橙色了」，
 * 等于把一个视觉通道浪费在噪音上。而颜色通道在这张图上已经很紧张：
 * 进度、父子、紧急度、里程碑、今天/节假日都在用它，v2 还要塞基线偏差和依赖冲突。
 *
 * 色相由**数据**决定，具体由哪一维数据决定交给用户选。
 *
 * 进度不和色相抢通道，走**明度对比**：
 *   已完成部分 = 该色 100%，未完成部分 = 同色 18%。
 * 于是「60% 完成的设计阶段任务」= 一根 60% 实心紫 + 40% 淡紫的条子，
 * 色相回答「属于谁」，实心比例回答「做了多少」，互不干扰。
 */

import type { ResolvedTask } from "./model";
import { PRIORITY_COLORS } from "./theme";
import type { Person } from "../db/api";

export type ColorBy = "stage" | "assignee" | "priority" | "none";

export const COLOR_BY_LABELS: Record<ColorBy, string> = {
  stage: "阶段",
  assignee: "负责人",
  priority: "紧急度",
  none: "单色",
};

/**
 * 8 个色相，**明度刻意错开**。
 *
 * 不只是为了好看：红绿色觉障碍者分不清其中几组色相，灰度打印更是全部退化成
 * 明度差。让明度本身就有区分度，这两种情况下依然读得出分组。
 */
const PALETTE_LIGHT = [
  "#4f46e5", // 靛蓝，暗
  "#0ea5e9", // 天蓝，亮
  "#059669", // 翠绿，中暗
  "#f59e0b", // 琥珀，很亮
  "#be185d", // 玫红，暗
  "#14b8a6", // 青，中
  "#7c3aed", // 紫罗兰，中暗
  "#f97316", // 橙，亮
];

/** 深色背景下同一组色相要提亮，否则条子和底色糊在一起 */
const PALETTE_DARK = [
  "#818cf8",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#2dd4bf",
  "#a78bfa",
  "#fb923c",
];

/* ------------------------------------------------------------------ */
/* 同色系变体                                                          */
/* ------------------------------------------------------------------ */

/**
 * 同一阶段下，让每个后代拿到一个**同色系的变体**，而不是和阶段完全同色。
 *
 * 关键约束：**明度已经被进度占用了**（实心 vs 同色 18%）。如果变体主要靠明度拉开，
 * 一个浅蓝子任务的实心段会和一个深蓝子任务的轨道段长得差不多 ——
 * 那就等于用一个通道同时表达两件事。
 *
 * 所以以**色相微旋**为主（视觉上最能区分、又不跨出色系），明度只做小幅点缀，
 * 且钳在一条安全带里：太亮的话 18% 的轨道会淡到看不见，太暗则和文字抢对比。
 *
 * 两个步长数组长度互质（9 和 7），组合周期 63 —— 一个阶段下不会有那么多后代。
 */
const HUE_STEPS = [0, 14, -14, 26, -26, 8, -8, 20, -20];
const LIGHT_STEPS = [0, -7, 7, -12, 12, -4, 4];

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;

  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  const to255 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 求基色的第 index 个变体。index 为 0 时返回基色本身（阶段自己用）。
 * 明度安全带按主题分开：深色背景下条子必须更亮才浮得出来。
 */
export function variantOf(base: string, index: number, isDark: boolean): string {
  if (index <= 0) return base;

  const [h, s, l] = hexToHsl(base);
  const hue = h + HUE_STEPS[index % HUE_STEPS.length];
  const light = clamp(
    l + LIGHT_STEPS[index % LIGHT_STEPS.length],
    isDark ? 55 : 34,
    isDark ? 78 : 58,
  );
  return hslToHex(hue, clamp(s, 42, 92), light);
}

/** 分组为空时的中性色（比如没填负责人） */
const NEUTRAL_LIGHT = "#94a3b8";
const NEUTRAL_DARK = "#64748b";

export interface BarPaint {
  /** 未完成部分 */
  track: string;
  /** 已完成部分 */
  fill: string;
  /** 父任务细条 */
  parent: string;
  /** 条内文字在填充区上的颜色 */
  onFill: string;
}

/** #rrggbb → rgba(r,g,b,a)。Canvas 不认 8 位十六进制的透明度写法。 */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 相对亮度，用来决定条内文字用黑还是白 */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function paintFrom(base: string): BarPaint {
  return {
    track: withAlpha(base, 0.18),
    fill: base,
    parent: withAlpha(base, 0.72),
    onFill: luminance(base) > 0.55 ? "#0f172a" : "#ffffff",
  };
}

/**
 * 建一个取色器。
 *
 * 色相按**出现顺序**分配，不用 id 哈希 ——
 * 哈希会导致调整一次任务顺序整屏变色，用户会以为数据坏了。
 */
export function makeBarPainter(
  tasks: ResolvedTask[],
  mode: ColorBy,
  isDark: boolean,
  projectColor: string,
  people: Person[] = [],
): (task: ResolvedTask) => BarPaint {
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;
  const neutral = isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT;

  const neutralPaint = paintFrom(neutral);
  const singlePaint = paintFrom(projectColor);

  if (mode === "none") return () => singlePaint;

  // 紧急度是固定映射，不参与顺序分配 —— P0 永远是红的，不能因为
  // 项目里恰好没有 P0 就让 P1 变成红色
  if (mode === "priority") {
    const byPriority = PRIORITY_COLORS.map(paintFrom);
    return (task) => byPriority[task.priority] ?? neutralPaint;
  }

  // 「按负责人」不走顺序分配的调色板，直接用每个人自己的颜色 ——
  // 这样甘特条的颜色和设置里那张脸的头像底色是同一个，用户不用做二次映射
  if (mode === "assignee") {
    const byPerson = new Map(people.map((p) => [`p${p.id}`, paintFrom(p.color)]));
    return (task) =>
      (task.personId != null && byPerson.get(`p${task.personId}`)) || neutralPaint;
  }

  // 「按阶段」：顶层任务拿调色板里的一个基色，它的每个后代拿一个同色系变体。
  // 这样一屏之内每一行的颜色都不同，但同一阶段仍然一眼看得出是一族。
  const byTaskId = new Map<number, BarPaint>();
  let base = palette[0];
  let stageIndex = 0;
  let childIndex = 0;

  for (const task of tasks) {
    if (task.depth === 0) {
      base = palette[stageIndex % palette.length];
      stageIndex++;
      childIndex = 0;
      byTaskId.set(task.id, paintFrom(base));
      continue;
    }
    childIndex++;
    byTaskId.set(task.id, paintFrom(variantOf(base, childIndex, isDark)));
  }

  return (task) => byTaskId.get(task.id) ?? neutralPaint;
}

/** 时间区间是否重叠 —— 同期高亮用它找出「此刻还有谁在并行」 */
export function overlaps(a: ResolvedTask, b: ResolvedTask): boolean {
  return a.startDay <= b.endDay && b.startDay <= a.endDay;
}
