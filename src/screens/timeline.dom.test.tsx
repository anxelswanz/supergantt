// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayToDate, dayToIso, today } from "../gantt/time";

/**
 * 时间线的日期筛选，走一遍接线。
 *
 * 裁剪规则在 core/timeline.test.ts 里钉住了；这里管的是点下去之后
 * 屏幕上的那几天有没有真的换掉 —— 规则全对、界面不动，是这一层最安静的错法。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const NOW = today();

const note = (id: number, day: number, content: string) => ({
  id,
  projectId: 7,
  taskId: null,
  day: dayToIso(day),
  content,
  createdAt: Date.parse(`${dayToIso(day)}T12:00:00Z`) / 1000,
  updatedAt: Date.parse(`${dayToIso(day)}T12:00:00Z`) / 1000,
});

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve([]));
});

async function openTimeline() {
  const { useAppStore } = await import("../store/useAppStore");
  const { TimelineView } = await import("./TimelineView");
  useAppStore.setState({
    project: { id: 7, name: "产线改造", color: "#0ea5e9" } as never,
    tasks: new Map(),
    dailyNotes: [
      note(1, NOW, "今天的事"),
      note(2, NOW - 3, "三天前的事"),
      note(3, NOW - 40, "很久以前的事"),
    ],
  });
  render(<TimelineView />);
  await screen.findByText("今天的事");
}

describe("时间线 · 日期筛选", () => {
  it("默认全部都在", async () => {
    await openTimeline();
    expect(screen.getByText("三天前的事")).toBeTruthy();
    expect(screen.getByText("很久以前的事")).toBeTruthy();
  });

  it("快捷项「今天」：只剩今天", async () => {
    await openTimeline();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(screen.getByText("今天的事")).toBeTruthy();
    expect(screen.queryByText("三天前的事")).toBeNull();
    expect(screen.queryByText("很久以前的事")).toBeNull();
  });

  it("快捷项「近 7 天」再点「全部」：先裁掉，再回来", async () => {
    await openTimeline();
    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    expect(screen.getByText("三天前的事")).toBeTruthy();
    expect(screen.queryByText("很久以前的事")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("很久以前的事")).toBeTruthy();
  });

  it("日历里点一天是单日，再点一天成一段", async () => {
    await openTimeline();
    fireEvent.click(screen.getByTitle(/按日期筛选/));

    // 月历里的格子：用「几号」找，只在当月的格子里找，避开前后补齐的邻月
    const cell = (day: number) => {
      const label = String(dayToDate(day).getUTCDate());
      const hits = screen
        .getAllByRole("button", { name: label })
        .filter((b) => !b.className.includes("opacity-35"));
      return hits[0];
    };

    fireEvent.click(cell(NOW));
    expect(screen.getByText("今天的事")).toBeTruthy();
    expect(screen.queryByText("三天前的事")).toBeNull();

    // 第二下选成一段。三天前可能落在上个月 —— 那种日子这条断言跳过，
    // 单日那一半已经验过接线了
    if (dayToDate(NOW - 3).getUTCMonth() === dayToDate(NOW).getUTCMonth()) {
      fireEvent.click(cell(NOW - 3));
      expect(screen.getByText("今天的事")).toBeTruthy();
      expect(screen.getByText("三天前的事")).toBeTruthy();
      expect(screen.queryByText("很久以前的事")).toBeNull();
    }
  });

  it("筛到一段没记录的日子：说清楚是空的，并给出清除入口", async () => {
    await openTimeline();
    fireEvent.click(screen.getByTitle(/按日期筛选/));
    // 明天一定没有记录；它落在下个月时翻一页
    if (dayToDate(NOW + 1).getUTCMonth() !== dayToDate(NOW).getUTCMonth()) {
      fireEvent.click(screen.getByRole("button", { name: "›" }));
    }
    const label = String(dayToDate(NOW + 1).getUTCDate());
    const target = screen
      .getAllByRole("button", { name: label })
      .filter((b) => !b.className.includes("opacity-35"))[0];
    fireEvent.click(target);

    const empty = screen.getByText(/没有任何记录。/).closest("div")!;
    fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("很久以前的事")).toBeTruthy();
  });
});
