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
/** 某些测试要一长串类型来验分页；null = 用默认那两个 */
let manyKinds: typeof KINDS | null;

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  settings = {};
  manyKinds = null;

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
        return Promise.resolve(manyKinds ?? KINDS);
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
    // 类型按钮带 ▾ —— 实体行的类型现在也能改（会拆掉实体，菜单里写明代价）
    expect(screen.getByText("阻碍 ▾")).toBeTruthy();
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
  /** 未关闭里一条都没命中、答案却折在已关闭里：直接摊开，而不是说「没有」 */
  it("搜索只命中已关闭的那条时，已关闭区自动展开", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");

    await screen.findByText("下周一确认夹具方案");
    fireEvent.change(screen.getByPlaceholderText("搜索标题或结论…"), {
      target: { value: "打过电话" },
    });
    expect(await screen.findByText("已经办完的那条")).toBeTruthy();
    expect(screen.getByText(/已关闭里命中的 1 条/)).toBeTruthy();
  });

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

describe("改类型", () => {
  /**
   * 实体行的类型**也能改**。它一度是不可点的，理由是「身份由实体本身决定」——
   * 那条理由站不住：分错类型是常事（「这其实是个风险，不是阻碍」），不给改
   * 的话用户唯一的出路是删掉重记一遍，连那句原话一起丢。
   *
   * 改的实现是「先把实体收回成一条事项，再按新类型分拣」。这里验的是
   * 第一步真的发生了 —— 不是从事项分拣来的阻碍，收回时要新建一条事项承接
   * 那句话，并把那段受阻从任务上摘掉。
   */
  it("⌥ 拖出来的阻碍改成代办：新建一条事项承接原话，受阻段被摘掉", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("等料");
    expect(store.getState().tasks.get(12)!.blocked).toHaveLength(1);

    fireEvent.click(screen.getByText("阻碍 ▾"));
    fireEvent.click(await screen.findByText("代办"));

    // 原话被接住了 —— 它是不可再生的信息
    await waitFor(() => {
      const added = invoke.mock.calls.find(([c]) => c === "add_item_note");
      expect(added).toBeTruthy();
      expect((added![1] as Record<string, unknown>).name).toBe("等料");
    });
    // 实体真的被拆掉了
    await waitFor(() => expect(store.getState().tasks.get(12)!.blocked).toHaveLength(0));
  });

  /** 点当前类型自己：什么都不做 —— 否则会白拆一次实体再建一个一样的 */
  it("实体行点自己的类型不动数据", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("等料");

    fireEvent.click(screen.getByText("阻碍 ▾"));
    fireEvent.click(await screen.findByText("阻碍（当前）"));

    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().tasks.get(12)!.blocked).toHaveLength(1);
    expect(invoke.mock.calls.some(([c]) => c === "add_item_note")).toBe(false);
  });

  /** 菜单顶上必须把代价写出来 —— 改类型不是改一个标签 */
  it("实体行的菜单写明改类型会拆掉实体", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("等料");

    fireEvent.click(screen.getByText("阻碍 ▾"));
    expect(await screen.findByText(/改类型会拆掉这条阻碍/)).toBeTruthy();
    expect(screen.getByText(/累计天数、顺延过的工期、归类都会消失/)).toBeTruthy();
  });

  /**
   * 自定义类型藏在设置里，而用户是在分拣菜单前面发现「没有我要的类型」的。
   * 那一刻要有一条直达的路。
   */
  it("分拣菜单里有「新建类型…」，直达设置的事项类型页", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("加入到事项 ▾"));
    fireEvent.click(await screen.findByText("新建类型…"));

    await waitFor(() => expect(store.getState().settingsTab).toBe("kinds"));
    // 那一页上的标志性内容 —— 不是侧栏里那个同名页签
    expect(await screen.findByText(/共 \d+ 个（\d+ 个内置）/)).toBeTruthy();
  });

  /** 行上不显示任务了，菜单项就必须说清楚要打开的是哪条 */
  it("⋯ 菜单把任务名写在菜单项上", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("等料");

    fireEvent.click(screen.getAllByTitle("更多")[0]);
    expect(await screen.findByText("打开 #12 电机安装")).toBeTruthy();
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

describe("设置 → 事项类型", () => {
  /**
   * 类型多起来之后这一页要能用。
   *
   * 不分页的话这张 520px 高的面板会变成一条长滚动条，而「新建类型」被顶到
   * 最底下 —— 要加一个类型得先滚到底，而那是这一页最高频的动作。
   */
  it("超过一页才出现翻页控件，翻页换一批", async () => {
    manyKinds = Array.from({ length: 15 }, (_, i) => ({
      key: `custom:k${i}`,
      label: `类型${String(i).padStart(2, "0")}`,
      color: "#0ea5e9",
      requiresNote: false,
      builtin: false,
      sortOrder: i,
    }));
    const store = await openWorkspace();
    store.getState().openSettings("kinds");

    await screen.findByText(/共 15 个/);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    // 第一页是前 6 个
    expect(screen.getByDisplayValue("类型00")).toBeTruthy();
    expect(screen.queryByDisplayValue("类型06")).toBe(null);

    fireEvent.click(screen.getByText("›"));
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeTruthy());
    expect(screen.getByDisplayValue("类型06")).toBeTruthy();
    expect(screen.queryByDisplayValue("类型00")).toBe(null);
  });

  it("只有两个类型时不出现翻页，也不出现搜索框", async () => {
    const store = await openWorkspace();
    store.getState().openSettings("kinds");

    await screen.findByText(/共 2 个/);
    expect(screen.queryByText("1 / 1")).toBe(null);
    expect(screen.queryByPlaceholderText("搜索类型…")).toBe(null);
  });

  /** 搜索跨全部类型，不只是当前页 —— 分页是显示手段，不该缩小搜索范围 */
  it("搜索能命中不在当前页的类型", async () => {
    manyKinds = Array.from({ length: 15 }, (_, i) => ({
      key: `custom:k${i}`,
      label: `类型${String(i).padStart(2, "0")}`,
      color: "#0ea5e9",
      requiresNote: false,
      builtin: false,
      sortOrder: i,
    }));
    const store = await openWorkspace();
    store.getState().openSettings("kinds");

    const box = await screen.findByPlaceholderText("搜索类型…");
    // 故意用一个**不等于**标签全文的词：搜索框自己也是个 input，
    // 查 displayValue 时会和被筛出来那一行撞上
    fireEvent.change(box, { target: { value: "型14" } });

    await waitFor(() => expect(screen.getByDisplayValue("类型14")).toBeTruthy());
    expect(screen.getByText(/筛出 1 个/)).toBeTruthy();
    expect(screen.queryByText(/\d+ \/ \d+/)).toBe(null);
  });

  /** 「新建类型」钉在列表上方，位置不随条数变 —— 不然加一个类型得先滚到底 */
  it("新建按钮在列表之前", async () => {
    manyKinds = Array.from({ length: 15 }, (_, i) => ({
      key: `custom:k${i}`,
      label: `类型${String(i).padStart(2, "0")}`,
      color: "#0ea5e9",
      requiresNote: false,
      builtin: false,
      sortOrder: i,
    }));
    const store = await openWorkspace();
    store.getState().openSettings("kinds");

    const add = await screen.findByText("＋ 新建类型");
    const first = screen.getByDisplayValue("类型00");
    expect(add.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("页面上写明阻碍和风险为什么不在清单里", async () => {
    const store = await openWorkspace();
    store.getState().openSettings("kinds");
    expect(await screen.findByText(/为什么这里没有「阻碍」和「风险」/)).toBeTruthy();
  });
});

describe("类型多起来之后", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    key: `custom:k${i}`,
    label: `类型${String(i).padStart(2, "0")}`,
    color: "#0ea5e9",
    requiresNote: false,
    builtin: false,
    sortOrder: i,
  }));

  /**
   * 不限高的话二十个类型会让菜单比屏幕还高，而底下那句「新建类型…」
   * 就永远点不到了 —— 那是这个菜单在类型多时唯一还需要的出口。
   */
  it("分拣菜单限高滚动，底部的「新建类型…」仍然在", async () => {
    manyKinds = twenty;
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("加入到事项 ▾"));
    const first = await screen.findByText("类型00");
    const list = first.closest("div.max-h-\\[184px\\]");
    expect(list).toBeTruthy();
    expect(list!.className).toContain("overflow-y-auto");
    expect(screen.getByText("新建类型…")).toBeTruthy();
  });

  it("超过 8 个才给搜索框，搜了能筛出来", async () => {
    manyKinds = twenty;
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("加入到事项 ▾"));
    const box = await screen.findByPlaceholderText("搜类型…");
    fireEvent.change(box, { target: { value: "型17" } });

    await waitFor(() => expect(screen.getByText("类型17")).toBeTruthy());
    expect(screen.queryByText("类型00")).toBe(null);
  });

  it("只有两个类型时菜单不给搜索框", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("加入到事项 ▾"));
    await screen.findByText("代办");
    expect(screen.queryByPlaceholderText("搜类型…")).toBe(null);
  });

  /**
   * 「常用」单独一组，下面那份完整清单顺序不变 —— 整个菜单按频次重排的话，
   * 用户记住「问题在第二个」之后某天它会跳走，而他看不出发生了什么。
   */
  it("这个项目用过的类型单独排一组在上面", async () => {
    manyKinds = twenty;
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");
    // 让 custom:k17 成为「用过的」
    await store.getState().patchItemNote(1, { kind: "custom:k17" });

    fireEvent.click(screen.getAllByText("类型17 ▾")[0]);
    expect(await screen.findByText("这个项目常用")).toBeTruthy();
    // 常用组 + 完整清单里各有一个，共两处
    expect(screen.getAllByText("类型17")).toHaveLength(2);
  });

  /** 类型名是行上那个小标签里的字，所以在入口处就限长 */
  it("设置里类型名限 12 字", async () => {
    const store = await openWorkspace();
    store.getState().openSettings("kinds");
    const input = (await screen.findAllByDisplayValue("代办"))[0] as HTMLInputElement;
    expect(input.maxLength).toBe(12);
  });

  /** 筛选器的选项多了也给搜索 —— 滚着找三十项里那一个，和没有筛选器差不多 */
  it("类型筛选器在选项多时给搜索框", async () => {
    manyKinds = twenty;
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("类型 ▾"));
    expect(await screen.findByPlaceholderText("搜类型…")).toBeTruthy();
  });
});

