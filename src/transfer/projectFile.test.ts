import { describe, expect, it } from "vitest";
import { backupStamp, isProjectFile, projectFileName } from "./projectFile";

/**
 * 纯文件名逻辑。看起来琐碎，但这两个字符串是用户在访达里唯一能看到的东西 ——
 * 认不出哪个是哪个，跨电脑传输就退化成了猜。
 */

describe("projectFileName", () => {
  it("带上日期，好让同一个项目的多次导出能排序", () => {
    expect(projectFileName("厂房建设", new Date(2026, 7, 25))).toBe(
      "厂房建设-2026-08-25.ganttproj",
    );
  });

  it("洗掉路径分隔符 —— 项目名是自由文本，一个 / 就落到别的目录去了", () => {
    expect(projectFileName("A/B:C", new Date(2026, 0, 2))).toBe("A B C-2026-01-02.ganttproj");
  });

  it("空名字有兜底，不会产生一个以横杠开头的文件名", () => {
    expect(projectFileName("   ", new Date(2026, 0, 2))).toBe("项目-2026-01-02.ganttproj");
  });
});

describe("backupStamp", () => {
  /**
   * 必须是**本地**时间。Rust 那边的 std 拿不到时区，自己拼会拼出 UTC ——
   * 下午两点做的「覆盖前」备份，文件名写着 0602，用户认不出这是刚才那一份。
   */
  it("用本地时区的年月日时分", () => {
    expect(backupStamp(new Date(2026, 7, 25, 14, 2))).toBe("20260825-1402");
  });

  it("补零，保证字典序等于时间序", () => {
    expect(backupStamp(new Date(2026, 0, 5, 9, 7))).toBe("20260105-0907");
  });
});

describe("isProjectFile", () => {
  it("认扩展名，且不分大小写", () => {
    expect(isProjectFile("/x/a.ganttproj")).toBe(true);
    expect(isProjectFile("/x/a.GANTTPROJ")).toBe(true);
  });

  it("Excel 导出件不是项目文件 —— 这正是要在导入前挡住的那个误会", () => {
    expect(isProjectFile("/x/厂房建设-2026-08-25.xlsx")).toBe(false);
    expect(isProjectFile("/x/时间线.html")).toBe(false);
    expect(isProjectFile("/x/ganttproj")).toBe(false);
  });
});
