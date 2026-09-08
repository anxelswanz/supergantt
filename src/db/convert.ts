/**
 * 数据库行 ↔ 内存模型的转换。
 *
 * 唯一实质性的工作是日期表示的切换：
 *   数据库存 ISO 'YYYY-MM-DD'（自描述、可被 Excel 和 DB 浏览器直接读）
 *   内存用天序号   number      （可做浮点插值和像素换算）
 * 两种表示各有不可替代的理由，转换只发生在这一层。
 */

import type { Priority, Task } from "../gantt/model";
import { dayToIso, isoToDay } from "../gantt/time";
import { parseBlocked, serializeBlocked } from "../core/blocked";
import type { TaskRow } from "./api";

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    startDay: isoToDay(row.startDate),
    endDay: isoToDay(row.endDate),
    actualStartDay: row.actualStart != null ? isoToDay(row.actualStart) : null,
    actualEndDay: row.actualEnd != null ? isoToDay(row.actualEnd) : null,
    progress: row.progress,
    priority: clampPriority(row.priority),
    personId: row.personId,
    milestone: row.milestone,
    weight: row.weight,
    collapsed: row.collapsed,
    pinned: row.pinned,
    sortOrder: row.sortOrder,
    blocked: parseBlocked(row.blocked),
  };
}

/** note 不在渲染模型里，写回时从原始行取回，否则每次保存都会把它抹平。 */
export function taskToRow(task: Task, previous?: TaskRow): TaskRow {
  return {
    id: task.id,
    parentId: task.parentId,
    name: task.name,
    startDate: dayToIso(task.startDay),
    endDate: dayToIso(task.endDay),
    // 两端必须同空同有 —— 库层有触发器兜底，这里保证不会送出半填状态
    actualStart:
      task.actualStartDay != null && task.actualEndDay != null
        ? dayToIso(task.actualStartDay)
        : null,
    actualEnd:
      task.actualStartDay != null && task.actualEndDay != null
        ? dayToIso(task.actualEndDay)
        : null,
    progress: task.progress,
    priority: task.priority,
    personId: task.personId,
    milestone: task.milestone,
    weight: task.weight,
    collapsed: task.collapsed,
    pinned: task.pinned,
    note: previous?.note ?? "",
    sortOrder: task.sortOrder,
    blocked: serializeBlocked(task.blocked),
  };
}

function clampPriority(value: number): Priority {
  const v = Math.round(value);
  return (v < 0 ? 0 : v > 3 ? 3 : v) as Priority;
}
