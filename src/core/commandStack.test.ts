import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandStack } from "./commandStack";
import { invertEdits, makeCommand, type Edit, type TaskMap } from "./edits";
import type { Task } from "../gantt/model";

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

let tasks: TaskMap;
let stack: CommandStack;

beforeEach(() => {
  tasks = new Map([1, 2, 3].map((id) => [id, task(id)]));
  stack = new CommandStack(tasks);
});

describe("基本撤销重做", () => {
  it("执行后可撤销，撤销后可重做", () => {
    expect(stack.canUndo).toBe(false);

    stack.execute(makeCommand("移动任务", tasks, [{ id: 1, changes: { startDay: 110 } }]));
    expect(tasks.get(1)!.startDay).toBe(110);
    expect(stack.canUndo).toBe(true);
    expect(stack.undoLabel).toBe("移动任务");

    stack.undo();
    expect(tasks.get(1)!.startDay).toBe(100);
    expect(stack.canRedo).toBe(true);

    stack.redo();
    expect(tasks.get(1)!.startDay).toBe(110);
  });

  it("新操作清空 redo 栈", () => {
    stack.execute(makeCommand("A", tasks, [{ id: 1, changes: { startDay: 110 } }]));
    stack.undo();
    expect(stack.canRedo).toBe(true);

    stack.execute(makeCommand("B", tasks, [{ id: 2, changes: { startDay: 120 } }]));
    expect(stack.canRedo).toBe(false);
  });

  it("空命令不入栈", () => {
    stack.execute(null);
    // startDay 本来就是 100，不构成变更
    stack.execute(makeCommand("无变化", tasks, [{ id: 1, changes: { startDay: 100 } }]));
    expect(stack.canUndo).toBe(false);
  });
});

describe("复合命令 —— 连锁重排的核心要求", () => {
  it("一次重排 3 个任务，撤销一次全部回滚（DESIGN.md §7）", () => {
    const command = makeCommand(
      "重排 3 个任务",
      tasks,
      [1, 2, 3].map((id) => ({ id, changes: { startDay: 200 + id } })),
    );
    stack.execute(command);

    expect([...tasks.values()].map((t) => t.startDay)).toEqual([201, 202, 203]);

    // 关键：撤一次，不是撤三次
    stack.undo();
    expect([...tasks.values()].map((t) => t.startDay)).toEqual([100, 100, 100]);
    expect(stack.canUndo).toBe(false);
  });
});

describe("edits 求逆", () => {
  it("删除的逆是插入，且顺序颠倒", () => {
    const edits: Edit[] = [
      { kind: "delete", row: task(1) },
      { kind: "delete", row: task(2, { parentId: 1 }) },
    ];
    const inverse = invertEdits(edits);

    // 必须先插回父任务 1，否则子任务 2 的 parentId 悬空
    expect(inverse.map((e) => e.kind)).toEqual(["insert", "insert"]);
    expect((inverse[0] as { row: Task }).row.id).toBe(2);
    expect((inverse[1] as { row: Task }).row.id).toBe(1);
  });

  it("求逆两次回到原样", () => {
    const edits: Edit[] = [
      { kind: "update", id: 1, before: { progress: 0 }, after: { progress: 0.5 } },
      { kind: "insert", row: task(9) },
    ];
    expect(invertEdits(invertEdits(edits))).toEqual(edits);
  });

  it("只记录真正变化的字段", () => {
    const command = makeCommand("改名", tasks, [
      { id: 1, changes: { name: "新名字", startDay: 100 } },
    ])!;
    const edit = command.edits[0] as { after: Partial<Task> };
    expect(Object.keys(edit.after)).toEqual(["name"]);
  });
});

describe("连续手势合并", () => {
  it("拖动进度手柄的一串微小变更合并成一条命令", () => {
    for (const p of [0.1, 0.2, 0.35, 0.5]) {
      stack.executeOrMerge(
        makeCommand("调整进度", tasks, [{ id: 1, changes: { progress: p } }]),
      );
    }
    expect(tasks.get(1)!.progress).toBe(0.5);

    // 撤销一次应该直接回到起点 0，而不是退回 0.35
    stack.undo();
    expect(tasks.get(1)!.progress).toBe(0);
    expect(stack.canUndo).toBe(false);
  });

  it("换了操作类型就不再合并", () => {
    stack.executeOrMerge(makeCommand("调整进度", tasks, [{ id: 1, changes: { progress: 0.5 } }]));
    stack.executeOrMerge(makeCommand("移动任务", tasks, [{ id: 1, changes: { startDay: 150 } }]));

    stack.undo();
    expect(tasks.get(1)!.startDay).toBe(100);
    expect(tasks.get(1)!.progress).toBe(0.5); // 进度那条还在栈里
    expect(stack.canUndo).toBe(true);
  });

  it("改的字段不同就不合并", () => {
    stack.executeOrMerge(makeCommand("编辑", tasks, [{ id: 1, changes: { progress: 0.5 } }]));
    stack.executeOrMerge(makeCommand("编辑", tasks, [{ id: 1, changes: { name: "X" } }]));
    stack.undo();
    expect(tasks.get(1)!.name).toBe("任务1");
    expect(tasks.get(1)!.progress).toBe(0.5);
  });
});

describe("持久化钩子", () => {
  it("撤销时下发的是逆向 edits，持久化层可以直接照写", () => {
    const listener = vi.fn();
    stack.subscribe(listener);

    stack.execute(makeCommand("移动", tasks, [{ id: 1, changes: { startDay: 110 } }]));
    expect(listener).toHaveBeenLastCalledWith(
      [{ kind: "update", id: 1, before: { startDay: 100 }, after: { startDay: 110 } }],
      "execute",
    );

    stack.undo();
    expect(listener).toHaveBeenLastCalledWith(
      [{ kind: "update", id: 1, before: { startDay: 110 }, after: { startDay: 100 } }],
      "undo",
    );
  });
});

describe("栈深度上限", () => {
  it("超出上限后丢弃最早的命令", () => {
    const small = new CommandStack(tasks, 3);
    for (let i = 0; i < 5; i++) {
      small.execute(makeCommand(`第${i}步`, tasks, [{ id: 1, changes: { startDay: 100 + i + 1 } }]));
    }
    let count = 0;
    while (small.undo()) count++;
    expect(count).toBe(3);
  });
});
