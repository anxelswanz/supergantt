/**
 * 项目文件（.ganttproj）在前端这一侧的编排。
 *
 * 只做三件事：挑路径、记住上次挑的目录、把路径交给 Rust。数据本身一个字节
 * 都不经过这里 —— 它全在库里，Rust 直接读、直接写 zip（见 src-tauri/src/transfer.rs）。
 *
 * 和 export/run.ts 的分工：
 *   · run.ts    —— Excel / 时间线 HTML，**给人看**的排版件，依赖着色器和汇总
 *                  结果这些只有渲染层才有的东西，所以内容必须在前端生成
 *   · 这个文件  —— .ganttproj，**给这个软件看**的全保真数据，能原样导回来
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

/**
 * 整库文件（.db）：另一台电脑上 Gantt 的全部数据。
 *
 * 可以是那边「设置 → 数据 → 导出数据库」导出的文件，也可以是它 backups/
 * 里的自动备份，或者直接拷过来的 gantt.db —— 三者都是同一种 SQLite 文件，
 * 而 SQLite 的格式不分 Mac 和 Windows。
 */
export const DATABASE_FILE_EXT = "db";
export const DATABASE_FILE_FILTER = {
  name: "Gantt 数据库",
  extensions: [DATABASE_FILE_EXT],
};

/**
 * 上次导出到哪个目录。
 *
 * 存在 settings 表而不是靠系统对话框自己的记忆：系统那份是全局的，会被
 * 导 Excel、导时间线的操作冲掉。而项目文件的去处通常是固定的一个云盘目录，
 * 每次重新翻过去是这个功能最烦人的地方 —— 而且它每次都烦。
 */
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

/** 和 Excel / 时间线导出同一套命名规矩，只换扩展名。 */
export function projectFileName(projectName: string, at: Date): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${stem.slice(0, 60)}-${stamp}.${PROJECT_FILE_EXT}`;
}

/**
 * 「覆盖前」备份的时间戳，本机时区。
 *
 * 必须由前端算：Rust 那边的 std 拿不到时区，自己拼出来的是 UTC ——
 * 下午两点做的备份，文件名写着 0602，用户根本认不出这是刚才那一份。
 */
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
 * 弹文件选择框，.ganttproj 和 .db 都能选。返回 null = 用户取消了。
 *
 * 第一个过滤器同时认两种扩展名：Windows 的对话框默认只显示第一个过滤器
 * 匹配的文件，只放 .ganttproj 的话，用户拷过来的 .db 在对话框里是隐形的。
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

/** 整库文件的默认名。带日期：云盘里放几份不同时间的库时，不用点开就分得清。 */
export function databaseFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Gantt-数据库-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}.${DATABASE_FILE_EXT}`;
}

/**
 * 导出整个库。和导出项目文件共用「上次的目录」—— 两者去的通常是同一个
 * 云盘或 U 盘目录，都是为了拿到另一台电脑上去。
 */
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
 * 监听「把文件拖进窗口」。返回取消订阅的函数。
 *
 * 整段裹在守卫里：这是个纯粹的便利功能，拿不到 webview 句柄（测试环境、
 * 或者将来某个跑在别处的宿主）时应该安静地什么都不做 —— 项目列表不能
 * 因为一个锦上添花的监听器注册失败就整屏白掉。按钮那条路始终是通的。
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
          // 拖一把文件进来时认第一个能导入的；一个都没有就把第一个交上去，
          // 好让用户看到「你拖的东西不对」而不是什么都没发生
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
