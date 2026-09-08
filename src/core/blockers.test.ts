/**
 * 未关闭的阻碍：自动延长、手动关闭、以及它对任务日期的影响。
 *
 * 这一段是整个功能里最危险的部分 —— 它是**系统自己改用户的排期**。
 * 错一天，用户看到的工期就是错的，而且他不会知道是谁改的。所以这里逐条钉死：
 * 幂等（同一天跑两次不能推两天）、多段不叠加、已关闭的一天也不动。
 */

import { describe, expect, it } from "vitest";
import {
  closeBlocked,
  closeOpenBlocks,
  collectBlockers,
  daysOf,
  extendOpenBlocks,
  fitBlocked,
  parseBlocked,
  reclamp,
  serializeBlocked,
  type BlockedPeriod,
} from "./blocked";
import {
  columnOf,
  isBlockedOn,
  isInProgress,
  moveToColumn,
  newBlocker,
  openBlockerOn,
} from "./board";
import type { Task } from "../gantt/model";

const TODAY = 1000;

const task = (over: Partial<Task> = {}): Task => ({
  id: 1,
  parentId: null,
  name: "任务1",
  startDay: TODAY - 5,
  endDay: TODAY,
  progress: 0.5,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: 1,
  blocked: [],
  actualStartDay: TODAY - 5,
  actualEndDay: TODAY,
  ...over,
});

const openBlock = (from: number, to: number, over: Partial<BlockedPeriod> = {}): BlockedPeriod => ({
  id: `b${from}`,
  from,
  to,
  reason: "material",
  open: true,
  ...over,
});

describe("自动延长", () => {
  it("把未关闭的阻碍推到今天，并顺延同样的天数", () => {
    const t = task({ blocked: [openBlock(TODAY - 3, TODAY - 3)] });
    const patch = extendOpenBlocks(t, TODAY)!;

    expect(patch.blocked![0].to).toBe(TODAY);
    // 计划结束日往后推 3 天 —— 这 3 天没能干活
    expect(patch.endDay).toBe(t.endDay + 3);
    // 顺延过多少留在记录里，事后能解释「这条活为什么比原计划长」
    expect(patch.blocked![0].pushed).toBe(3);
  });

  it("同一天跑两次不会推两次", () => {
    const t = task({ blocked: [openBlock(TODAY - 3, TODAY - 3)] });
    const first = extendOpenBlocks(t, TODAY)!;
    const after = { ...t, ...first } as Task;

    expect(extendOpenBlocks(after, TODAY)).toBeNull();
  });

  it("连着两天跑，天数逐日累加", () => {
    let t = task({ blocked: [openBlock(TODAY, TODAY)] });
    t = { ...t, ...extendOpenBlocks(t, TODAY + 1)! } as Task;
    t = { ...t, ...extendOpenBlocks(t, TODAY + 2)! } as Task;

    expect(t.blocked[0].to).toBe(TODAY + 2);
    expect(t.blocked[0].pushed).toBe(2);
    expect(t.endDay).toBe(TODAY + 2);
  });

  it("两条阻碍同时开着时，顺延取最大值而不是求和", () => {
    // 两段卡的是同一批日子，加起来会让一天算两次、工期凭空翻倍
    const t = task({
      blocked: [openBlock(TODAY - 3, TODAY - 3), openBlock(TODAY - 2, TODAY - 2, { id: "b2" })],
    });
    const patch = extendOpenBlocks(t, TODAY)!;

    expect(patch.endDay).toBe(t.endDay + 3);
    expect(patch.blocked!.every((b) => b.to === TODAY)).toBe(true);
  });

  it("已关闭的阻碍一天也不动", () => {
    // ⌥ 在甘特条上拖出来的历史标注就是这种，它不该有任何排期后果
    const t = task({
      blocked: [{ id: "h1", from: TODAY - 9, to: TODAY - 7, reason: "quality" }],
    });
    expect(extendOpenBlocks(t, TODAY)).toBeNull();
  });

  it("实施结束日跟着走，但只到今天为止", () => {
    const t = task({
      actualEndDay: TODAY - 2,
      blocked: [openBlock(TODAY - 4, TODAY - 4)],
    });
    const patch = extendOpenBlocks(t, TODAY)!;
    expect(patch.actualEndDay).toBe(TODAY);
  });

  it("还没开工的任务没有实施日期，也不会被凭空补上", () => {
    const t = task({
      actualStartDay: null,
      actualEndDay: null,
      blocked: [openBlock(TODAY - 2, TODAY - 2)],
    });
    const patch = extendOpenBlocks(t, TODAY)!;
    expect(patch.actualEndDay).toBeUndefined();
  });

  it("延长后受阻段仍然落在任务区间内", () => {
    // 不变式：to <= endDay。破了的话甘特条上会画出一截飘在条子外面的斜纹
    const t = task({ endDay: TODAY - 3, blocked: [openBlock(TODAY - 6, TODAY - 3)] });
    const patch = extendOpenBlocks(t, TODAY)!;
    expect(patch.blocked![0].to).toBeLessThanOrEqual(patch.endDay!);
  });
});

