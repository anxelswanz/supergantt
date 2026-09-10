// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 项目列表上的两个破坏性/外部动作：删项目、打开数据目录。
 *
 * 删项目是整个应用里**唯一没有退路**的操作 —— 任务和受阻走命令栈可以 ⌘Z，
 * 风险删错了重敲一句话就行，只有它带走整棵树且级联清库。所以保险不是
 * 「点两次」而是「手敲一个词」：连点两下是肌肉记忆，敲字必须先读一眼。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const summary = {
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
  taskCount: 37,
  startDate: "2026-08-03",
  endDate: "2026-08-28",
  leafCount: 30,
  overdueCount: 0,
  progress: 0.4,
};

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

  invoke.mockImplementation((cmd: string) => {
    if (cmd === "list_projects") return Promise.resolve([summary]);
    return Promise.resolve(null);
  });
});

async function openList() {
  const { ProjectList } = await import("./ProjectList");
  render(<ProjectList />);
  await screen.findByText("产线改造");
}

const deleteCalls = () => invoke.mock.calls.filter(([c]) => c === "delete_project");

describe("删项目的保险", () => {
  it("点删除只是开对话框，什么都还没发生", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));

    // 代价写成具体数字：「不可恢复」是套话，「37 个任务」才会让人停一下
    expect(await screen.findByText(/37 个任务，连同它们的风险、评论/)).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("没输对之前，删除按钮是禁用的", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));

    const button = await screen.findByRole("button", { name: "永久删除" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(deleteCalls()).toHaveLength(0);

    // 差一个字也不行
    fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delet" } });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("输入 delete 之后才真的删", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));
    fireEvent.change(await screen.findByPlaceholderText("delete"), {
      target: { value: "delete" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    });
    expect(deleteCalls()[0][1]).toMatchObject({ id: 7 });
  });

  it("大小写和首尾空格不计较 —— 保险防的是手滑，不是拼写", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));
    fireEvent.change(await screen.findByPlaceholderText("delete"), {
      target: { value: "  DELETE " },
    });
    expect(
      screen.getByRole("button", { name: "永久删除" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("敲完直接回车也能确认", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));
    const input = await screen.findByPlaceholderText("delete");
    fireEvent.change(input, { target: { value: "delete" } });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(deleteCalls()).toHaveLength(1);
  });

  it("Esc 取消，一个字都没输的时候回车也不会误删", async () => {
    await openList();
    fireEvent.click(screen.getByTitle(/删除这个项目/));
    const input = await screen.findByPlaceholderText("delete");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(deleteCalls()).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByPlaceholderText("delete")).toBeNull());
    expect(deleteCalls()).toHaveLength(0);
  });
});

describe("数据目录", () => {
  it("卡片上就能打开数据文件所在的目录", async () => {
    await openList();
    await act(async () => {
      fireEvent.click(screen.getByTitle(/数据文件所在的目录/));
    });
    expect(invoke.mock.calls.some(([c]) => c === "reveal_data_dir")).toBe(true);
  });

  it("点它不会顺手把项目打开 —— 卡片本身是个按钮，事件必须拦住", async () => {
    await openList();
    await act(async () => {
      fireEvent.click(screen.getByTitle(/数据文件所在的目录/));
    });
    expect(invoke.mock.calls.some(([c]) => c === "load_project")).toBe(false);
  });
});
