// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI 复盘的整条路走一遍：填背景 → 首轮题 → 追问 → 文档。
 *
 * `claude` 用替身：按「这次要的是题还是文档」吐出实测过的那种 stream-json。
 * 要证明的是流程里那几件会静默出错的事：
 *
 *   1. 每一步都落库，而且库里**没有「在跑」这种阶段** —— 否则关掉应用再打开，
 *      会看到一份永远转圈的复盘
 *   2. 调用失败时已经答过的题一道不丢，原地重试能接上
 *   3. 文档里的数据表来自快照，不来自模型
 *   4. 在这个视图里按 Enter 不会在甘特里凭空多出一条任务
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

/** `plugin-proc` 事件的监听者（db/proc.ts 只挂一个） */
let emit: (payload: { run_id: number; kind: string; data: string }) => void = () => {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: never }) => void) => {
    emit = (payload) => handler({ payload: payload as never });
    return Promise.resolve(() => {});
  },
}));

interface Row {
  id: number;
  projectId: number;
  title: string;
  stage: string;
  background: string;
  snapshot: string;
  questions: string;
  document: string;
  createdAt: number;
  updatedAt: number;
}

/** ai_reviews 表的内存替身 */
let rows: Row[];
/** 每次 save 时写进库的阶段，按顺序 */
let savedStages: string[];
/** 送给 claude 的提示词，按顺序 */
let prompts: { prompt: string; schema: string | null }[];
/** 下一次调用怎么收场 */
let nextCall: "ok" | "fail";
let runId: number;

const questions = (n: number, prefix: string) => ({
  questions: Array.from({ length: n }, (_, i) => ({
    topic: "根因分析",
    title: `${prefix}第 ${i + 1} 题`,
    why: "数据显示电机安装受阻",
    multi: i === 0,
    options: ["选项甲", "选项乙", "选项丙", "选项丁"],
  })),
});

const BODY = "## 一、目标与结果\n模型写的结论。\n\n{{数据概览}}\n\n## 二、过程回顾\n模型写的经过。";

/** 替身 claude：下一个事件循环里把输出一行行吐出来，再退出 */
function fakeClaude(id: number, schema: string | null) {
  const out = (data: object) => emit({ run_id: id, kind: "stdout", data: JSON.stringify(data) });
  setTimeout(() => {
    if (nextCall === "fail") {
      nextCall = "ok";
      out({ type: "result", is_error: true, result: "Invalid API key · Please run /login" });
    } else if (schema) {
      const round2 = prompts.at(-1)!.prompt.includes("道追问");
      out({
        type: "result",
        is_error: false,
        result: "",
        structured_output: round2 ? questions(3, "追问") : questions(7, "首轮"),
      });
    } else {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: BODY } } });
      out({ type: "result", is_error: false, result: BODY });
    }
    emit({ run_id: id, kind: "exit", data: "0" });
  }, 0);
}

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
        startDate: "2026-09-01",
        endDate: "2026-09-10",
        actualStart: "2026-09-01",
        actualEnd: "2026-09-16",
        progress: 1,
        priority: 1,
        personId: null,
        milestone: false,
        weight: null,
        collapsed: false,
        pinned: false,
        note: "",
        sortOrder: 0,
        blocked: JSON.stringify([{ id: "b1", from: "2026-09-03", to: "2026-09-05", reason: "material" }]),
        autoRollover: false,
      },
    ],
    nextTaskId: 13,
    dependencies: [],
    baselines: [],
    people: [],
  };
}

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  rows = [];
  savedStages = [];
  prompts = [];
  nextCall = "ok";
  runId = 0;

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
      case "load_item_notes":
      case "load_daily_notes":
      case "load_project_risks":
      case "count_open_risks":
      case "list_item_kinds":
        return Promise.resolve([]);
      case "load_project":
        return Promise.resolve(projectPayload());
      case "ai_review_available":
        return Promise.resolve(true);
      case "list_ai_reviews":
        return Promise.resolve(rows.map((r) => ({ ...r })));
      case "create_ai_review": {
        const row: Row = {
          id: rows.length + 1,
          projectId: args!.projectId as number,
          title: args!.title as string,
          stage: "ask1",
          background: args!.background as string,
          snapshot: args!.snapshot as string,
          questions: "[]",
          document: "",
          createdAt: 1_790_000_000,
          updatedAt: 1_790_000_000,
        };
        rows.push(row);
        return Promise.resolve({ ...row });
      }
      case "save_ai_review": {
        const row = rows.find((r) => r.id === args!.id)!;
        Object.assign(row, {
          title: args!.title,
          stage: args!.stage,
          questions: args!.questions,
          document: args!.document,
        });
        savedStages.push(row.stage);
        return Promise.resolve(1_790_000_001);
      }
      case "ai_review_run": {
        prompts.push({ prompt: args!.prompt as string, schema: args!.schema as string | null });
        fakeClaude(++runId, args!.schema as string | null);
        return Promise.resolve(runId);
      }
      default:
        return Promise.resolve(null);
    }
  });
});

