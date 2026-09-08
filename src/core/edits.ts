/**
 * 编辑原语。
 *
 * 整个应用的所有数据变更都必须表达成 Edit[]，没有例外（DESIGN.md §7）。
 *
 * 关键取舍：Edit 记录的是「行级前后快照」，而不是「操作的语义逆运算」。
 * 也就是说不存在 MoveTaskCommand / ResizeTaskCommand 各自实现自己的 undo() ——
 * 那种写法每加一种编辑就多一个可能写错的逆运算，而且组合起来极难验证。
 * 这里只有一种逆运算：把 before 写回去。
 */

import type { Task } from "../gantt/model";

export type Edit =
  | { kind: "insert"; row: Task }
  | { kind: "delete"; row: Task }
  | { kind: "update"; id: number; before: Partial<Task>; after: Partial<Task> };

/** 一次用户操作 = 一条命令。连锁重排的 20 个任务打包成一条，撤销一次全回滚。 */
export interface Command {
  /** 显示在撤销提示里，如「移动任务」「重排 7 个任务」 */
  label: string;
  edits: Edit[];
}

export type TaskMap = Map<number, Task>;

/** 正向应用。就地修改传入的 map —— 调用方负责决定要不要先复制。 */
export function applyEdits(tasks: TaskMap, edits: Edit[]): void {
  for (const edit of edits) {
    switch (edit.kind) {
      case "insert":
        tasks.set(edit.row.id, { ...edit.row });
        break;
      case "delete":
        tasks.delete(edit.row.id);
        break;
      case "update": {
        const current = tasks.get(edit.id);
        if (!current) {
          throw new Error(`applyEdits: 任务 ${edit.id} 不存在，无法更新`);
        }
        tasks.set(edit.id, { ...current, ...edit.after });
        break;
      }
    }
  }
}

/**
 * 求逆：顺序颠倒 + 每条各自取反。
 *
 * 顺序必须颠倒。反例：先删父任务再删子任务，逆运算若不颠倒就会先插入子任务，
 * 而此时父任务还不存在，外键约束当场炸掉。
 */
export function invertEdits(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    switch (edit.kind) {
      case "insert":
        out.push({ kind: "delete", row: edit.row });
        break;
      case "delete":
        out.push({ kind: "insert", row: edit.row });
        break;
      case "update":
        out.push({ kind: "update", id: edit.id, before: edit.after, after: edit.before });
        break;
    }
  }
  return out;
}

/**
 * 构造一条 update Edit，自动只记录真正变化的字段。
 *
 * 这不只是省空间：只记差异，两条相邻命令才可能被安全地合并
 * （比如连续拖动进度手柄产生的一串微小变更）。
 */
export function diffTask(current: Task, changes: Partial<Task>): Edit | null {
  const before: Partial<Task> = {};
  const after: Partial<Task> = {};
  let changed = false;

  for (const key of Object.keys(changes) as (keyof Task)[]) {
    const next = changes[key];
    if (next === undefined || Object.is(current[key], next)) continue;
    (before as Record<string, unknown>)[key] = current[key];
    (after as Record<string, unknown>)[key] = next;
    changed = true;
  }

  return changed ? { kind: "update", id: current.id, before, after } : null;
}

/** 便捷构造：一批任务的字段变更打包成一条命令。 */
export function makeCommand(
  label: string,
  tasks: TaskMap,
  changes: Array<{ id: number; changes: Partial<Task> }>,
): Command | null {
  const edits: Edit[] = [];
  for (const { id, changes: patch } of changes) {
    const current = tasks.get(id);
    if (!current) continue;
    const edit = diffTask(current, patch);
    if (edit) edits.push(edit);
  }
  return edits.length > 0 ? { label, edits } : null;
}
