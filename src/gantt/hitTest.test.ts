import { describe, expect, it } from "vitest";
import { hitTest, progressGripX, snapProgress, tapAdoptsPlanDates } from "./hitTest";
import { resolve, type Task } from "./model";
import { AXIS_HEIGHT } from "./theme";
import { Viewport } from "./viewport";

/**
 * 进度手柄的位置。
 *
 * 这里挡住的是一个真实 bug：进度为 0 时手柄落在条子最左端，正好被
 * 「拖左边缘改工期」的判定区整个盖住 —— 手柄画在那里，但永远抓不住。
 * 100% 时对称地被右边缘吃掉。
 */
describe("进度手柄位置", () => {
  const X1 = 100;
  const X2 = 300; // 200px 宽的条子

  it("0% 时不落在左边缘 —— 否则会被改工期的判定区盖住", () => {
    const grip = progressGripX(X1, X2, 0)!;
    expect(grip).toBeGreaterThan(X1 + 7);
  });

  it("100% 时不落在右边缘", () => {
    const grip = progressGripX(X1, X2, 1)!;
    expect(grip).toBeLessThan(X2 - 7);
  });

  it("中间的进度按比例落位，不受钳制影响", () => {
    expect(progressGripX(X1, X2, 0.5)).toBe(200);
    expect(progressGripX(X1, X2, 0.25)).toBe(150);
  });

  it("任何进度值下都落在两端手柄之间的安全区里", () => {
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const grip = progressGripX(X1, X2, p)!;
      expect(grip).toBeGreaterThanOrEqual(X1 + 10);
      expect(grip).toBeLessThanOrEqual(X2 - 10);
    }
  });

  it("条子太窄时放弃这个手柄，免得抢掉整体拖动", () => {
    expect(progressGripX(100, 120, 0.5)).toBe(null);
  });

  it("越界的进度值被夹住，不会算出条子外面去", () => {
    expect(progressGripX(X1, X2, -1)).toBe(progressGripX(X1, X2, 0));
    expect(progressGripX(X1, X2, 5)).toBe(progressGripX(X1, X2, 1));
  });
});

describe("进度档位吸附", () => {
  it("靠近整档时吸过去并标记", () => {
    expect(snapProgress(0.51)).toEqual({ value: 0.5, snapped: true });
    expect(snapProgress(0.99)).toEqual({ value: 1, snapped: true });
    expect(snapProgress(0.02)).toEqual({ value: 0, snapped: true });
  });

  it("离档位远时保留两位小数，不强行吸附", () => {
    expect(snapProgress(0.63)).toEqual({ value: 0.63, snapped: false });
  });

  it("越界值被夹回 0–1", () => {
    expect(snapProgress(-0.5).value).toBe(0);
    expect(snapProgress(1.8).value).toBe(1);
  });
});

/**
 * 进度手柄归**实施**视图。
 *
 * 挡住的 bug：计划视图下条子中段也能抓到进度手柄，一拖就把进度改了 ——
 * 可左侧网格和详情面板在计划视图里明明把进度显示成只读（viewMode.canEdit）。
 * 同一个字段，图上能改、表里不能改，用户只会觉得是随机的。
 */
describe("进度手柄只在实施视图给", () => {
  const vp = new Viewport();
  vp.zoom.value = 12; // 每天 12px
  vp.zoom.target = 12;
  vp.anchorDay = 100;
  vp.anchorX = 0; // 于是第 100 天落在 x = 0
  vp.rowHeight = 32;
  vp.width = 800;
  vp.height = 400;

  const base: Task = {
    id: 1,
    parentId: null,
    name: "任务1",
    startDay: 100,
    endDay: 104, // 条子 100 → 105，即 x ∈ [0, 60]
    progress: 0.5,
    priority: 2,
    personId: null,
    milestone: false,
    weight: null,
    collapsed: false,
    pinned: false,
    sortOrder: 1,
    blocked: [],
    autoRollover: false,
    actualStartDay: null,
    actualEndDay: null,
  };

  const rowY = AXIS_HEIGHT + vp.rowHeight / 2;
  /** 进度 50% 时手柄所在的位置 */
  const gripAt = (t: Task) =>
    progressGripX(vp.xOf(t.startDay), vp.xOf(t.endDay + 1), t.progress)!;

  it("计划视图：手柄位置抓到的是整体移动，不是进度", () => {
    const tasks = resolve([base]);
    const hit = hitTest(vp, tasks, gripAt(base), rowY, "plan");
    expect(hit?.mode).toBe("move");
  });

  it("实施视图：同一个位置抓到进度", () => {
    const t = { ...base, actualStartDay: 100, actualEndDay: 104 };
    const tasks = resolve([t]);
    const hit = hitTest(vp, tasks, gripAt(t), rowY, "actual");
    expect(hit?.mode).toBe("progress");
  });

  it("实施视图的手柄落在**实施条**上，不在计划条上", () => {
    // 实施比计划整体晚 10 天
    const t = { ...base, actualStartDay: 110, actualEndDay: 114 };
    const tasks = resolve([t]);

    // 计划条中段（x = 30）现在是空白，抓不到任何东西
    expect(hitTest(vp, tasks, 30, rowY, "actual")?.mode).toBe(null);

    const x = progressGripX(vp.xOf(110), vp.xOf(115), t.progress)!;
    expect(hitTest(vp, tasks, x, rowY, "actual")?.mode).toBe("progress");
  });

  it("还没填实施日期的虚线条上不给手柄 —— 那上面没有进度填充可拖", () => {
    const tasks = resolve([base]); // actualStartDay/EndDay 为空 → ghost
    const hit = hitTest(vp, tasks, gripAt(base), rowY, "actual");
    expect(hit?.mode).toBe("move");
  });
});

