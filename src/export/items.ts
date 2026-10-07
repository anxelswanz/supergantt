/**
 * 事项清单 → Excel 工作表或 Word 文档。
 *
 * 导出的是**屏幕上那张清单**：筛选器筛剩下的、按屏幕上的顺序（包括手动排过的）。
 * 「导出我现在看到的」是这个按钮被点的唯一理由 —— 筛出「张三负责、关联电机安装的
 * 那几条」发给他，而不是发一份全项目的再让他自己筛。
 *
 * 所以表头必须写明**筛了什么**。一份只有 5 行的事项表，收到的人看不出那是
 * 「全部只有 5 条」还是「筛出来 5 条」，而这两个结论差得很远。
 */

import ExcelJS from "exceljs";
import {
  BorderStyle,
  Document,
  HeadingLevel,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { ItemKind, Person } from "../db/api";
import type { ItemRow } from "../core/items";
import { kindLabel } from "../core/items";
import { RISK_LEVELS } from "../core/risks";
import { reasonLabel } from "../core/blocked";
import { PRIORITY_LABELS } from "../gantt/theme";
import { sanitizeSheetName } from "./excel";

export interface ItemsExportInput {
  projectName: string;
  /** 已经筛过、排好序的行。未关闭在前、已关闭在后，和屏幕一致 */
  rows: ItemRow[];
  kinds: ItemKind[];
  people: Pick<Person, "id" | "name">[];
  /** 任务 id → 显示名（`#12 电机安装`）；任务已删返回 null */
  taskName: (id: number | null) => string | null;
  /** 人读的筛选条件，空串 = 没筛 */
  filterSummary: string;
  exportedAt: Date;
}

const HEAD_FILL = "FFF1F5F9";
const RULE = "FFCBD5E1";
const DIM = "FF64748B";

const SOURCE_LABEL: Record<ItemRow["source"], string> = {
  note: "事项",
  blocker: "阻碍实体",
  risk: "风险实体",
};

/** 一行的附注：阻碍卡了几天、风险等级 —— 和清单上的附注行同一个口径 */
export function itemDetail(row: ItemRow): string {
  const parts: string[] = [];
  if (row.blocker) {
    if (row.blocker.period.note?.trim()) parts.push(reasonLabel(row.blocker.period.reason));
    parts.push(row.blocker.live ? `已卡 ${row.blocker.days} 天` : `共 ${row.blocker.days} 天`);
    if (row.blocker.period.pushed) parts.push(`顺延工期 ${row.blocker.period.pushed} 天`);
  }
  if (row.risk) parts.push(`${RISK_LEVELS[row.risk.level] ?? "中"}风险`);
  if (row.dangling) parts.push("分拣成的实体已被删除");
  return parts.join(" · ");
}

/**
 * Excel 和 Word 共用的那张表：表头、副标题、每行的单元格文字。
 *
 * 两种格式只在排版上不同。行内容在这里算一次 —— 分开算的话，迟早会出现
 * 「Excel 里写已卡 3 天、Word 里写共 3 天」这种两份文件对不上的情况。
 */
export function itemsTable(input: ItemsExportInput) {
  const { projectName, rows, kinds, people, taskName, filterSummary, exportedAt } = input;
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const open = rows.filter((r) => !r.closed).length;

  return {
    title: `${projectName} · 事项`,
    subtitle: `${filterSummary ? `筛选：${filterSummary}` : "未筛选（全部事项）"}　·　共 ${rows.length} 条，未关闭 ${open} 条　·　导出于 ${fmt(exportedAt)}`,
    head: ITEM_COLUMNS,
    body: rows.map((r, i) => ({
      closed: r.closed,
      cells: [
        String(i + 1),
        r.closed ? "已关闭" : "未关闭",
        kindLabel(r.kind, kinds),
        r.title || "（没写内容）",
        r.priority == null ? "" : `P${r.priority} ${PRIORITY_LABELS[r.priority]}`,
        r.personId == null ? "" : (personName.get(r.personId) ?? ""),
        taskName(r.taskId) ?? "",
        dateOf(r.createdAt),
        itemDetail(r),
        r.resolution ?? "",
        SOURCE_LABEL[r.source],
      ],
    })),
  };
}

/** 列定义。width 是 Excel 的字符宽，Word 按它的比例分配表宽 */
const ITEM_COLUMNS = [
  { text: "序号", width: 6 },
  { text: "状态", width: 8 },
  { text: "类型", width: 12 },
  { text: "标题", width: 48 },
  { text: "优先级", width: 10 },
  { text: "负责人", width: 12 },
  { text: "关联任务", width: 24 },
  { text: "记录日期", width: 12 },
  { text: "附注", width: 26 },
  { text: "结论", width: 36 },
  { text: "来源", width: 10 },
];

/** 会换行的长文本列：标题、结论 */
const WRAP_COLS = new Set([3, 9]);

export function buildItemsWorkbook(input: ItemsExportInput): ExcelJS.Workbook {
  const table = itemsTable(input);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Gantt";
  wb.created = input.exportedAt;

  const sheet = wb.addWorksheet(sanitizeSheetName("事项"), {
    views: [{ state: "frozen", ySplit: 4 }],
  });
  sheet.columns = table.head.map((h) => ({ width: h.width }));

  sheet.getCell("A1").value = table.title;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = table.subtitle;
  sheet.getCell("A2").font = { size: 9, color: { argb: DIM } };

  const headRow = sheet.getRow(4);
  table.head.forEach((h, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = h.text;
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    cell.border = { bottom: { style: "thin", color: { argb: RULE } } };
    cell.alignment = { vertical: "middle" };
  });
  headRow.height = 20;

  table.body.forEach((r, i) => {
    const row = sheet.getRow(5 + i);
    r.cells.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      // 序号写成数字，Excel 里才能按它排序
      cell.value = c === 0 ? Number(v) : v;
      cell.font = { size: 10, color: r.closed ? { argb: DIM } : undefined };
      cell.alignment = { vertical: "top", wrapText: WRAP_COLS.has(c) };
      cell.border = { bottom: { style: "hair", color: { argb: RULE } } };
    });
  });

  return wb;
}

