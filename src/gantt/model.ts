/** 任务模型与汇总规则。全部是纯函数，不碰 UI 也不碰数据库。 */

import type { BlockedPeriod } from "../core/blocked";

export type Priority = 0 | 1 | 2 | 3; // P0 紧急 / P1 高 / P2 中 / P3 低

export interface Task {
  id: number;
  parentId: number | null;
  name: string;
  /** 叶子任务的计划起止（含首尾两天）。父任务的这两个字段由子任务汇总覆盖 */
  startDay: number;
  endDay: number;
  /** 实施起止，null = 还没动过（显示计划虚线）。两端同为 null 或同有值，库层触发器保证 */
  actualStartDay: number | null;
  actualEndDay: number | null;
  /** 0–1。父任务的进度由子任务加权汇总，不可手填 */
  progress: number;
  priority: Priority;
  /** 指向 people 表；null 表示未指派 */
  personId: number | null;
  milestone: boolean;
  /** 手动权重覆盖；null 表示按工期加权 */
  weight: number | null;
  collapsed: boolean;
  /** 锁定后不参与自动重排，v2 才会真正用到 */
  pinned: boolean;
  /** 兄弟排序。用 REAL：插入时取中点，不必给后面所有行重新编号 */
  sortOrder: number;
  /** 受阻时段（core/blocked.ts）。纯记录，不影响日期、工期、进度 */
  blocked: BlockedPeriod[];
  /**
   * 实施逾期时跨天自动把计划结束日顺延到今天（core/rollover.ts）。
   * 每条任务自己的开关；只对叶子有意义，父任务日期会被汇总覆盖。
   */
  autoRollover: boolean;
}

/** 汇总之后的只读视图，渲染层只认这个。 */
export interface ResolvedTask extends Task {
  depth: number;
  hasChildren: boolean;
  /** 折叠祖先导致的不可见 */
  visible: boolean;
}

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
 * 自底向上汇总并展平成渲染顺序。父任务日期 = 子任务最早开始 ~ 最晚结束；
 * 进度 = Σ(子进度 × 子权重) / Σ子权重，权重默认取工期。两者都不可手填。
 */
export function resolve(tasks: Task[]): ResolvedTask[] {
  const childrenOf = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const list = childrenOf.get(t.parentId);
    if (list) list.push(t);
    else childrenOf.set(t.parentId, [t]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  const resolved = new Map<number, Rollup>();
  /** 正在计算中的节点。脏数据里父子成环时当叶子处理，否则递归爆栈白屏 */
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
      // 实施区间只汇总已填过的子任务；一个都没动过时父任务也是 null
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
      // 同一条任务只展平一次，否则成环时 walk 也绕不出来
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