/**
 * 命中结果要带上「这是不是一个还没动过的影子」。
 *
 * 挡住的 bug：hitTest 内部用 activeSpan 算出了 ghost，却没往外传，
 * 于是单击虚线的调用方无从判断 —— 那条线看上去能点，点下去什么都不发生。
 * 判定必须和绘制同源，调用方自己拿 actualStartDay == null 再推一遍，
 * 迟早会和绘制分叉。
 */
describe("命中结果带着 ghost 标记", () => {
  const vp = new Viewport();
  vp.zoom.value = 12;
  vp.zoom.target = 12;
  vp.anchorDay = 100;
  vp.anchorX = 0;
  vp.rowHeight = 32;
  vp.width = 800;
  vp.height = 400;

  const base: Task = {
    id: 1,
    parentId: null,
    name: "任务1",
    startDay: 100,
    endDay: 104,
    progress: 0.5,
    priority: 2,
    personId: null,
    milestone: false,
    weight: null,
    collapsed: false,
    pinned: false,
    sortOrder: 1,
    blocked: [],
    autoRollover: false,
    actualStartDay: null,
    actualEndDay: null,
  };
  /** 条子 100 → 105，即 x ∈ [0, 60]；取中段避开两端改工期的手柄 */
  const MID = 30;
  const rowY = AXIS_HEIGHT + vp.rowHeight / 2;

  it("实施视图、没填实施日期：中段抓到的是 ghost", () => {
    const tasks = resolve([base]);
    const hit = hitTest(vp, tasks, MID, rowY, "actual");
    expect(hit?.mode).toBe("move");
    expect(hit?.ghost).toBe(true);
  });

  it("实施视图、已经填了实施日期：不再是 ghost", () => {
    const t = { ...base, actualStartDay: 102, actualEndDay: 108 };
    const tasks = resolve([t]);
    const hit = hitTest(vp, tasks, vp.xOf(104), rowY, "actual");
    expect(hit?.mode).toBe("move");
    expect(hit?.ghost).toBe(false);
  });

  it("计划视图下永远不是 ghost —— 计划条本身就是真的", () => {
    const tasks = resolve([base]);
    const hit = hitTest(vp, tasks, MID, rowY, "plan");
    expect(hit?.mode).toBe("move");
    expect(hit?.ghost).toBe(false);
  });

  it("父任务不算影子：汇总值没有「还没动过」一说，也没有日期可采用", () => {
    const parent: Task = { ...base, id: 1, name: "组" };
    const child: Task = { ...base, id: 2, parentId: 1, name: "子" };
    const tasks = resolve([parent, child]);
    // 父任务排在前面，取它的那一行
    const hit = hitTest(vp, tasks, MID, rowY, "actual");
    expect(hit?.task.hasChildren).toBe(true);
    expect(hit?.mode).toBe("move");
    expect(hit?.ghost).toBe(false);
  });

  it("条子外的空白：ghost 也照实带出，免得调用方以为这里是干净的", () => {
    const tasks = resolve([base]);
    const hit = hitTest(vp, tasks, 400, rowY, "actual");
    expect(hit?.mode).toBe(null);
    expect(hit?.ghost).toBe(true);
  });
});

/**
 * 「单击虚线 = 采用计划日期」的判定。
 *
 * 这是左网格那句提示（「点它采用计划日期」）背后一直没实现的规则。
 * 四个条件必须同时成立，缺任何一个的表现都是静默的：要么点了没反应，
 * 要么一次拖动被误当成单击 —— 后者会凭空写一组实施日期进撤销栈。
 */
describe("单击虚线采用计划日期", () => {
  const ok = {
    viewMode: "actual" as const,
    ghost: true,
    moved: false,
    actualStartDay: null,
  };

  it("实施视图 + 抓到虚线 + 指针没动 + 还没填过 = 采用", () => {
    expect(tapAdoptsPlanDates(ok)).toBe(true);
  });

  it("拖动过（指针动了）不算 —— 那是落笔变实施，不是采用原计划", () => {
    expect(tapAdoptsPlanDates({ ...ok, moved: true })).toBe(false);
  });

  it("计划视图不采用 —— 那里没有影子，也没有要写的实施日期", () => {
    expect(tapAdoptsPlanDates({ ...ok, viewMode: "plan" })).toBe(false);
  });

  it("抓到的是真实施条就不采用 —— 已经发生过的事不该被计划覆盖", () => {
    expect(tapAdoptsPlanDates({ ...ok, ghost: false })).toBe(false);
  });

  it("已经填过实施日期的不覆盖 —— 单击只是选中，不是重置", () => {
    expect(tapAdoptsPlanDates({ ...ok, actualStartDay: 100 })).toBe(false);
  });

  it("undefined 和 null 一视同仁（都当成还没填）", () => {
    // 松手时任务查不到会传 undefined。这里放行没关系 —— 真被删了的话，
    // 下游 adoptPlanDates 找不到任务会自己 no-op，不会凭空造数据
    expect(tapAdoptsPlanDates({ ...ok, actualStartDay: undefined })).toBe(true);
  });

  it("0 也算已填 —— 天序号可以合法地是 0，别把它当成 null", () => {
    // 第 0 天（1970-01-01）在真实数据里不该出现，但判断写错成真值判断
    // （`!actualStartDay`）就会在这里放行，把一条已有实施的任务重置成计划值
    expect(tapAdoptsPlanDates({ ...ok, actualStartDay: 0 })).toBe(false);
  });
});
