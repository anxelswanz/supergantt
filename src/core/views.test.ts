import { describe, expect, it } from "vitest";
import { applyViewOrder, moveView, parseViewOrder } from "./views";

const v = (...keys: string[]) => keys.map((key) => ({ key }));
const keysOf = (list: { key: string }[]) => list.map((x) => x.key);

describe("parseViewOrder", () => {
  it("读不懂一律当作没排过", () => {
    expect(parseViewOrder(null)).toEqual([]);
    expect(parseViewOrder("")).toEqual([]);
    expect(parseViewOrder("坏的")).toEqual([]);
    expect(parseViewOrder('{"a":1}')).toEqual([]);
  });

  it("只留合法的 key", () => {
    expect(parseViewOrder('["items","BAD KEY",3,"gantt"]')).toEqual(["items", "gantt"]);
  });
});

describe("applyViewOrder", () => {
  it("没排过就原样返回", () => {
    expect(keysOf(applyViewOrder(v("gantt", "board"), []))).toEqual(["gantt", "board"]);
  });

  it("排过的在前，新出现的接在后面并保持原有相对顺序", () => {
    const out = applyViewOrder(v("gantt", "board", "timeline", "milestone"), ["timeline", "gantt"]);
    expect(keysOf(out)).toEqual(["timeline", "gantt", "board", "milestone"]);
  });

  it("顺序里有、清单里已没有的（插件被删）直接忽略", () => {
    const out = applyViewOrder(v("gantt", "board"), ["plugin.gone", "board", "gantt"]);
    expect(keysOf(out)).toEqual(["board", "gantt"]);
  });
});

describe("moveView", () => {
  const keys = ["gantt", "board", "timeline", "review"];

  it("挪到目标前面 / 后面", () => {
    expect(moveView(keys, "review", "board", "before")).toEqual(["gantt", "review", "board", "timeline"]);
    expect(moveView(keys, "gantt", "timeline", "after")).toEqual(["board", "timeline", "gantt", "review"]);
  });

  it("挪到自己或不存在的 key 上，原样返回同一个数组", () => {
    expect(moveView(keys, "board", "board", "after")).toBe(keys);
    expect(moveView(keys, "nope", "board", "after")).toBe(keys);
    expect(moveView(keys, "board", "nope", "after")).toBe(keys);
  });
});
