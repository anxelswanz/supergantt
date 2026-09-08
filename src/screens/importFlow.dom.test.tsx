// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 导入项目文件的三条关键路径。
 *
 * 这一屏承担的是「用户手上拿着一个从别处传来的文件，他并不确切知道里面是
 * 什么」这个局面，所以测的不是渲染，而是三条承诺：
 *   · 文件不合格 → 一个字都不写库，并且**明说**没写
 *   · 覆盖已有项目 → 必须带上 targetId，否则会悄悄多出一个重名项目
 *   · 覆盖之后 → 撤销走的是同一条导入路径，不存在第二套恢复逻辑
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const pick = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => pick(...a),
  save: (...a: unknown[]) => pick(...a),
}));

const FILE = "/Volumes/U盘/厂房建设-2026-08-25.ganttproj";

const summary = {
  project: {
    id: 7,
    uuid: "u-local",
    name: "厂房建设",
    color: "#0ea5e9",
    workDays: "[1,2,3,4,5]",
    holidays: "[]",
    sortOrder: 0,
    createdAt: "0",
    updatedAt: "1755000000",
  },
  taskCount: 42,
  startDate: "2026-03-01",
  endDate: "2026-09-30",
  leafCount: 40,
  overdueCount: 0,
  progress: 0.4,
};

const side = (name: string, tasks: number, updatedAt: string) => ({
  name,
  taskCount: tasks,
  peopleCount: 2,
  riskCount: 3,
  commentCount: 4,
  dailyNoteCount: 18,
  startDate: "2026-03-01",
  endDate: "2026-09-30",
  updatedAt,
});

const cleanPreview = {
  problems: [],
  warnings: [],
  file: side("厂房建设二期", 47, "1756000000"),
  existing: side("厂房建设", 42, "1755000000"),
  matchedBy: "uuid",
  targetId: 7,
  renameTo: "厂房建设二期",
  nameConflict: false,
  suggestedName: "厂房建设二期",
};

let preview: unknown = cleanPreview;

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  pick.mockReset();
  preview = cleanPreview;

  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  pick.mockResolvedValue(FILE);
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "list_projects") return Promise.resolve([summary]);
    if (cmd === "inspect_import") return Promise.resolve(preview);
    if (cmd === "create_project") return Promise.resolve({ ...summary.project, id: 8 });
    if (cmd === "load_project")
      return Promise.resolve({
        project: { ...summary.project, id: 8 },
        tasks: [],
        dependencies: [],
        baselines: [],
        people: [],
        nextTaskId: 1,
      });
    if (cmd === "commit_import")
      return Promise.resolve({
        projectId: 7,
        name: "厂房建设二期",
        overwritten: true,
        backupPath: "/cfg/backups/厂房建设-覆盖前-20260825-1402.ganttproj",
        taskCount: 47,
        newPeople: [],
      });
    return Promise.resolve(null);
  });
});

async function startImport() {
  const { ProjectList } = await import("./ProjectList");
  render(<ProjectList />);
  await screen.findByText("厂房建设");
  fireEvent.click(screen.getByText("↧ 导入项目"));
}

const commits = () => invoke.mock.calls.filter(([c]) => c === "commit_import");

