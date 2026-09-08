// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 看板上的阻碍与风险，走一遍用户真会做的那条路。
 *
 * 单元测试已经钉住了规则（core/blockers.test.ts、core/risks.test.ts），
 * 这里管的是**接线**：按钮点下去有没有落到那条规则上、卡片会不会换列、
 * 关掉之后标识会不会消失。这一层错起来很安静 —— 规则全对，界面照样不动。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let risks: Record<string, unknown>[] = [];

/** 一条已经开工、还没做完的活 —— 唯一能挂阻碍和风险的状态 */
function projectPayload() {
  const iso = (day: number) => new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
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
        startDate: iso(-3),
        endDate: iso(4),
        actualStart: iso(-3),
        actualEnd: iso(4),
        progress: 0.5,
        priority: 1,
        personId: null,
        milestone: false,
        weight: null,
        collapsed: false,
        pinned: false,
        note: "",
        sortOrder: 0,
        blocked: "[]",
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
  risks = [];

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
        return Promise.resolve(projectPayload());
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
          resolvedAt: null,
          resolution: null,
        };
        risks = [...risks, row];
        return Promise.resolve(row);
      }
      case "resolve_risk": {
        const ts = 1_770_000_999;
        risks = risks.map((r) =>
          r.id === args.id
            ? { ...r, resolved: true, resolvedAt: ts, resolution: args.resolution }
            : r,
        );
        return Promise.resolve(ts);
      }
      case "reopen_risk": {
        risks = risks.map((r) =>
          r.id === args.id ? { ...r, resolved: false, resolvedAt: null, resolution: null } : r,
        );
        return Promise.resolve(null);
      }
      default:
        return Promise.resolve(null);
    }
  });
});

async function openBoard() {
  const { default: App } = await import("../App");
  const { useAppStore } = await import("../store/useAppStore");
  render(<App />);
  await screen.findByText("我的项目");
  await act(async () => {
    await useAppStore.getState().openProject(7);
  });
  act(() => useAppStore.getState().setActiveView("board"));
  await screen.findByText("受阻");
  return useAppStore;
}

describe("看板 · 阻碍", () => {
  it("新建一条阻碍：卡片进受阻列，标识写出原因和天数", async () => {
    const store = await openBoard();

    // 新建入口收在清单面板里 —— 在那儿能先看见已经记过什么
    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    fireEvent.click(await screen.findByRole("button", { name: "＋ 新建" }));
    fireEvent.click(await screen.findByRole("button", { name: "设备故障" }));
    fireEvent.change(screen.getByPlaceholderText(/具体是什么/), {
      target: { value: "三号机主轴异响" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "记下来" }));
    });

    const blocked = store.getState().tasks.get(1)!.blocked;
    expect(blocked).toHaveLength(1);
    // 未关闭 —— 它会一直跟着往后长，直到有人来关
    expect(blocked[0]).toMatchObject({ open: true, reason: "equipment", note: "三号机主轴异响" });
    expect(await screen.findByText(/三号机主轴异响 · 已 1 天/)).toBeTruthy();
  });

  it("关闭之后卡片离开受阻列，标识跟着消失", async () => {
    const store = await openBoard();
    await act(async () => {
      store.getState().addBlocker(1, "material", "等钢筋");
    });
    await screen.findByText(/等钢筋/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✓ 关闭" }));
    });

    // 今天开、今天关的那条整段丢掉，不留 from > to 的空区间
    expect(store.getState().tasks.get(1)!.blocked).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText(/等钢筋/)).toBeNull());
  });

  it("没有进行中的任务时，新建是禁用的", async () => {
    const store = await openBoard();
    await act(async () => {
      store.getState().patchTask(1, { progress: 1 }, "完成");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "＋ 新建" }).hasAttribute("disabled"),
      ).toBe(true),
    );
  });

  it("自动延长会把未关闭的阻碍推到今天，并顺延计划结束日", async () => {
    const store = await openBoard();
    await act(async () => {
      store.getState().addBlocker(1, "material");
    });

    const before = store.getState().tasks.get(1)!;
    // 把这条阻碍伪造成昨天开的，再跑一次跨天检查
    await act(async () => {
      store.getState().patchTask(
        1,
        { blocked: before.blocked.map((b) => ({ ...b, from: b.from - 1, to: b.to - 1 })) },
        "回拨",
      );
      store.getState().extendOpenBlockers();
    });

    const after = store.getState().tasks.get(1)!;
    expect(after.endDay).toBe(before.endDay + 1);
    expect(after.blocked[0].pushed).toBe(1);
    // 自动延长不进撤销栈：⌘Z 该撤销的是用户刚才那次操作
    expect(store.getState().stack!.undoLabel).toBe("回拨");
  });
});

