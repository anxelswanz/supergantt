// 导出的编排层：取数据 → 生成内容 → 选路径 → 落盘。内容全在前端生成，Rust 只负责写字节。

import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../db/api";
import { resolve } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";
import { buildTimelineHtml, timelineFileName } from "./timelineHtml";
import type { DayRange } from "../core/timeline";

export interface ExportResult {
  /** 用户取消保存对话框时为 null —— 这是正常路径，不是错误 */
  path: string | null;
}

export async function exportProjectToExcel(): Promise<ExportResult> {
  // exceljs 有 900KB，只在真要导 Excel 时才动态加载
  const { buildWorkbook, safeFileName } = await import("./excel");

  const state = useAppStore.getState();
  const { project, tasks: taskMap, people, calendar, colorBy } = state;
  if (!project) throw new Error("没有打开的项目");

  // 折叠是浏览状态不是内容，导出一律展开 —— resolve() 会过滤掉折叠分支
  const tasks = resolve(
    [...taskMap.values()].map((t) => ({ ...t, collapsed: false })),
  );

  const risks = await api.loadProjectRisks(project.id);
  const exportedAt = new Date();

  const workbook = buildWorkbook({
    projectName: project.name,
    projectColor: project.color,
    tasks,
    people,
    calendar,
    colorBy,
    risks,
    exportedAt,
  });

  // 先生成再弹对话框，避免用户选完路径才知道导不出来
  const buffer = await workbook.xlsx.writeBuffer();

  const path = await save({
    defaultPath: safeFileName(project.name, exportedAt),
    filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
  });
  if (!path) return { path: null };

  await api.writeExport(path, toBase64(buffer));
  return { path };
}

/**
 * 时间线 → 单文件 HTML。逐日记录与风险都现查库（导出前刚 flush），
 * 不用 store 里那份，保证导出件内部口径一致。
 */
export async function exportTimelineToHtml(
  /** 时间线上正筛着的那段日期；不筛就是 null，导出全部 */
  range: DayRange | null = null,
): Promise<ExportResult> {
  const state = useAppStore.getState();
  const { project, tasks: taskMap, people } = state;
  if (!project) throw new Error("没有打开的项目");

  // 同 Excel：导出一律展开
  const tasks = resolve(
    [...taskMap.values()].map((t) => ({ ...t, collapsed: false })),
  );

  const [risks, notes] = await Promise.all([
    api.loadProjectRisks(project.id),
    api.loadDailyNotes(project.id),
  ]);
  const exportedAt = new Date();

  const html = buildTimelineHtml({
    projectName: project.name,
    projectColor: project.color,
    tasks,
    notes,
    risks,
    people,
    exportedAt,
    range,
  });

  const path = await save({
    defaultPath: timelineFileName(project.name, exportedAt),
    filters: [{ name: "网页", extensions: ["html"] }],
  });
  if (!path) return { path: null };

  // 必须按 UTF-8 编码再转 base64：btoa 只认 Latin-1，中文会直接抛异常
  await api.writeExport(path, toBase64(new TextEncoder().encode(html)));
  return { path };
}

/**
 * ArrayBuffer → base64。必须分块：几十万字节一次性 spread 进
 * String.fromCharCode 会撑爆调用栈（RangeError）。
 */
function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 事项类型清单 → Excel。使用数只统计当前项目：item_kinds 是全局表、
 * item_notes 按项目分，范围写在列名和表头上（见 itemKinds.ts）。
 */
export async function exportItemKindsToExcel(): Promise<ExportResult> {
  const { buildItemKindsWorkbook, itemKindsFileName } = await import("./itemKinds");

  const { project, itemKinds, itemNotes } = useAppStore.getState();
  const exportedAt = new Date();

  const workbook = buildItemKindsWorkbook({
    // 没开项目也能导 —— 类型是全局的。那时使用数全是 0，表头写明范围
    projectName: project?.name ?? "（未打开项目，使用数不统计）",
    kinds: itemKinds,
    notes: project ? itemNotes : [],
    exportedAt,
  });

  // 先生成再弹对话框
  const buffer = await workbook.xlsx.writeBuffer();

  const path = await save({
    defaultPath: itemKindsFileName(exportedAt),
    filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
  });
  if (!path) return { path: null };

  await api.writeExport(path, toBase64(buffer));
  return { path };
}

/**
 * 事项清单 → Excel 或 Word。导出屏幕上那张清单（已筛选排序），
 * 行由调用方传入，这里不再筛一遍。
 */
export async function exportItems(
  format: "xlsx" | "docx",
  input: Omit<import("./items").ItemsExportInput, "projectName" | "exportedAt">,
): Promise<ExportResult> {
  // exceljs 和 docx 都在 items.ts 里，导出时才动态加载
  const { buildItemsWorkbook, buildItemsDocx, itemsFileName } = await import("./items");

  const { project } = useAppStore.getState();
  if (!project) throw new Error("没有打开的项目");
  const exportedAt = new Date();
  const full = { ...input, projectName: project.name, exportedAt };

  // 同另外几条路：先生成再弹对话框
  let bytes: ArrayBuffer;
  if (format === "xlsx") {
    bytes = (await buildItemsWorkbook(full).xlsx.writeBuffer()) as ArrayBuffer;
  } else {
    const { Packer } = await import("docx");
    bytes = await Packer.toArrayBuffer(buildItemsDocx(full));
  }

  const path = await save({
    defaultPath: itemsFileName(project.name, exportedAt, format),
    filters: [
      format === "xlsx"
        ? { name: "Excel 工作簿", extensions: ["xlsx"] }
        : { name: "Word 文档", extensions: ["docx"] },
    ],
  });
  if (!path) return { path: null };

  await api.writeExport(path, toBase64(bytes));
  return { path };
}

/**
 * AI 复盘文档 → Markdown 或 Word。内容由调用方传入，不从 store 取：
 * 用户可能正改到一半，导出的必须是他眼前那一版。
 */
export async function exportAiReview(
  format: "md" | "docx",
  input: { projectName: string; title: string; markdown: string },
): Promise<ExportResult> {
  const { buildReviewDocx, reviewFileName } = await import("./aiReview");
  const exportedAt = new Date();

  // 同另外几条路：先生成再弹对话框
  let bytes: ArrayBuffer | Uint8Array;
  if (format === "md") {
    bytes = new TextEncoder().encode(input.markdown);
  } else {
    const { Packer } = await import("docx");
    bytes = await Packer.toArrayBuffer(buildReviewDocx(input.title, input.markdown));
  }

  const path = await save({
    defaultPath: reviewFileName(input.projectName, input.title, exportedAt, format),
    filters: [
      format === "md"
        ? { name: "Markdown", extensions: ["md"] }
        : { name: "Word 文档", extensions: ["docx"] },
    ],
  });
  if (!path) return { path: null };

  await api.writeExport(path, toBase64(bytes));
  return { path };
}
