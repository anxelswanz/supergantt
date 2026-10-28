/**
 * 甘特条的命中检测。判定宽度比视觉宽度大：「能不能抓住」取决于命中区，
 * 「看起来在哪」取决于绘制，两者故意不一致。
 */

import type { ResolvedTask } from "./model";
import { AXIS_HEIGHT } from "./theme";
import type { Viewport } from "./viewport";
import { activeSpan, canEdit, type ViewMode } from "../core/viewMode";
export type DragMode = "move" | "resizeStart" | "resizeEnd" | "progress";

export interface Hit {
  index: number;
  task: ResolvedTask;
  mode: DragMode | null;
  /**
   * 抓到的这条是不是「还没动过」的虚线影子。
   * 必须由这里给出：调用方自己用 `actualStartDay == null` 再推一遍会和绘制分叉，
   * 表现就是「点上去没反应」。
   */
  ghost: boolean;
}

const HANDLE = 7;

/** 进度手柄的抓取半径，比视觉上的小方块宽不少。 */
const PROGRESS_GRIP = 9;

/** 手柄和两端改工期区之间留的空隙，保证三个手柄互不重叠 */
const GRIP_GAP = 3;

/** 条子至少要这么宽才放得下「左改工期 + 进度 + 右改工期」三个手柄 */
const MIN_WIDTH_FOR_PROGRESS = (HANDLE + GRIP_GAP) * 2 + PROGRESS_GRIP;

/**
 * 进度手柄画在哪、也从哪抓。**绘制和命中必须共用这一个函数**：
 * 否则 0% / 100% 时手柄会落进两端改工期的判定区，永远拖不动。
 * 因此把手柄钳进两端手柄之间的安全区。
 */
export function progressGripX(
  x1: number,
  x2: number,
  progress: number,
): number | null {
  const width = x2 - x1;
  if (width < MIN_WIDTH_FOR_PROGRESS) return null;

  const lo = x1 + HANDLE + GRIP_GAP;
  const hi = x2 - HANDLE - GRIP_GAP;
  const raw = x1 + width * Math.min(1, Math.max(0, progress));
  return Math.min(hi, Math.max(lo, raw));
}

export function hitTest(
  vp: Viewport,
  tasks: ResolvedTask[],
  x: number,
  y: number,
  mode: ViewMode = "plan",
): Hit | null {
  if (y < AXIS_HEIGHT) return null;

  const index = Math.floor((y - AXIS_HEIGHT + vp.scrollY) / vp.rowHeight);
  const task = tasks[index];
  if (!task) return null;

  // 父任务不能拖边缘改工期（日期是汇总的），但整体平移可以。
  // 父任务也永远不算影子：「还没动过」对一条汇总值没有意义。
  if (task.hasChildren) {
    const { span: p } = activeSpan(task, mode);
    const px1 = vp.xOf(p.startDay);
    const px2 = vp.xOf(p.endDay + 1);
    return {
      index,
      task,
      mode: x >= px1 && x <= px2 ? "move" : null,
      ghost: false,
    };
  }

  // 必须用当前视图正在画的那个区间判定，用另一组日期会出现「点在条子上却没反应」
  const { span, ghost } = activeSpan(task, mode);

  if (task.milestone) {
    const cx = vp.xOf(span.startDay) + vp.pxPerDay / 2;
    return { index, task, mode: Math.abs(x - cx) <= 9 ? "move" : null, ghost };
  }

  const x1 = vp.xOf(span.startDay);
  const x2 = vp.xOf(span.endDay + 1);
  if (x < x1 - HANDLE || x > x2 + HANDLE) return { index, task, mode: null, ghost };

  // 进度手柄只在实施视图给，且虚线条（ghost）不给：上面本来就不画进度填充。
  // 判定先于两端改工期，否则 0% / 100% 时会被吃掉（见 progressGripX）。
  if (canEdit("progress", mode) && !ghost) {
    const grip = progressGripX(x1, x2, task.progress);
    if (grip != null && Math.abs(x - grip) <= PROGRESS_GRIP) {
      return { index, task, mode: "progress", ghost };
    }
  }

  if (x <= x1 + HANDLE) return { index, task, mode: "resizeStart", ghost };
  if (x >= x2 - HANDLE) return { index, task, mode: "resizeEnd", ghost };

  return { index, task, mode: "move", ghost };
}

export function cursorFor(mode: DragMode | null): string {
  switch (mode) {
    case "resizeStart":
    case "resizeEnd":
      return "ew-resize";
    case "progress":
      return "col-resize";
    case "move":
      return "grab";
    default:
      return "default";
  }
}

/**
 * 这次松手算不算「单击虚线，采用计划日期」。和拖动落笔靠**指针位移**区分：
 * 缩到「月」时一次明显的拖动也可能不足一天，用日期差判会退化成「采用计划」。
 */
export function tapAdoptsPlanDates(opts: {
  viewMode: ViewMode;
  /** 抓到的这条是不是虚线影子（hitTest 给出） */
  ghost: boolean;
  /** 按下到松手，指针有没有真的动过 */
  moved: boolean;
  /** 当前这条任务的实施开始日 —— 已经有值就不该被覆盖 */
  actualStartDay: number | null | undefined;
}): boolean {
  return (
    opts.viewMode === "actual" &&
    opts.ghost &&
    !opts.moved &&
    opts.actualStartDay == null
  );
}

/** 鼠标离手柄多近时手柄变大 —— 视觉上的「吸附」提示 */
export const GRIP_MAGNET = 18;

/** 进度吸附到 0 / 25 / 50 / 75 / 100 档位。 */
export function snapProgress(raw: number): { value: number; snapped: boolean } {
  const clamped = Math.min(1, Math.max(0, raw));
  for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
    if (Math.abs(clamped - stop) < 0.035) return { value: stop, snapped: true };
  }
  return { value: Math.round(clamped * 100) / 100, snapped: false };
}
