import { describe, expect, it } from "vitest";
import { FIXED_COLS_WIDTH, MIN_PANEL_WIDTH, visibleColumns } from "./TaskGrid";

/**
 * 面板变窄时列的渐进隐藏。
 *
 * 之前最小宽度写死成「固定列总宽 + 150」，每加一列下限就往右顶一截 ——
 * 加了紧急度列之后变成 628px，面板往左拉一点就拉不动了。
 */

const keys = (w: number) => visibleColumns(w).map((c) => c.key);

describe("列的渐进隐藏", () => {
  it("宽度够时全部显示", () => {
    expect(keys(FIXED_COLS_WIDTH + 300)).toHaveLength(6);
  });

  it("最窄时只剩任务名，一列都不显示", () => {
    expect(keys(MIN_PANEL_WIDTH)).toEqual([]);
  });

  it("先丢的是甘特图已经说过一遍的信息", () => {
    // 结束、开始看条子位置就知道；进度条子上直接写着百分比
    const shrinking = [
      FIXED_COLS_WIDTH + 200,
      FIXED_COLS_WIDTH,
      FIXED_COLS_WIDTH - 90,
      FIXED_COLS_WIDTH - 180,
    ];
    const dropped = shrinking.map((w) => keys(w));

    expect(dropped[0]).toContain("end");
    expect(dropped[dropped.length - 1]).not.toContain("end");
    // 工期和受阻天数图上读不出来，所以留到最后
    expect(dropped[dropped.length - 1]).toContain("duration");
  });

  it("越窄列越少，不会中途反弹", () => {
    let previous = Infinity;
    for (let w = FIXED_COLS_WIDTH + 300; w >= MIN_PANEL_WIDTH; w -= 20) {
      const count = keys(w).length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });

  it("永远保持声明顺序，不按隐藏优先级重排", () => {
    for (let w = MIN_PANEL_WIDTH; w < FIXED_COLS_WIDTH + 300; w += 17) {
      const order = keys(w);
      const canonical = [
        "priority",
        "start",
        "end",
        "duration",
        "progress",
        "assignee",
      ].filter((k) => order.includes(k as never));
      expect(order).toEqual(canonical);
    }
  });

  it("剩余列的总宽永远给任务名留够空间", () => {
    for (let w = MIN_PANEL_WIDTH; w < FIXED_COLS_WIDTH + 300; w += 13) {
      const used = visibleColumns(w).reduce((sum, c) => sum + c.width, 0);
      expect(w - used).toBeGreaterThanOrEqual(120);
    }
  });
});