describe("手动关闭", () => {
  it("关掉之后，今天就不再算受阻", () => {
    const t = task({ blocked: [openBlock(TODAY - 3, TODAY)] });
    const next = closeBlocked(t.blocked, "b997", TODAY);

    expect(next[0].open).toBeUndefined();
    expect(next[0].to).toBe(TODAY - 1);
    expect(isBlockedOn({ blocked: next }, TODAY)).toBe(false);
  });

  it("顺延过的天数在关闭之后仍然留着", () => {
    const t = task({ blocked: [openBlock(TODAY - 3, TODAY, { pushed: 3 })] });
    expect(closeBlocked(t.blocked, "b997", TODAY)[0].pushed).toBe(3);
  });

  it("今天开、今天关的那条整段丢掉", () => {
    // 留一个 from > to 的空区间会污染后面所有按天统计的地方
    const t = task({ blocked: [openBlock(TODAY, TODAY)] });
    expect(closeBlocked(t.blocked, "b1000", TODAY)).toEqual([]);
  });

  it("只关点名的那一条，别的不动", () => {
    const t = task({
      blocked: [openBlock(TODAY - 3, TODAY), openBlock(TODAY - 2, TODAY, { id: "b2" })],
    });
    const next = closeBlocked(t.blocked, "b997", TODAY);
    expect(next.find((b) => b.id === "b2")!.open).toBe(true);
  });

  it("拖出受阻列会把所有还开着的一次关掉", () => {
    const t = task({
      blocked: [openBlock(TODAY - 3, TODAY), { id: "h", from: TODAY - 9, to: TODAY - 8, reason: "other" }],
    });
    const next = closeOpenBlocks(t.blocked, TODAY);
    expect(next.every((b) => b.open !== true)).toBe(true);
    // 历史标注原样保留
    expect(next.find((b) => b.id === "h")!.to).toBe(TODAY - 8);
  });
});

describe("准入：只能挂在进行中的任务上", () => {
  it("进行中的可以", () => {
    expect(isInProgress(task(), TODAY)).toBe(true);
  });

  it("已经卡住的也可以 —— 一条活可能同时卡在两件事上", () => {
    expect(isInProgress(task({ blocked: [openBlock(TODAY, TODAY)] }), TODAY)).toBe(true);
  });

  it("还没开工的不行", () => {
    expect(isInProgress(task({ progress: 0, actualStartDay: null }), TODAY)).toBe(false);
  });

  it("已完成的不行", () => {
    expect(isInProgress(task({ progress: 1 }), TODAY)).toBe(false);
  });
});

describe("归列", () => {
  it("有未关闭的阻碍就落在受阻列", () => {
    // 跨天延长是每分钟查一次的，刚过零点那会儿 to 还停在昨天 ——
    // 只认区间的话卡片会短暂地跳出受阻列
    const t = task({ blocked: [openBlock(TODAY - 2, TODAY - 1)] });
    expect(columnOf(t, TODAY)).toBe("blocked");
  });

  it("拖进受阻列开出来的是一条未关闭的阻碍", () => {
    const t = task({ blocked: [] });
    const changes = moveToColumn(t, "blocked", TODAY, "equipment")!;
    expect(changes.blocked![0]).toMatchObject({ open: true, from: TODAY, reason: "equipment" });
  });

  it("完成优先于受阻 —— 做完的活不该长期挂着假警报", () => {
    const t = task({ progress: 1, blocked: [openBlock(TODAY - 1, TODAY)] });
    expect(columnOf(t, TODAY)).toBe("done");
  });
});

