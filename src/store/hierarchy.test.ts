// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "../gantt/model";
import type { TaskRow } from "../db/api";
import { isoToDay } from "../gantt/time";

/**
 * 层级与排序的行为测试。
 *
 * 这里覆盖的正是「加不了子任务」的根因：兄弟顺序原先靠 Map 的插入序，
 * 导致新任务只能落到末尾，「在选中行之后插入」根本无法表达。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const row = (id: number, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDate: "2026-08-03",
  endDate: "2026-08-07",
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  note: "",
  sortOrder: id,
  blocked: "[]",
  actualStart: null,
  actualEnd: null,
  ...over,
});

/** 加载一个项目，返回 store —— 每个用例都拿到干净的状态 */
async function loadStore(rows: TaskRow[]) {
  vi.resetModules();
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "load_project") {
      return Promise.resolve({
        project: {
          id: 1,
          name: "P",
          color: "#6366f1",
          workDays: "[1,2,3,4,5]",
          holidays: "[]",
          sortOrder: 0,
          createdAt: "0",
          updatedAt: "0",
        },
        tasks: rows,
        dependencies: [],
        baselines: [],
        // 和真实情况一致：全库最大 id + 1
        nextTaskId: Math.max(0, ...rows.map((r) => r.id)) + 1,
      });
    }
    return Promise.resolve(cmd === "list_projects" ? [] : null);
  });

  const { useAppStore } = await import("./useAppStore");
  await useAppStore.getState().openProject(1);
  return useAppStore;
}

/** 当前展平后的顺序（id + 深度），即用户在左侧网格看到的样子 */
const outline = (store: { getState: () => { tasks: Map<number, unknown> } }) =>
  resolve([...(store.getState().tasks.values() as Iterable<never>)]).map((t) => [
    t.id,
    t.depth,
  ]);

beforeEach(() => {
  invoke.mockReset();
});

describe("新建子任务", () => {
  it("直接挂到指定任务下，不需要先建同级再缩进", async () => {
    const store = await loadStore([row(1), row(2)]);
    store.getState().addSubtask(1);

    expect(outline(store)).toEqual([
      [1, 0],
      [3, 1], // 新的子任务
      [2, 0],
    ]);
  });

  it("一个还没有任何兄弟的任务也能挂子任务", async () => {
    // 这正是「新建同级 + ⌘] 缩进」做不到的场景：缩进需要前面有兄弟
    const store = await loadStore([row(1)]);
    store.getState().addSubtask(1);
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("挂到折叠的父节点下会自动展开，否则新任务凭空消失", async () => {
    const store = await loadStore([row(1, { collapsed: true }), row(2, { parentId: 1 })]);
    store.getState().addSubtask(1);

    expect(store.getState().tasks.get(1)!.collapsed).toBe(false);
    expect(outline(store).length).toBe(3);
  });

  it("展开与插入是同一条命令，撤销一次全部回滚", async () => {
    const store = await loadStore([row(1, { collapsed: true }), row(2, { parentId: 1 })]);
    store.getState().addSubtask(1);
    store.getState().undo();

    expect(store.getState().tasks.get(1)!.collapsed).toBe(true);
    expect(store.getState().tasks.size).toBe(2);
  });

  it("新建的子任务成为选中行，可以直接接着改名", async () => {
    const store = await loadStore([row(1)]);
    store.getState().addSubtask(1);
    expect(store.getState().selectedId).toBe(2);
  });
});

describe("新建同级任务的插入位置", () => {
  it("插在选中行的紧后面，而不是列表末尾", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().addTaskAfter(1);

    expect(outline(store)).toEqual([
      [1, 0],
      [4, 0], // 新任务落在 1 和 2 之间
      [2, 0],
      [3, 0],
    ]);
  });

  it("在同一处连插三次，顺序依然稳定", async () => {
    const store = await loadStore([row(1), row(2)]);
    store.getState().addTaskAfter(1); // id 3
    store.getState().addTaskAfter(1); // id 4
    store.getState().addTaskAfter(1); // id 5

    expect(outline(store).map(([id]) => id)).toEqual([1, 5, 4, 3, 2]);
  });

  it("在子任务上按 Enter 建的是同级子任务，不是顶层任务", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 })]);
    store.getState().addTaskAfter(2);

    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 1], // 仍在父任务 1 之下
    ]);
  });
});

