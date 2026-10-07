import { describe, expect, it } from "vitest";
import { Packer } from "docx";
import JSZip from "jszip";
import { buildItemsDocx, buildItemsWorkbook, itemsFileName } from "./items";
import type { ItemRow } from "../core/items";
import { BUILTIN_KINDS } from "../core/items";

/**
 * 事项清单的导出。钉死两件事：
 *
 *   1. 导出的就是传进来的那些行、按传进来的顺序 —— 屏幕上筛出几条就是几条
 *   2. 表头写明筛了什么，否则收到的人分不清「全部」和「筛出来的」
 */

const row = (over: Partial<ItemRow> & { key: string }): ItemRow => ({
  source: "note",
  title: over.key,
  kind: null,
  priority: 2,
  personId: null,
  taskId: null,
  createdAt: Date.parse("2026-10-01T00:00:00Z") / 1000,
  closed: false,
  resolution: null,
  fromNoteId: null,
  dangling: false,
  ...over,
});

const input = (rows: ItemRow[], filterSummary = "") => ({
    projectName: "产线改造",
    rows,
    kinds: BUILTIN_KINDS,
    people: [{ id: 3, name: "张三" }],
    taskName: (id: number | null) => (id == null ? null : `#${id} 电机安装`),
    filterSummary,
    exportedAt: new Date(2026, 9, 7, 9, 0),
});
const build = (rows: ItemRow[], filterSummary = "") =>
  buildItemsWorkbook(input(rows, filterSummary)).worksheets[0];

describe("buildItemsWorkbook", () => {
  it("按传进来的顺序逐行写出，字段齐全", () => {
    const sheet = build([
      row({ key: "b", title: "第二条", kind: "todo", personId: 3, taskId: 12 }),
      row({ key: "a", title: "第一条", closed: true, resolution: "打过电话了" }),
    ]);
    const r5 = sheet.getRow(5);
    expect(r5.getCell(4).value).toBe("第二条");
    expect(r5.getCell(3).value).toBe("代办");
    expect(r5.getCell(6).value).toBe("张三");
    expect(r5.getCell(7).value).toBe("#12 电机安装");
    expect(r5.getCell(8).value).toBe("2026-10-01");
    const r6 = sheet.getRow(6);
    expect(r6.getCell(2).value).toBe("已关闭");
    expect(r6.getCell(10).value).toBe("打过电话了");
    expect(sheet.getRow(7).getCell(4).value).toBe(null);
  });

  it("表头写明筛选条件；没筛就说没筛", () => {
    expect(String(build([row({ key: "a" })], "负责人：张三").getCell("A2").value)).toContain(
      "筛选：负责人：张三",
    );
    expect(String(build([row({ key: "a" })]).getCell("A2").value)).toContain("未筛选");
  });

  it("文件名带项目名和日期，去掉路径非法字符", () => {
    expect(itemsFileName("a/b", new Date(2026, 9, 7))).toBe("a b-事项-20261007.xlsx");
    expect(itemsFileName("a", new Date(2026, 9, 7), "docx")).toBe("a-事项-20261007.docx");
  });
});

describe("buildItemsDocx", () => {
  /** 和 Excel 同一张表（itemsTable）—— 两份文件的内容不能对不上 */
  it("生成的 docx 里有标题、筛选说明和每一行", async () => {
    const doc = buildItemsDocx(
      input(
        [
          row({ key: "b", title: "第二条", kind: "todo", personId: 3, taskId: 12 }),
          row({ key: "a", title: "第一条", closed: true, resolution: "打过电话了" }),
        ],
        "负责人：张三",
      ),
    );
    const zip = await JSZip.loadAsync(await Packer.toArrayBuffer(doc));
    const xml = await zip.file("word/document.xml")!.async("string");
    for (const text of ["产线改造 · 事项", "筛选：负责人：张三", "第二条", "#12 电机安装", "打过电话了", "已关闭"])
      expect(xml).toContain(text);
    expect(xml.indexOf("第二条")).toBeLessThan(xml.indexOf("第一条"));
  });
});