describe("存取", () => {
  it("未关闭标记与顺延天数能存能读", () => {
    const rows = [newBlocker(TODAY, "material", " 等钢筋 "), { id: "h", from: TODAY - 5, to: TODAY - 4, reason: "other" as const }];
    const back = parseBlocked(serializeBlocked(rows));

    expect(back[0]).toMatchObject({ open: true, reason: "material", note: "等钢筋" });
    // 历史数据没有 open 字段，读回来一律当已关闭 —— 一个新字段的默认值
    // 绝不能去改写既有项目的排期
    expect(back[1].open).toBeUndefined();
  });

  it("已关闭的段不写出 open 字段", () => {
    const json = serializeBlocked([{ id: "h", from: 1, to: 2, reason: "other" }]);
    expect(json).not.toContain("open");
  });
});

describe("开阻碍时把区间拉到今天", () => {
  it("计划早该结束、实际还在做的活，开阻碍会把计划结束日拉到今天", () => {
    // 不拉的话，这条阻碍落在任务区间外，用户下次改归类时会被 reclamp 静默裁掉
    const t = task({ endDay: TODAY - 4, actualEndDay: TODAY - 4 });
    const changes = openBlockerOn(t, TODAY, "material");

    expect(changes.endDay).toBe(TODAY);
    expect(changes.actualEndDay).toBe(TODAY);
    expect(changes.blocked!.at(-1)).toMatchObject({ from: TODAY, to: TODAY, open: true });
  });

  it("区间已经盖住今天就不动日期", () => {
    const changes = openBlockerOn(task({ endDay: TODAY + 3 }), TODAY, "material");
    expect(changes.endDay).toBeUndefined();
  });

  it("说明会去掉首尾空格，空说明不写字段", () => {
    expect(openBlockerOn(task(), TODAY, "other", "  等厂家  ").blocked!.at(-1)!.note).toBe("等厂家");
    expect(openBlockerOn(task(), TODAY, "other", "   ").blocked!.at(-1)!.note).toBeUndefined();
  });

  it("原有的阻碍不会被覆盖掉", () => {
    const t = task({ blocked: [openBlock(TODAY - 5, TODAY - 4, { open: false })] });
    expect(openBlockerOn(t, TODAY, "quality").blocked).toHaveLength(2);
  });
});

describe("调整一条阻碍（详情面板背后的规则）", () => {
  it("天数调长到任务尾部之外，任务跟着变长 —— 而不是把这段裁回去", () => {
    // 裁回去的表现是「调了没反应」，用户不会知道是被规则挡了还是软件坏了
    const t = task({ endDay: TODAY, blocked: [openBlock(TODAY - 2, TODAY - 2, { open: false })] });
    const out = fitBlocked(t, { ...t.blocked[0], to: TODAY + 5 }, TODAY)!;

    expect(out.blocked[0].to).toBe(TODAY + 5);
    expect(out.endDay).toBe(TODAY + 5);
  });

  it("区间还在任务里就不动任务日期", () => {
    const t = task({ endDay: TODAY + 9, blocked: [openBlock(TODAY - 2, TODAY - 2, { open: false })] });
    const out = fitBlocked(t, { ...t.blocked[0], to: TODAY }, TODAY)!;
    expect(out.endDay).toBeUndefined();
  });

  it("起始日往任务开始之前挪会被夹回去", () => {
    const t = task({ startDay: TODAY - 5, blocked: [openBlock(TODAY - 2, TODAY - 2, { open: false })] });
    const out = fitBlocked(t, { ...t.blocked[0], from: TODAY - 30 }, TODAY)!;
    expect(out.blocked[0].from).toBe(TODAY - 5);
  });

  it("打开「持续中」会把结束日顶到今天", () => {
    // 「一直持续到我手动关掉」的起码含义就是「到此刻为止都还卡着」
    const t = task({ endDay: TODAY + 3, blocked: [openBlock(TODAY - 4, TODAY - 4, { open: false })] });
    const out = fitBlocked(t, { ...t.blocked[0], open: true }, TODAY)!;
    expect(out.blocked[0].to).toBe(TODAY);
  });

  it("关掉「持续中」时区间原样保留，不会被偷偷改", () => {
    const t = task({ endDay: TODAY + 3, blocked: [openBlock(TODAY - 4, TODAY)] });
    const out = fitBlocked(t, { ...t.blocked[0], open: undefined }, TODAY)!;
    expect(out.blocked[0].to).toBe(TODAY);
    expect(out.blocked[0].open).toBeUndefined();
  });

  it("实施结束日短于新区间时一起顺延", () => {
    const t = task({
      endDay: TODAY + 9,
      actualEndDay: TODAY,
      blocked: [openBlock(TODAY - 2, TODAY - 2, { open: false })],
    });
    const out = fitBlocked(t, { ...t.blocked[0], to: TODAY + 4 }, TODAY)!;
    expect(out.actualEndDay).toBe(TODAY + 4);
  });

  it("倒着调（结束日早于起始日）会被收成一天，不会留下负区间", () => {
    const t = task({ blocked: [openBlock(TODAY - 2, TODAY, { open: false })] });
    const out = fitBlocked(t, { ...t.blocked[0], to: TODAY - 9 }, TODAY)!;
    expect(out.blocked[0].to).toBe(out.blocked[0].from);
  });

  it("改的是不存在的那条时什么都不做", () => {
    const t = task({ blocked: [] });
    expect(fitBlocked(t, openBlock(TODAY, TODAY), TODAY)).toBeNull();
  });

  it("持续中的天数按「到今天为止」算", () => {
    expect(daysOf(openBlock(TODAY - 3, TODAY - 3), TODAY)).toBe(4);
    expect(daysOf(openBlock(TODAY - 3, TODAY - 3, { open: false }), TODAY)).toBe(1);
  });
});

