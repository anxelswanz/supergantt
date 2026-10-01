/**
 * 甘特条的命中检测。
 *
 * 手柄的判定宽度（HANDLE）比视觉宽度大，因为「能不能抓住」取决于命中区，
 * 而「看起来在哪」取决于绘制 —— 两者故意不一致，前者要宽容。
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
   *
   * 必须由这里给出：判定用的是 `activeSpan(task, mode)`，只有它知道这条子
   * 画在实施位置还是计划位置、以及那是不是一个影子。调用方自己用
   * `actualStartDay == null` 再推一遍，迟早会和绘制分叉 —— 表现就是
   * 「点上去没反应」而条子看上去明明在那里。
   */
  ghost: boolean;
}

const HANDLE = 7;

/**
 * 进度手柄的抓取半径。比视觉上那个小方块宽不少 ——
 * 「能不能抓住」取决于命中区，「看起来在哪」取决于绘制，前者要宽容。
 */
const PROGRESS_GRIP = 9;

/** 手柄和两端改工期区之间留的空隙，保证三个手柄互不重叠 */
const GRIP_GAP = 3;

/** 条子至少要这么宽才放得下「左改工期 + 进度 + 右改工期」三个手柄 */
const MIN_WIDTH_FOR_PROGRESS = (HANDLE + GRIP_GAP) * 2 + PROGRESS_GRIP;

/**
 * 进度手柄画在哪、也从哪抓。
 *
 * **绘制和命中必须共用这一个函数。** 之前两边各算各的，结果是：
 * 进度为 0 时手柄落在条子左端，正好被「拖左边缘改工期」的判定区整个盖住，
 * 于是 0% 和 100% 两端的进度**永远拖不动** —— 而画面上手柄明明就在那里。
 *
 * 所以这里把手柄位置钳进两端手柄之间的安全区。代价是 0% 时手柄不在最左边，
 * 而是稍微靠里一点；换来的是任何进度值下它都抓得住。
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

  // 父任务的日期是子任务汇总出来的，不能直接拖它的边缘改工期。
  // 但整体平移是允许的 —— 那等价于平移整组子任务（DESIGN.md §1.3）。
  //
  // 父任务永远不算影子：它的实施区间是**已经填过的子任务**汇总出来的，
  // 「还没动过」对一条汇总值没有意义，也没有一组日期可以拿来填。
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

  // 命中判定必须用**当前视图正在画的那个区间** —— 用另一组日期去判定，
  // 就会出现「点在条子上却没反应」
  const { span, ghost } = activeSpan(task, mode);

  if (task.milestone) {
    const cx = vp.xOf(span.startDay) + vp.pxPerDay / 2;
    return { index, task, mode: Math.abs(x - cx) <= 9 ? "move" : null, ghost };
  }

  const x1 = vp.xOf(span.startDay);
  const x2 = vp.xOf(span.endDay + 1);
  if (x < x1 - HANDLE || x > x2 + HANDLE) return { index, task, mode: null, ghost };

  // —— 进度手柄 ——
  // 只在**实施**视图给。进度是「实际干了多少」，归实施侧（viewMode.canEdit）；
  // 计划视图里这块位置让给移动 / 改工期，否则就是「图上拖得动、表格里却只读」。
  //
  // 还没填过实施日期的虚线条（ghost）也不给：那条子只是计划的影子，
  // 上面本来就不画进度填充，手柄拖了画面上毫无变化。要给它录进度，
  // 先把它拖成真正的实施条，或者去左侧网格 / 详情面板填。
  //
  // 判定先于两端的改工期，否则 0% / 100% 时它会被吃掉（见 progressGripX 的说明）
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
 * 这次松手算不算「单击虚线，采用计划日期」。
 *
 * 和拖动落笔（也是一按一放）靠**指针位移**区分，不是靠日期差 —— 缩到「月」时
 * 一次明显的拖动也可能不足一天，用日期差判会让它退化成"采用计划"。
 *
 * 抽成纯函数是为了让这条规则可测：它同时被四个条件约束（实施视图、
 * 抓到 ghost、指针没动、确实还没填过实施日期），漏掉任何一个，表现都是
 * 「点了没反应」或「拖一下反而被当成点了一下」，而这两种在界面上都不报错。
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

/** 鼠标离手柄多近时手柄开始变大 —— 视觉上的「吸附」提示 */
export const GRIP_MAGNET = 18;

/** 进度吸附到 0 / 25 / 50 / 75 / 100 档位（DESIGN.md §1.4）。 */
export function snapProgress(raw: number): { value: number; snapped: boolean } {
  const clamped = Math.min(1, Math.max(0, raw));
  for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
    if (Math.abs(clamped - stop) < 0.035) return { value: stop, snapped: true };
  }
  return { value: Math.round(clamped * 100) / 100, snapped: false };
}
