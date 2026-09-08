/**
 * 计划 / 实施 双轨。
 *
 * ⚠️ 这**不是顶层视图**（顶层见 core/views.ts：甘特/看板/时间线/复盘）。
 * 它是甘特视图内部的一个开关：读哪一组日期、拖拽写哪一组日期。
 *
 * 一条任务只有一行数据，上面挂两组日期。切换**不是换一张表**，
 * 只是换读哪一组日期 —— 名字、层级、紧急度、负责人、进度、受阻、风险、评论
 * 全都只有一份，两侧看到的永远一致，不存在"同步"这个动作。
 *
 * 这个文件的存在意义：把"当前视图下这条任务的条子画在哪"收敛成**一个函数**。
 * 否则渲染、命中检测、左侧网格、导出会各自写一遍 `mode === "actual" ? ... : ...`，
 * 迟早有一处漏改，表现就是"图上和表里对不上"。
 */

import type { ResolvedTask } from "../gantt/model";

export type ViewMode = "plan" | "actual";

export const VIEW_LABELS: Record<ViewMode, string> = {
  plan: "计划",
  actual: "实施",
};

export interface Span {
  startDay: number;
  endDay: number;
}

export interface ActiveSpan {
  /** 条子画在哪 */
  span: Span;
  /**
   * true = 这只是计划的影子，不是真实施。
   *
   * 实施视图下、且该任务还没填过实施日期时为 true。画成虚线轮廓，
   * 表示"还没动过"。一旦填了就不再是影子 —— 之后计划怎么改都不覆盖它。
   */
  ghost: boolean;
}

/** 计划区间。父任务的已经由 resolve() 汇总过 */
export const planSpan = (task: ResolvedTask): Span => ({
  startDay: task.startDay,
  endDay: task.endDay,
});

/** 实施区间；为空表示还没动过 */
export function actualSpan(task: ResolvedTask): Span | null {
  return task.actualStartDay != null && task.actualEndDay != null
    ? { startDay: task.actualStartDay, endDay: task.actualEndDay }
    : null;
}

/**
 * 当前视图下要画的区间。
 *
 * 「未来 / 过去」的判定**不看今天**，只看实施日期填了没。
 * 用今天做分界的话，同一条任务会因为日子一天天过去，自己从"虚线预览"
 * 悄悄变成"固定实施"，而用户根本没做任何操作。
 */
export function activeSpan(task: ResolvedTask, mode: ViewMode): ActiveSpan {
  if (mode === "plan") return { span: planSpan(task), ghost: false };
  const actual = actualSpan(task);
  return actual
    ? { span: actual, ghost: false }
    : { span: planSpan(task), ghost: true };
}

/** 实施相对计划的偏移天数。正数=延后，负数=提前，null=还没实施 */
export function deviation(task: ResolvedTask): { start: number; end: number } | null {
  const actual = actualSpan(task);
  if (!actual) return null;
  return {
    start: actual.startDay - task.startDay,
    end: actual.endDay - task.endDay,
  };
}

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

/**
 * 哪一侧能改什么。
 *
 * 分工是：**计划侧管「打算怎么干」，实施侧管「实际怎么干的」**。
 * 所以计划日期归计划侧；实施日期、进度、受阻/风险/评论归实施侧 ——
 * 后面这些全都是"实际发生了什么"的记录。
 *
 * **结构、紧急度、负责人不受这个开关管，任何时候都能改。**
 * 这是多视图化时改掉的一条：原先它们归计划侧，于是切到实施表连改个错别字
 * 都做不到。而 plan/actual 现在只是甘特视图内部的一个开关（顶层是
 * 甘特/看板/时间线/复盘），再用它去禁用「新建任务」这种全局操作，
 * 就会变成"我在看板里，为什么加不了任务" —— 每天都要撞一次的墙。
 *
 * 判据是：**这个字段写进哪一组数据**。写进计划日期的归计划侧，
 * 写进实施记录的归实施侧，两组都不写的（名字、层级、负责人）不归任何一侧。
 *
 * 注意这只是**编辑权限**，不是可见性：两侧都看得到全部字段，
 * 只是在没有权限的那一侧显示为只读。
 */
export function canEdit(
  field:
    | "structure" // 增删任务、改名、缩进
    | "priority"
    | "assignee"
    | "planDates"
    | "actualDates"
    | "progress"
    | "notes", // 受阻 / 风险 / 评论
  mode: ViewMode,
): boolean {
  switch (field) {
    // 任务本身的属性，不属于计划也不属于实施
    case "structure":
    case "priority":
    case "assignee":
      return true;
    case "planDates":
      return mode === "plan";
    case "actualDates":
    case "progress":
    case "notes":
      return mode === "actual";
  }
}
