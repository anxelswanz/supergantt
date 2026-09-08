/**
 * 导出的编排层：取数据 → 生成文件内容 → 让用户选路径 → 落盘。
 *
 * 内容全部在前端生成，Rust 只负责写字节（见 src-tauri/src/export.rs 的说明）。
 *
 * 两个出口，对应两种问法：
 *   · Excel   —— 按任务排的排期表，给人核计划用
 *   · 时间线  —— 按日期排的流水，给人看「那几天到底发生了什么」
 */

import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../db/api";
import { resolve } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";
import { buildTimelineHtml, timelineFileName } from "./timelineHtml";

export interface ExportResult {
  /** 用户取消保存对话框时为 null —— 这是正常路径，不是错误 */
  path: string | null;
}

export async function exportProjectToExcel(): Promise<ExportResult> {
  // exceljs 有 900KB，只在真的要导 Excel 时才拉进来 ——
  // 否则导一份 HTML 时间线也得先把它下载解析一遍
  const { buildWorkbook, safeFileName } = await import("./excel");

  const state = useAppStore.getState();
  const { project, tasks: taskMap, people, calendar, colorBy } = state;
  if (!project) throw new Error("没有打开的项目");

  // 折叠是看屏幕时的浏览状态，不是项目内容 —— 导出一律展开，
  // 否则发出去的文件会静默少掉一整棵子树（resolve() 会过滤掉折叠分支）
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

  // 先生成再弹对话框：生成失败时用户还没做任何选择，不会出现
  // 「选完路径才告诉你导不出来」
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
 * 时间线 → 单文件 HTML。
 *
 * 逐日记录这里重新从库里查一遍，不用 store 里那份：导出前刚 flush 过，
 * 库是当下唯一确定的口径；而风险本来就只有库里有。两边取同一个源头，
 * 导出件里不会出现「记录里提到的事，风险表里查无此项」。
 */
export async function exportTimelineToHtml(): Promise<ExportResult> {
  const state = useAppStore.getState();
  const { project, tasks: taskMap, people } = state;
  if (!project) throw new Error("没有打开的项目");

  // 同 Excel：折叠是浏览状态，不是内容 —— 导出一律展开
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
 * ArrayBuffer → base64。
 *
 * 必须分块：`String.fromCharCode(...bytes)` 在几十万字节上会把参数一次性铺到
 * 调用栈里，直接 RangeError。8KB 一块远低于任何引擎的参数上限。
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