describe("看板 · 风险清单", () => {
  it("能从清单里记一条风险，卡片上出现独立的风险标识", async () => {
    const store = await openBoard();

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    fireEvent.change(await screen.findByPlaceholderText(/这条活可能出什么问题/), {
      target: { value: "备件交期不确定" },
    });
    fireEvent.click(screen.getByRole("button", { name: "高" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "记下来" }));
    });

    expect(await screen.findByText("备件交期不确定")).toBeTruthy();
    expect(invoke.mock.calls.find(([c]) => c === "add_risk")?.[1]).toMatchObject({
      taskId: 1,
      level: 0,
    });
    // 风险和受阻是两个独立标识：这条活没被卡住，只有风险标
    expect(await screen.findByText(/1 条风险未关闭 · 最高高/)).toBeTruthy();
    expect(screen.queryByText(/已 1 天/)).toBeNull();
    expect(store.getState().openRisks.get(1)).toEqual({ count: 1, top: 0 });
  });

  it("关闭要写清怎么解决的，光点那个圈不算关", async () => {
    const store = await openBoard();
    await act(async () => {
      await store.getState().addRisk(1, "备件交期不确定", 0);
    });

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    await screen.findByText("备件交期不确定");

    // 点圆圈只是把输入框展开，风险还开着
    await act(async () => {
      fireEvent.click(screen.getByTitle(/关闭这条风险，需要写清怎么解决的/));
    });
    expect(store.getState().openRisks.has(1)).toBe(true);
    expect(invoke.mock.calls.some(([c]) => c === "resolve_risk")).toBe(false);

    // 没写说明之前，确认按钮是禁用的
    const confirm = screen.getByRole("button", { name: "确认关闭" });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/怎么解决的/), {
      target: { value: "改用二号供应商，交期提前 5 天" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认关闭" }));
    });

    expect(invoke.mock.calls.find(([c]) => c === "resolve_risk")?.[1]).toMatchObject({
      id: 1,
      resolution: "改用二号供应商，交期提前 5 天",
    });
    await waitFor(() => expect(store.getState().openRisks.has(1)).toBe(false));
    // 关掉的留在清单里，而且看得见是怎么关的 —— 复盘要的正是这句
    expect(screen.getByText(/改用二号供应商/)).toBeTruthy();
    // 关闭时刻也记下了 —— 「什么时候不再是风险的」是个会被写进汇报的事实
    expect(screen.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} 关闭/)).toBeTruthy();
  });

  it("重新打开会把关闭时间和处置说明一起清掉", async () => {
    const store = await openBoard();
    await act(async () => {
      await store.getState().addRisk(1, "备件交期不确定", 0);
      await store.getState().resolveRisk(1, "改用二号供应商");
    });

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    await screen.findByText(/改用二号供应商/);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/重新打开/));
    });

    // 留着的话，界面上会出现一条「未关闭」却挂着「已解决：换了供应商」的风险
    await waitFor(() => expect(screen.queryByText(/改用二号供应商/)).toBeNull());
    expect(store.getState().openRisks.get(1)).toEqual({ count: 1, top: 0 });
  });
});

