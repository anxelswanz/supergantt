import { describe, expect, it } from "vitest";
import {
  BUILTIN_KINDS,
  EMPTY_FILTER,
  blockerRef,
  closePolicy,
  filterItems,
  kindLabel,
  mergeItems,
  parseBlockerRef,
  sortItems,
  type ItemRow,
  type ItemTask,
} from "./items";
import type { ItemKind, ItemNote, Risk } from "../db/api";
import { isoToDay } from "../gantt/time";

/**
 * 事项合并层。
 *
 * 这里要钉死的不是「列表长什么样」，而是三件会静默出错、而且出错之后
 * 用户只会觉得「这软件在骗我」的事：
 *
 *   1. 不是从事项分拣来的实体也必须出现（否则甘特上标的阻碍在这看不到）
 *   2. 已分拣的事项**不出自己那一行**（否则一件事两行，而且立刻不同步）
 *   3. 悬挂引用要显形，不能静默消失（实体被删了，那句话还得留着）
 */

const TODAY = isoToDay("2026-10-05");
const unix = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

const note = (over: Partial<ItemNote> & { id: number }): ItemNote => ({
  projectId: 1,
  name: `事项${over.id}`,
  kind: null,
  priority: 2,
  personId: null,
  taskId: null,
  promotedKind: null,
  promotedRef: null,
  closedAt: null,
  resolution: null,
  createdAt: unix("2026-10-01"),
  updatedAt: unix("2026-10-01"),
  ...over,
});

const risk = (over: Partial<Risk> & { id: number }): Risk => ({
  taskId: 12,
  content: `风险${over.id}`,
  level: 1,
  resolved: false,
  createdAt: unix("2026-10-01"),
  resolvedAt: null,
  resolution: null,
  priority: null,
  ...over,
});

const task = (over: Partial<ItemTask> & { id: number }): ItemTask => ({
  name: `任务${over.id}`,
  personId: null,
  blocked: [],
  ...over,
});

const period = (id: string, over: Partial<ItemTask["blocked"][number]> = {}) => ({
  id,
  from: isoToDay("2026-10-01"),
  to: isoToDay("2026-10-01"),
  reason: "material" as const,
  ...over,
});

const keys = (rows: ItemRow[]) => rows.map((r) => r.key);

describe("mergeItems：三个来源", () => {
  it("未分拣的事项直接成行", () => {
    const rows = mergeItems({ notes: [note({ id: 1 })], tasks: [], risks: [], today: TODAY });
    expect(keys(rows)).toEqual(["note:1"]);
    expect(rows[0].kind).toBe(null);
    expect(rows[0].source).toBe("note");
  });

  /**
   * 第 3 点：⌥ 在甘特条上拖出来的阻碍、任务详情里直接建的风险，
   * 都没有事项来源。它们**必须**出现在事项视图里 —— 不然同一个东西
   * 在两个地方说法不同，而这正是设计稿反复在防的那件事。
   */
  it("没有事项来源的阻碍和风险也要出现，且不带 ⤴", () => {
    const rows = mergeItems({
      notes: [],
      tasks: [task({ id: 12, blocked: [period("b1")] })],
      risks: [risk({ id: 7 })],
      today: TODAY,
    });
    expect(keys(rows).sort()).toEqual(["blocker:12/b1", "risk:7"]);
    expect(rows.every((r) => r.fromNoteId == null)).toBe(true);
  });

  /** 第 2 点：已分拣的事项只出实体那一行，不出自己那一行 */
  it("已分拣的事项只留实体行，并标上来源事项", () => {
    const rows = mergeItems({
      notes: [note({ id: 1, promotedKind: "blocker", promotedRef: blockerRef(12, "b1") })],
      tasks: [task({ id: 12, personId: 3, blocked: [period("b1", { note: "电机交付延期" })] })],
      risks: [],
      today: TODAY,
    });
    expect(keys(rows)).toEqual(["blocker:12/b1"]);
    expect(rows[0].fromNoteId).toBe(1);
    // 内容按**实体本身**渲染，不是事项的标题
    expect(rows[0].title).toBe("电机交付延期");
    // 阻碍挂在活上，负责人就取那条活的
    expect(rows[0].personId).toBe(3);
  });

  it("晋升成风险的同理，一条事项不会变成两行", () => {
    const rows = mergeItems({
      notes: [note({ id: 1, promotedKind: "risk", promotedRef: "7" })],
      tasks: [task({ id: 12 })],
      risks: [risk({ id: 7, content: "供应商可能缺料" })],
      today: TODAY,
    });
    expect(keys(rows)).toEqual(["risk:7"]);
    expect(rows[0].fromNoteId).toBe(1);
    expect(rows[0].title).toBe("供应商可能缺料");
  });

  /** 第 1 点：实体被单独删掉了，事项上那个引用指向空处 */
  it("悬挂引用要显形 —— 退回成一条标着 dangling 的事项行", () => {
    const rows = mergeItems({
      notes: [
        note({ id: 1, name: "电机交付延期", promotedKind: "blocker", promotedRef: "12/gone" }),
        note({ id: 2, name: "可能缺料", promotedKind: "risk", promotedRef: "999" }),
      ],
      tasks: [task({ id: 12, blocked: [period("b1")] })],
      risks: [],
      today: TODAY,
    });
    const dangling = rows.filter((r) => r.dangling);
    expect(dangling.map((r) => r.title).sort()).toEqual(["可能缺料", "电机交付延期"]);
    // 原始那句话必须还在 —— 它记录的「谁在什么时候说的」是不可再生的
    expect(dangling.every((r) => r.note != null)).toBe(true);
  });

  it("阻碍的未关闭 = 持续中；已经过去的那段算关闭", () => {
    const rows = mergeItems({
      notes: [],
      tasks: [
        task({ id: 12, blocked: [period("live", { open: true }), period("past")] }),
      ],
      risks: [],
      today: TODAY,
    });
    const live = rows.find((r) => r.key === "blocker:12/live")!;
    const past = rows.find((r) => r.key === "blocker:12/past")!;
    expect(live.closed).toBe(false);
    expect(past.closed).toBe(true);
  });

  it("优先级跟着实体走；没填过的是 null，不伪造一个「中」", () => {
    const rows = mergeItems({
      notes: [],
      tasks: [task({ id: 12, blocked: [period("b1", { priority: 0 }), period("b2")] })],
      risks: [risk({ id: 7 })],
      today: TODAY,
    });
    expect(rows.find((r) => r.key === "blocker:12/b1")!.priority).toBe(0);
    expect(rows.find((r) => r.key === "blocker:12/b2")!.priority).toBe(null);
    expect(rows.find((r) => r.key === "risk:7")!.priority).toBe(null);
  });

  it("列表 key 带来源前缀 —— 三张表的自增 id 会撞车", () => {
    const rows = mergeItems({
      notes: [note({ id: 1 })],
      tasks: [task({ id: 1 })],
      risks: [risk({ id: 1 })],
      today: TODAY,
    });
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });
});

