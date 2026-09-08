import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, columnOf, moveToColumn } from "./board";
import type { Task } from "../gantt/model";

const TODAY = 1000;

const task = (over: Partial<Task> = {}): Task => ({
  id: 1,
  parentId: null,
  name: "任务1",
  startDay: TODAY - 2,
  endDay: TODAY + 2,
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: 1,
  blocked: [],
  actualStartDay: null,
  actualEndDay: null,
  ...over,
});

const block = (from: number, to: number) => ({
  id: `b${from}`,
  from,
  to,
  reason: "material" as const,
});

describe("看板归列", () => {
  it("没动过就是未开始", () => {
    expect(columnOf(task(), TODAY)).toBe("todo");
  });

  it("填了实施开始就是进行中", () => {
    expect(columnOf(task({ actualStartDay: TODAY - 1 }), TODAY)).toBe("doing");
  });

  it("只填了进度、没填实施日期，也算动过了", () => {
    // 用户可能只在网格里改了个进度就走了 —— 那也是"开工了"
    expect(columnOf(task({ progress: 0.3 }), TODAY)).toBe("doing");
  });

  it("今天落在受阻区间里就是卡住", () => {
    const t = task({ actualStartDay: TODAY - 3, blocked: [block(TODAY - 1, TODAY + 1)] });
    expect(columnOf(t, TODAY)).toBe("blocked");
  });

  it("受阻已经过去了就不再算卡住", () => {
    const t = task({ actualStartDay: TODAY - 5, blocked: [block(TODAY - 3, TODAY - 2)] });
    expect(columnOf(t, TODAY)).toBe("doing");
  });

  /**
   * 这条挡住的是「假警报」：人做完活之后不会记得回去关掉受阻记录，
   * 于是一堆已完成的任务永远挂在卡住列里，警报一多就没人看了。
   */
  it("已完成优先于卡住 —— 忘了关的受阻不该让完成的活挂在卡住列", () => {
    const t = task({ progress: 1, blocked: [block(TODAY - 1, TODAY + 5)] });
    expect(columnOf(t, TODAY)).toBe("done");
  });
});

describe("拖动卡片写回底层字段", () => {
  it("拖到进行中：从今天开工，按计划结束日收尾", () => {
    const changes = moveToColumn(task(), "doing", TODAY)!;
    expect(changes.actualStartDay).toBe(TODAY);
    expect(changes.actualEndDay).toBe(TODAY + 2); // 计划结束日
  });

  it("计划结束日已经过去的，实施区间退化成今天一天", () => {
    const changes = moveToColumn(task({ endDay: TODAY - 5 }), "doing", TODAY)!;
    expect(changes.actualStartDay).toBe(TODAY);
    expect(changes.actualEndDay).toBe(TODAY);
  });

  it("拖到已完成：进度置满，完成日记今天", () => {
    const changes = moveToColumn(task({ actualStartDay: TODAY - 3, actualEndDay: TODAY + 4 }), "done", TODAY)!;
    expect(changes.progress).toBe(1);
    expect(changes.actualStartDay).toBe(TODAY - 3); // 已有的开工日保留
    expect(changes.actualEndDay).toBe(TODAY);
  });

  it("没开过工就直接拖到已完成：开工日也补成今天", () => {
    const changes = moveToColumn(task(), "done", TODAY)!;
    expect(changes.actualStartDay).toBe(TODAY);
    expect(changes.actualEndDay).toBe(TODAY);
  });

  it("拖到卡住：开一段从今天起的受阻，并把实施区间补上", () => {
    const changes = moveToColumn(task(), "blocked", TODAY, "material")!;
    expect(changes.blocked).toHaveLength(1);
    expect(changes.blocked![0]).toMatchObject({ from: TODAY, to: TODAY, reason: "material" });
    // 受阻要画在条子上，没有实施区间它就飘在空处
    expect(changes.actualStartDay).toBe(TODAY);
  });

  it("从卡住拖回进行中：关掉受阻，但保留历史那几天", () => {
    const t = task({ actualStartDay: TODAY - 5, actualEndDay: TODAY + 5, blocked: [block(TODAY - 2, TODAY + 3)] });
    const changes = moveToColumn(t, "doing", TODAY)!;
    expect(changes.blocked).toHaveLength(1);
    // 已经卡掉的那两天是既成事实，不能抹；只把今天之后的部分砍掉
    expect(changes.blocked![0]).toMatchObject({ from: TODAY - 2, to: TODAY - 1 });
  });

  it("当天开始又当天解除的受阻直接丢掉，不留空区间", () => {
    const t = task({ actualStartDay: TODAY - 5, actualEndDay: TODAY + 5, blocked: [block(TODAY, TODAY + 2)] });
    const changes = moveToColumn(t, "doing", TODAY)!;
    expect(changes.blocked).toHaveLength(0);
  });

  it("从已完成拖回进行中：进度退一档，否则立刻被判回已完成", () => {
    const t = task({ progress: 1, actualStartDay: TODAY - 5, actualEndDay: TODAY });
    const changes = moveToColumn(t, "doing", TODAY)!;
    expect(changes.progress).toBeLessThan(1);
    expect(columnOf({ ...t, ...changes } as Task, TODAY)).toBe("doing");
  });

  it("拖回未开始：抹掉实施痕迹", () => {
    const t = task({ progress: 0.5, actualStartDay: TODAY - 5, actualEndDay: TODAY });
    const changes = moveToColumn(t, "todo", TODAY)!;
    expect(changes).toMatchObject({ progress: 0, actualStartDay: null, actualEndDay: null });
  });

  it("拖到它已经在的那一列，什么都不改 —— 撤销栈里不留空命令", () => {
    expect(moveToColumn(task(), "todo", TODAY)).toBe(null);
  });

  it("每一列都能落回它自己的判据", () => {
    for (const { key } of BOARD_COLUMNS) {
      const changes = moveToColumn(task(), key, TODAY);
      if (!changes) continue;
      expect(columnOf({ ...task(), ...changes } as Task, TODAY)).toBe(key);
    }
  });
});