describe("重裁时保护持续中的阻碍", () => {
  it("历史标注该裁就裁", () => {
    const periods = [openBlock(TODAY - 9, TODAY, { open: false })];
    const out = reclamp(periods, { startDay: TODAY - 5, endDay: TODAY });
    expect(out[0].from).toBe(TODAY - 5);
  });

  it("整段落在区间外的历史标注会被丢掉", () => {
    const periods = [openBlock(TODAY - 20, TODAY - 15, { open: false })];
    expect(reclamp(periods, { startDay: TODAY - 5, endDay: TODAY })).toEqual([]);
  });

  it("持续中的那条原样保留 —— 它还在真实地卡着人", () => {
    // 拖一下实施区间就静默丢掉一条正在计数的阻碍，丢失是永久且无声的
    const periods = [openBlock(TODAY - 20, TODAY)];
    const out = reclamp(periods, { startDay: TODAY - 5, endDay: TODAY });
    expect(out).toHaveLength(1);
    expect(out[0].from).toBe(TODAY - 20);
  });
});

describe("阻碍清单的排序", () => {
  const of = (id: number, name: string, blocked: BlockedPeriod[]) => ({ id, name, blocked });

  it("持续中的排在最前，其余按起始日倒序", () => {
    const rows = collectBlockers(
      [
        of(1, "甲", [
          openBlock(TODAY - 10, TODAY - 8, { id: "old", open: false }),
          openBlock(TODAY - 2, TODAY - 1, { id: "recent", open: false }),
        ]),
        of(2, "乙", [openBlock(TODAY - 20, TODAY, { id: "live" })]),
      ],
      TODAY,
    );

    // 还开着的那条起始日最早，但它要人今天去处理，所以排最前
    expect(rows.map((r) => r.period.id)).toEqual(["live", "recent", "old"]);
  });

  it("带上任务名和到今天为止的天数", () => {
    const rows = collectBlockers([of(3, "钢结构吊装", [openBlock(TODAY - 4, TODAY - 4)])], TODAY);
    expect(rows[0]).toMatchObject({ taskId: 3, taskName: "钢结构吊装", days: 5, live: true });
  });

  it("没名字的任务给个占位，清单里不能出现空白行", () => {
    const rows = collectBlockers([of(4, "", [openBlock(TODAY, TODAY)])], TODAY);
    expect(rows[0].taskName).toBe("未命名");
  });

  it("一条阻碍都没有时是空表，不是抛错", () => {
    expect(collectBlockers([of(1, "甲", [])], TODAY)).toEqual([]);
  });
});
