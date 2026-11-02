import { describe, expect, it } from "vitest";
import { parseMarkdown, plainText } from "./markdown";

describe("Markdown 块树", () => {
  it("模型会用到的写法都认得", () => {
    const tree = parseMarkdown(
      [
        "## 四、经验沉淀",
        "一段 **粗** 和 `码`。",
        "- [ ] 开工前确认 **长周期物料** 已下单",
        "- [x] 已做",
        "",
        "1. 一",
        "2. 二",
        "",
        "> 引用",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(tree.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "table"]);

    const [, para, tasks, ordered] = tree;
    if (para.type !== "paragraph" || tasks.type !== "list" || ordered.type !== "list") throw new Error("形状不对");
    expect(para.inlines).toEqual([
      { text: "一段 " },
      { text: "粗", bold: true },
      { text: " 和 " },
      { text: "码", code: true },
      { text: "。" },
    ]);
    expect(tasks.items.map((i) => i.checked)).toEqual([false, true]);
    // 勾选框不重复出现在文字里
    const first = tasks.items[0].blocks[0];
    expect(first.type === "paragraph" && plainText(first.inlines)).toBe("开工前确认 长周期物料 已下单");
    expect(ordered).toMatchObject({ ordered: true, start: 1 });
    expect(ordered.items[0].checked).toBe(null);
  });

  it("认不得的东西当文字留下，不丢内容；实体要解开", () => {
    const tree = parseMarkdown("<div>原样</div>\n\nA &amp; B");
    expect(JSON.stringify(tree)).toContain("原样");
    const last = tree[tree.length - 1];
    expect(last.type === "paragraph" && plainText(last.inlines)).toBe("A & B");
  });
});
