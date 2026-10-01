import type { Task } from "../gantt/model";

/**
 * 实施逾期自动顺延：给一条任务决定「计划要不要跟着事实走」。
 *
 * 从前这里是全局开关，现在挂在任务行上（task.autoRollover）。根因是：
 * 这个决定天然是逐条的 —— 关键路径上的活逾期了应该暴露出来，辅助性的活
 * 让它跟着实际走就好，同一个项目里两种情况完全可能并存，全局开关只会
 * 逼用户在两个都不对的选项里二选一。
 *
 * 面板里的开关是**用户的操作**，走 patchTask 进撤销栈；而它引起的跨天
 * 顺延不进栈（见 store.extendOpenBlockers / core/rollover.ts）。
 */

/** rolloverOverdue 需要读的那几个字段 */
export interface RolloverHost {
  endDay: number;
  actualStartDay: number | null;
  progress: number;
  autoRollover: boolean;
}

/**
 * 一条任务这次跨天该不该给它顺延计划结束日。
 *
 * 四个条件全部要满足：
 *   · **开了这条任务自己的开关**（autoRollover）—— 默认是关的，
 *     新增字段的默认值不该改写既有项目的排期
 *   · **已开工**（actualStartDay 非空）—— 没开工的逾期是「还没排上」，
 *     不是「干超时」，推它的计划结束日只会把真正的问题盖住
 *   · **没干完**（progress < 1）—— 干完的活不该再被推日期
 *   · **计划结束日已过**（endDay < today）—— 这才是「逾期」本身
 *
 * 注意**不判叶子**：叶子判定要看全项目有没有别的任务以它为父，那是 store
 * 的活（它手上有整张 tasks 表）。这里只管单条任务自身的状态。
 */
export function isOverdue(task: RolloverHost, today: number): boolean {
  return (
    task.autoRollover &&
    task.actualStartDay != null &&
    task.progress < 1 &&
    task.endDay < today
  );
}

/**
 * 跨天：逾期任务把计划结束日推到今天。
 *
 * 返回 null 表示这条任务没有要改的 —— 调用方据此不产生写入，否则每分钟
 * 一次的跨天检查会把整个项目反复写库。
 *
 * **幂等**：推到今天之后（endDay === today）当天再调一次就返回 null，不会
 * 重复推；要到明天跨天、today 又往前走一格，才会再推一天。
 *
 * **只写 endDay**。实施日期、进度都是用户自己维护的事实，系统没有理由去动
 * 它们 —— 顺延的是「计划」，不是「实际」。
 */
export function rolloverOverdue(task: Task, today: number): Partial<Task> | null {
  if (!isOverdue(task, today)) return null;
  return { endDay: today };
}
