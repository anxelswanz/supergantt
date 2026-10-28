/**
 * 计划 / 实施 双轨：甘特内部的开关（不是顶层视图，顶层见 core/views.ts），
 * 决定读写哪一组日期；其余字段只有一份。渲染、命中、网格、导出都应经
 * activeSpan 取区间，别各写一遍 mode 判断。
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
  /** 实施视图下且未填实施日期 = 计划的影子，画虚线轮廓 */
  ghost: boolean;
}

/** 计划区间；父任务的已由 resolve() 汇总 */
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

/** 当前视图下要画的区间。是否为影子只看实施日期填没填，不看今天。 */
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
 * 哪一侧能改什么（只管编辑，不管可见性）。按字段写进哪组数据判定：
 * 计划日期归计划侧，实施记录归实施侧，结构/紧急度/负责人任何时候都能改。
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
