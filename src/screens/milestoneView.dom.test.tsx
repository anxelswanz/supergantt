// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayToIso, today } from "../gantt/time";
import type { Milestone } from "../db/api";
import type { Task } from "../gantt/model";

/**
 * 里程碑页：最近的未完成里程碑做成倒计时牌，其余按「逾期 → 接下来 → 已达成」分组。
 * 日期都相对今天算，测试哪天跑都一样
 */

let rows: Milestone[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "load_milestones" ? rows : null),
}));

const iso = (offset: number) => dayToIso(today() + offset);
const ms = (id: number, name: string, offset: number, taskIds: number[] = []): Milestone => ({
  id,
  projectId: 7,
  name,
  date: iso(offset),
  color: "#b0752a",
  description: "",
  sortOrder: id,
  taskIds,
  createdAt: 0,
  updatedAt: 0,
});
const task = (id: number, name: string, progress: number) =>
  ({
    id,
    parentId: null,
    name,
    startDay: today() - 10,
    endDay: today() + 5,
    actualStartDay: null,
    actualEndDay: null,
    progress,
    priority: 2,
    personId: null,
    milestone: false,
    collapsed: false,
    sortOrder: id,
    blocked: [],
  }) as unknown as Task;

beforeEach(async () => {
  const { useAppStore } = await import("../store/useAppStore");
  rows = [
    ms(1, "样机评审", 12, [21, 22]),
    ms(2, "小批试产", 40),
    ms(3, "图纸冻结", -3, [22]),
    ms(4, "立项", -20, [21]),
  ];
  useAppStore.setState({
    project: { id: 7, name: "产线改造" } as never,
    milestones: rows,
    tasks: new Map([
      [21, task(21, "电机安装", 1)],
      [22, task(22, "夹具设计", 0.5)],
    ]),
  });
});
afterEach(cleanup);

async function open() {
  const { MilestoneView } = await import("./MilestoneView");
  render(<MilestoneView />);
  return screen.findByRole("region", { name: "下一个里程碑" });
}

describe("里程碑页", () => {
  it("最近的未完成里程碑做成倒计时牌：天数、关联任务进度", async () => {
    const hero = await open();
    expect(within(hero).getByText("样机评审")).toBeTruthy();
    expect(within(hero).getByText("12")).toBeTruthy();
    expect(within(hero).getByText("关联任务 1/2 完成")).toBeTruthy();
    expect(within(hero).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("75");
  });

  it("分组：逾期、接下来、已达成；已达成默认收起", async () => {
    await open();
    expect(screen.getByText("逾期")).toBeTruthy();
    expect(screen.getByTitle("已逾期 3 天")).toBeTruthy();
    expect(screen.getByTitle("还有 40 天")).toBeTruthy();
    // 关联任务全做完：立项达成；收起时看不到
    expect(screen.queryByText("立项")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已达成/ }));
    expect(screen.getByText("立项")).toBeTruthy();
  });

  it("时间轴上每个里程碑一个菱形，点它进编辑", async () => {
    await open();
    const axis = screen.getByRole("region", { name: "里程碑时间轴" });
    expect(within(axis).getAllByRole("button")).toHaveLength(4);
    fireEvent.click(within(axis).getByRole("button", { name: /小批试产，还有 40 天/ }));
    expect((screen.getByDisplayValue("小批试产") as HTMLInputElement).tagName).toBe("INPUT");
  });

  // 工作区内容区是横向 flex：根节点不撑满的话整页缩成内容宽、贴在左边
  it("根节点撑满工作区的宽度", async () => {
    const hero = await open();
    const root = hero.closest(".overflow-hidden.flex-col") as HTMLElement;
    expect(root.className).toMatch(/\bflex-1\b/);
    expect(root.className).toMatch(/\bmin-w-0\b/);
  });
});
