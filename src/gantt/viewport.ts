/**
 * 视口：整个甘特图的相机。时间轴状态只有一个变量 pxPerDay，
 * 「日/周/月/年」按钮和 Cmd+滚轮都只是往它推目标值。
 *
 * 水平位置存锚点对 (anchorDay, anchorX) 而非 originDay：
 *     originDay = anchorDay − anchorX / pxPerDay
 * 这样缩放动画过程中 anchorDay 始终钉在屏幕 anchorX 处，锚定鼠标位置是免费的，
 * 不必每帧补偿（补偿必然漂移）。
 */

import { Spring, SPRING } from "./spring";
import { today } from "./time";

export const MIN_PX_PER_DAY = 0.15; // 一年约 55px
export const MAX_PX_PER_DAY = 80; // 一天 80px

/** 「日/周/月/年」预设档位 */
export const ZOOM_PRESETS = {
  day: 36,
  week: 12,
  month: 3.2,
  year: 0.8,
} as const;

export type ZoomPreset = keyof typeof ZOOM_PRESETS;

const clampZoom = (v: number) =>
  Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, v));

/**
 * 存下来的缩放值 → 可用的 pxPerDay，读不懂返回 null。
 *
 * 存的是 pxPerDay 而不是「日/周/月/年」这个名字：滚轮缩放是连续量，
 * 存档位名的话用户滚到一个中间密度、关掉再打开，会被拽回整档。
 * 数值超出范围（换了显示器、改过预设值）就钳住，不丢用户的选择。
 */
export function parseZoom(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clampZoom(n) : null;
}

/** pxPerDay 最接近哪个预设档位。按对数距离比较 —— 缩放是指数的，线性比会偏粗档。 */
export function nearestPreset(pxPerDay: number): ZoomPreset {
  let best: ZoomPreset = "day";
  let bestDist = Infinity;
  for (const [name, value] of Object.entries(ZOOM_PRESETS)) {
    const dist = Math.abs(Math.log(pxPerDay / value));
    if (dist < bestDist) {
      bestDist = dist;
      best = name as ZoomPreset;
    }
  }
  return best;
}

export class Viewport {
  readonly zoom = new Spring(ZOOM_PRESETS.week, SPRING.wheel);

  /** 锚点：anchorDay 这一天恒定显示在画布 x = anchorX 处 */
  anchorDay = today();
  anchorX = 240;

  /** 垂直滚动位置（px），不做 spring —— 列表滚动需要绝对跟手 */
  scrollY = 0;

  /**
   * 行高。是视图参数而非模块常量：渲染、命中检测、左侧网格必须共用同一个值。
   */
  rowHeight = 32;

  width = 0;
  height = 0;

  get pxPerDay(): number {
    return this.zoom.value;
  }

  /** 画布左边缘对应的天序号（浮点） */
  get originDay(): number {
    return this.anchorDay - this.anchorX / this.zoom.value;
  }

  xOf(day: number): number {
    return (day - this.originDay) * this.zoom.value;
  }

  dayAt(x: number): number {
    return this.originDay + x / this.zoom.value;
  }

  /** 视口内可见的天序号范围，两端各留一格余量供裁剪使用 */
  visibleDays(): [number, number] {
    return [this.dayAt(-1), this.dayAt(this.width + 1)];
  }

  /**
   * 滚轮缩放。x 是鼠标在画布内的横坐标：缩放锚点必须是鼠标位置，
   * 不是视口中心。
   */
  zoomAt(x: number, factor: number) {
    this.reanchor(x);
    this.zoom.config = SPRING.wheel;
    this.zoom.target = clampZoom(this.zoom.target * factor);
  }

  /** 预设按钮：用较柔和的 spring 推到目标档位，锚点取视口中心。 */
  zoomToPreset(preset: ZoomPreset) {
    this.reanchor(this.width / 2);
    this.zoom.config = SPRING.smooth;
    this.zoom.target = ZOOM_PRESETS[preset];
  }

  /**
   * 恢复存档的缩放：直接落到目标值，不播动画。
   * 打开项目那一下没有「从哪来」可言，播一段 spring 只会让人看见刻度先粗后细地跳一下。
   */
  setZoom(pxPerDay: number) {
    this.zoom.snap(clampZoom(pxPerDay));
  }

  /** 把锚点移到画布上的某个 x，且不改变当前画面。 */
  private reanchor(x: number) {
    this.anchorDay = this.dayAt(x);
    this.anchorX = x;
  }

  /** 水平平移：dx > 0 表示画面内容左移（时间轴往后看）。 */
  panBy(dx: number) {
    this.anchorX -= dx;
  }

  /** 把某一天居中显示。 */
  centerOn(day: number) {
    this.anchorDay = day;
    this.anchorX = this.width / 2;
  }

  /** 推进动画一帧，返回是否仍在运动。 */
  step(dt: number): boolean {
    return this.zoom.step(dt);
  }

  /** 当前 pxPerDay 最接近哪个预设档位（用于按钮高亮）。 */
  nearestPreset(): ZoomPreset {
    return nearestPreset(this.zoom.target);
  }
}
