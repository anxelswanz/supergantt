/**
 * 实施逾期自动顺延（可开关）。
 *
 * 和 blocked.ts 的自动延长是**两条独立的路径**，解决的是两种不同的延误：
 *
 *   · blocked.ts —— 有人**明确标了**一条未关闭的阻碍（设备坏、等料…），
 *     跨天时把受阻段推到今天、并顺延计划结束日。前提是「有人说它卡住了」。
 *   · 这里 —— **没人标任何东西**，任务只是单纯干超时了：已开工、还没干完、
 *     计划结束日已经过去。这种「静默逾期」在真实项目里才是大多数 ——
 *     没人会为每一次拖延都专门去记一条阻碍。
 *
 * 它是**默认关掉**的一个开关（store.autoRollover）。原因和 blocked.ts 里
 * 反复强调的一致：一个日期被系统自动改掉是有代价的 —— 顺延几天并没有唯一
 * 正确答案，而计划结束日是排期的锚。所以把「要不要让计划自动让位给事实」
 * 这个判断交回给用户，而不是替他默认决定。开了之后：
 *
 *   1. **只推叶子任务。** 父任务的日期是子任务汇总出来的（model.resolve），
 *      直接推它下一轮汇总就覆盖回去了，等于没改。
 *   2. **必须已开工**（actualStartDay 非空）。没开工的逾期是「还没排上」，
 *      不是「干超时」，推它的计划结束日只会掩盖真正的问题。
 *   3. **必须没干完**（progress < 1）。干完的活不该再被推日期。
 *   4. 和阻碍顺延**取最大值、不叠加**（合并逻辑在 store 里），否则同一天
 *      会被算两次。
 *   5. 和阻碍顺延一样**不进撤销栈**（store.extendOpenBlockers 走 applySystem）——
 *      它不是用户的操作，⌘Z 撤销它没有意义，下一次跨天它还会回来。
 */

import type { Task } from "../gantt/model";

/** rolloverOverdue 需要读的那几个字段 */
export interface RolloverHost {
  endDay: number;
  actualStartDay: number | null;
  progress: number;
}

/**
 * 一条任务是不是「已开工、没干完、计划结束日已过」——
 * 即这次跨天该不该给它顺延计划结束日。
 *
 * 注意**不判叶子**：叶子判定要看全项目有没有别的任务以它为父，
 * 那是 store 的活（它手上有整张 tasks 表）。这里只管单条任务自身的状态。
 */
export function isOverdue(task: RolloverHost, today: number): boolean {
  return task.actualStartDay != null && task.progress < 1 && task.endDay < today;
}

/**
 * 跨天：逾期任务把计划结束日推到今天。
 *
 * 返回 null 表示这条任务没有要改的 —— 调用方据此不产生写入，否则每分钟
 * 一次的跨天检查会把整个项目反复写库。
 *
 * 幂等：推到今天之后（endDay === today）当天再调一次就返回 null，不会
 * 重复推；要到明天跨天、today 又往前走一格，才会再推一天。
 */
export function rolloverOverdue(task: Task, today: number): Partial<Task> | null {
  if (!isOverdue(task, today)) return null;
  return { endDay: today };
}
