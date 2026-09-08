// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 冒烟测试：确认整个应用能真的挂载并跑通「读项目 → 开项目 → 渲染工作区」。
 *
 * 类型检查过不代表跑得起来 —— 最容易炸的是 Canvas、ResizeObserver、
 * matchMedia 这些只在浏览器里存在的东西，以及组件挂载顺序。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// 没开 globals，testing-library 不会自动清理；不清的话上一次 render 的
// DOM 还留在 body 里，查询会命中多个同名节点
beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();

  // jsdom 没有这些，但组件在挂载时就会用到
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
});

describe("应用冒烟", () => {
  it("空状态渲染项目列表", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "list_projects" ? Promise.resolve([]) : Promise.resolve(null),
    );

    const { default: App } = await import("../App");
    render(<App />);

    expect(await screen.findByText("我的项目")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/还没有项目/)).toBeTruthy(),
    );
  });

  it("有项目时渲染卡片，并显示逾期数与汇总进度", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            project: {
              id: 1,
              name: "官网改版",
              color: "#6366f1",
              workDays: "[1,2,3,4,5]",
              holidays: "[]",
              sortOrder: 0,
              createdAt: "0",
              updatedAt: "0",
            },
            taskCount: 24,
            startDate: "2026-03-15",
            endDate: "2026-06-30",
            leafCount: 20,
            overdueCount: 2,
            progress: 0.68,
          },
        ]);
      }
      return Promise.resolve(null);
    });

    const { default: App } = await import("../App");
    render(<App />);

    expect(await screen.findByText("官网改版")).toBeTruthy();
    expect(screen.getByText("68")).toBeTruthy();
    expect(screen.getByText(/2 逾期/)).toBeTruthy();
  });

  it("打开项目后进入工作区，任务网格与甘特画布都挂载起来", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "load_project") {
        return Promise.resolve({
          project: {
            id: 7,
            name: "App v2.0",
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
              name: "核心开发",
              startDate: "2026-08-03",
              endDate: "2026-08-14",
              progress: 0,
              priority: 1,
              personId: 1,
              milestone: false,
              weight: null,
              collapsed: false,
              pinned: false,
              note: "",
              sortOrder: 0,
            },
            {
              id: 2,
              parentId: 1,
              name: "接口定义",
              startDate: "2026-08-03",
              endDate: "2026-08-07",
              progress: 1,
              priority: 2,
              personId: 2,
              milestone: false,
              weight: null,
              collapsed: false,
              pinned: false,
              note: "",
              sortOrder: 1,
            },
          ],
          nextTaskId: 3,
          dependencies: [],
          baselines: [],
          people: [
            { id: 1, name: "张三", color: "#4f46e5", avatar: null, sortOrder: 0 },
            { id: 2, name: "李四", color: "#059669", avatar: null, sortOrder: 1 },
          ],
        });
      }
      return Promise.resolve(null);
    });

    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");

    render(<App />);
    await screen.findByText("我的项目");

    await useAppStore.getState().openProject(7);

    expect(await screen.findByText("App v2.0")).toBeTruthy();
    expect(screen.getByText("接口定义")).toBeTruthy();
    // 负责人以「头像 + 名字」呈现，不再是一个自由文本。
    // 两字中文名的首字母头像就是全名本身，所以「李四」会出现两次（头像 + 名字）
    expect(screen.getAllByText("李四").length).toBe(2);
    // 父任务进度必须是子任务汇总出来的 100%，而不是它自己存的 0
    // 父任务和它唯一的子任务都是 100%，所以会有两个
    expect(screen.getAllByText("100%").length).toBeGreaterThanOrEqual(2);
  });
});
