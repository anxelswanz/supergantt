import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../src/plugins/manifest";
// 插件是纯 JS 单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import {
  addChild,
  addSibling,
  cutSetStatus,
  evaluate,
  itemRef,
  layoutTree,
  minimalCutSets,
  moveNode,
  newTree,
  outline,
  parseStore,
  removeNode,
  updateNode,
} from "./main.js";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

type Tree = ReturnType<typeof newTree>;

/** 顶事件「夹具尺寸不对」：或门 → 图纸错（与门：版本旧 + 没复核） / 加工偏差 */
function sample() {
  let t: Tree = newTree({ id: "t1", projectId: 1, label: "夹具尺寸不对", now: "x" });
  const add = (parent: string, label: string) => {
    const r = addChild(t, parent, { label });
    t = r.tree;
    return r.id as string;
  };
  const drawing = add("n1", "图纸错");
  const old = add(drawing, "用了旧版图纸");
  const unchecked = add(drawing, "没人复核");
  t = updateNode(t, drawing, { gate: "and" });
  const machining = add("n1", "加工偏差");
  return { t, drawing, old, unchecked, machining };
}

describe("编辑树", () => {
  it("往基本事件下面加子事件，它就变成中间事件；删空了变回基本事件", () => {
    const { t, machining } = sample();
    const r = addChild(t, machining, { label: "刀具磨损" });
    expect(r.tree.nodes[machining].kind).toBe("intermediate");
    const back = removeNode(r.tree, r.id);
    expect(back.nodes[machining].kind).toBe("basic");
  });

  it("删除带走整枝；顶事件删不掉", () => {
    const { t, drawing, old } = sample();
    const next = removeNode(t, drawing);
    expect(next.nodes[drawing]).toBeUndefined();
    expect(next.nodes[old]).toBeUndefined();
    expect(removeNode(t, "n1")).toBe(t);
  });

  it("同级插在自己后面，左右挪位", () => {
    const { t, drawing, machining } = sample();
    const r = addSibling(t, drawing, { label: "测量错" });
    expect(r.tree.nodes.n1.children).toEqual([drawing, r.id, machining]);
    expect(moveNode(r.tree, machining, -1).nodes.n1.children).toEqual([drawing, machining, r.id]);
  });

  it("有子事件的不能改成叶子，顶事件永远是顶事件", () => {
    const { t, drawing } = sample();
    expect(updateNode(t, drawing, { kind: "basic" }).nodes[drawing].kind).toBe("intermediate");
    expect(updateNode(t, "n1", { kind: "basic" }).nodes.n1.kind).toBe("top");
  });
});

describe("按门推导", () => {
  it("与门：一个输入被排除，整枝就被排除；或门：全部排除才排除", () => {
    let { t, old, machining, drawing } = sample();
    t = updateNode(t, old, { status: "ruled" });
    let ev = evaluate(t);
    expect(ev[drawing]).toBe("ruled");
    expect(ev.n1).toBe("open");
    t = updateNode(t, machining, { status: "ruled" });
    expect(evaluate(t).n1).toBe("ruled");
  });

  it("与门：所有输入都确认才成立，然后顺着或门推到顶", () => {
    let { t, old, unchecked, drawing } = sample();
    t = updateNode(t, old, { status: "confirmed" });
    expect(evaluate(t)[drawing]).toBe("open");
    t = updateNode(t, unchecked, { status: "confirmed" });
    const ev = evaluate(t);
    expect(ev[drawing]).toBe("confirmed");
    expect(ev.n1).toBe("confirmed");
  });
});

describe("最小割集", () => {
  it("或门并、与门拼，按阶数排", () => {
    const { t, old, unchecked, machining } = sample();
    expect(minimalCutSets(t).sets).toEqual([[machining], [old, unchecked]]);
  });

  it("顶事件还没拆就没有割集；割集含已排除的叶子就不成立", () => {
    expect(minimalCutSets(newTree({ id: "t", projectId: 1, now: "x" })).sets).toEqual([]);
    let { t, old, unchecked } = sample();
    t = updateNode(t, old, { status: "ruled" });
    expect(cutSetStatus(t, [old, unchecked])).toBe("ruled");
  });

  it("组合爆炸时截断", () => {
    // 与门下 8 个或门，每个 3 个叶子 → 3^8 = 6561 个割集
    let t: Tree = newTree({ id: "t", projectId: 1, now: "x" });
    const and = addChild(t, "n1", { label: "and" });
    t = and.tree;
    for (let i = 0; i < 8; i++) {
      const g = addChild(t, and.id as string, { label: `g${i}` });
      t = g.tree;
      for (let j = 0; j < 3; j++) t = addChild(t, g.id as string, { label: `${i}.${j}` }).tree;
    }
    t = updateNode(t, and.id as string, { gate: "and" });
    const r = minimalCutSets(t, 50);
    expect(r.truncated).toBe(true);
    expect(r.sets.length).toBeLessThanOrEqual(50);
  });
});

describe("布局", () => {
  it("父节点居中在首尾子节点上方，下一层往下一格", () => {
    const { t, drawing, old, unchecked } = sample();
    const { pos } = layoutTree(t);
    expect(pos[drawing].x).toBe((pos[old].x + pos[unchecked].x) / 2);
    expect(pos[old].y).toBeGreaterThan(pos[drawing].y);
    expect(pos[unchecked].x).toBeGreaterThan(pos[old].x);
  });
});

describe("其他", () => {
  it("大纲：门、符号、验证状态都写出来", () => {
    let { t, old } = sample();
    t = updateNode(t, old, { status: "confirmed" });
    const text = outline(t);
    expect(text.split("\n")[0]).toBe("顶事件：夹具尺寸不对  [或门]");
    expect(text).toContain("├─ 图纸错  [与门]");
    expect(text).toContain("○ 用了旧版图纸（已确认）");
    expect(text).toContain("└─ ○ 加工偏差");
  });

  it("事项按 noteId 认，分拣改类型也还是同一条", () => {
    expect(itemRef({ key: "risk:7", noteId: 3 })).toBe("note:3");
    expect(itemRef({ key: "blocker:2/b1", noteId: null })).toBe("blocker:2/b1");
  });

  it("坏文件当空的", () => {
    expect(parseStore("{oops")).toEqual({ version: 1, trees: [] });
  });

  it("manifest 通过校验，没有警告；入口是自包含的单文件", () => {
    expect(validateManifest(read("./manifest.json"), "fault-tree")).toMatchObject({ ok: true, warnings: [] });
    expect(read("./main.js")).not.toMatch(/\bfrom\s*["']|\bimport\s*\(|\bimport\s+["']/);
  });
});
