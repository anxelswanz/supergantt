/**
 * 事项清单 → 单张 Excel 工作表。
 *
 * 导出的是**屏幕上那张清单**：筛选器筛剩下的、按屏幕上的顺序（包括手动排过的）。
 * 「导出我现在看到的」是这个按钮被点的唯一理由 —— 筛出「张三负责、关联电机安装的
 * 那几条」发给他，而不是发一份全项目的再让他自己筛。
 *
 * 所以表头必须写明**筛了什么**。一份只有 5 行的事项表，收到的人看不出那是
 * 「全部只有 5 条」还是「筛出来 5 条」，而这两个结论差得很远。
 */

import ExcelJS from "exceljs";
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

export function buildItemsWorkbook(input: ItemsExportInput): ExcelJS.Workbook {
  const { projectName, rows, kinds, people, taskName, filterSummary, exportedAt } = input;
  const personName = new Map(people.map((p) => [p.id, p.name]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Gantt";
  wb.created = exportedAt;

  const sheet = wb.addWorksheet(sanitizeSheetName("事项"), {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  const head = [
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
  sheet.columns = head.map((h) => ({ width: h.width }));

  const open = rows.filter((r) => !r.closed).length;
  sheet.getCell("A1").value = `${projectName} · 事项`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value =
    `${filterSummary ? `筛选：${filterSummary}` : "未筛选（全部事项）"}　·　共 ${rows.length} 条，未关闭 ${open} 条　·　导出于 ${fmt(exportedAt)}`;
  sheet.getCell("A2").font = { size: 9, color: { argb: DIM } };

  const headRow = sheet.getRow(4);
  head.forEach((h, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = h.text;
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    cell.border = { bottom: { style: "thin", color: { argb: RULE } } };
    cell.alignment = { vertical: "middle" };
  });
  headRow.height = 20;

  rows.forEach((r, i) => {
    const row = sheet.getRow(5 + i);
    const values = [
      i + 1,
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
    ];
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      cell.font = { size: 10, color: r.closed ? { argb: DIM } : undefined };
      cell.alignment = { vertical: "top", wrapText: c === 3 || c === 9 };
      cell.border = { bottom: { style: "hair", color: { argb: RULE } } };
    });
  });

  return wb;
}

export function itemsFileName(projectName: string, at: Date): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${stem.slice(0, 60)}-事项-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}.xlsx`;
}

/** Unix 秒 → YYYY-MM-DD（UTC，和清单上的 shortDate 一个口径） */
function dateOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