describe("sortItems", () => {
  it("未关闭在前，其余按创建时间倒序", () => {
    const rows = mergeItems({
      notes: [
        note({ id: 1, createdAt: unix("2026-09-30") }),
        note({ id: 2, createdAt: unix("2026-10-02"), kind: "todo", closedAt: unix("2026-10-03") }),
        note({ id: 3, createdAt: unix("2026-10-01") }),
      ],
      tasks: [],
      risks: [],
      today: TODAY,
    });
    // 关掉的那条即使最新也沉底
    expect(keys(sortItems(rows))).toEqual(["note:3", "note:1", "note:2"]);
  });

  /**
   * 「分拣不改变行的位置」是按时间倒序这个选择买到的东西：
   * 记完抬头一看那条还在原地。按类型分组的话，每点一次分拣那行就跳走了。
   */
  it("同一时刻上实体在事项之前", () => {
    const sameDay = unix("2026-10-01");
    const rows = mergeItems({
      // 三条都未关闭，比的才是来源次序；已经过去的那段阻碍算关闭、会沉底
      notes: [note({ id: 1, createdAt: sameDay })],
      tasks: [task({ id: 12, blocked: [period("b1", { open: true })] })],
      risks: [risk({ id: 7, createdAt: sameDay })],
      today: TODAY,
    });
    expect(keys(sortItems(rows))).toEqual(["blocker:12/b1", "risk:7", "note:1"]);
  });

  it("同一时刻的两条阻碍：持续中的在前", () => {
    const rows = mergeItems({
      notes: [],
      tasks: [task({ id: 12, blocked: [period("past"), period("live", { open: true })] })],
      risks: [],
      today: TODAY,
    });
    // 持续中的未关闭，已经过去的算关闭 —— 关闭沉底这一条就足以分开它们
    expect(keys(sortItems(rows))).toEqual(["blocker:12/live", "blocker:12/past"]);
  });

  it("同一时刻的两条风险：等级高的在前（0 高，所以是数值升序）", () => {
    const sameDay = unix("2026-10-01");
    const rows = mergeItems({
      notes: [],
      tasks: [],
      risks: [
        risk({ id: 1, level: 2, createdAt: sameDay }),
        risk({ id: 2, level: 0, createdAt: sameDay }),
      ],
      today: TODAY,
    });
    expect(keys(sortItems(rows))).toEqual(["risk:2", "risk:1"]);
  });
});

