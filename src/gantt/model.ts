/**
 * 任务模型与汇总规则（DESIGN.md §1）。
 *
 * 这里的函数全部是纯函数，不碰 UI 也不碰数据库 —— 它们是整个应用最容易出错
 * 也最值得先钉死的部分。
 */

import type { BlockedPeriod } from "../core/blocked";

export type Priority = 0 | 1 | 2 | 3; // P0 紧急 / P1 高 / P2 中 / P3 低

export interface Task {
  id: number;
  parentId: number | null;
  name: string;
  /** 叶子任务的计划起止（含首尾两天）。父任务的这两个字段由子任务汇总覆盖 */
  startDay: number;
  endDay: number;
  /**
   * 实施起止。null = 还没动过 —— 界面据此显示计划的虚线轮廓。
   * 两端同为 null 或同有值，库层有触发器保证。
   */
  actualStartDay: number | null;
  actualEndDay: number | null;
  /** 0–1。父任务的进度由子任务加权汇总，不可手填 */
  progress: number;
  priority: Priority;
  /** 指向 people 表；null 表示未指派 */
  personId: number | null;
  milestone: boolean;
  /** 手动权重覆盖；null 表示按工期加权（DESIGN.md §1.2） */
  weight: number | null;
  collapsed: boolean;
  /** 锁定后不参与自动重排（DESIGN.md §2.3），v2 才会真正用到 */
  pinned: boolean;
  /**
   * 同一父节点下的兄弟排序。
   *
   * 用 REAL 而不是整数序号：在两行之间插入新行时取中点即可，
   * 不必把后面所有行重新编号（那会让一次「插入」变成 N 行的变更，
   * 撤销栈里就成了一条巨大的命令）。
   */
  sortOrder: number;
  /**
   * 受阻时段：区间内「这几天没能正常推进」的记录（core/blocked.ts）。
   * 纯记录，不影响日期、工期、进度中的任何一个。
   */
  blocked: BlockedPeriod[];
}

/** 汇总之后的只读视图，渲染层只认这个。 */
export interface ResolvedTask extends Task {
  depth: number;
  hasChildren: boolean;
  /** 折叠祖先导致的不可见 */
  visible: boolean;
}

/** 汇总结果：计划区间、实施区间、进度 */
interface Rollup {
  startDay: number;
  endDay: number;
  actualStartDay: number | null;
  actualEndDay: number | null;
  progress: number;
}

export const durationOf = (t: { startDay: number; endDay: number }) =>
  Math.max(1, t.endDay - t.startDay + 1);

/**
 * 自底向上汇总，并展平成渲染顺序。
 *
 * 父任务的两件事都是算出来的、不可手填：
 *   - 日期 = 最早子任务开始 ~ 最晚子任务结束
 *   - 进度 = Σ(子进度 × 子权重) / Σ子权重，权重默认取工期
 *
 * 进度只读这条不是洁癖：一旦允许手填，就会出现「父 80% / 子全 0%」的自相矛盾，
 * 用户从此不再相信界面上的任何数字。
 */
export function resolve(tasks: Task[]): ResolvedTask[] {
  const childrenOf = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const list = childrenOf.get(t.parentId);
    if (list) list.push(t);
    else childrenOf.set(t.parentId, [t]);
  }
  // 兄弟顺序由 sortOrder 决定，不是由数据到达的顺序决定。
  // 否则「在选中行之后插入」就无法表达 —— 新任务只能落到末尾。
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  const resolved = new Map<number, Rollup>();
  /**
   * 正在计算中的节点。
   *
   * 父子关系成环（a 的父是 b、b 的父是 a）时，后序遍历会无限递归直到爆栈 ——
   * 整个界面白屏。环不该出现，但脏数据是会出现的（历史上就出过一次跨项目改写），
   * 所以这里必须自保：遇到环就当叶子处理，让剩下的数据照样能显示出来。
   */
  const visiting = new Set<number>();

  // 后序遍历：先算完所有子节点，再算自己
  const compute = (task: Task): Rollup => {
    const cached = resolved.get(task.id);
    if (cached) return cached;
    if (visiting.has(task.id)) {
      return {
        startDay: task.startDay,
        endDay: task.endDay,
        actualStartDay: task.actualStartDay,
        actualEndDay: task.actualEndDay,
        progress: task.progress,
      };
    }
    visiting.add(task.id);

    const children = childrenOf.get(task.id);
    let out: Rollup;

    if (!children || children.length === 0) {
      out = {
        startDay: task.startDay,
        endDay: task.endDay,
        actualStartDay: task.actualStartDay,
        actualEndDay: task.actualEndDay,
        progress: task.progress,
      };
    } else {
      let start = Infinity;
      let end = -Infinity;
      // 实施区间只汇总**已经填过**的子任务。一个子任务都没动过时，
      // 父任务的实施区间也是 null —— 它同样显示为「还没开始」的虚线
      let actualStart = Infinity;
      let actualEnd = -Infinity;
      let weighted = 0;
      let totalWeight = 0;

      for (const child of children) {
        const c = compute(child);
        start = Math.min(start, c.startDay);
        end = Math.max(end, c.endDay);
        if (c.actualStartDay != null && c.actualEndDay != null) {
          actualStart = Math.min(actualStart, c.actualStartDay);
          actualEnd = Math.max(actualEnd, c.actualEndDay);
        }
        // 权重优先取手动覆盖，否则用汇总后的工期
        const w = child.weight ?? durationOf(c);
        weighted += c.progress * w;
        totalWeight += w;
      }

      const hasActual = Number.isFinite(actualStart);
      out = {
        startDay: start,
        endDay: end,
        actualStartDay: hasActual ? actualStart : null,
        actualEndDay: hasActual ? actualEnd : null,
        progress: totalWeight > 0 ? weighted / totalWeight : 0,
      };
    }

    visiting.delete(task.id);
    resolved.set(task.id, out);
    return out;
  };

  const flat: ResolvedTask[] = [];

  const seen = new Set<number>();
  const walk = (parentId: number | null, depth: number, ancestorCollapsed: boolean) => {
    const children = childrenOf.get(parentId);
    if (!children) return;
    for (const task of children) {
      // 同一条任务只展平一次。环形引用下 walk 也会绕不出来
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const agg = compute(task);
      const hasChildren = (childrenOf.get(task.id)?.length ?? 0) > 0;
      flat.push({
        ...task,
        ...agg,
        depth,
        hasChildren,
        visible: !ancestorCollapsed,
      });
      walk(task.id, depth + 1, ancestorCollapsed || task.collapsed);
    }
  };

  walk(null, 0, false);
  // 折叠的分支已经被标记为不可见，这里直接过滤掉，渲染层不必再关心层级
  return flat.filter((t) => t.visible);
}

/** 项目整体的时间跨度，用于「跳到全部」和迷你缩略图。 */
export function projectSpan(tasks: ResolvedTask[]): [number, number] {
  if (tasks.length === 0) return [0, 30];
  let start = Infinity;
  let end = -Infinity;
  for (const t of tasks) {
    start = Math.min(start, t.startDay);
    end = Math.max(end, t.endDay);
  }
  return [start, end];
}
