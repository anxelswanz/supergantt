// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 表头与数据行的列对齐。
 *
 * 之前表头和数据格各写各的宽度与内边距，越往右误差越大，最后两列明显错位。
 * 现在两者都从 COLUMNS 取值，这个测试就是防止有人再把它们拆开。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const PROJECT = {
  id: 7,
  name: "P",
  color: "#0ea5e9",
  workDays: "[1,2,3,4,5]",
  holidays: "[]",
  sortOrder: 0,
  createdAt: "0",
  updatedAt: "0",
};

const taskRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDate: "2026-08-03",
  endDate: "2026-08-07",
  progress: 0.5,
  priority: 2,
  personId: 1,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  note: "",
  sortOrder: id,
  blocked: "[]",
  ...over,
});

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();

  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  HTMLCanvasElement.prototype.getContext ??= (() => null) as never;

  invoke.mockImplementation((cmd: string) => {
    if (cmd === "list_projects") return Promise.resolve([]);
    if (cmd === "load_project") {
      return Promise.resolve({
        project: PROJECT,
        tasks: [taskRow(1), taskRow(2, { parentId: 1, priority: 0 })],
        nextTaskId: 3,
        dependencies: [],
        baselines: [],
        people: [{ id: 1, name: "张三", color: "#4f46e5", avatar: null, sortOrder: 0 }],
      });
    }
    return Promise.resolve(null);
  });
});

/** 取一行里所有单元格的 (宽度, 左内边距, 右内边距) */
function boxesOf(row: Element): string[] {
  return [...row.children].map((el) => {
    const s = (el as HTMLElement).style;
    return `${s.width}|${s.paddingLeft}|${s.paddingRight}`;
  });
}

describe("网格列对齐", () => {
  it("表头与数据行的每一列宽度和内边距完全一致", async () => {
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");

    render(<App />);
    await screen.findByText("我的项目");
    await useAppStore.getState().openProject(7);
    await screen.findByText("任务1");

    // 表头那一行：第一个孩子是任务名列，后面是 COLUMNS
    const header = document.querySelector("[style*='height: 60px']")!;
    const headerBoxes = boxesOf(header);

    // 顶层任务行（depth 0，缩进为 0，应与表头逐列相同）
    const rows = [...document.querySelectorAll("[style*='height: 32px']")];
    expect(rows.length).toBeGreaterThan(0);
    const rowBoxes = boxesOf(rows[0]);

    expect(rowBoxes).toEqual(headerBoxes);
  });

  it("子任务只在任务名列多出缩进，其余列仍与表头对齐", async () => {
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");

    render(<App />);
    await screen.findByText("我的项目");
    await useAppStore.getState().openProject(7);
    await screen.findByText("任务2");

    const header = boxesOf(document.querySelector("[style*='height: 60px']")!);
    const rows = [...document.querySelectorAll("[style*='height: 32px']")];
    const child = boxesOf(rows[1]);

    // 第 0 列（任务名）因为缩进而不同，这是预期的
    expect(child[0]).not.toBe(header[0]);
    // 其余每一列必须逐个相等 —— 用户看到的「后面两列错位」正是这里
    expect(child.slice(1)).toEqual(header.slice(1));
  });

  it("紧急度是一个可点的列，不再是藏在任务名旁边的小圆点", async () => {
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");

    render(<App />);
    await screen.findByText("我的项目");
    await useAppStore.getState().openProject(7);
    await screen.findByText("任务1");

    expect(screen.getByText("紧急")).toBeTruthy(); // 表头
    expect(screen.getAllByText("P2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("P0").length).toBeGreaterThan(0);
  });
});

describe("行高可调", () => {
  it("换档位后左侧行高跟着变，且列对齐不受影响", async () => {
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");

    render(<App />);
    await screen.findByText("我的项目");
    await act(async () => {
      await useAppStore.getState().openProject(7);
    });
    await screen.findByText("任务1");

    expect(document.querySelectorAll("[style*='height: 32px']").length).toBeGreaterThan(0);

    act(() => useAppStore.getState().setRowHeight("roomy"));

    const roomy = [...document.querySelectorAll("[style*='height: 42px']")];
    expect(roomy.length).toBeGreaterThan(0);

    // 行高变了，但每一列的宽度和内边距必须还和表头一致
    const header = boxesOf(document.querySelector("[style*='height: 60px']")!);
    expect(boxesOf(roomy[0]).slice(1)).toEqual(header.slice(1));
  });
});

/**
 * 下拉浮层。
 *
 * 上一版把单元格加了 overflow-hidden，绝对定位的下拉被整个裁掉 ——
 * 负责人在左侧列表里选不了了。现在浮层 portal 到 body，
 * 不再受任何祖先裁剪影响。这组测试就是防止它再被裁回去。
 */
describe("行内下拉浮层", () => {
  async function openWorkspace() {
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");
    render(<App />);
    await screen.findByText("我的项目");
    await act(async () => {
      await useAppStore.getState().openProject(7);
    });
    await screen.findByText("任务1");
    return useAppStore;
  }

  it("点负责人能打开人员列表，并且浮层挂在 body 上（不受单元格裁剪）", async () => {
    await openWorkspace();

    // 未指派的占位在关闭状态下不存在
    expect(screen.queryByText("未指派")).toBeNull();

    fireEvent.click(screen.getAllByText("张三")[0]);

    const option = await screen.findByText("未指派");
    expect(option).toBeTruthy();
    // 浮层必须是 body 的直接后代，而不是长在被裁剪的单元格里
    const popover = option.closest("[style*='position: fixed']");
    expect(popover?.parentElement).toBe(document.body);
  });

  it("在下拉里选「未指派」会真的解除指派", async () => {
    const useAppStore = await openWorkspace();
    expect(useAppStore.getState().tasks.get(1)!.personId).toBe(1);

    fireEvent.click(screen.getAllByText("张三")[0]);
    fireEvent.click(await screen.findByText("未指派"));

    expect(useAppStore.getState().tasks.get(1)!.personId).toBe(null);
  });

  it("紧急度下拉能打开并改档位", async () => {
    const useAppStore = await openWorkspace();
    expect(useAppStore.getState().tasks.get(1)!.priority).toBe(2);

    fireEvent.click(screen.getAllByText("P2")[0]);
    fireEvent.click(await screen.findByText("P0 紧急"));

    expect(useAppStore.getState().tasks.get(1)!.priority).toBe(0);
  });

  it("行尾 ⋯ 菜单提供删除，且删除可撤销", async () => {
    const useAppStore = await openWorkspace();
    const before = useAppStore.getState().tasks.size;

    fireEvent.click(screen.getAllByText("⋯")[1]); // 第二行是子任务
    fireEvent.click(await screen.findByText("删除"));

    expect(useAppStore.getState().tasks.size).toBe(before - 1);
    act(() => useAppStore.getState().undo());
    expect(useAppStore.getState().tasks.size).toBe(before);
  });
});
