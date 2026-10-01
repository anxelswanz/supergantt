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

/**
 * 视图 key。
 *
 * **不是联合类型**。插件可以注册新视图，而插件是运行时扫描出来的 ——
 * 编译期根本写不出那个联合。所以这里退化成 string，把「这个 key 认不认得」
 * 的判断挪到渲染时：Workspace 拿它去注册表里查，查不到就回退到甘特。
 *
 * 仍然保留了内置四个的常量（APP_VIEWS）和 key 的字符集约束（isViewKey），
 * 因为「能把什么字符串存进 active_view」还是要有底线的。
 */
export type AppView = string;

/**
 * 内置视图的 key。
 *
 * 只有「确实只对内置视图有意义」的地方用它 —— 比如状态栏的 HintsFor，
 * 插件视图该显示什么提示是插件自己的事，宿主猜不出来。
 */
export type BuiltinView = "gantt" | "board" | "timeline" | "review";

export interface ViewMeta {
  key: BuiltinView;
  label: string;
  /** 悬停提示。写「它回答什么问题」而不是「它长什么样」 */
  hint: string;
}

/**
 * 内置视图。
 *
 * 插件的视图**不在这里** —— 它们在运行时由 plugins/registry.ts 注册，由
 * Workspace 合并成一份完整清单（见 usePlugins 里的 views）。本文件因此
 * 保持对插件系统零依赖，加第五个内置视图之外的东西不需要改它。
 */
export const APP_VIEWS: ViewMeta[] = [
  { key: "gantt", label: "甘特", hint: "这些活排在哪 —— 拖拽改期、改工期、记进度" },
  { key: "board", label: "看板", hint: "此刻谁没开始、谁在做、谁卡住了" },
  { key: "timeline", label: "时间线", hint: "逐日流水：每天发生了什么" },
  { key: "review", label: "复盘", hint: "计划与实际差在哪、为什么、丢了多少天" },
];

/**
 * key 的字符集约束，和 plugins/manifest.ts 的 ID_PATTERN 同源。
 *
 * 只在**读持久化值时**用得上：`active_view` 存的是上次关掉时那个 key，
 * 而那时启用的插件现在可能已经被删了。store 启动时用它挡掉明显不合法的
 * 字符串，至于「格式合法但已经没有这个视图了」只能等 Workspace 渲染时
 * 查注册表才知道 —— 那时候 store 还没读过插件目录。
 */
const VIEW_KEY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export const isViewKey = (v: unknown): v is AppView =>
  typeof v === "string" && VIEW_KEY_PATTERN.test(v);
