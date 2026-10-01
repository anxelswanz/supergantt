import { describe, expect, it } from "vitest";
import { buildItemKindsWorkbook, countByKind, itemKindsFileName } from "./itemKinds";
import type { ItemKind, ItemNote } from "../db/api";

/**
 * 事项类型的导出。
 *
 * 这里钉死的不是排版，而是两件会让收到文件的人得出**错误结论**的事：
 *
 *   1. 使用数只数「打了这个类型」的事项 —— 未分拣的和已晋升成实体的
 *      都不算，否则那个数字不等于「点这个类型筛出来有几条」
 *   2. 脚注必须在文件里，说明阻碍和风险为什么不在表上
 */

const kind = (over: Partial<ItemKind> & { key: string }): ItemKind => ({
  label: over.key,
  color: "#0ea5e9",
  requiresNote: false,
  builtin: false,
  sortOrder: 0,
  ...over,
});

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
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  ...over,
});

describe("countByKind", () => {
  it("按类型数总数和未关闭数", () => {
    const counts = countByKind([
      note({ id: 1, kind: "todo" }),
      note({ id: 2, kind: "todo", closedAt: 1_700_000_900 }),
      note({ id: 3, kind: "issue" }),
    ]);
    expect(counts.get("todo")).toEqual({ total: 2, open: 1 });
    expect(counts.get("issue")).toEqual({ total: 1, open: 1 });
  });

  it("未分拣的不算进任何类型 —— 它不属于任何一类", () => {
    expect(countByKind([note({ id: 1 })]).size).toBe(0);
  });

  /**
   * 已晋升成实体的那些，身份由实体表达、kind 本就是空的。
   * 万一库里留着一个旧 kind（手改过的数据），也不能算进去 ——
   * 否则这一行的数字不等于「点这个类型筛出来有几条」。
   */
  it("已晋升成实体的不算，即使它身上还留着 kind", () => {
    const counts = countByKind([
      note({ id: 1, kind: "todo", promotedKind: "risk", promotedRef: "7" }),
      note({ id: 2, kind: "todo" }),
    ]);
    expect(counts.get("todo")).toEqual({ total: 1, open: 1 });
  });
});

describe("buildItemKindsWorkbook", () => {
  const at = new Date(2026, 9, 5, 14, 30);

  const wb = () =>
    buildItemKindsWorkbook({
      projectName: "产线改造",
      kinds: [
        kind({ key: "custom:qc", label: "待验收", requiresNote: true, sortOrder: 9 }),
        kind({ key: "todo", label: "代办", builtin: true, sortOrder: 0 }),
        kind({ key: "issue", label: "问题", builtin: true, requiresNote: true, sortOrder: 1 }),
      ],
      notes: [note({ id: 1, kind: "todo" }), note({ id: 2, kind: "custom:qc" })],
      exportedAt: at,
    });

  const text = (sheet: ReturnType<typeof wb>["worksheets"][number]) => {
    const out: string[] = [];
    sheet.eachRow((row) =>
      row.eachCell((c) => {
        if (c.value != null) out.push(String(c.value));
      }),
    );
    return out.join("\n");
  };

  it("表头写明使用数的统计范围 —— 不然那个数字会被当成全库统计", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    expect(text(sheet)).toContain("使用数统计范围：产线改造");
  });

  /** 行序只由数据决定：内置在前，然后按 sortOrder —— 不依赖调用方传进来的顺序 */
  it("内置的排在前面，和界面一致", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    const labels = [5, 6, 7].map((r) => sheet.getRow(r).getCell(1).value);
    expect(labels).toEqual(["代办", "问题", "待验收"]);
  });

  it("关闭规则和来源写成人话，不是 0/1", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    expect(sheet.getRow(5).getCell(3).value).toBe("单击即完成");
    expect(sheet.getRow(5).getCell(4).value).toBe("内置");
    expect(sheet.getRow(6).getCell(3).value).toBe("必须写结论");
    expect(sheet.getRow(7).getCell(4).value).toBe("自定义");
  });

  it("颜色既填成色块又写出十六进制 —— 色块给人看，字串给人抄", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    const cell = sheet.getRow(5).getCell(2);
    expect(cell.value).toBe("#0EA5E9");
    expect(JSON.stringify(cell.fill)).toContain("FF0EA5E9");
  });

  it("使用数落在对应的行上", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    expect(sheet.getRow(5).getCell(5).value).toBe(1); // 代办
    expect(sheet.getRow(6).getCell(5).value).toBe(0); // 问题
    expect(sheet.getRow(7).getCell(5).value).toBe(1); // 待验收
  });

  /**
   * 一份静默省掉「阻碍」和「风险」的类型表，会让收到它的人以为这个系统
   * 只有代办和问题两类。那句说明必须在文件里，不是在界面上。
   */
  it("脚注说明阻碍和风险为什么不在表上", () => {
    const sheet = wb().getWorksheet("事项类型")!;
    const all = text(sheet);
    expect(all).toContain("它们是实体，不是分类");
    expect(all).toContain("受阻列");
  });

  it("文件名带日期", () => {
    expect(itemKindsFileName(at)).toBe("事项类型-20261005.xlsx");
  });
});