describe("filterItems", () => {
  const rows = mergeItems({
    notes: [
      note({ id: 1, name: "打电话确认交期", kind: "todo", priority: 1, personId: 3 }),
      note({ id: 2, name: "下周一确认夹具方案", priority: 2 }),
      note({ id: 3, name: "已经办完了", kind: "todo", closedAt: unix("2026-10-03") }),
    ],
    tasks: [],
    risks: [],
    today: TODAY,
  });

  it("空筛选 = 全都要", () => {
    expect(filterItems(rows, EMPTY_FILTER)).toHaveLength(3);
  });

  it("类型可筛「未分拣」—— null 是一个真实的值，不是「不筛」", () => {
    const out = filterItems(rows, { ...EMPTY_FILTER, kinds: [null] });
    expect(keys(out)).toEqual(["note:2"]);
  });

  it("只看未关闭", () => {
    expect(keys(filterItems(rows, { ...EMPTY_FILTER, onlyOpen: true })).sort()).toEqual([
      "note:1",
      "note:2",
    ]);
  });

  it("几维可以叠加", () => {
    const out = filterItems(rows, {
      ...EMPTY_FILTER,
      kinds: ["todo"],
      priorities: [1],
      people: [3],
    });
    expect(keys(out)).toEqual(["note:1"]);
  });

  it("没填过优先级的不会被优先级筛选器命中", () => {
    const withRisk = mergeItems({
      notes: [],
      tasks: [],
      risks: [risk({ id: 7, priority: null })],
      today: TODAY,
    });
    expect(filterItems(withRisk, { ...EMPTY_FILTER, priorities: [0, 1, 2, 3] })).toHaveLength(0);
  });

  it("搜索对标题做大小写无关的包含匹配", () => {
    expect(keys(filterItems(rows, { ...EMPTY_FILTER, query: "夹具" }))).toEqual(["note:2"]);
  });
});

describe("closePolicy", () => {
  const kinds: ItemKind[] = [
    ...BUILTIN_KINDS,
    { key: "custom:a", label: "待验收", color: "#000", requiresNote: true, builtin: false, sortOrder: 2 },
  ];
  const rowOf = (over: Partial<ItemNote> & { id: number }) =>
    mergeItems({ notes: [note(over)], tasks: [], risks: [], today: TODAY })[0];

  it("未分拣不能关 —— 还没决定它是什么，谈不上完成", () => {
    expect(closePolicy(rowOf({ id: 1 }), kinds)).toBe("forbidden");
  });

  it("代办单击即关", () => {
    expect(closePolicy(rowOf({ id: 1, kind: "todo" }), kinds)).toBe("click");
  });

  it("问题要写结论", () => {
    expect(closePolicy(rowOf({ id: 1, kind: "issue" }), kinds)).toBe("note");
  });

  it("自定义类型由它自己的 requiresNote 决定", () => {
    expect(closePolicy(rowOf({ id: 1, kind: "custom:a" }), kinds)).toBe("note");
  });

  it("风险要写结论，阻碍是收区间 —— 两条既有路径各走各的", () => {
    const [blocker] = mergeItems({
      notes: [],
      tasks: [task({ id: 12, blocked: [period("b1", { open: true })] })],
      risks: [],
      today: TODAY,
    });
    const [r] = mergeItems({ notes: [], tasks: [], risks: [risk({ id: 7 })], today: TODAY });
    expect(closePolicy(blocker, kinds)).toBe("blocker");
    expect(closePolicy(r, kinds)).toBe("note");
  });

  it("悬挂的那一行不能关 —— 先决定它现在是什么", () => {
    const [row] = mergeItems({
      notes: [note({ id: 1, kind: "todo", promotedKind: "risk", promotedRef: "999" })],
      tasks: [],
      risks: [],
      today: TODAY,
    });
    expect(closePolicy(row, kinds)).toBe("forbidden");
  });
});

describe("引用编码", () => {
  it("往返", () => {
    expect(parseBlockerRef(blockerRef(12, "b1x"))).toEqual({ taskId: 12, periodId: "b1x" });
  });

  it("periodId 里含斜杠也能解开 —— 只按第一个斜杠切", () => {
    expect(parseBlockerRef("12/a/b")).toEqual({ taskId: 12, periodId: "a/b" });
  });

  it("解不开的返回 null，不抛", () => {
    for (const bad of ["", "12", "/b1", "abc/b1"]) {
      expect(parseBlockerRef(bad)).toBe(null);
    }
  });
});

describe("kindLabel", () => {
  it("阻碍和风险有显示用的伪类型，但不在 item_kinds 里", () => {
    expect(kindLabel("blocker", BUILTIN_KINDS)).toBe("阻碍");
    expect(kindLabel("risk", BUILTIN_KINDS)).toBe("风险");
    expect(BUILTIN_KINDS.some((k) => k.key === "blocker" || k.key === "risk")).toBe(false);
  });

  it("null 是「未分拣」，认不出来的 key 原样显示、不吞掉", () => {
    expect(kindLabel(null, BUILTIN_KINDS)).toBe("未分拣");
    expect(kindLabel("custom:gone", BUILTIN_KINDS)).toBe("custom:gone");
  });
});