describe("看板 · 风险清单的显示", () => {
  it("有多少条就列多少条，一条不少", async () => {
    const store = await openBoard();
    await act(async () => {
      for (let i = 1; i <= 12; i++) {
        await store.getState().addRisk(1, `风险条目${i}`, i % 3);
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    await screen.findByText("风险条目1");
    for (let i = 1; i <= 12; i++) {
      expect(screen.getByText(`风险条目${i}`)).toBeTruthy();
    }
  });

  it("关掉的条目仍在清单里，「只看未关闭」才把它们收起来", async () => {
    const store = await openBoard();
    await act(async () => {
      await store.getState().addRisk(1, "已经解决了的", 0);
      await store.getState().addRisk(1, "还没解决的", 0);
    });
    await act(async () => {
      await store.getState().resolveRisk(1, "供应商换了");
    });

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    expect(await screen.findByText("已经解决了的")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "只看未关闭" }));
    await waitFor(() => expect(screen.queryByText("已经解决了的")).toBeNull());
    expect(screen.getByText("还没解决的")).toBeTruthy();
  });

  it("长正文完整渲染，不靠截断", async () => {
    const long = "供应商的回复很含糊：".repeat(12);
    const store = await openBoard();
    await act(async () => {
      await store.getState().addRisk(1, long, 1);
    });

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    const el = await screen.findByText(long);
    expect(el.className).toContain("whitespace-pre-wrap");
    expect(el.className).not.toContain("truncate");
  });
});

/**
 * 阻碍清单：卡片上只看得到此刻卡着的那几条，那是行动视角。
 * 「上个月一共卡了几次、都卡在什么上」的答案全在**已经关掉**的记录里 ——
 * 关掉就从界面上消失，等于每个月把账本烧掉。
 */
describe("看板 · 阻碍清单", () => {
  /** 造一条已经结束的历史阻碍（⌥ 拖出来的那种，不带 open） */
  const history = (from: number, to: number, note: string) => ({
    id: `h${from}`,
    from,
    to,
    reason: "equipment" as const,
    note,
  });

  it("已经关掉的阻碍留在清单里，不会从界面上消失", async () => {
    const store = await openBoard();
    const task = store.getState().tasks.get(1)!;
    await act(async () => {
      store.getState().patchTask(
        1,
        { blocked: [history(task.startDay, task.startDay + 2, "上个月等料")] },
        "补记",
      );
    });

    // 卡片上看不到它 —— 那条受阻已经过去了
    expect(screen.queryByText(/上个月等料/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    expect(await screen.findByText("上个月等料")).toBeTruthy();
    expect(screen.getByText("3 天")).toBeTruthy();
  });

  it("持续中的排在最上面，并能就地关掉", async () => {
    const store = await openBoard();
    const task = store.getState().tasks.get(1)!;
    await act(async () => {
      store.getState().patchTask(
        1,
        { blocked: [history(task.startDay, task.startDay + 1, "旧的那条")] },
        "补记",
      );
      store.getState().addBlocker(1, "material", "现在卡着的");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    // 卡片上也有同一条阻碍的标签，所以查询限定在面板里
    const panel = (await screen.findByText("阻碍清单")).closest("aside")!;
    const items = within(panel).getAllByText(/旧的那条|现在卡着的/);
    expect(items[0].textContent).toBe("现在卡着的");

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "✓ 关闭" }));
    });
    // 今天开、今天关的那条整段丢掉（零持续时间，留着只会污染按天统计），
    // 历史那条原样留在清单里
    expect(within(panel).getByText("旧的那条")).toBeTruthy();
    expect(within(panel).queryByText("现在卡着的")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "✓ 关闭" })).toBeNull();
    expect(store.getState().tasks.get(1)!.blocked.every((b) => b.open !== true)).toBe(true);
  });

  it("按状态筛选：只看持续中 / 只看已结束", async () => {
    const store = await openBoard();
    const task = store.getState().tasks.get(1)!;
    await act(async () => {
      store.getState().patchTask(
        1,
        { blocked: [history(task.startDay, task.startDay + 1, "旧的那条")] },
        "补记",
      );
      store.getState().addBlocker(1, "material", "现在卡着的");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    await screen.findByText("旧的那条");

    fireEvent.click(screen.getByRole("button", { name: /持续中/ }));
    expect(screen.queryByText("旧的那条")).toBeNull();
    expect(screen.getByText("现在卡着的")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "已结束" }));
    expect(screen.getByText("旧的那条")).toBeTruthy();
    expect(screen.queryByText("现在卡着的")).toBeNull();
  });

  it("按原因汇总天数 —— 「时间卡在什么上」只有这张表答得了", async () => {
    const store = await openBoard();
    const task = store.getState().tasks.get(1)!;
    await act(async () => {
      store.getState().patchTask(
        1,
        {
          blocked: [
            history(task.startDay, task.startDay + 2, "设备坏了"),
            { ...history(task.startDay + 3, task.startDay + 3, "等料"), reason: "material" },
          ],
        },
        "补记",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    expect(await screen.findByText("设备故障 3 天")).toBeTruthy();
    expect(screen.getByText("等料 1 天")).toBeTruthy();
  });

  it("两个面板一次只开一个 —— 并排会把看板挤没", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    expect(await screen.findByText("阻碍清单")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /风险清单/ }));
    await waitFor(() =>
      expect(screen.queryByText(/累计 \d+ 天没能推进/)).toBeNull(),
    );
    expect(screen.getByText(/全项目 · 高风险在前/)).toBeTruthy();
  });
});
