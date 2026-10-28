/**
 * 项目文件（.ganttproj）前端编排：挑路径、记住上次目录、把路径交给 Rust。
 * 数据不经过这里，Rust 直接读库写 zip（见 src-tauri/src/transfer.rs）。
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  type DbImportOutcome,
  type DbImportPreview,
  type ImportOutcome,
  type ImportPreview,
} from "../db/api";

export const PROJECT_FILE_EXT = "ganttproj";
export const PROJECT_FILE_FILTER = {
  name: "Gantt 项目文件",
  extensions: [PROJECT_FILE_EXT],
};

/** 整库文件（.db）：导出的库、backups/ 里的自动备份或直接拷的 gantt.db，同一种 SQLite 文件。 */
export const DATABASE_FILE_EXT = "db";
export const DATABASE_FILE_FILTER = {
  name: "Gantt 数据库",
  extensions: [DATABASE_FILE_EXT],
};

/** 上次导出目录。存 settings 表而非靠系统对话框记忆：那份是全局的，会被导 Excel 等冲掉。 */
const LAST_DIR_KEY = "transfer.lastDir";

/** 路径里最后一个分隔符之前的部分。Windows 用 \，其他平台用 /。 */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${dir.endsWith(sep) ? "" : sep}${name}`;
}

export function projectFileName(projectName: string, at: Date): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${stem.slice(0, 60)}-${stamp}.${PROJECT_FILE_EXT}`;
}

/** 「覆盖前」备份的时间戳，本机时区。必须前端算：Rust std 拿不到时区，只能拼出 UTC。 */
export function backupStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`
  );
}

export interface ExportResult {
  /** 用户取消保存对话框时为 null —— 正常路径，不是错误 */
  path: string | null;
}

export async function exportProjectFile(
  projectId: number,
  projectName: string,
): Promise<ExportResult> {
  const lastDir = (await api.getSetting(LAST_DIR_KEY)) ?? "";
  const suggested = projectFileName(projectName, new Date());

  const path = await save({
    defaultPath: joinPath(lastDir, suggested),
    filters: [PROJECT_FILE_FILTER],
  });
  if (!path) return { path: null };

  const written = await api.exportProjectFile(projectId, path);
  // 记住目录而不是整个路径：下次导的多半是另一个项目，文件名得重新生成
  const dir = dirOf(written);
  if (dir && dir !== lastDir) await api.setSetting(LAST_DIR_KEY, dir);
  return { path: written };
}

/**
 * 弹文件选择框，.ganttproj 和 .db 都能选，null = 取消。
 * 第一个过滤器同时认两种扩展名：Windows 对话框默认只显示第一个过滤器匹配的文件。
 */
export async function pickProjectFile(): Promise<string | null> {
  const lastDir = (await api.getSetting(LAST_DIR_KEY)) ?? undefined;
  const picked = await open({
    multiple: false,
    directory: false,
    defaultPath: lastDir,
    filters: [
      { name: "Gantt 项目文件或数据库", extensions: [PROJECT_FILE_EXT, DATABASE_FILE_EXT] },
      PROJECT_FILE_FILTER,
      DATABASE_FILE_FILTER,
    ],
  });
  return typeof picked === "string" ? picked : null;
}

export function isProjectFile(path: string): boolean {
  return path.toLowerCase().endsWith(`.${PROJECT_FILE_EXT}`);
}

export function isDatabaseFile(path: string): boolean {
  return path.toLowerCase().endsWith(`.${DATABASE_FILE_EXT}`);
}

/** 拖进窗口、或者从对话框里选中的，是不是这个软件能导入的东西 */
export function isImportable(path: string): boolean {
  return isProjectFile(path) || isDatabaseFile(path);
}

/** 整库文件的默认名，带日期。 */
export function databaseFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Gantt-数据库-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}.${DATABASE_FILE_EXT}`;
}

/** 导出整个库，和导出项目文件共用「上次的目录」。 */
export async function exportDatabaseFile(): Promise<ExportResult> {
  const lastDir = (await api.getSetting(LAST_DIR_KEY)) ?? "";
  const path = await save({
    defaultPath: joinPath(lastDir, databaseFileName(new Date())),
    filters: [DATABASE_FILE_FILTER],
  });
  if (!path) return { path: null };

  const written = await api.exportDatabase(path);
  const dir = dirOf(written);
  if (dir && dir !== lastDir) await api.setSetting(LAST_DIR_KEY, dir);
  return { path: written };
}

export function inspectDatabase(path: string): Promise<DbImportPreview> {
  return api.inspectDbImport(path);
}

export function commitDatabase(path: string): Promise<DbImportOutcome> {
  return api.commitDbImport(path, backupStamp(new Date()));
}

export function inspect(path: string): Promise<ImportPreview> {
  return api.inspectImport(path);
}

export function commit(
  path: string,
  targetId: number | null,
  name: string,
): Promise<ImportOutcome> {
  return api.commitImport(path, targetId, name, backupStamp(new Date()));
}

/**
 * 监听「把文件拖进窗口」，返回取消订阅函数。
 * 拿不到 webview 句柄（如测试环境）时静默不做，不能让项目列表白屏。
 */
export function onProjectFileDrop(handlers: {
  onHover: (active: boolean) => void;
  onDrop: (path: string) => void;
}): () => void {
  let cancelled = false;
  let stop: (() => void) | undefined;

  try {
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") handlers.onHover(true);
        else if (p.type === "drop") {
          handlers.onHover(false);
          // 认第一个能导入的；都不能就交第一个上去，让用户看到报错而不是没反应
          const file = p.paths.find(isImportable) ?? p.paths[0];
          if (file) handlers.onDrop(file);
        } else handlers.onHover(false);
      })
      .then(
        (un) => {
          if (cancelled) un();
          else stop = un;
        },
        () => {},
      );
  } catch {
    /* 宿主不支持拖拽事件，按钮那条路还在 */
  }

  return () => {
    cancelled = true;
    stop?.();
  };
}
