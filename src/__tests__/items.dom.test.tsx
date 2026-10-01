// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 事项视图 + 视图开关的冒烟。
 *
 * 要证明的不是「列表长什么样」，而是三件会静默出错的事：
 *
 *   1. ⌘K 在**任何视图**下都能唤出录入弹窗（包括正在输入框里打字时）
 *   2. 不是从事项分拣来的实体也出现在清单里 —— 否则甘特上标的阻碍
 *      在这儿看不到，同一个东西两处说法不同
 *   3. 关掉一个视图后，它的按钮和 ⌘数字编号一起消失，不留死键
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const unix = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

/** 一条有未关闭阻碍的活，用来验证「实体也要出现」 */
function projectPayload() {
  return {
    project: {
      id: 7,
      uuid: "u",
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
        id: 12,
        parentId: null,
        name: "电机安装",
        startDate: "2026-09-28",
        endDate: "2026-10-20",
        actualStart: "2026-09-29",
        actualEnd: "2026-10-20",
        progress: 0.4,
        priority: 1,
        personId: null,
        milestone: false,
        weight: null,
        collapsed: false,
        pinned: false,
        note: "",
        sortOrder: 0,
        // ⌥ 在甘特条上拖出来的那种：没有任何事项来源
        blocked: JSON.stringify([
          { id: "b1", from: "2026-10-01", to: "2026-10-01", reason: "material", open: true },
        ]),
        autoRollover: false,
      },
    ],
    nextTaskId: 13,
    dependencies: [],
    baselines: [],
    people: [],
  };
}

const NOTES = [
  {
    id: 1,
    projectId: 7,
    name: "下周一确认夹具方案",
    kind: null,
    priority: 2,
    personId: null,
    taskId: null,
    promotedKind: null,
    promotedRef: null,
    closedAt: null,
    resolution: null,
    createdAt: unix("2026-09-30"),
    updatedAt: unix("2026-09-30"),
  },
  {
    id: 2,
    projectId: 7,
    name: "已经办完的那条",
    kind: "todo",
    priority: 3,
    personId: null,
    taskId: null,
    promotedKind: null,
    promotedRef: null,
    closedAt: unix("2026-10-02"),
    resolution: "打过电话了",
    createdAt: unix("2026-09-29"),
    updatedAt: unix("2026-10-02"),
  },
];

const KINDS = [
  { key: "todo", label: "代办", color: "#0ea5e9", requiresNote: false, builtin: true, sortOrder: 0 },
  { key: "issue", label: "问题", color: "#a855f7", requiresNote: true, builtin: true, sortOrder: 1 },
];

/** settings 表的内存替身 —— 视图开关要能读回去 */
let settings: Record<string, string>;

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  settings = {};

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

  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "list_projects":
        return Promise.resolve([]);
      case "load_project":
        return Promise.resolve(projectPayload());
      case "load_item_notes":
        return Promise.resolve(NOTES);
      case "list_item_kinds":
        return Promise.resolve(KINDS);
      case "add_item_note":
        return Promise.resolve({
          ...NOTES[0],
          id: 99,
          name: args!.name,
          priority: args!.priority,
          personId: args!.personId,
          taskId: args!.taskId,
          createdAt: unix("2026-10-05"),
          updatedAt: unix("2026-10-05"),
        });
      case "load_daily_notes":
      case "load_project_risks":
      case "count_open_risks":
        return Promise.resolve([]);
      case "get_setting":
        return Promise.resolve(settings[args!.key as string] ?? null);
      case "set_setting":
        settings[args!.key as string] = args!.value as string;
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
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

describe("事项视图", () => {
  it("工具条上多了「事项」这一档", async () => {
    await openWorkspace();
    expect(screen.getByRole("button", { name: "事项" })).toBeTruthy();
  });

  /**
   * 合并层的第 3 个来源。漏掉它的表现是：在甘特上 ⌥ 拖出来的阻碍
   * 在事项视图里根本不存在 —— 而用户以为那里是「所有待处理的事」。
   */
  it("清单里既有事项，也有不是从事项分拣来的阻碍实体", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    expect(await screen.findByText("下周一确认夹具方案")).toBeTruthy();
    // ⌥ 拖出来的那条阻碍：标题显示成「等料」（自己没写说明就用归类标签），
    // 右侧的类型按钮显示「阻碍」，附注行显示它卡了多久
    expect(screen.getByText("等料")).toBeTruthy();
    expect(screen.getByText("阻碍")).toBeTruthy();
    expect(screen.getByText(/已卡 \d+ 天/)).toBeTruthy();
  });

  it("已关闭的折叠在底部，展开才看得到", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    await screen.findByText("下周一确认夹具方案");
    expect(screen.queryByText("已经办完的那条")).toBe(null);

    fireEvent.click(screen.getByText(/已关闭 \(1\)/));
    expect(await screen.findByText("已经办完的那条")).toBeTruthy();
    // 结论一直显示 —— 复盘时值钱的正是这一句
    expect(screen.getByText("结论：打过电话了")).toBeTruthy();
  });

  /**
   * 未分拣那一行：右侧是一句召唤（「加入到事项 ▾」），而圆圈点不动 ——
   * 还没决定它是什么，谈不上完成。
   */
  it("未分拣的那条给出「加入到事项」，并且不能关闭", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    await screen.findByText("下周一确认夹具方案");
    expect(screen.getByText("加入到事项 ▾")).toBeTruthy();

    const circle = screen.getByTitle(
      "还没加入到事项分类里，谈不上完成 —— 先决定它是什么",
    );
    expect((circle as HTMLButtonElement).disabled).toBe(true);
  });

  /** 行上不再有负责人头像和任务名两列 —— 信息退到悬停里，不占版面 */
  it("行上不显示关联任务和负责人，但悬停还查得到", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    await screen.findByText("下周一确认夹具方案");
    // 任务名不作为独立文本出现在列表里
    expect(screen.queryByText("#12 电机安装")).toBe(null);
    // 但那条阻碍的标题带着它 —— 要看的时候悬停就有
    expect(screen.getByTitle(/关联：#12 电机安装/)).toBeTruthy();
  });
});

