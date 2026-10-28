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

  it("每个节点直接写结论，逾期未达成的不会显示成没偏差", () => {
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={() => {}} />);
    expect(screen.getByText("晚 3 天达成")).toBeTruthy();
    expect(screen.getByText("逾期 5 天 · 未达成")).toBeTruthy();
    expect(screen.getByText("还有 12 天")).toBeTruthy();
    expect(screen.getByText("个节点已达成")).toBeTruthy();
  });

  it("今天插在已过与未到之间", () => {
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={() => {}} />);
    const items = screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-label") ?? li.textContent);
    expect(items.findIndex((t) => t === "今天")).toBe(2);
  });

  it("点一行打开那个任务", () => {
    const onOpen = vi.fn();
    render(<MilestoneTrack marks={marks} today={TODAY} people={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("量产"));
    expect(onOpen).toHaveBeenCalledWith(3);
  });
});
