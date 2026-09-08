/**
 * 导出件的结构测试。
 *
 * 断言的是**收件人打开文件后能看到什么**，而不是内部函数怎么调的：
 * 每个任务一行、日期没有差一天、进度是百分比、风险表在甘特图下面、
 * 已解决的风险褪色。这几条错一条，导出件就是错的，而错法都很安静。
 *
 * 走一遍 writeBuffer → 再读回来，顺带证明生成的确实是一个 Excel 打得开的 zip，
 * 而不只是一棵在内存里长得对的对象树。
 */

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildWorkbook, safeFileName, sanitizeSheetName, type ExportInput } from "./excel";
import { resolve, type Task } from "../gantt/model";
import { WorkCalendar } from "../core/calendar";
import { isoToDay } from "../gantt/time";
import type { Person, Risk } from "../db/api";

const AT = new Date(2026, 7, 9, 14, 30); // 2026-08-09 14:30 本地时间

function task(over: Partial<Task> & { id: number }): Task {
  return {
    parentId: null,
    name: `任务${over.id}`,
    startDay: isoToDay("2026-08-03"),
    endDay: isoToDay("2026-08-07"),
    progress: 0,
    priority: 2,
    personId: null,
    blocked: [],
  actualStartDay: null,
  actualEndDay: null,
    milestone: false,
    weight: null,
    collapsed: false,
    pinned: false,
    sortOrder: over.id,
    ...over,
  };
}

function risk(over: Partial<Risk> & { id: number; taskId: number }): Risk {
  return {
    content: "风险内容",
    level: 1,
    resolved: false,
    createdAt: Math.floor(new Date(2026, 7, 1, 9, 5).getTime() / 1000),
    resolvedAt: null,
    resolution: null,
    ...over,
  };
}

function input(over: Partial<ExportInput> = {}): ExportInput {
  const rows = over.tasks
    ? []
    : [task({ id: 1, name: "需求阶段" }), task({ id: 2, name: "调研", parentId: 1 })];
  return {
    projectName: "登月计划",
    projectColor: "#6366F1",
    tasks: over.tasks ?? resolve(rows),
    people: [],
    calendar: WorkCalendar.default(),
    colorBy: "stage",
    risks: [],
    exportedAt: AT,
    ...over,
  };
}

/** 生成 → 落成 buffer → 读回来。返回收件人真正会看到的那张表。 */
async function roundTrip(i: ExportInput): Promise<ExcelJS.Worksheet> {
  const buffer = await buildWorkbook(i).xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer as ArrayBuffer);
  const sheet = reopened.worksheets[0];
  expect(sheet, "读回来的工作簿里一张表都没有").toBeTruthy();
  return sheet;
}

/** 在某一列里找到第一个含指定文本的行号 */
function findRow(sheet: ExcelJS.Worksheet, col: number, text: string): number {
  for (let r = 1; r <= sheet.rowCount; r++) {
    if (String(sheet.getCell(r, col).value ?? "").includes(text)) return r;
  }
  throw new Error(`第 ${col} 列里找不到「${text}」`);
}