/**
 * Word 版。横向 A4 —— 11 列竖着放，标题那一列会被挤成一字一行。
 *
 * Word 的读者和 Excel 的不一样：多半是要贴进周报、打印出来过会，
 * 不会再筛再排。所以没有冻结表头之类的东西，但表头行设成跨页重复。
 */
export function buildItemsDocx(input: ItemsExportInput): Document {
  const table = itemsTable(input);
  const total = table.head.reduce((n, h) => n + h.width, 0);
  // 横向 A4 宽 16838，左右各留 720（半英寸）
  const usable = 16838 - 720 * 2;
  const widths = table.head.map((h) => Math.round((h.width / total) * usable));

  const border = { style: BorderStyle.SINGLE, size: 2, color: "CBD5E1" };
  const borders = { top: border, bottom: border, left: border, right: border };

  const cell = (text: string, i: number, opts: { head?: boolean; dim?: boolean } = {}) =>
    new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      borders,
      shading: opts.head ? { type: ShadingType.CLEAR, fill: "F1F5F9", color: "auto" } : undefined,
      margins: { top: 40, bottom: 40, left: 60, right: 60 },
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text,
              bold: opts.head,
              size: 16, // 半磅：8pt
              color: opts.dim ? "64748B" : undefined,
            }),
          ],
        }),
      ],
    });

  return new Document({
    creator: "Gantt",
    title: table.title,
    styles: { default: { document: { run: { font: "Microsoft YaHei" } } } },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: table.title, bold: true, size: 28 })],
          }),
          new Paragraph({
            spacing: { after: 160 },
            children: [new TextRun({ text: table.subtitle, size: 16, color: "64748B" })],
          }),
          new Table({
            width: { size: usable, type: WidthType.DXA },
            columnWidths: widths,
            rows: [
              new TableRow({
                tableHeader: true,
                children: table.head.map((h, i) => cell(h.text, i, { head: true })),
              }),
              ...table.body.map(
                (r) =>
                  new TableRow({
                    cantSplit: true,
                    children: r.cells.map((v, i) => cell(v, i, { dim: r.closed })),
                  }),
              ),
            ],
          }),
        ],
      },
    ],
  });
}

export function itemsFileName(projectName: string, at: Date, ext: "xlsx" | "docx" = "xlsx"): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${stem.slice(0, 60)}-事项-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}.${ext}`;
}

/** Unix 秒 → YYYY-MM-DD（UTC，和清单上的 shortDate 一个口径） */
function dateOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
