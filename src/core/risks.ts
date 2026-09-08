/**
 * 风险点的排序与归集。
 *
 * 风险和受阻是两件事，界面上必须分开显示（DESIGN 里那句「卡住」之所以被拆掉，
 * 就是因为它把两者糊成了一个词）：
 *
 *   · **受阻** = 已经在发生，工期正在被吃掉 —— 见 core/blocked.ts
 *   · **风险** = 可能会发生，现在还没吃掉任何东西
 *
 * 混在一起的后果是行动被延误：受阻要的是「今天去解决」，风险要的是
 * 「安排人盯着」，两者挂在同一个红点下面，看的人分不出哪个该现在打电话。
 *
 * 风险存在独立的表里（migrations/003_notes.sql），即写即存、不进撤销栈。
 */

import { isInProgress } from "./board";
import type { Risk } from "../db/api";

export const RISK_LEVELS = ["高", "中", "低"];
export const RISK_COLORS = ["#ef4444", "#f59e0b", "#64748b"];

export const riskLevelLabel = (level: number): string => RISK_LEVELS[level] ?? "中";

/**
 * 清单的默认顺序：**未关闭在前 → 等级高在前 → 记得早的在前**。
 *
 * 等级用 0 高 / 1 中 / 2 低，所以「等级降序」在这里是数值升序 ——
 * 这个反直觉的地方值得写一句，否则下一个人会「顺手修正」成 b - a，
 * 把高风险全排到列表底下去。
 *
 * 已关闭的沉底而不是隐藏：「这个坑我们踩过并且填了」本身是信息，
 * 但它不该和还没解决的风险抢同一块注意力。
 */
export function sortRisks(risks: Risk[]): Risk[] {
  return [...risks].sort(
    (a, b) =>
      Number(a.resolved) - Number(b.resolved) ||
      a.level - b.level ||
      a.createdAt - b.createdAt ||
      a.id - b.id,
  );
}

/** 一条任务此刻挂着的风险：几条、最高一档是什么 */
export interface RiskFlag {
  count: number;
  /** 0 高 / 1 中 / 2 低 —— 卡片角标按它上色 */
  top: number;
}

/**
 * 按任务归集**未关闭**的风险。
 *
 * 只数未关闭的：卡片上的角标是一个待办提示，已经关掉的风险留在角标里
 * 只会让数字永远下不去，最后没人再看它。
 */
export function riskFlags(risks: Risk[]): Map<number, RiskFlag> {
  const out = new Map<number, RiskFlag>();
  for (const r of risks) {
    if (r.resolved) continue;
    const prev = out.get(r.taskId);
    if (prev) {
      prev.count += 1;
      prev.top = Math.min(prev.top, r.level);
    } else {
      out.set(r.taskId, { count: 1, top: r.level });
    }
  }
  return out;
}

/**
 * 能不能给这条任务记风险 —— 判据和新建阻碍是同一个（core/board.isInProgress）。
 *
 * 两个入口共用一条规矩，用户才不会遇到「风险记得下、阻碍记不下」这种
 * 说不出道理的差别。
 */
export const canAddRisk = isInProgress;