describe("缩进与取消缩进", () => {
  it("缩进后成为前一个兄弟的最后一个子任务", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 }), row(3)]);
    store.getState().indentTask(3);

    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 1], // 排在已有子任务 2 的后面
    ]);
  });

  it("第一个兄弟无法缩进（前面没有可当父节点的行）", async () => {
    const store = await loadStore([row(1), row(2)]);
    store.getState().indentTask(1);
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it("取消缩进后落在原父任务的紧后面，而不是跳到末尾", async () => {
    const store = await loadStore([
      row(1),
      row(2, { parentId: 1 }),
      row(3), // 后面还有别的顶层任务
    ]);
    store.getState().outdentTask(2);

    expect(outline(store)).toEqual([
      [1, 0],
      [2, 0], // 紧跟在原父任务后面
      [3, 0],
    ]);
  });

  it("缩进可撤销", async () => {
    const store = await loadStore([row(1), row(2)]);
    store.getState().indentTask(2);
    expect(store.getState().tasks.get(2)!.parentId).toBe(1);

    store.getState().undo();
    expect(store.getState().tasks.get(2)!.parentId).toBe(null);
  });
});

describe("上下移动", () => {
  it("在兄弟之间上移一位", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().moveTask(3, -1);
    expect(outline(store).map(([id]) => id)).toEqual([1, 3, 2]);
  });

  it("下移一位", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().moveTask(1, 1);
    expect(outline(store).map(([id]) => id)).toEqual([2, 1, 3]);
  });

  it("到达首尾就不动，不会跳到别的父节点下面", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 }), row(3, { parentId: 1 })]);
    store.getState().moveTask(2, -1); // 已经是第一个子任务
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
  });

  it("只在同一父节点内移动，不会跨层级", async () => {
    const store = await loadStore([
      row(1),
      row(2, { parentId: 1 }),
      row(3), // 另一个顶层任务
    ]);
    store.getState().moveTask(2, 1); // 子任务已经是唯一的兄弟
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
  });

  it("sortOrder 全相等这种退化数据也能正常移动", async () => {
    // 交换两个 sortOrder 的写法在这里会静默失效；重新编号则能自愈
    const store = await loadStore([
      row(1, { sortOrder: 0 }),
      row(2, { sortOrder: 0 }),
      row(3, { sortOrder: 0 }),
    ]);
    store.getState().moveTask(1, 1);
    expect(outline(store).map(([id]) => id)).toEqual([2, 1, 3]);
  });

  it("移动可撤销", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().moveTask(3, -1);
    store.getState().undo();
    expect(outline(store).map(([id]) => id)).toEqual([1, 2, 3]);
  });

  it("一次移动是一条命令，不是逐行多条", async () => {
    const store = await loadStore([row(1), row(2), row(3), row(4)]);
    store.getState().moveTask(4, -1);
    store.getState().undo();
    expect(store.getState().stack!.canUndo).toBe(false);
  });
});