describe("事项视图：任务按钮、筛选、排序", () => {
  /** 事项页记的是还没变成任务的东西 —— 那里不给「+ 任务」，Enter 也不建任务 */
  it("事项视图里没有「+ 任务」，Enter 也不会建任务", async () => {
    const store = await openWorkspace();
    expect(screen.getByText("+ 任务")).toBeTruthy();

    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");
    expect(screen.queryByText("+ 任务")).toBe(null);

    const before = store.getState().tasks.size;
    fireEvent.keyDown(window, { key: "Enter" });
    expect(store.getState().tasks.size).toBe(before);
  });

  it("按关联任务筛：只留挂在那条任务上的", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("任务 ▾"));
    fireEvent.click(await screen.findByText("#12 电机安装"));

    await waitFor(() => expect(screen.queryByText("下周一确认夹具方案")).toBe(null));
    expect(screen.getByText("等料")).toBeTruthy();
    expect(screen.getByText(/筛出 1 条/)).toBeTruthy();
  });

  it("⋯ 菜单下移一位：顺序变了，存进本项目的设置，并可以恢复时间顺序", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    const titles = () =>
      ["等料", "下周一确认夹具方案"].sort(
        (a, b) =>
          screen.getByText(a).compareDocumentPosition(screen.getByText(b)) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      );
    // 默认时间倒序：10-01 的阻碍在 09-30 的事项前面
    expect(titles()).toEqual(["等料", "下周一确认夹具方案"]);

    fireEvent.click(screen.getAllByTitle("更多")[0]);
    fireEvent.click(await screen.findByText("下移一位"));

    await waitFor(() => expect(titles()).toEqual(["下周一确认夹具方案", "等料"]));
    expect(JSON.parse(settings["items_order.7"])[0]).toBe("note:1");
    expect(screen.getByText(/手动排序/)).toBeTruthy();

    fireEvent.click(screen.getByText("恢复时间顺序"));
    await waitFor(() => expect(titles()).toEqual(["等料", "下周一确认夹具方案"]));
    expect(settings["items_order.7"]).toBe("");
  });

  it("事项页的导出可以选 Excel 或 Word", async () => {
    const store = await openWorkspace();
    store.getState().setActiveView("items");
    await screen.findByText("下周一确认夹具方案");

    fireEvent.click(screen.getByText("⤓ 导出 ▾"));
    expect(await screen.findByText("Excel 表格")).toBeTruthy();
    expect(screen.getByText("Word 文档")).toBeTruthy();
  });

  /** 工具条上那颗导的是甘特图 —— 只在甘特视图出现，别处不和本页的导出并排 */
  it("甘特图的导出只在甘特视图里有", async () => {
    const store = await openWorkspace();
    expect(screen.getByText("⤓ 导出")).toBeTruthy();

    store.getState().setActiveView("board");
    await waitFor(() => expect(screen.queryByText("⤓ 导出")).toBe(null));
  });
});
