// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MilestoneTrack } from "./MilestoneTrack";
import { milestoneMarks } from "../core/review";
import { resolve, type Task } from "../gantt/model";
import { isoToDay } from "../gantt/time";

const TODAY = isoToDay("2026-10-20");

const task = (id: number, name: string, day: string, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name,
  startDay: isoToDay(day),
  endDay: isoToDay(day),
  progress: 0,
  priority: 2,
  personId: null,
  milestone: true,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: id,
  blocked: [],
  autoRollover: false,
  actualStartDay: null,
  actualEndDay: null,
  ...over,
});

afterEach(cleanup);

describe("MilestoneTrack", () => {
  const tasks = resolve([
    task(1, "方案评审", "2026-10-05", {
      actualStartDay: isoToDay("2026-10-08"),
      actualEndDay: isoToDay("2026-10-08"),
    }),
    task(2, "样机交付", "2026-10-15"),
    task(3, "量产", "2026-11-01"),
  ]);
  const marks = milestoneMarks(tasks, TODAY);

  it("按三句话分栏：已达成 / 该到没到 / 接下来，各自写结论", () => {
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={() => {}} />);
    expect(screen.getByText("晚 3 天")).toBeTruthy();
    expect(screen.getByText("逾期 5 天")).toBeTruthy();
    expect(screen.getByText("还有 12 天")).toBeTruthy();
    expect(screen.getByText("个节点已达成")).toBeTruthy();
    const col = (title: string) => screen.getByText(title).closest("section")!.textContent;
    expect(col("已达成")).toContain("方案评审");
    expect(col("该到没到")).toContain("样机交付");
    expect(col("接下来")).toContain("量产");
  });

  it("时间轴上有今天，每个节点一个菱形", () => {
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={() => {}} />);
    const axis = screen.getByLabelText("里程碑时间轴");
    expect(axis.textContent).toContain("今天 10-20");
    expect(axis.querySelectorAll('button[aria-label*="计划"]').length).toBe(3);
  });

  it("点一行打开那个任务", () => {
    const onOpen = vi.fn();
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("接下来").closest("section")!.querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith(3);
  });
});
