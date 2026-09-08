// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayToIso, today } from "../gantt/time";

/**
 * 详情抽屉：阻碍、风险与评论。
 *
 * 这两类附注刻意**不进撤销栈** —— ⌘Z 该撤销的是排期误操作，
 * 而不是把刚敲的一条评论悄悄抹掉。这里验证它们走的是独立的持久化路径。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let risks: unknown[] = [];
let comments: unknown[] = [];

const taskRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDate: "2026-08-03",
  endDate: "2026-08-07",
  progress: 0.4,
  priority: 2,
  personId: null,
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
  risks = [];
  comments = [];

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

  invoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "list_projects":
        return Promise.resolve([]);
      case "load_project":
        return Promise.resolve({
          project: {
            id: 7,
            name: "P",
            color: "#0ea5e9",
            workDays: "[1,2,3,4,5]",
            holidays: "[]",
            sortOrder: 0,
            createdAt: "0",
            updatedAt: "0",
          },
          tasks: [taskRow(1)],
          dependencies: [],
          baselines: [],
          people: [],
          nextTaskId: 2,
        });
      case "load_task_notes":
        return Promise.resolve({ risks, comments });
      // 角标和风险清单都从这一份数据算出来（store.refreshRisks）
      case "load_project_risks":
        return Promise.resolve(risks);
      case "add_risk": {
        const row = {
          id: risks.length + 1,
          taskId: args.taskId,
          content: args.content,
          level: args.level,
          resolved: false,
          createdAt: 1_770_000_000,
        };
        risks = [...risks, row];
        return Promise.resolve(row);
      }
      case "add_comment": {
        const row = {
          id: comments.length + 1,
          taskId: args.taskId,
          content: args.content,
          createdAt: 1_770_000_000,
        };
        comments = [...comments, row];
        return Promise.resolve(row);
      }
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
  await act(async () => {
    await useAppStore.getState().openProject(7);
  });
  await screen.findByText("任务1");
  return useAppStore;
}

describe("详情抽屉", () => {
  it("双击任务行打开详情，Esc 关闭", async () => {
    const useAppStore = await openWorkspace();
    expect(useAppStore.getState().detailId).toBe(null);

    fireEvent.doubleClick(screen.getByText("任务1"));
    expect(useAppStore.getState().detailId).toBe(1);
    expect(await screen.findByText("风险")).toBeTruthy();
    expect(screen.getByText("评论")).toBeTruthy();

    act(() => useAppStore.getState().openDetail(null));
    expect(screen.queryByText("阻碍")).toBeNull();
  });

  it("能添加风险点，并在左侧行上显示未解决角标", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    await screen.findByText("阻碍");

    const input = screen.getByPlaceholderText(/记一条风险/);
    fireEvent.change(input, { target: { value: "第三方接口还没确认" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(await screen.findByText("第三方接口还没确认")).toBeTruthy();
    // 角标要出现在左侧网格，否则风险记了也看不见
    expect(await screen.findByText("⚠1")).toBeTruthy();
  });

  /**
   * 风险输入是 textarea 而不是单行 input：一条风险说清楚往往要一整句话，
   * 单行框里只看得见光标附近那一小段。换行行为和评论区刻意相反 ——
   * 风险多半就是一句话，连记三条时每条都按 ⌘↵ 是纯粹的摩擦。
   */
  it("风险输入可换行：⇧Enter 换行不提交，Enter 才提交", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    await screen.findByText("阻碍");

    const box = screen.getByPlaceholderText(/记一条风险/);
    expect(box.tagName).toBe("TEXTAREA");

    fireEvent.change(box, { target: { value: "接口协议还没定" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "add_risk")).toBe(false);

    fireEvent.change(box, { target: { value: "接口协议还没定\n下周一前不确认就阻塞" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    const added = invoke.mock.calls.find(([cmd]) => cmd === "add_risk");
    expect(added?.[1]).toMatchObject({ content: "接口协议还没定\n下周一前不确认就阻塞" });
  });

  it("能添加评论（⌘Enter 提交，单独 Enter 用于换行）", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    await screen.findByText("评论");

    const box = screen.getByPlaceholderText("写点什么…（⌘Enter 提交）");
    fireEvent.change(box, { target: { value: "和后端约了周三联调" } });

    // 单独 Enter 只换行，不提交 —— 直接看有没有发出写库命令，
    // 比查 DOM 更准（textarea 的值本身就含这段文字）
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "add_comment")).toBe(false);

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    expect(await screen.findByText("和后端约了周三联调")).toBeTruthy();
  });

  it("风险与评论不进撤销栈 —— ⌘Z 不会把它们撤掉", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    await screen.findByText("阻碍");

    const input = screen.getByPlaceholderText(/记一条风险/);
    fireEvent.change(input, { target: { value: "依赖未定" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByText("依赖未定");

    // 加风险不该在撤销栈里留下任何东西
    expect(useAppStore.getState().stack!.canUndo).toBe(false);
  });

  it("详情里改进度会走命令栈，可以撤销", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    // 用「阻碍」等抽屉挂载 —— 「进度」在表头和抽屉里各有一个，不唯一
    await screen.findByText("阻碍");

    const slider = document.querySelector("input[type='range']") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "80" } });

    expect(useAppStore.getState().tasks.get(1)!.progress).toBeCloseTo(0.8, 5);
    act(() => useAppStore.getState().undo());
    expect(useAppStore.getState().tasks.get(1)!.progress).toBeCloseTo(0.4, 5);
  });

  it("甘特条双击也能开详情 —— 和左侧行双击同一个效果", async () => {
    const useAppStore = await openWorkspace();
    expect(useAppStore.getState().detailId).toBe(null);

    // 画布是 Canvas，jsdom 下拿不到几何，所以直接验证 store 契约：
    // 两个入口调的是同一个 action
    act(() => useAppStore.getState().openDetail(1));
    expect(useAppStore.getState().detailId).toBe(1);
    expect(await screen.findByText("阻碍")).toBeTruthy();
  });

  it("阻碍区块在没有记录时给出怎么创建的提示", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
    });
    expect(await screen.findByText(/按住 ⌥ 拖一段/)).toBeTruthy();
  });

  it("阻碍列出区间、天数和原因，且删除可撤销", async () => {
    const useAppStore = await openWorkspace();
    await act(async () => {
      useAppStore.getState().openDetail(1);
      useAppStore.getState().addBlocked(1, {
        id: "b1",
        from: useAppStore.getState().tasks.get(1)!.startDay,
        to: useAppStore.getState().tasks.get(1)!.startDay + 2,
        reason: "equipment",
      });
    });

    expect(await screen.findByText("设备故障")).toBeTruthy();
    expect(screen.getByText("3 天")).toBeTruthy();
    expect(screen.getByText("共 3 天")).toBeTruthy();

    act(() => useAppStore.getState().removeBlocked(1, "b1"));
    expect(useAppStore.getState().tasks.get(1)!.blocked).toHaveLength(0);
    act(() => useAppStore.getState().undo());
    expect(useAppStore.getState().tasks.get(1)!.blocked).toHaveLength(1);
  });

  /**
   * 阻碍详情：行里放得下的只有摘要，改天数和「持续中」开关都在这个面板里。
   * 双击是主入口，但不能是唯一入口 —— 悬停时那个「详情」按钮走的是同一条路。
   */
  describe("阻碍详情面板", () => {
    /** 面板里的「到哪天为止」输入框 */
    const untilInput = () =>
      screen.getByTitle(/终点就是今天|这段受阻的最后一天/) as HTMLInputElement;

    async function openPanel() {
      const useAppStore = await openWorkspace();
      await act(async () => {
        useAppStore.getState().openDetail(1);
        // 固件里那条任务排在过去（08-03～08-07），而新建的阻碍从今天起算 ——
        // 先把计划区间挪到覆盖今天往后，终止日才有得可填
        useAppStore
          .getState()
          .patchTask(1, { startDay: today() - 2, endDay: today() + 10 }, "挪一下日期");
        useAppStore.getState().addBlocker(1, "material", "等钢筋");
      });
      // 说明是个 InlineText（受控 input），所以按值找而不是按文本找
      const row = await screen.findByDisplayValue("等钢筋");
      await act(async () => {
        fireEvent.doubleClick(row);
      });
      await screen.findByText("阻碍详情");
      return useAppStore;
    }

    it("双击一行就能打开，标题带着任务名", async () => {
      await openPanel();
      // 网格里也有一个「任务1」，所以这里数的是「不止一处」
      expect(screen.getAllByText("任务1").length).toBeGreaterThan(1);
      // 新建出来的阻碍默认是持续中的
      expect(screen.getByText("持续中")).toBeTruthy();
    });

    it("持续中的时候终止日锁在今天，不给手填", async () => {
      // 让人填一个明天就会过期的日期没有意义 —— 跨天检查每天都会把它推到今天
      await openPanel();
      const until = untilInput();
      expect(until.disabled).toBe(true);
      expect(until.value).toBe(dayToIso(today()));
    });

    it("关掉「持续中」之后可以自己写终止日期，保存写回任务", async () => {
      const useAppStore = await openPanel();
      const task = useAppStore.getState().tasks.get(1)!;

      fireEvent.click(screen.getByText("持续中"));
      const until = untilInput();
      expect(until.disabled).toBe(false);

      const target = task.blocked[0].from + 3;
      fireEvent.change(until, { target: { value: dayToIso(target) } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
      });

      const [only] = useAppStore.getState().tasks.get(1)!.blocked;
      expect(only.to).toBe(target);
      // 开关关掉了，明天不会再自动加一天
      expect(only.open).toBeUndefined();
    });

    it("终止日期填不过任务结束日 —— 越界的一律夹回去", async () => {
      const useAppStore = await openPanel();
      const task = useAppStore.getState().tasks.get(1)!;

      fireEvent.click(screen.getByText("持续中"));
      const until = untilInput();
      // date 控件的 max 只挡得住点选，手打的照样进得来，所以要在代码里夹
      expect(until.getAttribute("max")).toBe(dayToIso(task.endDay));

      fireEvent.change(until, { target: { value: dayToIso(task.endDay + 40) } });
      expect(until.value).toBe(dayToIso(task.endDay));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
      });
      const after = useAppStore.getState().tasks.get(1)!;
      expect(after.blocked[0].to).toBe(task.endDay);
      // 手填不会把任务撑长，只有「持续中」才会顺延工期
      expect(after.endDay).toBe(task.endDay);
    });

    it("倒着填（终止早于起始）收成一天，不留负区间", async () => {
      const useAppStore = await openPanel();
      const task = useAppStore.getState().tasks.get(1)!;

      fireEvent.click(screen.getByText("持续中"));
      fireEvent.change(untilInput(), { target: { value: dayToIso(task.blocked[0].from - 9) } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
      });

      const [only] = useAppStore.getState().tasks.get(1)!.blocked;
      expect(only.to).toBe(only.from);
    });

    it("「标记为已解决」把区间收到昨天，面板随之关闭", async () => {
      const useAppStore = await openPanel();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "✓ 标记为已解决" }));
      });

      // 今天开、今天关的那条整段丢掉 —— 不留 from > to 的空区间
      expect(useAppStore.getState().tasks.get(1)!.blocked).toHaveLength(0);
      await waitFor(() => expect(screen.queryByText("阻碍详情")).toBeNull());
    });

    it("改归类和说明都写得回去，且可撤销", async () => {
      const useAppStore = await openPanel();

      fireEvent.click(screen.getByRole("button", { name: "设备故障" }));
      // 行内的说明框和面板里的用的是同一句提示语，按标签挑出面板里那个
      const box = screen
        .getAllByPlaceholderText(/三号机主轴异响/)
        .find((el) => el.tagName === "TEXTAREA")!;
      fireEvent.change(box, { target: { value: "主轴异响，厂家明天到" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
      });

      expect(useAppStore.getState().tasks.get(1)!.blocked[0]).toMatchObject({
        reason: "equipment",
        note: "主轴异响，厂家明天到",
      });

      act(() => useAppStore.getState().undo());
      expect(useAppStore.getState().tasks.get(1)!.blocked[0]).toMatchObject({
        reason: "material",
        note: "等钢筋",
      });
    });

    it("Esc 关掉面板，不保存改动", async () => {
      const useAppStore = await openPanel();
      fireEvent.click(screen.getByRole("button", { name: "质量问题" }));

      await act(async () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      await waitFor(() => expect(screen.queryByText("阻碍详情")).toBeNull());
      expect(useAppStore.getState().tasks.get(1)!.blocked[0].reason).toBe("material");
      // 面板的 Esc 不该顺手把整个详情抽屉也关掉
      expect(useAppStore.getState().detailId).toBe(1);
    });
  });

  it("新建任务后自动进入重命名 —— 双击已让位给详情", async () => {
    const useAppStore = await openWorkspace();
    act(() => useAppStore.getState().addTaskAfter(1));

    // pendingEditId 被网格消费后清空，且出现了一个聚焦的输入框
    await act(async () => {});
    expect(useAppStore.getState().pendingEditId).toBe(null);
    expect(document.activeElement?.tagName).toBe("INPUT");
  });
});
