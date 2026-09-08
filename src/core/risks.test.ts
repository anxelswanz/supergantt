/**
 * 风险清单的排序与归集。
 *
 * 排序这条特别值得钉住：等级用 0 高 / 1 中 / 2 低，「按等级降序」在代码里
 * 是数值**升序**。反了的话高风险会被排到列表最底下 —— 而这种错在界面上
 * 一点也不显眼，列表照样是排好序的样子。
 */

import { describe, expect, it } from "vitest";
import { canAddRisk, riskFlags, sortRisks } from "./risks";
import type { Risk } from "../db/api";
import type { Task } from "../gantt/model";

const TODAY = 1000;

const risk = (over: Partial<Risk> & { id: number }): Risk => ({
  taskId: 1,
  content: `风险${over.id}`,
  level: 1,
  resolved: false,
  createdAt: 1_700_000_000,
  resolvedAt: null,
  resolution: null,
  ...over,
});

describe("sortRisks", () => {
  it("等级高的在前", () => {
    const out = sortRisks([risk({ id: 1, level: 2 }), risk({ id: 2, level: 0 }), risk({ id: 3, level: 1 })]);
    expect(out.map((r) => r.level)).toEqual([0, 1, 2]);
  });

  it("未关闭的整体排在已关闭之前，哪怕它等级更低", () => {
    const out = sortRisks([
      risk({ id: 1, level: 0, resolved: true }),
      risk({ id: 2, level: 2, resolved: false }),
    ]);
    expect(out.map((r) => r.id)).toEqual([2, 1]);
  });

  it("同级按记录时间，早的在前", () => {
    const out = sortRisks([
      risk({ id: 1, level: 1, createdAt: 200 }),
      risk({ id: 2, level: 1, createdAt: 100 }),
    ]);
    expect(out.map((r) => r.id)).toEqual([2, 1]);
  });

  it("不改动传入的数组", () => {
    const input = [risk({ id: 1, level: 2 }), risk({ id: 2, level: 0 })];
    sortRisks(input);
    expect(input.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("riskFlags", () => {
  it("按任务数未关闭的条数，并记下最高一档", () => {
    const flags = riskFlags([
      risk({ id: 1, taskId: 7, level: 2 }),
      risk({ id: 2, taskId: 7, level: 0 }),
      risk({ id: 3, taskId: 8, level: 1 }),
    ]);
    expect(flags.get(7)).toEqual({ count: 2, top: 0 });
    expect(flags.get(8)).toEqual({ count: 1, top: 1 });
  });

  it("已关闭的不计入 —— 角标是待办提示，不是历史统计", () => {
    const flags = riskFlags([
      risk({ id: 1, taskId: 7, resolved: true }),
      risk({ id: 2, taskId: 7, level: 1 }),
    ]);
    expect(flags.get(7)).toEqual({ count: 1, top: 1 });
  });

  it("一条未关闭的都没有的任务不出现在表里", () => {
    expect(riskFlags([risk({ id: 1, taskId: 7, resolved: true })].slice()).has(7)).toBe(false);
  });
});

describe("canAddRisk", () => {
  const task = (over: Partial<Task> = {}): Pick<Task, "progress" | "actualStartDay" | "blocked"> => ({
    progress: 0,
    actualStartDay: null,
    blocked: [],
    ...over,
  });

  it("进行中的可以记", () => {
    expect(canAddRisk(task({ actualStartDay: TODAY - 1 }), TODAY)).toBe(true);
  });

  it("还没开工、已完成的都不行 —— 和新建阻碍是同一条规矩", () => {
    expect(canAddRisk(task(), TODAY)).toBe(false);
    expect(canAddRisk(task({ progress: 1 }), TODAY)).toBe(false);
  });
});