describe("buildWorkbook", () => {
  it("生成的是一个能被重新打开的 xlsx", async () => {
    const sheet = await roundTrip(input());
    expect(sheet.name).toBe("登月计划");
  });

  it("标题行写项目名，副标题交代导出时间与规模", async () => {
    const sheet = await roundTrip(
      input({ risks: [risk({ id: 1, taskId: 2 }), risk({ id: 2, taskId: 2, resolved: true })] }),
    );
    expect(sheet.getCell(1, 1).value).toBe("登月计划");
    const subtitle = String(sheet.getCell(2, 1).value);
    expect(subtitle).toContain("2026-08-09 14:30");
    expect(subtitle).toContain("2 个任务");
    expect(subtitle).toContain("1 个未解决风险");
    expect(subtitle).toContain("共 2 条记录");
  });

  it("每个任务一行，层级用缩进和大纲级别双重表达", async () => {
    const sheet = await roundTrip(input());

    expect(sheet.getCell(6, 1).value).toBe("需求阶段");
    expect(sheet.getCell(7, 1).value).toBe("调研");
    expect(sheet.getCell(6, 1).alignment?.indent).toBeFalsy();
    expect(sheet.getCell(7, 1).alignment?.indent).toBe(1);
    expect(sheet.getRow(7).outlineLevel).toBe(1);
    // 父任务加粗，一眼能和叶子任务分开
    expect(sheet.getCell(6, 1).font?.bold).toBe(true);
  });

  /**
   * 折叠只是浏览状态。发出去的文件静默少掉一整棵子树是最难被发现的错误 ——
   * 收件人没有任何线索能察觉「这里本来还有五个任务」。
   */
  it("折叠的子树照样导出", async () => {
    const rows = [
      task({ id: 1, name: "需求阶段", collapsed: true }),
      task({ id: 2, name: "藏起来的子任务", parentId: 1 }),
    ];
    // 前置条件：resolve 原样调用时确实会把折叠分支滤掉
    expect(resolve(rows)).toHaveLength(1);

    const expanded = resolve(rows.map((t) => ({ ...t, collapsed: false })));
    const sheet = await roundTrip(input({ tasks: expanded }));
    expect(sheet.getCell(7, 1).value).toBe("藏起来的子任务");
  });

  it("日期按 ISO 文本写，不会被收件人的区域设置改写成别的月份", async () => {
    const sheet = await roundTrip(input());
    expect(sheet.getCell(6, 4).value).toBe("2026-08-03");
    expect(sheet.getCell(6, 5).value).toBe("2026-08-07");
  });

  it("工期同时给自然日和工作日", async () => {
    const sheet = await roundTrip(input());
    // 8/3(一) – 8/7(五)：自然日 5，工作日 5
    expect(sheet.getCell(7, 9).value).toBe("5 · 5");
  });

  it("跨周末时工作日少于自然日 —— 这正是工期列存在的理由", async () => {
    const rows = [
      task({
        id: 1,
        name: "跨周末",
        startDay: isoToDay("2026-08-07"), // 周五
        endDay: isoToDay("2026-08-11"), // 下周二
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(sheet.getCell(6, 9).value).toBe("5 · 3");
  });

  it("进度是数值 + 百分比格式，收件人可以直接拿去算", async () => {
    const rows = [task({ id: 1, progress: 0.65 })];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(sheet.getCell(6, 10).value).toBe(0.65);
    expect(sheet.getCell(6, 10).numFmt).toBe("0%");
  });

  it("父任务进度显示的是子任务汇总值，不是它自己填的数", async () => {
    const rows = [
      task({ id: 1, name: "父", progress: 0 }),
      task({ id: 2, parentId: 1, progress: 1 }),
      task({ id: 3, parentId: 1, progress: 0 }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(sheet.getCell(6, 10).value).toBe(0.5);
  });

  it("负责人和未解决风险数落到对应列", async () => {
    const people: Person[] = [
      { id: 7, name: "张三", color: "#0EA5E9", avatar: null, sortOrder: 0 },
    ];
    const rows = [task({ id: 1, personId: 7 }), task({ id: 2, personId: null })];
    const sheet = await roundTrip(
      input({
        tasks: resolve(rows),
        people,
        risks: [
          risk({ id: 1, taskId: 1 }),
          risk({ id: 2, taskId: 1 }),
          risk({ id: 3, taskId: 1, resolved: true }), // 已解决的不计入角标
        ],
      }),
    );

    expect(sheet.getCell(6, 2).value).toBe("张三");
    expect(sheet.getCell(7, 2).value).toBe("—");
    expect(sheet.getCell(6, 11).value).toBe(2);
    expect(sheet.getCell(7, 11).value).toBe("—");
  });

  it("甘特条是一串下边框连成的线，进度以线的粗细区分", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-06"), // 4 天
        // 甘特条画的是**实施**；不填实施日期就还没开工，画虚线
        actualStartDay: isoToDay("2026-08-03"),
        actualEndDay: isoToDay("2026-08-06"),
        progress: 0.5,
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));

    // 轴从 8/1 起（最早任务往前留两天），甘特列从第 9 列开始
    const colOf = (iso: string) => 12 + (isoToDay(iso) - isoToDay("2026-08-01"));
    const lineAt = (iso: string) => sheet.getCell(6, colOf(iso)).border?.bottom;

    expect(lineAt("2026-08-02"), "条子之前不该有线").toBeFalsy();

    // 已完成那半段是粗线，未完成那半段是细线 —— 但整根条子的长度仍是完整工期
    expect(lineAt("2026-08-03")?.style).toBe("thick");
    expect(lineAt("2026-08-04")?.style).toBe("thick");
    expect(lineAt("2026-08-05")?.style).toBe("thin");
    expect(lineAt("2026-08-06")?.style).toBe("thin");

    expect(lineAt("2026-08-07"), "条子之后不该有线").toBeFalsy();
  });

  /** 用色块画条子会把整张表糊成一片，所以正文里除了极淡的休息日底纹不该有填充 */
  it("甘特区不再用填充色块画条子", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-06"),
        actualStartDay: isoToDay("2026-08-03"),
        actualEndDay: isoToDay("2026-08-06"),
        progress: 0.5,
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    const colOf = (iso: string) => 12 + (isoToDay(iso) - isoToDay("2026-08-01"));

    for (const iso of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]) {
      const fill = sheet.getCell(6, colOf(iso)).fill as ExcelJS.FillPattern | undefined;
      const argb = fill?.fgColor?.argb;
      // 允许休息日的浅底纹，但不能是条子本身的颜色
      expect(argb === undefined || /F6F7F9$/i.test(String(argb))).toBe(true);
    }
  });

  /** 甘特区一旦画满横向分隔线，细条子就淹没在网格里了 */
  it("甘特区的空白格不画行分隔线", async () => {
    const rows = [task({ id: 1, startDay: isoToDay("2026-08-03"), endDay: isoToDay("2026-08-04") })];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    const far = 12 + (isoToDay("2026-08-06") - isoToDay("2026-08-01"));
    expect(sheet.getCell(6, far).border?.bottom).toBeFalsy();
    // 左侧信息列仍然保留分隔线，行的归属靠它交代
    expect(sheet.getCell(6, 1).border?.bottom).toBeTruthy();
  });

  it("里程碑画成一个菱形而不是一整条", async () => {
    const rows = [
      task({
        id: 1,
        milestone: true,
        startDay: isoToDay("2026-08-05"),
        endDay: isoToDay("2026-08-05"),
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    const col = 12 + (isoToDay("2026-08-05") - isoToDay("2026-08-03"));
    expect(sheet.getCell(6, col).value).toBe("◆");
    expect(sheet.getCell(6, 9).value).toBe("—"); // 时间点没有工期
  });

  it("跨度变大时自动降粒度，列数不会失控", async () => {
    const rows = [
      task({ id: 1, startDay: isoToDay("2024-01-01"), endDay: isoToDay("2026-12-31") }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    // 三年按月分桶 ≈ 37 列，绝不该是一千多列
    expect(sheet.columnCount).toBeLessThan(60);
    expect(sheet.columnCount).toBeGreaterThan(8);
  });
});

describe("计划 vs 实施", () => {
  it("还没开工的任务，条子画在计划位置上且是虚线", async () => {
    const rows = [
      task({ id: 1, startDay: isoToDay("2026-08-03"), endDay: isoToDay("2026-08-06") }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    const col = 12 + (isoToDay("2026-08-04") - isoToDay("2026-08-01"));
    expect(sheet.getCell(6, col).border?.bottom?.style).toBe("dashed");
    // 实际起止写「—」而不是留空 —— 否则收件人分不清「没开工」和「忘了填」
    expect(sheet.getCell(6, 6).value).toBe("—");
    expect(sheet.getCell(6, 8).value).toBe("—");
  });

  it("已开工的任务，计划线画在上边框、实施线画在下边框", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-06"),
        actualStartDay: isoToDay("2026-08-05"),
        actualEndDay: isoToDay("2026-08-09"),
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));

    // 轴从 8/01 起（最早日期往前留两天）
    const colOf = (iso: string) => 12 + (isoToDay(iso) - isoToDay("2026-08-01"));

    // 8/04 只在计划区间内 → 只有上边框（计划）
    const planOnly = colOf("2026-08-04");
    expect(sheet.getCell(6, planOnly).border?.top?.style).toBe("hair");
    expect(sheet.getCell(6, planOnly).border?.bottom).toBeFalsy();

    // 8/08 只在实施区间内 → 只有下边框（实施）
    const actualOnly = colOf("2026-08-08");
    expect(sheet.getCell(6, actualOnly).border?.bottom).toBeTruthy();
    expect(sheet.getCell(6, actualOnly).border?.top).toBeFalsy();
  });

  it("偏差列给出实施相对计划晚了几天", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-06"),
        actualStartDay: isoToDay("2026-08-05"),
        actualEndDay: isoToDay("2026-08-09"),
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(sheet.getCell(6, 6).value).toBe("2026-08-05");
    expect(sheet.getCell(6, 7).value).toBe("2026-08-09");
    expect(sheet.getCell(6, 8).value).toBe("+3d");
  });

  it("实施拖到计划之外时，时间轴要跟着扩，不能把那一截截掉", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-06"),
        actualStartDay: isoToDay("2026-08-05"),
        actualEndDay: isoToDay("2026-08-20"), // 远超计划
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    const col = 12 + (isoToDay("2026-08-20") - isoToDay("2026-08-01"));
    expect(sheet.getCell(6, col).border?.bottom, "超出计划的那一截被截掉了").toBeTruthy();
  });

  it("提前完成时偏差是负数", async () => {
    const rows = [
      task({
        id: 1,
        startDay: isoToDay("2026-08-03"),
        endDay: isoToDay("2026-08-10"),
        actualStartDay: isoToDay("2026-08-03"),
        actualEndDay: isoToDay("2026-08-07"),
      }),
    ];
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(sheet.getCell(6, 8).value).toBe("-3d");
  });
});

describe("风险表", () => {
  const rows = [task({ id: 1, name: "接口联调" })];

  it("排在甘特图下面，标题给出未解决与总数", async () => {
    const sheet = await roundTrip(
      input({
        tasks: resolve(rows),
        risks: [risk({ id: 1, taskId: 1 }), risk({ id: 2, taskId: 1, resolved: true })],
      }),
    );
    const titleRow = findRow(sheet, 1, "风险点（");
    expect(titleRow).toBeGreaterThan(6); // 在任务行之后
    expect(String(sheet.getCell(titleRow, 1).value)).toContain("1 个未解决");
    expect(String(sheet.getCell(titleRow, 1).value)).toContain("共 2 条");
  });

  it("每条风险带上所属任务、等级、状态和时间", async () => {
    const sheet = await roundTrip(
      input({
        tasks: resolve(rows),
        risks: [risk({ id: 1, taskId: 1, content: "协议还没定", level: 0 })],
      }),
    );
    const r = findRow(sheet, 3, "协议还没定");
    expect(sheet.getCell(r, 1).value).toBe("接口联调");
    expect(sheet.getCell(r, 2).value).toBe("高");
    expect(sheet.getCell(r, 6).value).toBe("未解决");
    expect(String(sheet.getCell(r, 7).value)).toBe("2026-08-01 09:05");
  });

  /**
   * 表格顶上冻结了窗格（xSplit = 8）。跨越冻结线的合并单元格在 Excel 里是坏的：
   * 左半边钉在固定窗格、右半边跟着滚动，内容看上去从格子里支棱出去。
   */
  it("整张风险表不越过冻结线，合并单元格全部落在 A–H 之内", async () => {
    const sheet = await roundTrip(
      input({ tasks: resolve(rows), risks: [risk({ id: 1, taskId: 1 })] }),
    );
    const headerRow = findRow(sheet, 1, "所属任务");

    // ExcelJS 把合并区记在 model.merges，形如 "G12:H12"
    const merges: string[] = (sheet as unknown as { model: { merges: string[] } }).model.merges ?? [];
    const colOf = (ref: string) => {
      const letters = ref.replace(/[0-9]/g, "");
      return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    };
    const rowOf = (ref: string) => Number(ref.replace(/[^0-9]/g, ""));

    for (const merge of merges) {
      const [from, to] = merge.split(":");
      if (rowOf(from) < headerRow) continue; // 只看风险表那几行
      expect(colOf(to), `合并区 ${merge} 越过了冻结线`).toBeLessThanOrEqual(11);
    }
  });

  /** 长风险是这份文件里唯一的长文本，不开自动换行就会被右边的单元格切掉 */
  it("内容列开了自动换行", async () => {
    const long = "接口协议还没定，下周一前不确认就要阻塞前端联调，需要后端同学给个明确时间";
    const sheet = await roundTrip(
      input({ tasks: resolve(rows), risks: [risk({ id: 1, taskId: 1, content: long })] }),
    );
    const r = findRow(sheet, 3, "接口协议还没定");
    expect(sheet.getCell(r, 3).value).toBe(long);
    expect(sheet.getCell(r, 3).alignment?.wrapText).toBe(true);
  });

  it("已解决的风险留下但褪色加删除线，不和活着的风险抢注意力", async () => {
    const sheet = await roundTrip(
      input({
        tasks: resolve(rows),
        risks: [risk({ id: 1, taskId: 1, content: "已经解决了", resolved: true })],
      }),
    );
    const r = findRow(sheet, 3, "已经解决了");
    expect(sheet.getCell(r, 6).value).toBe("已解决");
    expect(sheet.getCell(r, 3).font?.strike).toBe(true);
  });

  it("风险指向的任务被删掉时也不塌，标明出处即可", async () => {
    const sheet = await roundTrip(
      input({ tasks: resolve(rows), risks: [risk({ id: 1, taskId: 999 })] }),
    );
    const r = findRow(sheet, 1, "（任务已删除）");
    expect(r).toBeGreaterThan(6);
  });

  it("没有风险时给一句话，而不是留一片空白让人以为导漏了", async () => {
    const sheet = await roundTrip(input({ tasks: resolve(rows) }));
    expect(() => findRow(sheet, 1, "还没有记录风险")).not.toThrow();
  });
});

describe("空项目", () => {
  it("一个任务都没有也能导出，不抛异常", async () => {
    const sheet = await roundTrip(input({ tasks: [] }));
    expect(String(sheet.getCell(6, 1).value)).toContain("还没有任务");
    expect(() => findRow(sheet, 1, "风险点（")).not.toThrow();
  });
});

describe("文件名与表名", () => {
  /**
   * Excel 对非法表名不报错，而是存出一个**打不开**的文件 ——
   * 这是那种只有真实用户才会踩到、且完全无从排查的错误。
   */
  it("剔除 Excel 不接受的表名字符并截到 31 字", () => {
    expect(sanitizeSheetName("A/B:C?D*E[F]G")).toBe("A B C D E F G");
    expect(sanitizeSheetName("超".repeat(40))).toHaveLength(31);
    expect(sanitizeSheetName("   ")).toBe("甘特图");
    expect(sanitizeSheetName("")).toBe("甘特图");
  });

  it("文件名带日期戳，且不含路径分隔符", () => {
    expect(safeFileName("登月计划", AT)).toBe("登月计划-2026-08-09.xlsx");
    expect(safeFileName("a/b\\c:d", AT)).toBe("a b c d-2026-08-09.xlsx");
    expect(safeFileName("", AT)).toBe("项目-2026-08-09.xlsx");
  });
});

/** 整张表的可见文本。富文本单元格靠 .text 拼回来，正好覆盖处置说明那一段 */
function cellText(sheet: ExcelJS.Worksheet): string {
  const out: string[] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    for (let c = 1; c <= 12; c++) out.push(sheet.getCell(r, c).text);
  }
  return out.join("\n");
}

describe("风险的关闭记录", () => {
  it("已关闭的风险带上处置说明和关闭时刻", async () => {
    const closedAt = Math.floor(new Date(2026, 7, 8, 16, 20).getTime() / 1000);
    const sheet = await roundTrip(
      input({
        risks: [
          risk({
            id: 1,
            taskId: 2,
            content: "备件交期不确定",
            resolved: true,
            resolvedAt: closedAt,
            resolution: "改用二号供应商，交期提前 5 天",
          }),
        ],
      }),
    );

    const text = cellText(sheet);
    // 处置说明是复盘里唯一值得抄的东西，导出件不能只留一个「已解决」
    expect(text).toContain("处置：改用二号供应商，交期提前 5 天");
    // 记录时刻和关闭时刻是两个不同的事实，都要写出来
    expect(text).toContain("2026-08-08 16:20");
    expect(text).toContain("记录 2026-08-01 09:05");
  });

  it("没有处置说明的历史记录不会凭空编一句出来", async () => {
    const sheet = await roundTrip(
      input({ risks: [risk({ id: 1, taskId: 2, resolved: true })] }),
    );
    expect(cellText(sheet)).not.toContain("处置：");
  });
});