async function openAiReview() {
  const { default: App } = await import("../App");
  const { useAppStore } = await import("../store/useAppStore");
  render(<App />);
  await screen.findByText("我的项目");
  await useAppStore.getState().openProject(7);
  await screen.findByText("产线改造");
  useAppStore.getState().setActiveView("ai-review");
  await screen.findByText("项目目标与成功标准");
  return useAppStore;
}

const fill = (placeholder: RegExp, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("AI 复盘", () => {
  it("没填目标不能开始 —— 复盘的第一章就是拿结果对照它", async () => {
    await openAiReview();
    expect((screen.getByRole("button", { name: "开始复盘" }) as HTMLButtonElement).disabled).toBe(true);
    fill(/原本要达成什么/, "9 月底投产");
    expect((screen.getByRole("button", { name: "开始复盘" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("填背景 → 答 7 题 → 答 3 道追问 → 得到文档，每一步都落库", async () => {
    await openAiReview();
    fill(/原本要达成什么/, "9 月底投产");
    fill(/实际达成了什么/, "10 月中投产");
    click("开始复盘");

    // —— 首轮 ——
    expect(await screen.findByText("首轮第 1 题")).toBeTruthy();
    expect(screen.getByText("1 / 10")).toBeTruthy();
    // 快照在开始那一刻冻结进库，数字来自 review.ts：电机安装晚 6 天、受阻 3 天
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.tasks[0]).toMatchObject({ name: "电机安装", endDelta: 6, blockedDays: 3 });
    expect(prompts[0].schema).toBeTruthy();
    expect(prompts[0].prompt).toContain("9 月底投产");

    // 第 1 题是多选：选两个，再补一句
    click("选项甲");
    click("选项丙");
    fill(/补充一句/, "合同签晚了");
    click("下一题");
    expect(await screen.findByText("首轮第 2 题")).toBeTruthy();
    // 第 2 题是单选：再点一个会换掉前一个
    click("选项甲");
    click("选项乙");
    click("下一题");
    // 第 3 题只写不选
    await screen.findByText("首轮第 3 题");
    fill(/直接写你的答案/, "都不是，是图纸改了");
    click("下一题");
    // 剩下的跳过
    for (let i = 4; i <= 7; i++) {
      await screen.findByText(`首轮第 ${i} 题`);
      click("跳过");
    }

    // —— 追问 ——
    expect(await screen.findByText("追问第 1 题")).toBeTruthy();
    expect(screen.getByText("8 / 10")).toBeTruthy();
    const saved = JSON.parse(rows[0].questions);
    expect(saved[0].answer).toEqual({ picked: [0, 2], text: "合同签晚了", skipped: false });
    expect(saved[1].answer.picked).toEqual([1]);
    expect(saved[2].answer).toMatchObject({ picked: [], text: "都不是，是图纸改了" });
    expect(saved[6].answer.skipped).toBe(true);
    // 追问的提示词自带首轮的回答 —— 那是个全新的进程，什么都不记得
    expect(prompts[1].prompt).toContain("选项甲；选项丙。补充：合同签晚了");
    expect(prompts[1].prompt).toContain("（未回答）");

    for (let i = 1; i <= 3; i++) {
      await screen.findByText(`追问第 ${i} 题`);
      click("选项丁");
      click(i < 3 ? "下一题" : "提交，生成文档");
    }

    // —— 文档 ——
    expect(await screen.findByText("模型写的经过。")).toBeTruthy();
    expect(prompts[2].schema).toBe(null);
    const doc = rows[0].document;
    expect(doc).toContain("模型写的结论。");
    // 数据表是程序按快照写的，占位行被换掉了
    expect(doc).not.toContain("{{数据概览}}");
    expect(doc).toContain("| 累计受阻 | 3 天 |");
    expect(doc).toContain("| 电机安装 |");
    expect(doc).toContain("## 附录：问答记录");
    expect(screen.getByText("累计受阻")).toBeTruthy();

    // 库里从头到尾没有出现过「在跑」这种阶段
    expect(new Set(savedStages)).toEqual(new Set(["answer1", "ask2", "answer2", "write", "done"]));
    expect(rows[0].stage).toBe("done");
  });

  it("调用失败：答过的题不丢，说人话，原地重试能接上", async () => {
    await openAiReview();
    fill(/原本要达成什么/, "9 月底投产");
    click("开始复盘");
    await screen.findByText("首轮第 1 题");
    click("选项乙");
    click("下一题");
    for (let i = 2; i <= 6; i++) {
      await screen.findByText(`首轮第 ${i} 题`);
      click("跳过");
    }
    await screen.findByText("首轮第 7 题");

    nextCall = "fail";
    click("跳过");

    expect(await screen.findByText(/还没登录，或者登录已经过期/)).toBeTruthy();
    // 阶段停在「该出追问了」，不是退回去，也不是卡在某个中间态
    expect(rows[0].stage).toBe("ask2");
    expect(JSON.parse(rows[0].questions)[0].answer.picked).toEqual([1]);

    click("继续：准备追问");
    expect(await screen.findByText("追问第 1 题")).toBeTruthy();
    expect(screen.queryByText(/还没登录/)).toBe(null);
  });

  it("关掉再打开：停在哪一步就从哪一步接着来", async () => {
    rows = [
      {
        id: 1,
        projectId: 7,
        title: "上个月没做完的",
        stage: "answer1",
        background: JSON.stringify({ kind: "stage", goal: "先投产一条线", outcome: "", extra: "" }),
        snapshot: JSON.stringify({ projectName: "产线改造", takenOn: "2026-09-20", summary: { leafCount: 1 } }),
        questions: JSON.stringify(
          questions(7, "旧").questions.map((q, i) => ({
            ...q,
            id: `r1-${i}`,
            round: 1,
            answer: i < 2 ? { picked: [0], text: "", skipped: false } : null,
          })),
        ),
        document: "",
        createdAt: 1_788_000_000,
        updatedAt: 1_788_000_000,
      },
    ];
    const { default: App } = await import("../App");
    const { useAppStore } = await import("../store/useAppStore");
    render(<App />);
    await screen.findByText("我的项目");
    await useAppStore.getState().openProject(7);
    useAppStore.getState().setActiveView("ai-review");

    // 直接落在第一道没答的题上，不用从头点
    expect(await screen.findByText("旧第 3 题")).toBeTruthy();
    expect(screen.getByText("3 / 10")).toBeTruthy();
    expect(prompts).toHaveLength(0);

    // 新开一份时，目标从上一份带出来
    click("+ 新的复盘");
    expect((screen.getByPlaceholderText(/原本要达成什么/) as HTMLTextAreaElement).value).toBe("先投产一条线");
  });

  /**
   * 点完选项焦点在按钮上，顺手按 Enter 想进下一题 —— 全局快捷键里 Enter 是
   * 「新建任务」。这个视图里看不到任务表，多出来的那条没人会发现。
   */
  it("在这个视图里按 Enter / ⌫ 不会动到任务", async () => {
    const store = await openAiReview();
    const before = store.getState().tasks.size;
    store.getState().select(12);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(store.getState().tasks.size).toBe(before));
    expect(screen.queryByRole("button", { name: "+ 任务" })).toBe(null);
  });
});
