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
import { dayToIso } from "../gantt/time";

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

  it("已完成的活也能补记，只有还没开工的不行", async () => {
    const store = await openBoard();
    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));

    // 做完了也要能记：「上个月这条活等了三天料」是复盘会上才想起来的，
    // 那时它早就在已完成列里了
    await act(async () => {
      store.getState().patchTask(1, { progress: 1 }, "完成");
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "＋ 新建" }).hasAttribute("disabled"),
      ).toBe(false),
    );

    // 退回未开始就不行了 —— 那个阶段谈不上「推不动」，该改的是计划日期
    await act(async () => {
      store
        .getState()
        .patchTask(1, { progress: 0, actualStartDay: null, actualEndDay: null }, "退回");
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "＋ 新建" }).hasAttribute("disabled"),
      ).toBe(true),
    );
  });

  it("给已完成的活补记一段过去的阻碍：日期按填的来，不把工期撑长", async () => {
    const store = await openBoard();
    const before = store.getState().tasks.get(1)!;
    await act(async () => {
      store.getState().patchTask(1, { progress: 1 }, "完成");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    fireEvent.click(await screen.findByRole("button", { name: "＋ 新建" }));

    // 已完成的活默认就是补记：持续中是关掉的，终止日可以自己填
    await screen.findByText("补记阻碍");
    const until = screen.getByTitle("这段受阻的最后一天") as HTMLInputElement;
    expect(until.disabled).toBe(false);

    const from = dayToIso(before.startDay);
    const to = dayToIso(before.startDay + 2);
    fireEvent.click(screen.getByRole("button", { name: "设备故障" }));
    fireEvent.change(screen.getByTitle("这段受阻的第一天"), { target: { value: from } });
    fireEvent.change(until, { target: { value: to } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "记下来" }));
    });

    const [only] = store.getState().tasks.get(1)!.blocked;
    expect(dayToIso(only.from)).toBe(from);
    expect(dayToIso(only.to)).toBe(to);
    // 不是持续中：明天不会再自动加一天，卡片也不会回到受阻列
    expect(only.open).toBeUndefined();
    expect(only.reason).toBe("equipment");
    // 补记一段过去的事，不该顺延计划结束日
    expect(store.getState().tasks.get(1)!.endDay).toBe(before.endDay);
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

  it("点清单里的一条就进详情；关掉之后能补一句结论（可不填）", async () => {
    const store = await openBoard();
    await act(async () => {
      store.getState().addBlocker(1, "material", "等钢筋");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    const panel = (await screen.findByText("阻碍清单")).closest("aside")!;
    await act(async () => {
      fireEvent.click(within(panel).getByTitle(/点开详情/));
    });

    await screen.findByText("阻碍详情");
    // 还卡着的时候谈不上「最后怎么过去的」，所以这时没有结论框
    expect(screen.queryByPlaceholderText(/最后是怎么过去的/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /一直卡到手动关掉为止/ }));
    fireEvent.change(screen.getByPlaceholderText(/最后是怎么过去的/), {
      target: { value: "换了二号供应商，交期提前 5 天" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    const [only] = store.getState().tasks.get(1)!.blocked;
    expect(only.resolution).toBe("换了二号供应商，交期提前 5 天");
    expect(only.open).toBeUndefined();
    // 写了就得看得见，否则等于没写
    expect(await screen.findByText(/换了二号供应商/)).toBeTruthy();
  });

  it("结论不是必填 —— 不写也能关掉，清单里就是没有那一行", async () => {
    const store = await openBoard();
    await act(async () => {
      store.getState().addBlocker(1, "equipment", "三号机异响");
    });

    fireEvent.click(screen.getByRole("button", { name: /阻碍清单/ }));
    const panel = (await screen.findByText("阻碍清单")).closest("aside")!;
    await act(async () => {
      fireEvent.click(within(panel).getByTitle(/点开详情/));
    });
    await screen.findByText("阻碍详情");

    fireEvent.click(screen.getByRole("button", { name: /一直卡到手动关掉为止/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    expect(store.getState().tasks.get(1)!.blocked[0].resolution).toBeUndefined();
    expect(screen.queryByText(/^结论：/)).toBeNull();
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

/**
 * 卡片拖拽走指针事件，不走 HTML5 draggable —— 后者在 Windows 上会被 Tauri 的
 * 文件拖放接管而整个失效，macOS 上却一切正常。jsdom 没有布局，这里给四列
 * 摆上假的几何位置，走一遍「按下 → 拖过阈值 → 在别的列松手」。
 */
describe("看板 · 拖拽", () => {
  it("把卡片拖进另一列，写回的是底层字段，并且能撤销", async () => {
    const store = await openBoard();
    const cols = [...document.querySelectorAll<HTMLElement>("[data-board-column]")];
    expect(cols).toHaveLength(4);
    cols.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ left: i * 300, right: i * 300 + 280, top: 0, bottom: 800, x: i * 300, y: 0, width: 280, height: 800 }) as DOMRect;
    });
    const todo = cols.findIndex((el) => el.dataset.boardColumn === "todo");
    const at = { clientX: todo * 300 + 100, clientY: 200 };

    fireEvent.pointerDown(screen.getByText("设备安装"), { button: 0, clientX: 310, clientY: 100 });
    // 没挪过阈值只是点选，不进入拖拽态
    fireEvent.pointerMove(window, { clientX: 312, clientY: 101 });
    expect(screen.getAllByText("设备安装")).toHaveLength(1);

    await act(async () => {
      fireEvent.pointerMove(window, at);
    });
    // 跟手的小标签出来了
    expect(screen.getAllByText("设备安装")).toHaveLength(2);

    await act(async () => {
      fireEvent.pointerUp(window, at);
    });
    const task = store.getState().tasks.get(1)!;
    expect(task.progress).toBe(0);
    expect(task.actualStartDay).toBeNull();
    expect(store.getState().stack!.undoLabel).toMatch(/^移到「/);
    expect(screen.getAllByText("设备安装")).toHaveLength(1);

    act(() => store.getState().undo());
    expect(store.getState().tasks.get(1)!.progress).toBe(0.5);
  });

  it("松手时不在任何一列上，什么都不改", async () => {
    const store = await openBoard();
    for (const el of document.querySelectorAll<HTMLElement>("[data-board-column]")) {
      el.getBoundingClientRect = () =>
        ({ left: 0, right: 280, top: 0, bottom: 800, x: 0, y: 0, width: 280, height: 800 }) as DOMRect;
    }

    fireEvent.pointerDown(screen.getByText("设备安装"), { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 900, clientY: 900 });
      fireEvent.pointerUp(window, { clientX: 900, clientY: 900 });
    });
    expect(store.getState().stack!.canUndo).toBe(false);
    expect(store.getState().tasks.get(1)!.progress).toBe(0.5);
  });
});
