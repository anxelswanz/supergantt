// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 多视图冒烟：四个顶层视图都要能真的挂载。
 *
 * 类型检查过不代表跑得起来 —— 视图切换换掉的是整棵子树，最容易炸在
 * 「某个视图读了一个只有甘特才有的东西」上（画布、视口、行高同步）。
 * 这里逐个切过去，确认各自能渲染出它标志性的内容。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ISO_START = "2026-08-03";
const ISO_END = "2026-08-14";

/** 一个有实施记录、有受阻、有当日记录的项目 —— 四个视图都有东西可显示 */
function projectPayload() {
  return {
    project: {
      id: 7,
      name: "产线改造",
      color: "#0ea5e9",
      workDays: "[1,2,3,4,5]",
      holidays: "[]",
      sortOrder: 0,
      createdAt: "0",
      updatedAt: "0",
    },
    tasks: [
      {
        id: 1,
        parentId: null,
        name: "设备安装",
        startDate: ISO_START,
        endDate: ISO_END,
        actualStart: "2026-08-05",
        actualEnd: "2026-08-20",
        progress: 0.5,
        priority: 1,
        personId: null,
        milestone: false,
        weight: null,
        collapsed: false,
        pinned: false,
        note: "",
        sortOrder: 0,
        blocked: JSON.stringify([
          { id: "b1", from: "2026-08-06", to: "2026-08-09", reason: "material" },
        ]),
      },
    ],
    nextTaskId: 2,
    dependencies: [],
    baselines: [],
    people: [],
  };
}

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
    if (cmd === "load_project") return Promise.resolve(projectPayload());
    if (cmd === "load_daily_notes") {
      return Promise.resolve([
        {
          id: 1,
          projectId: 7,
          taskId: null,
          day: "2026-08-06",
          content: "供应商说下周才能到货",
          createdAt: Date.parse("2026-08-06T12:00:00Z") / 1000,
          updatedAt: Date.parse("2026-08-06T12:00:00Z") / 1000,
        },
      ]);
    }
    if (cmd === "load_project_risks") return Promise.resolve([]);
    if (cmd === "count_open_risks") return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

async function openWorkspace() {
  const { default: App } = await import("../App");
  const { useAppStore } = await import("../store/useAppStore");
  render(<App />);
  await screen.findByText("我的项目");
  await useAppStore.getState().openProject(7);
  await screen.findByText("产线改造");
  return useAppStore;
}

describe("顶层视图", () => {
  it("四个视图的切换按钮都在工具条上", async () => {
    await openWorkspace();
    for (const label of ["甘特", "看板", "时间线", "复盘"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("默认是甘特：左侧网格在，计划/实施开关也在", async () => {
    await openWorkspace();
    expect(screen.getByText("设备安装")).toBeTruthy();
    expect(screen.getByRole("button", { name: "计划" })).toBeTruthy();
  });

  it("看板：卡片按判据落到「进行中」，列头写着判据", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("board");

    await waitFor(() => expect(screen.getByText("未开始")).toBeTruthy());
    expect(screen.getByText("没有实施日期，进度为 0")).toBeTruthy();
    // 有实施开始日、进度未满 —— 落在进行中（受阻区间已经过去了）
    expect(screen.getByText("设备安装")).toBeTruthy();
  });

  /**
   * 计划/实施是甘特内部的开关。别的视图里没有它可切，
   * 那就不该显示 —— 一个切了没反应的开关比没有更糟。
   */
  it("离开甘特后，计划/实施开关消失", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("board");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "计划" })).toBe(null),
    );
  });

  it("时间线：当日记录和受阻都落在它们发生的那天", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("timeline");

    expect(await screen.findByText("供应商说下周才能到货")).toBeTruthy();
    // 受阻从 08-06 起，共 4 天 —— 只出现一条，不是逐天铺开
    expect(screen.getByText("等料")).toBeTruthy();
    expect(screen.getByText("共 4 天")).toBeTruthy();
  });

  it("复盘：算出整体偏差，并把受阻归到原因上", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("review");

    // 实施 08-20 收尾 vs 计划 08-14 —— 晚 6 天
    expect(await screen.findByText("整体比计划晚 6 天")).toBeTruthy();
    expect(screen.getByText("时间丢在哪")).toBeTruthy();
    expect(screen.getByText(/4 天 · 1 条/)).toBeTruthy();
  });

  it("甘特上右键记一笔会切到时间线，并把草稿带过去", async () => {
    const store = await openWorkspace();
    store.getState().startNoteAt(1, 9713);

    await waitFor(() => expect(store.getState().activeView).toBe("timeline"));
    expect(store.getState().noteDraft).toMatchObject({ taskId: 1, day: 9713 });
  });
});
