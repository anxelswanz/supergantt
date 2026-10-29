/** 甘特条着色：色相一律由数据决定，进度走明度（实心 vs 同色 18%），不与色相抢通道。 */

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

/** 8 个色相，明度刻意错开：色障和灰度打印下仍能靠明度分组 */
const PALETTE_LIGHT = [
  "#295565",
  "#9b6b3b",
  "#6a538d",
  "#3d765b",
  "#9e4767",
  "#698a38",
  "#4c7dbd",
  "#724672",
];

/** 深色背景下同一组色相提亮，否则糊在底色里 */
const PALETTE_DARK = [
  "#6ba7bd",
  "#cca37b",
  "#a492bf",
  "#81bba0",
  "#c889a0",
  "#abc87e",
  "#91aed4",
  "#b78fb7",
];

/* ------------------------------------------------------------------ */
/* 同色系变体                                                          */
/* ------------------------------------------------------------------ */

/**
 * 同阶段后代拿同色系变体：色相微旋，明度只小幅点缀（明度已被进度占用）。
 * 两个步长数组长度互质，组合周期 63。
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

/** 基色的第 index 个变体；0 返回基色本身。明度安全带按主题分开，深色下需更亮。 */
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
const NEUTRAL_LIGHT = "#8a9a9c";
const NEUTRAL_DARK = "#5f7073";

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
    onFill: luminance(base) > 0.55 ? "#17292d" : "#fbfcfc",
  };
}

/** 建取色器。色相按出现顺序分配，不用 id 哈希——否则调整一次顺序整屏变色。 */
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

  // 紧急度是固定映射，不参与顺序分配：P0 永远红，不能因项目里没 P0 就让 P1 变红
  if (mode === "priority") {
    const byPriority = PRIORITY_COLORS.map(paintFrom);
    return (task) => byPriority[task.priority] ?? neutralPaint;
  }

  // 按负责人直接用各人自己的颜色，与设置里头像底色同一个，免去二次映射
  if (mode === "assignee") {
    const byPerson = new Map(people.map((p) => [`p${p.id}`, paintFrom(p.color)]));
    return (task) =>
      (task.personId != null && byPerson.get(`p${task.personId}`)) || neutralPaint;
  }

  // 按阶段：顶层任务取调色板基色，后代取同色系变体，同行不同色但同族一眼可辨
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
