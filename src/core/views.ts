/**
 * 顶层视图。
 *
 * 甘特图从「整个工作区」降级为「四个视图之一」。四个视图共用同一批任务、
 * 同一份数据，区别只在**问的问题不同**：
 *
 *   甘特   —— 这些活在时间上排在哪？（唯一的编辑面）
 *   看板   —— 此刻谁没开始、谁卡住了？
 *   时间线 —— 每一天到底发生了什么？
 *   复盘   —— 计划和实际差在哪，为什么？
 *
 * 这里只定义「有哪些视图」。视图各自需要什么数据由各自的组件决定 ——
 * 这个文件不该知道任何一个视图的实现细节，否则加第五个视图时它会被迫改。
 */

export type AppView = "gantt" | "board" | "timeline" | "review";

export interface ViewMeta {
  key: AppView;
  label: string;
  /** 悬停提示。写「它回答什么问题」而不是「它长什么样」 */
  hint: string;
}

export const APP_VIEWS: ViewMeta[] = [
  { key: "gantt", label: "甘特", hint: "这些活排在哪 —— 拖拽改期、改工期、记进度" },
  { key: "board", label: "看板", hint: "此刻谁没开始、谁在做、谁卡住了" },
  { key: "timeline", label: "时间线", hint: "逐日流水：每天发生了什么" },
  { key: "review", label: "复盘", hint: "计划与实际差在哪、为什么、丢了多少天" },
];

export const isAppView = (v: unknown): v is AppView =>
  typeof v === "string" && APP_VIEWS.some((x) => x.key === v);
