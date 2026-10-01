/**
 * 事项类型清单 → 单张 Excel 工作表。
 *
 * 和 `excel.ts` 那张排期表不是一回事：那张是给人核计划的，这张是给人
 * **对口径**的 —— 「我们这个团队把事情分成哪几类、哪几类关掉时要写结论」。
 * 它通常的用途是发给别的组照着建一份一样的，或者在评审会上过一遍。
 *
 * 两个必须带进文件的东西，否则收到文件的人会得到错的结论：
 *
 *  1. **「阻碍」和「风险」不在这张表里**，而它们恰恰是分拣菜单里最显眼的
 *     两项。不写一句说明，收到的人会以为这个系统只有「代办 / 问题」两类。
 *     它们是实体不是分类（见 migrations/011_item_kinds.sql）。
 *  2. **使用数只统计当前项目**。`item_kinds` 是全局表，而 `item_notes` 按项目
 *     分，一次导出手里只有当前这一个项目的事项。列名因此写明「本项目」——
 *     一个含糊的「使用数」会被当成全库统计，然后用来做「这个类型没人用，
 *     删掉吧」这种判断。
 */

import ExcelJS from "exceljs";
import type { ItemKind, ItemNote } from "../db/api";
import { sanitizeSheetName } from "./excel";

export interface ItemKindsExportInput {
  /** 统计使用数的那个项目。只为了写进表头，让人知道数字的范围 */
  projectName: string;
  kinds: ItemKind[];
  /** 当前项目的全部事项，用来数每个类型用了几条 */
  notes: ItemNote[];
  exportedAt: Date;
}

/** 一个类型在当前项目里的使用情况 */
export interface KindUsage {
  total: number;
  open: number;
}

/**
 * 按类型数事项。
 *
 * 只数**打了类型**的那些：未分拣的（`kind` 为 null）不属于任何类型，
 * 已晋升成实体的（`promotedKind` 非空）身份由实体表达、`kind` 本就是空的。
 * 把它们算进某一行，那一行的数字就不再等于「点这个类型筛出来有几条」。
 */
export function countByKind(notes: ItemNote[]): Map<string, KindUsage> {
  const out = new Map<string, KindUsage>();
  for (const n of notes) {
    if (n.kind == null || n.promotedKind != null) continue;
    const prev = out.get(n.kind) ?? { total: 0, open: 0 };
    prev.total += 1;
    if (n.closedAt == null) prev.open += 1;
    out.set(n.kind, prev);
  }
  return out;
}

const HEAD_FILL = "FFF1F5F9";
const RULE = "FFCBD5E1";

export function buildItemKindsWorkbook(input: ItemKindsExportInput): ExcelJS.Workbook {
  const { projectName, kinds, notes, exportedAt } = input;
  const usage = countByKind(notes);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Gantt";
  wb.created = exportedAt;

  const sheet = wb.addWorksheet(sanitizeSheetName("事项类型"), {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  sheet.columns = [
    { width: 18 }, // 名称
    { width: 11 }, // 颜色
    { width: 16 }, // 关闭规则
    { width: 10 }, // 来源
    { width: 14 }, // 本项目事项数
    { width: 12 }, // 其中未关闭
    { width: 26 }, // 类型标识
  ];

  sheet.getCell("A1").value = "事项类型";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value =
    `全局定义，所有项目共用　·　导出于 ${fmt(exportedAt)}　·　使用数统计范围：${projectName}`;
  sheet.getCell("A2").font = { size: 9, color: { argb: "FF64748B" } };

  // 表头在第 4 行，第 3 行留空当间距
  const head = ["名称", "颜色", "关闭时", "来源", "本项目事项数", "其中未关闭", "类型标识"];
  const headRow = sheet.getRow(4);
  head.forEach((text, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = text;
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    cell.border = { bottom: { style: "thin", color: { argb: RULE } } };
    cell.alignment = { vertical: "middle" };
  });
  headRow.height = 20;

  // 内置的排在前面，和界面上一致（sort_order 已经这么排了），
  // 但导出件的行序不能依赖调用方传进来的顺序 —— 这里自己再定一次
  const rows = [...kinds].sort(
    (a, b) =>
      Number(b.builtin) - Number(a.builtin) || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key),
  );

  rows.forEach((k, i) => {
    const row = sheet.getRow(5 + i);
    const used = usage.get(k.key) ?? { total: 0, open: 0 };

    row.getCell(1).value = k.label;
    row.getCell(1).font = { size: 10, bold: true };

    // 颜色既填成色块又写出十六进制：色块给人看，字串给人抄
    const argb = toArgb(k.color);
    row.getCell(2).value = k.color.toUpperCase();
    row.getCell(2).font = { size: 9, name: "Menlo" };
    row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    row.getCell(2).alignment = { horizontal: "center" };

    row.getCell(3).value = k.requiresNote ? "必须写结论" : "单击即完成";
    row.getCell(3).font = { size: 10 };
    row.getCell(4).value = k.builtin ? "内置" : "自定义";
    row.getCell(4).font = { size: 10, color: { argb: "FF64748B" } };

    row.getCell(5).value = used.total;
    row.getCell(6).value = used.open;
    for (const c of [5, 6]) {
      row.getCell(c).font = { size: 10 };
      row.getCell(c).alignment = { horizontal: "right" };
    }

    row.getCell(7).value = k.key;
    row.getCell(7).font = { size: 9, name: "Menlo", color: { argb: "FF94A3B8" } };

    for (let c = 1; c <= 7; c++) {
      row.getCell(c).border = { bottom: { style: "hair", color: { argb: RULE } } };
    }
    row.height = 18;
  });

  /*
    脚注。不是装饰 —— 见文件头那段：一份静默省掉「阻碍」和「风险」的类型表
    会让收到它的人以为这个系统只有代办和问题两类。
  */
  const foot = sheet.getRow(5 + rows.length + 1);
  foot.getCell(1).value =
    "「阻碍」和「风险」不在这张表里：它们是实体，不是分类 —— 事项分拣成阻碍会真的在那条活上建一段受阻（顺延排期、进复盘归因、上看板受阻列），分拣成风险会真的写进风险表。";
  foot.getCell(1).font = { size: 9, color: { argb: "FF64748B" } };
  foot.getCell(1).alignment = { wrapText: true, vertical: "top" };
  sheet.mergeCells(foot.number, 1, foot.number, 7);
  foot.height = 30;

  return wb;
}

export function itemKindsFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `事项类型-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}.xlsx`;
}

/** "#0ea5e9" → "FF0EA5E9"。Excel 要 ARGB，且不认 3 位简写 */
function toArgb(hex: string): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "FFFFFFFF";
  return `FF${h.toUpperCase()}`;
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
