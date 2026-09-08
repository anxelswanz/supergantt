/**
 * 视口：整个甘特图的相机。
 *
 * 全部时间轴状态压缩成一个变量 —— pxPerDay（每天占多少像素）。
 * 「日/周/月/年」按钮和 Cmd+滚轮不是两套逻辑，只是往同一个变量推不同的目标值
 * （DESIGN.md §6.3）。
 *
 * 水平位置不直接存 originDay，而是存一对锚点 (anchorDay, anchorX)：
 *
 *     originDay = anchorDay − anchorX / pxPerDay
 *
 * 这样在 pxPerDay 做 spring 动画的整个过程中，anchorDay 这一天会牢牢钉在
 * 屏幕 anchorX 这个位置上。缩放锚点是鼠标位置这件事因此是「免费」的，
 * 而不是每帧去补偿修正 —— 后者在动画中必然产生漂移。
 */

import { Spring, SPRING } from "./spring";
import { today } from "./time";

export const MIN_PX_PER_DAY = 0.15; // 一年约 55px
export const MAX_PX_PER_DAY = 80; // 一天 80px

/** 「日/周/月/年」四个预设档位对应的 pxPerDay。 */
export const ZOOM_PRESETS = {
  day: 36,
  week: 12,
  month: 3.2,
  year: 0.8,
} as const;

export type ZoomPreset = keyof typeof ZOOM_PRESETS;

const clampZoom = (v: number) =>
  Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, v));

export class Viewport {
  readonly zoom = new Spring(ZOOM_PRESETS.week, SPRING.wheel);

  /** 锚点：anchorDay 这一天恒定显示在画布 x = anchorX 处 */
  anchorDay = today();
  anchorX = 240;

  /** 垂直滚动位置（px），不做 spring —— 列表滚动需要绝对跟手 */
  scrollY = 0;

  /**
   * 行高。放在视口里而不是当模块常量，是因为它是**视图参数**：
   * 渲染、命中检测、左侧网格必须用同一个值，而它现在可以被用户改。
   * 三处各自 import 一个常量的话，改起来必然漏掉一处。
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
   * 滚轮缩放。x 是鼠标在画布内的横坐标 —— 缩放锚点必须是鼠标位置，
   * 不是视口中心也不是左边缘（DESIGN.md §6.4）。
   */
  zoomAt(x: number, factor: number) {
    this.reanchor(x);
    this.zoom.config = SPRING.wheel;
    this.zoom.target = clampZoom(this.zoom.target * factor);
  }

  /** 预设按钮：用较柔和的 spring 平滑推到目标档位，锚点取视口中心。 */
  zoomToPreset(preset: ZoomPreset) {
    this.reanchor(this.width / 2);
    this.zoom.config = SPRING.smooth;
    this.zoom.target = ZOOM_PRESETS[preset];
  }

  /** 把锚点重设到画布上的某个 x，且不改变当前画面（originDay 保持不变）。 */
  private reanchor(x: number) {
    this.anchorDay = this.dayAt(x);
    this.anchorX = x;
  }

  /** 水平平移：dx > 0 表示画面内容向左移（即时间轴往后看）。 */
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
    const ppd = this.zoom.target;
    let best: ZoomPreset = "day";
    let bestDist = Infinity;
    for (const [name, value] of Object.entries(ZOOM_PRESETS)) {
      // 在对数尺度上比较 —— 缩放本身是指数的，线性比较会严重偏向大档位
      const dist = Math.abs(Math.log(ppd / value));
      if (dist < bestDist) {
        bestDist = dist;
        best = name as ZoomPreset;
      }
    }
    return best;
  }
}
