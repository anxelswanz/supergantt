import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useAppStore } from "../store/useAppStore";
import { itemSnapshot } from "./registry";
import type { Task } from "../gantt/model";

/**
 * 插件 API 1.1 的 data.items。要钉死的是：它和事项页走同一个合并层 ——
 * 不是从事项分拣来的阻碍也在里面 —— 并且把名字、类型名都解好了。
 */

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

  it("没打开项目时是空的", () => {
    useAppStore.setState({ project: null });
    expect(itemSnapshot()).toEqual([]);
  });
});