describe("拖放重挂", () => {
  it("拖到另一个任务中间 → 变成它的子任务，追加在末尾", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 }), row(3)]);
    store.getState().reparentTask(3, 1, "inside");
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
  });

  it("拖到上缘 → 插到目标之前，且成为目标的同级", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 }), row(3)]);
    store.getState().reparentTask(3, 2, "before");
    expect(outline(store)).toEqual([
      [1, 0],
      [3, 1],
      [2, 1],
    ]);
  });

  it("拖到下缘 → 插到目标之后", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().reparentTask(1, 2, "after");
    expect(outline(store).map(([id]) => id)).toEqual([2, 1, 3]);
  });

  it("子任务能被拖出来变回顶层", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 }), row(3)]);
    store.getState().reparentTask(2, 3, "after");
    expect(outline(store)).toEqual([
      [1, 0],
      [3, 0],
      [2, 0],
    ]);
  });

  it("整棵子树跟着一起走", async () => {
    const store = await loadStore([
      row(1),
      row(2, { parentId: 1 }),
      row(3, { parentId: 2 }),
      row(4),
    ]);
    store.getState().reparentTask(2, 4, "inside");
    expect(outline(store)).toEqual([
      [1, 0],
      [4, 0],
      [2, 1],
      [3, 2], // 孙子任务保持在子任务之下
    ]);
  });

  it("不能拖进自己的后代 —— 那会造出一个脱离树的环", async () => {
    const store = await loadStore([
      row(1),
      row(2, { parentId: 1 }),
      row(3, { parentId: 2 }),
    ]);
    expect(store.getState().canDrop(1, 3, "inside")).toBe(false);
    store.getState().reparentTask(1, 3, "inside");
    // 结构原样不动，且没有无限递归
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  it("不能拖到自己身上", async () => {
    const store = await loadStore([row(1), row(2)]);
    expect(store.getState().canDrop(1, 1, "inside")).toBe(false);
  });

  it("里程碑不接受子任务 —— 它是时间点不是容器", async () => {
    const store = await loadStore([row(1, { milestone: true }), row(2)]);
    expect(store.getState().canDrop(2, 1, "inside")).toBe(false);
    // 但插到它前后是允许的
    expect(store.getState().canDrop(2, 1, "before")).toBe(true);
    expect(store.getState().canDrop(2, 1, "after")).toBe(true);
  });

  it("拖进折叠的父节点会自动展开，否则任务凭空消失", async () => {
    const store = await loadStore([
      row(1, { collapsed: true }),
      row(2, { parentId: 1 }),
      row(3),
    ]);
    store.getState().reparentTask(3, 1, "inside");
    expect(store.getState().tasks.get(1)!.collapsed).toBe(false);
    expect(outline(store).length).toBe(3);
  });

  it("一次拖放是一条命令：撤销同时还原父子关系和整组顺序", async () => {
    const store = await loadStore([row(1), row(2), row(3)]);
    store.getState().reparentTask(3, 1, "inside");
    expect(store.getState().tasks.get(3)!.parentId).toBe(1);

    store.getState().undo();
    expect(store.getState().tasks.get(3)!.parentId).toBe(null);
    expect(outline(store).map(([id]) => id)).toEqual([1, 2, 3]);
    expect(store.getState().stack!.canUndo).toBe(false);
  });

  it("非法拖放不产生任何命令，撤销栈保持干净", async () => {
    const store = await loadStore([row(1), row(2, { parentId: 1 })]);
    store.getState().reparentTask(1, 2, "inside"); // 拖进自己的后代
    expect(store.getState().stack!.canUndo).toBe(false);
  });
});

describe("受阻时段", () => {
  const period = (id: string, from: string, to: string) => ({
    id,
    from: isoToDay(from),
    to: isoToDay(to),
    reason: "equipment" as const,
  });

  it("加一段受阻不动任务的任何日期和进度", async () => {
    const store = await loadStore([
      row(1, { startDate: "2026-08-13", endDate: "2026-08-17", progress: 0.6 }),
    ]);
    const before = { ...store.getState().tasks.get(1)! };

    store.getState().addBlocked(1, period("b1", "2026-08-15", "2026-08-17"));

    const after = store.getState().tasks.get(1)!;
    expect(after.startDay).toBe(before.startDay);
    expect(after.endDay).toBe(before.endDay);
    expect(after.progress).toBe(before.progress);
    expect(after.blocked).toHaveLength(1);
  });

  it("走命令栈，⌘Z 能撤销 —— 和条子上其他拖拽保持一致", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().addBlocked(1, period("b1", "2026-08-15", "2026-08-17"));
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(0);
  });

  it("删除也可撤销，所以不需要二次确认", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().addBlocked(1, period("b1", "2026-08-15", "2026-08-17"));
    store.getState().removeBlocked(1, "b1");
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(0);

    store.getState().undo();
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(1);
  });

  /**
   * 这里原来断言的是「超出任务尾部就裁回去」。
   *
   * 改掉了：详情面板可以直接调受阻天数，调过头被安静裁回的表现是
   * 「调了没反应」—— 最难查的那种 bug。现在反过来，**任务让位给事实**：
   * 一段真发生过的受阻比一个计划日期更硬（core/blocked.fitBlocked）。
   */
  it("把受阻调到任务尾部之外，会把任务的计划结束日一起拉长", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().addBlocked(1, period("b1", "2026-08-15", "2026-08-17"));
    store.getState().updateBlocked(1, {
      ...period("b1", "2026-08-15", "2026-08-30"),
      reason: "quality",
    });

    const task = store.getState().tasks.get(1)!;
    const [only] = task.blocked;
    expect(only.reason).toBe("quality");
    expect(only.to).toBe(isoToDay("2026-08-30"));
    expect(task.endDay).toBe(isoToDay("2026-08-30"));
  });

  it("往任务开始日之前挪，则夹回开始日 —— 活还没开工谈不上推不动", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().addBlocked(1, period("b1", "2026-08-15", "2026-08-16"));
    store.getState().updateBlocked(1, period("b1", "2026-08-01", "2026-08-16"));

    const task = store.getState().tasks.get(1)!;
    expect(task.blocked[0].from).toBe(isoToDay("2026-08-13"));
    expect(task.startDay).toBe(isoToDay("2026-08-13"));
  });
});

