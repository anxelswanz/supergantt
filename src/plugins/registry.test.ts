import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useAppStore } from "../store/useAppStore";
import { closeItem, itemSnapshot, reopenItem } from "./registry";
import type { Task } from "../gantt/model";

/** data.items 和事项页走同一个合并层：含不是从事项分拣来的阻碍，名字/类型名已解好 */

const unix = (iso: string) => new Date(`${iso}T10:00:00`).getTime() / 1000;

beforeEach(() => {
  useAppStore.setState({
    project: { id: 7, name: "产线改造" } as never,
    people: [{ id: 3, name: "张三", color: "#000" }] as never,
    tasks: new Map([
      [
        12,
        {
          id: 12,
          name: "电机安装",
          personId: 3,
          // 2026-10-01 = 第 9770 天
          blocked: [{ id: "b1", from: 9770, to: 9770, reason: "material", open: true }],
        } as unknown as Task,
      ],
    ]),
    itemNotes: [
      {
        id: 1,
        projectId: 7,
        name: "夹具尺寸不对",
        kind: "issue",
        priority: 1,
        personId: null,
        taskId: 12,
        promotedKind: null,
        promotedRef: null,
        closedAt: null,
        resolution: null,
        createdAt: unix("2026-10-07"),
        updatedAt: unix("2026-10-07"),
      },
    ],
    projectRisks: [
      {
        id: 5,
        taskId: 12,
        content: "电机可能延期",
        level: 0,
        resolved: false,
        createdAt: unix("2026-10-07"),
        resolvedAt: null,
        resolution: null,
        priority: null,
      },
    ],
  });
});

describe("itemSnapshot", () => {
  it("事项、风险、阻碍都在，名字和类型名已经解好", () => {
    const items = itemSnapshot();
    const byKey = new Map(items.map((i) => [i.key, i]));

    expect(byKey.get("note:1")).toMatchObject({
      kind: "issue",
      kindLabel: "问题",
      taskName: "电机安装",
      day: "2026-10-07",
      closed: false,
    });
    expect(byKey.get("risk:5")).toMatchObject({
      kind: "risk",
      riskLevel: 0,
      personName: "张三",
      day: "2026-10-07",
    });
    // ⌥ 拖出来的阻碍：没有事项来源，也要出现
    expect(byKey.get("blocker:12/b1")).toMatchObject({ kind: "blocker", day: "2026-10-01" });
  });

  it("1.2：noteId 认住事项本身，closedDay 给出关闭的那天", () => {
    const s = useAppStore.getState();
    useAppStore.setState({
      itemNotes: [
        { ...s.itemNotes[0], closedAt: unix("2026-10-09"), resolution: "换了供应商" },
        // 分拣成风险的那条：行 key 是 risk:5，但 noteId 还是 2
        { ...s.itemNotes[0], id: 2, promotedKind: "risk", promotedRef: "5" },
      ],
    });
    const byKey = new Map(itemSnapshot().map((i) => [i.key, i]));
    expect(byKey.get("note:1")).toMatchObject({ noteId: 1, closed: true, closedDay: "2026-10-09" });
    expect(byKey.get("risk:5")).toMatchObject({ noteId: 2, closedDay: null });
    // 直接在甘特上标的阻碍没有事项来源
    expect(byKey.get("blocker:12/b1")).toMatchObject({ noteId: null, closedDay: null });
  });

  it("没打开项目时是空的", () => {
    useAppStore.setState({ project: null });
    expect(itemSnapshot()).toEqual([]);
  });
});

describe("1.3：data.items.close", () => {
  it("事项走 closeItemNote，风险走 resolveRisk，结论去掉首尾空白", async () => {
    const closeItemNote = vi.fn(async () => {});
    const resolveRisk = vi.fn(async () => {});
    useAppStore.setState({ closeItemNote, resolveRisk } as never);

    await closeItem("note:1", "  换夹具\n1. 量尺寸  ");
    expect(closeItemNote).toHaveBeenCalledWith(1, "换夹具\n1. 量尺寸");
    await closeItem("risk:5", "改用备选供应商");
    expect(resolveRisk).toHaveBeenCalledWith(5, "改用备选供应商");
  });

  it("持续中的阻碍：今天结束，并记下结论", async () => {
    const patchTask = vi.fn();
    useAppStore.setState({ patchTask } as never);
    await closeItem("blocker:12/b1", "到货了");
    const [taskId, changes, label] = patchTask.mock.calls[0];
    expect(taskId).toBe(12);
    expect(label).toBe("关闭阻碍");
    expect(changes.blocked[0]).toMatchObject({ id: "b1", resolution: "到货了" });
    expect(changes.blocked[0].open).not.toBe(true);
  });

  it("1.4：事项可以不带结论关闭，风险不行", async () => {
    const closeItemNote = vi.fn(async () => {});
    useAppStore.setState({ closeItemNote } as never);
    await closeItem("note:1", "  ");
    expect(closeItemNote).toHaveBeenCalledWith(1, null);
    await expect(closeItem("risk:5", "")).rejects.toThrow(/结论/);
  });

  it("认不出的 key、还没分拣的事项都拒绝", async () => {
    const s = useAppStore.getState();
    await expect(closeItem("note:99", "x")).rejects.toThrow(/没有找到/);
    useAppStore.setState({ itemNotes: [{ ...s.itemNotes[0], kind: null }] });
    await expect(closeItem("note:1", "x")).rejects.toThrow(/分拣/);
  });
});

describe("1.4：data.items.reopen", () => {
  it("事项、风险重新打开；没关的不动", async () => {
    const reopenItemNote = vi.fn(async () => {});
    const reopenRisk = vi.fn(async () => {});
    const s = useAppStore.getState();
    useAppStore.setState({
      reopenItemNote,
      reopenRisk,
      itemNotes: [{ ...s.itemNotes[0], closedAt: unix("2026-10-09"), resolution: "x" }],
      projectRisks: [{ ...s.projectRisks[0], resolved: true, resolution: "y" }],
    } as never);
    await reopenItem("note:1");
    await reopenItem("risk:5");
    expect(reopenItemNote).toHaveBeenCalledWith(1);
    expect(reopenRisk).toHaveBeenCalledWith(5);

    useAppStore.setState({ itemNotes: [{ ...s.itemNotes[0], closedAt: null }] });
    reopenItemNote.mockClear();
    await reopenItem("note:1");
    expect(reopenItemNote).not.toHaveBeenCalled();
  });

  it("阻碍：不重开，只把结论拿掉", async () => {
    const patchTask = vi.fn();
    const task = useAppStore.getState().tasks.get(12)!;
    useAppStore.setState({
      patchTask,
      tasks: new Map([[12, { ...task, blocked: [{ ...task.blocked[0], open: false, resolution: "到货了" }] } as Task]]),
    } as never);
    await reopenItem("blocker:12/b1");
    const period = patchTask.mock.calls[0][1].blocked[0];
    expect(period.open).toBe(false);
    expect(period).not.toHaveProperty("resolution");
  });
});
