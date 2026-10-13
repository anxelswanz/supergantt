import { Packer } from "docx";
import { describe, expect, it } from "vitest";
import { buildReviewDocx, reviewFileName } from "./aiReview";

/** docx 是个 zip，正文在 word/document.xml 里；这里只需要它的文字 */
async function xmlOf(markdown: string): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const buf = await Packer.toBuffer(buildReviewDocx("结项复盘", markdown));
  const zip = await JSZip.loadAsync(buf);
  return zip.file("word/document.xml")!.async("string");
}

const DOC = [
  "# 结项复盘",
  "> 产线改造 · 结项复盘",
  "## 一、目标与结果",
  "基本达成，**晚了 12 天**。",
  "",
  "| 指标 | 数值 |",
  "| --- | --- |",
  "| 收尾偏差 | 比计划晚 12 天 |",
  "| 少一格 |",
  "",
  "## 四、经验沉淀",
  "- [ ] 开工前确认长周期物料已下单",
  "- [x] 已经做了的",
  "- 普通项",
  "  1. 嵌套的第一步",
  "",
  "```",
  "代码",
  "```",
  "",
  "---",
].join("\n");

describe("复盘文档 → Word", () => {
  it("屏幕上有的，Word 里也有：标题、表格、任务清单、嵌套列表", async () => {
    const xml = await xmlOf(DOC);
    for (const text of [
      "结项复盘",
      "晚了 12 天",
      "比计划晚 12 天",
      "☐ ",
      "☑ ",
      "开工前确认长周期物料已下单",
      "1. ",
      "嵌套的第一步",
      "代码",
    ]) {
      expect(xml).toContain(text);
    }
    expect(xml).toContain("<w:tbl>");
    // 表头 1 行 + 正文 2 行；少一格的那行补齐成两格，不然 Word 打开会报文件损坏
    expect(xml.match(/<w:tr[ >]/g)).toHaveLength(3);
    expect(xml.match(/<w:tc>/g)).toHaveLength(6);
  });

  it("空文档和只有怪东西的文档也导得出来", async () => {
    await expect(xmlOf("")).resolves.toContain("<w:body>");
    await expect(xmlOf("<div>html</div>\n\n| 只有表头 |\n|---|")).resolves.toContain("只有表头");
  });

  it("文件名里不带路径里不能有的字符", () => {
    expect(reviewFileName('产线/改造:"A"', "结项 复盘?", new Date(2026, 9, 13), "docx")).toBe(
      "产线 改造 A-结项 复盘-20261013.docx",
    );
    expect(reviewFileName("", "", new Date(2026, 0, 2), "md")).toBe("项目-复盘-20260102.md");
  });
});