describe("实施日期的写入", () => {
  it("写实施日期不动计划日期", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().setActualSpan(1, {
      startDay: isoToDay("2026-08-15"),
      endDay: isoToDay("2026-08-22"),
    });

    const t = store.getState().tasks.get(1)!;
    expect(t.startDay).toBe(isoToDay("2026-08-13"));
    expect(t.endDay).toBe(isoToDay("2026-08-17"));
    expect(t.actualStartDay).toBe(isoToDay("2026-08-15"));
    expect(t.actualEndDay).toBe(isoToDay("2026-08-22"));
  });

  it("两端始终同空同有 —— 半填状态没有语义", async () => {
    const store = await loadStore([row(1)]);
    store.getState().setActualSpan(1, {
      startDay: isoToDay("2026-08-15"),
      endDay: isoToDay("2026-08-22"),
    });
    store.getState().setActualSpan(1, null);

    const t = store.getState().tasks.get(1)!;
    expect(t.actualStartDay).toBe(null);
    expect(t.actualEndDay).toBe(null);
  });

  it("起止传反了会自动摆正", async () => {
    const store = await loadStore([row(1)]);
    store.getState().setActualSpan(1, {
      startDay: isoToDay("2026-08-22"),
      endDay: isoToDay("2026-08-15"),
    });
    const t = store.getState().tasks.get(1)!;
    expect(t.actualStartDay).toBe(isoToDay("2026-08-15"));
    expect(t.actualEndDay).toBe(isoToDay("2026-08-22"));
  });

  it("采用计划日期 = 把计划原样抄成实施", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-17" })]);
    store.getState().adoptPlanDates(1);
    const t = store.getState().tasks.get(1)!;
    expect(t.actualStartDay).toBe(t.startDay);
    expect(t.actualEndDay).toBe(t.endDay);
  });

  it("走命令栈，可以撤销", async () => {
    const store = await loadStore([row(1)]);
    store.getState().adoptPlanDates(1);
    expect(store.getState().tasks.get(1)!.actualStartDay).not.toBe(null);
    store.getState().undo();
    expect(store.getState().tasks.get(1)!.actualStartDay).toBe(null);
  });

  it("实施区间缩短时，落在外面的受阻时段跟着裁掉", async () => {
    const store = await loadStore([row(1, { startDate: "2026-08-13", endDate: "2026-08-25" })]);
    store.getState().addBlocked(1, {
      id: "b1",
      from: isoToDay("2026-08-20"),
      to: isoToDay("2026-08-22"),
      reason: "equipment",
    });
    // 实施只干到 8/18，受阻那段整个落在外面
    store.getState().setActualSpan(1, {
      startDay: isoToDay("2026-08-13"),
      endDay: isoToDay("2026-08-18"),
    });
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(0);
  });
});

describe("保存失败时不能丢数据", () => {
  it("落库失败时留在项目里，内存中的任务一条都不丢", async () => {
    const store = await loadStore([row(1), row(2)]);
    store.getState().patchTask(1, { name: "改了个名" }, "重命名");

    // 让保存失败（比如跨项目 id 撞车被后端挡下）
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "save_project") return Promise.reject("保存中止：ID 冲突");
      return Promise.resolve(cmd === "list_projects" ? [] : null);
    });

    await store.getState().closeProject();

    // 之前这里是 .catch(() => {}) 然后照样清空 —— 一条静默丢数据的通道
    expect(store.getState().screen.name).toBe("workspace");
    expect(store.getState().tasks.size).toBe(2);
    expect(store.getState().tasks.get(1)!.name).toBe("改了个名");
    expect(store.getState().saveError).toBeTruthy();
  });

  it("保存成功才真的离开", async () => {
    const store = await loadStore([row(1)]);
    store.getState().patchTask(1, { name: "x" }, "重命名");
    await store.getState().closeProject();

    expect(store.getState().screen.name).toBe("list");
    expect(store.getState().tasks.size).toBe(0);
  });
});

describe("删除子树", () => {
  it("删父任务会带走所有后代，撤销一次整棵树回来", async () => {
    const store = await loadStore([
      row(1),
      row(2, { parentId: 1 }),
      row(3, { parentId: 2 }),
      row(4),
    ]);
    store.getState().deleteTask(1);
    expect(outline(store)).toEqual([[4, 0]]);

    store.getState().undo();
    expect(outline(store)).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
    ]);
  });
});
