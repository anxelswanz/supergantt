/**
 * 看板的四列。列由现有字段推导，不存 status 字段（否则和 progress 成了两个真相）；
 * 拖动卡片写回那些字段。
 */

import type { BlockedPeriod } from "./blocked";
import { closeOpenBlocks, newBlockId, type BlockReason } from "./blocked";
import type { ResolvedTask, Task } from "../gantt/model";

export type BoardColumn = "todo" | "doing" | "blocked" | "done";

export const BOARD_COLUMNS: {
  key: BoardColumn;
  label: string;
  /** 列头下说明判据的小字 */
  rule: string;
}[] = [
  { key: "todo", label: "未开始", rule: "没有实施日期，进度为 0" },
  { key: "doing", label: "进行中", rule: "已经动过，但还没做完" },
  // 和详情面板、甘特、复盘统一叫「受阻」
  { key: "blocked", label: "受阻", rule: "有一条还没关掉的阻碍" },
  { key: "done", label: "已完成", rule: "进度 100%" },
];

/**
 * 此刻算不算受阻：没关掉的阻碍，或今天落在区间里的历史标注。
 * 两者都要看：只认区间的话，刚过零点跨天延长还没跑时卡片会短暂跳出受阻列。
 */
export function isBlockedOn(task: Pick<Task, "blocked">, day: number): boolean {
  return task.blocked.some((b) => b.open === true || (b.from <= day && day <= b.to));
}

/**
 * 新建风险的准入判据（进行中或受阻）。受阻列也算，否则同一条活开不了第二条阻碍。
 * 拖进受阻列不走这里，moveToColumn 会先补实施开始日。
 */
export const isInProgress = (
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): boolean => {
  const column = columnOf(task, today);
  return column === "doing" || column === "blocked";
};

/** 卡片落在哪一列。完成优先于受阻：做完的活常留着没关的阻碍，不该报假警 */
export function columnOf(
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): BoardColumn {
  if (task.progress >= 1) return "done";
  if (isBlockedOn(task, today)) return "blocked";
  if (task.actualStartDay != null || task.progress > 0) return "doing";
  return "todo";
}

/**
 * 拖到某一列要写回的字段；已在目标列返回 null，免得撤销栈堆空命令。
 * 实施日期两端必须同空同有（库层有触发器兜底）。
 */
export function moveToColumn(
  task: Pick<
    Task,
    "progress" | "startDay" | "endDay" | "actualStartDay" | "actualEndDay" | "blocked"
  >,
  column: BoardColumn,
  today: number,
  reason: BlockReason = "other",
): Partial<Task> | null {
  if (columnOf(task, today) === column) return null;

  switch (column) {
    case "todo":
      // 抹掉实施痕迹；受阻记录保留，只关掉今天还生效的
      return {
        progress: 0,
        actualStartDay: null,
        actualEndDay: null,
        blocked: closeOpenBlocks(task.blocked, today),
      };

    case "doing": {
      const blocked = closeOpenBlocks(task.blocked, today);
      if (task.actualStartDay != null && task.actualEndDay != null) {
        // 已有实施区间：解除受阻，100% 退到 0.99，否则立刻被判回「已完成」
        return {
          blocked,
          ...(task.progress >= 1 ? { progress: 0.99 } : {}),
        };
      }
      // 第一次开工：今天起，按计划结束日收尾；计划已过则退化成当天
      return {
        actualStartDay: today,
        actualEndDay: Math.max(today, task.endDay),
        blocked,
      };
    }

    case "blocked": {
      // 没开工也能直接拖进来，但要补上实施区间，否则受阻段飘在没有条子的地方
      const started =
        task.actualStartDay != null && task.actualEndDay != null
          ? {}
          : { actualStartDay: today, actualEndDay: Math.max(today, task.endDay) };
      return { ...started, ...openBlockerOn(task, today, reason) };
    }

    case "done": {
      const start = task.actualStartDay ?? today;
      return {
        progress: 1,
        actualStartDay: start,
        // 完成日就是今天，不是的去详情里改
        actualEndDay: Math.max(start, today),
        blocked: closeOpenBlocks(task.blocked, today),
      };
    }
  }
}

/**
 * 新开一条阻碍，默认未关闭、从今天起算。`span` / `live` 给补记用；
 * 持续中的终点顶到今天，和 fitBlocked 同口径。
 */
export function newBlocker(
  today: number,
  reason: BlockReason,
  note?: string,
  span?: { from: number; to: number },
  live = true,
): BlockedPeriod {
  const from = Math.floor(span?.from ?? today);
  const filled = Math.max(from, Math.floor(span?.to ?? today));
  return {
    id: newBlockId(),
    from,
    to: live ? Math.max(filled, today) : filled,
    reason,
    ...(live ? { open: true } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  };
}

/**
 * 开一条阻碍要写回的字段，「新建阻碍」和拖进受阻列共用。
 * 任务区间必须拉长到盖住它，否则下次 reclamp 会把它静默裁掉。
 */
export function openBlockerOn(
  task: Pick<Task, "blocked" | "endDay" | "actualEndDay">,
  today: number,
  reason: BlockReason,
  note?: string,
  span?: { from: number; to: number },
  live = true,
): Partial<Task> {
  const period = newBlocker(today, reason, note, span, live);
  // 拉到阻碍终点而非今天：补记旧阻碍不该把完成的活拽到今天
  const reach = period.to;
  return {
    blocked: [...task.blocked, period],
    ...(task.endDay < reach ? { endDay: reach } : {}),
    ...(task.actualEndDay != null && task.actualEndDay < reach
      ? { actualEndDay: reach }
      : {}),
  };
}

/** 能否记阻碍：比 isInProgress 宽，已完成的也能补记；未开工的不行 */
export const canRecordBlocker = (
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): boolean => columnOf(task, today) !== "todo";

/** 看板只放叶子：父任务是汇总值，拖它没有确定含义 */
export const boardTasks = (tasks: ResolvedTask[]): ResolvedTask[] =>
  tasks.filter((t) => !t.hasChildren);