describe("快速记录", () => {
  /**
   * ⌘K 要在 inInput 判断**之前**生效。
   *
   * 「正在输入框里打字时不响应快捷键」这条默认规矩在这里是错的：
   * 你正在给任务改名，同事推门说了一句要记的话 —— 那一刻按 ⌘K
   * 没反应，这个功能就白做了。
   */
  it("⌘K 在甘特视图下能唤出弹窗", async () => {
    const store = await openWorkspace();
    expect(store.getState().activeView).toBe("gantt");

    fireEvent.keyDown(window, { key: "k", metaKey: true, ctrlKey: true });
    expect(await screen.findByText("快速记录")).toBeTruthy();
  });

  it("存一条会走 add_item_note，而且不带类型 —— 分拣是分开的动作", async () => {
    await openWorkspace();
    fireEvent.keyDown(window, { key: "k", metaKey: true, ctrlKey: true });
    await screen.findByText("快速记录");

    const input = screen.getByPlaceholderText("会上提到的那件事…");
    fireEvent.change(input, { target: { value: "供应商说电机要延期" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === "add_item_note")).toBe(true),
    );
    const args = invoke.mock.calls.find(([c]) => c === "add_item_note")![1] as Record<
      string,
      unknown
    >;
    expect(args).toMatchObject({ name: "供应商说电机要延期", priority: 2, projectId: 7 });
    expect("kind" in args).toBe(false);

    // 存完不关窗：接着记下一条
    expect(screen.getByText("快速记录")).toBeTruthy();
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });
});

describe("常驻录入行", () => {
  /**
   * 标题框是**会换行的多行框**，不是单行输入框。
   *
   * 一条事项常常是一整句话，单行框里它会往左滚出去 —— 写到一半就无法
   * 回头检查自己写了什么。换成 textarea 之后随之而来的问题是「回车是
   * 提交还是换行」，所以这里把那条分工钉住：裸 ↵ 提交、⇧↵ 换行。
   */
  it("是 textarea：⇧↵ 换行不提交，裸 ↵ 才提交", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    const box = (await screen.findByPlaceholderText(/^记一条…/)) as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");

    fireEvent.change(box, { target: { value: "供应商说电机下周才能到" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(invoke.mock.calls.some(([c]) => c === "add_item_note")).toBe(false);

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === "add_item_note")).toBe(true),
    );
  });

  /**
   * 工作区在 window 上监听裸 Enter「新建任务」、Backspace「删除任务」。
   * 多行框不 stopPropagation 的话，在这里敲完回车会顺手建出一条空任务 ——
   * 而用户完全看不出那是怎么发生的。
   */
  it("回车不会漏到工作区去新建任务", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    const before = store.getState().tasks.size;

    const box = await screen.findByPlaceholderText(/^记一条…/);
    fireEvent.change(box, { target: { value: "随手记一条" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(store.getState().tasks.size).toBe(before);
  });
});

describe("视图开关", () => {
  it("关掉看板，它的按钮就消失，⌘2 顺位给时间线", async () => {
    const store = await openWorkspace();
    expect(screen.getByRole("button", { name: "看板" })).toBeTruthy();

    store.getState().setViewEnabled("board", false);

    await waitFor(() => expect(screen.queryByRole("button", { name: "看板" })).toBe(null));
    // 编号跟着重新算 —— 不留一个按了没反应的死键
    expect(store.getState().enabledViews).toEqual(["gantt", "timeline", "review", "items"]);

    fireEvent.keyDown(window, { key: "2", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(store.getState().activeView).toBe("timeline"));
  });

  /** 甘特是唯一能拖日期的面，关掉它这个软件就没有排期能力了 */
  it("甘特关不掉", async () => {
    const store = await openWorkspace();
    store.getState().setViewEnabled("gantt" as never, false);
    expect(store.getState().enabledViews).toContain("gantt");
  });

  /**
   * active_view 指向一个被关掉的视图时必须兜底回甘特。
   * 这条路径以前只有「插件被删」能触发，所以必须单独测。
   */
  it("正在看的视图被关掉时切回甘特", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await waitFor(() => expect(store.getState().activeView).toBe("items"));

    store.getState().setViewEnabled("items", false);
    await waitFor(() => expect(store.getState().activeView).toBe("gantt"));
    expect(screen.queryByRole("button", { name: "事项" })).toBe(null);
  });

  it("开关落在 settings 表里，重新读设置能回来", async () => {
    const store = await openWorkspace();
    store.getState().setViewEnabled("review", false);

    await waitFor(() => expect(settings["enabled_views"]).toBeTruthy());
    expect(JSON.parse(settings["enabled_views"])).toEqual([
      "gantt",
      "board",
      "timeline",
      "items",
    ]);

    await store.getState().loadSettings();
    expect(store.getState().enabledViews).toEqual(["gantt", "board", "timeline", "items"]);
  });
});
