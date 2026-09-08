import { describe, expect, it } from "vitest";
import { resolve, type Task } from "./model";

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: 100,
  endDay: 104,
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: id, // 默认按 id 排，即声明顺序
  blocked: [],
  actualStartDay: null,
  actualEndDay: null,
  ...over,
});

describe("父任务进度按工期加权汇总", () => {
  it("1 天完成 + 19 天未动 = 5%，不是 50%", () => {
    // 这是 DESIGN.md §1.2 里那个决定算法选型的例子：
    // 简单平均会给出 50%，严重失真到用户不再信任界面上的数字
    const tasks = [
      task(1),
      task(2, { parentId: 1, startDay: 100, endDay: 100, progress: 1 }), // 1 天，100%
      task(3, { parentId: 1, startDay: 101, endDay: 119, progress: 0 }), // 19 天，0%
    ];
    const parent = resolve(tasks).find((t) => t.id === 1)!;
    expect(parent.progress).toBeCloseTo(0.05, 5);
  });

  it("等工期时退化为简单平均", () => {
    const tasks = [
      task(1),
      task(2, { parentId: 1, startDay: 100, endDay: 104, progress: 1 }),
      task(3, { parentId: 1, startDay: 100, endDay: 104, progress: 0 }),
    ];
    expect(resolve(tasks).find((t) => t.id === 1)!.progress).toBeCloseTo(0.5, 5);
  });

  it("weight 不为 null 时覆盖工期权重", () => {
    const tasks = [
      task(1),
      task(2, { parentId: 1, startDay: 100, endDay: 100, progress: 1, weight: 9 }),
      task(3, { parentId: 1, startDay: 101, endDay: 119, progress: 0, weight: 1 }),
    ];
    expect(resolve(tasks).find((t) => t.id === 1)!.progress).toBeCloseTo(0.9, 5);
  });

  it("三层结构逐级向上冒泡", () => {
    const tasks = [
      task(1), // 阶段
      task(2, { parentId: 1 }), // 模块
      task(3, { parentId: 2, startDay: 100, endDay: 109, progress: 1 }),
      task(4, { parentId: 2, startDay: 110, endDay: 119, progress: 0 }),
    ];
    const out = resolve(tasks);
    expect(out.find((t) => t.id === 2)!.progress).toBeCloseTo(0.5, 5);
    expect(out.find((t) => t.id === 1)!.progress).toBeCloseTo(0.5, 5);
  });

  it("父任务自己填的 progress 被无视", () => {
    const tasks = [
      task(1, { progress: 0.8 }), // 手填 80%
      task(2, { parentId: 1, progress: 0 }),
    ];
    expect(resolve(tasks).find((t) => t.id === 1)!.progress).toBe(0);
  });
});

describe("父任务日期由子任务汇总", () => {
  it("取最早开始与最晚结束", () => {
    const tasks = [
      task(1, { startDay: 0, endDay: 1 }), // 自己填的日期应被覆盖
      task(2, { parentId: 1, startDay: 110, endDay: 115 }),
      task(3, { parentId: 1, startDay: 100, endDay: 108 }),
    ];
    const parent = resolve(tasks).find((t) => t.id === 1)!;
    expect(parent.startDay).toBe(100);
    expect(parent.endDay).toBe(115);
  });

  it("无子任务时保留自身日期", () => {
    const out = resolve([task(1, { startDay: 100, endDay: 104 })]);
    expect(out[0].startDay).toBe(100);
    expect(out[0].endDay).toBe(104);
  });
});

/**
 * 环不该出现，但脏数据会出现 —— 历史上就出过一次跨项目改写。
 * 展平逻辑必须自保，否则整个界面白屏，用户连打开都打不开。
 */
describe("父子成环时不能爆栈", () => {
  it("两个任务互为父子时，仍然返回结果而不是无限递归", () => {
    const tasks = [task(1, { parentId: 2 }), task(2, { parentId: 1 })];
    expect(() => resolve(tasks)).not.toThrow();
  });

  it("环之外的任务照常显示出来", () => {
    const tasks = [
      task(1, { parentId: 2 }),
      task(2, { parentId: 1 }),
      task(3), // 正常的顶层任务
      task(4, { parentId: 3 }),
    ];
    const out = resolve(tasks);
    expect(out.map((t) => t.id)).toContain(3);
    expect(out.map((t) => t.id)).toContain(4);
  });

  it("同一条任务不会被展平两次", () => {
    const tasks = [task(1), task(2, { parentId: 1 }), task(3, { parentId: 2 })];
    const ids = resolve(tasks).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("展平与折叠", () => {
  it("按层级深度优先展平并标注 depth", () => {
    const tasks = [
      task(1),
      task(2, { parentId: 1 }),
      task(3, { parentId: 2 }),
      task(4),
    ];
    expect(resolve(tasks).map((t) => [t.id, t.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
    ]);
  });

  it("折叠的父任务隐藏所有后代，但自己仍然可见", () => {
    const tasks = [
      task(1, { collapsed: true }),
      task(2, { parentId: 1 }),
      task(3, { parentId: 2 }),
      task(4),
    ];
    expect(resolve(tasks).map((t) => t.id)).toEqual([1, 4]);
  });

  it("折叠不影响汇总结果", () => {
    const tasks = [
      task(1, { collapsed: true }),
      task(2, { parentId: 1, startDay: 100, endDay: 109, progress: 1 }),
      task(3, { parentId: 1, startDay: 110, endDay: 119, progress: 0 }),
    ];
    const parent = resolve(tasks)[0];
    expect(parent.progress).toBeCloseTo(0.5, 5);
    expect(parent.endDay).toBe(119);
    expect(parent.hasChildren).toBe(true);
  });
});