describe("导入项目文件", () => {
  it("文件不合格时只报问题，一个字都不写库", async () => {
    preview = {
      ...cleanPreview,
      problems: [
        "任务「地基浇筑」：结束日期（2026-03-01）早于开始日期（2026-03-15）",
        "任务「验收」：只填了实施开始，没有实施结束",
      ],
    };
    await startImport();

    await screen.findByText(/无法导入，文件有 2 处问题/);
    expect(screen.getByText(/结束日期（2026-03-01）早于开始日期/)).toBeTruthy();
    // 用户此刻最想知道的不是哪里错了，而是「我刚才那一下有没有把现有数据搞坏」
    expect(screen.getByText(/数据库未发生任何改动/)).toBeTruthy();
    expect(commits()).toHaveLength(0);
  });

  it("认出是本机项目的新版本时，并排摆出两边的数字，并带上 targetId 覆盖", async () => {
    await startImport();

    await screen.findByText("本机已有这个项目");
    expect(screen.getByText(/项目标识和本机这个项目一致/)).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("47")).toBeTruthy();

    // 名字变了，按钮文案要说清楚这一步会改名
    fireEvent.click(screen.getByText("覆盖并改名"));

    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0][1]).toMatchObject({
      path: FILE,
      targetId: 7,
      name: "厂房建设二期",
    });
    // 时间戳由前端给：Rust 的 std 拿不到本机时区
    expect(commits()[0][1].backupStamp).toMatch(/^\d{8}-\d{4}$/);
  });

  it("改名会撞上另一个项目时，先要用户改名才放行", async () => {
    preview = { ...cleanPreview, nameConflict: true };
    await startImport();

    await screen.findByText("本机已有这个项目");
    expect(screen.getByText(/会和本机另一个项目撞名/)).toBeTruthy();

    // 名字没改之前不能提交 —— 提交了也会被库层的 UNIQUE 挡下来，
    // 而那时备份已经写完了，白做一次
    const go = screen.getByText("覆盖并改名") as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("换一个名字"), {
      target: { value: "厂房建设三期" },
    });
    expect((screen.getByText("覆盖并改名") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText("覆盖并改名"));
    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0][1].name).toBe("厂房建设三期");
  });

  it("覆盖之后给一条可撤销的横幅，撤销走的是同一条导入路径", async () => {
    await startImport();
    await screen.findByText("本机已有这个项目");
    fireEvent.click(screen.getByText("覆盖并改名"));

    await screen.findByText(/已用文件版覆盖/);
    expect(screen.getByText(/旧版已备份到/)).toBeTruthy();

    fireEvent.click(screen.getByText("撤销"));

    // 撤销 = 把「覆盖前」那份备份重新导入一次。没有第二套恢复逻辑：
    // 一份只在出事时才走的代码路径是不可信的
    await waitFor(() => expect(commits()).toHaveLength(2));
    expect(commits()[1][1].path).toContain("覆盖前");
    expect(commits()[1][1].targetId).toBe(7);
  });

  it("全新项目不摆对比表，只说里面有什么", async () => {
    preview = {
      ...cleanPreview,
      existing: null,
      matchedBy: null,
      targetId: null,
      renameTo: null,
      file: side("新工地", 12, "1756000000"),
      suggestedName: "新工地",
    };
    await startImport();

    await screen.findByText("导入项目");
    expect(screen.queryByText("本机")).toBeNull();
    expect(screen.getByText(/12 个任务 · 2 位负责人/)).toBeTruthy();

    fireEvent.click(screen.getByText("导入"));
    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0][1].targetId).toBeNull();
  });
});

describe("导出项目文件", () => {
  it("从卡片导出，导完给一个「在访达中显示」的去处", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([summary]);
      if (cmd === "export_project") return Promise.resolve(FILE);
      return Promise.resolve(null);
    });

    const { ProjectList } = await import("./ProjectList");
    render(<ProjectList />);
    await screen.findByText("厂房建设");

    fireEvent.click(screen.getByText("⤴ 导出"));

    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === "export_project")).toHaveLength(1),
    );
    await screen.findByText(/已导出到/);
    expect(screen.getByText("在访达中显示")).toBeTruthy();
  });

  it("记住上次导出的目录 —— 每次重新翻到云盘目录是这个功能最烦的地方", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([summary]);
      if (cmd === "get_setting") return Promise.resolve("/Users/me/坚果云/Gantt");
      if (cmd === "export_project") return Promise.resolve(FILE);
      return Promise.resolve(null);
    });

    const { ProjectList } = await import("./ProjectList");
    render(<ProjectList />);
    await screen.findByText("厂房建设");
    fireEvent.click(screen.getByText("⤴ 导出"));

    await waitFor(() => expect(pick).toHaveBeenCalled());
    const { projectFileName } = await import("../transfer/projectFile");
    expect(pick.mock.calls[0][0].defaultPath).toBe(
      `/Users/me/坚果云/Gantt/${projectFileName("厂房建设", new Date())}`,
    );

    // 导完把新目录记下来，下次对话框直接开在那儿
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([c, a]) => c === "set_setting" && (a as { key: string }).key === "transfer.lastDir"),
      ).toHaveLength(1),
    );
  });
});

describe("项目名唯一", () => {
  it("新建时边敲边比，重名当场提示且不提交", async () => {
    const { ProjectList } = await import("./ProjectList");
    render(<ProjectList />);
    await screen.findByText("厂房建设");

    fireEvent.click(screen.getByText("+ 新建项目"));
    const input = screen.getByPlaceholderText("项目名称");
    fireEvent.change(input, { target: { value: "厂房建设" } });

    expect(screen.getByText(/已有同名项目/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(invoke.mock.calls.filter(([c]) => c === "create_project")).toHaveLength(0);

    // 改成不重名的立刻放行
    fireEvent.change(input, { target: { value: "新工地" } });
    expect(screen.queryByText(/已有同名项目/)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === "create_project")).toHaveLength(1),
    );
  });
});
