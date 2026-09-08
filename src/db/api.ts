/**
 * Rust 命令的类型化包装。
 *
 * 渲染层永远不写 SQL —— schema 只有 src-tauri/src/db.rs 一个知情方。
 * 这样加一列、改一次迁移，编译器会在这里报错，而不是等到运行时某条
 * 手写 SQL 静默地查不到字段。
 */

import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: number;
  /**
   * 跨机器的项目身份，见 migrations/007_project_identity.sql。
   *
   * `id` 只在本机这一个库里有意义，导出到 .ganttproj、在另一台电脑上导入
   * 之后就换了一个值；`uuid` 跟着项目本身走，导入时靠它认出「这是同一个
   * 项目的新版本」，哪怕它在那边被改过名。
   */
  uuid: string;
  name: string;
  color: string;
  /** JSON 数组字符串，如 "[1,2,3,4,5]"，0 = 周日 */
  workDays: string;
  holidays: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  project: Project;
  taskCount: number;
  startDate: string | null;
  endDate: string | null;
  leafCount: number;
  overdueCount: number;
  /** 叶子任务按工期加权后的整体进度 */
  progress: number;
}

/** 数据库里的任务行。日期是 ISO 字符串，转成天序号是渲染层的事。 */
export interface TaskRow {
  id: number;
  parentId: number | null;
  name: string;
  startDate: string;
  endDate: string;
  /** 实施起止；两端要么都为 null（还没动过），要么都有值 */
  actualStart: string | null;
  actualEnd: string | null;
  progress: number;
  priority: number;
  /** 指向 people 表；null 表示无负责人 */
  personId: number | null;
  milestone: boolean;
  weight: number | null;
  collapsed: boolean;
  pinned: boolean;
  note: string;
  sortOrder: number;
  /** 受阻时段的 JSON 数组，见 migrations/004_blocked.sql */
  blocked: string;
}

export interface Person {
  id: number;
  name: string;
  /** 头像底色，同时也是「按负责人着色」时甘特条的颜色 */
  color: string;
  /** base64 data URI；为 null 时回退到首字母头像 */
  avatar: string | null;
  sortOrder: number;
}

export interface Risk {
  id: number;
  taskId: number;
  content: string;
  /** 0 高 / 1 中 / 2 低 */
  level: number;
  resolved: boolean;
  /** Unix 秒 */
  createdAt: number;
  /** 关闭的时刻。null = 还开着，或是没有这一列的历史记录 */
  resolvedAt: number | null;
  /** 怎么关掉的。复盘时有价值的是这一句，不是那个勾 */
  resolution: string | null;
}

export interface Comment {
  id: number;
  taskId: number;
  content: string;
  createdAt: number;
}

export interface TaskNotes {
  risks: Risk[];
  comments: Comment[];
}

/**
 * 一条逐日记录。时间线视图的原子单位。
 *
 * `day` 和 `createdAt` 是两个不同的时间：前者是「说的是哪一天」（时间线按它排），
 * 后者是「什么时候写的」。周五补记周三的事，两者相差两天 —— 混成一个字段的话，
 * 时间线从第一天起就是错的（见 migrations/006_daily_notes.sql）。
 */
export interface DailyNote {
  id: number;
  projectId: number;
  /** null = 项目级的当天记录，不挂在任何一条任务上 */
  taskId: number | null;
  /** ISO 'YYYY-MM-DD' */
  day: string;
  content: string;
  /** Unix 秒 */
  createdAt: number;
  updatedAt: number;
}

export interface DependencyRow {
  id: number;
  fromTaskId: number;
  toTaskId: number;
  /** 第一版只产生 'FS'，schema 已支持四种 */
  kind: "FS" | "SS" | "FF" | "SF";
  lagDays: number;
}

export interface BaselineRow {
  id: number;
  name: string;
  createdAt: string;
}

export interface BaselineTaskRow {
  taskId: number;
  name: string;
  startDate: string;
  endDate: string;
  duration: number;
}

export interface ProjectData {
  project: Project;
  tasks: TaskRow[];
  dependencies: DependencyRow[];
  baselines: BaselineRow[];
  people: Person[];
  /** 全局下一个可用的任务 id —— 前端不能只看当前项目去猜 */
  nextTaskId: number;
}

export const api = {
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),

  createProject: (name: string, color: string) =>
    invoke<Project>("create_project", { name, color }),

  renameProject: (id: number, name: string, color: string) =>
    invoke<void>("rename_project", { id, name, color }),

  updateProjectCalendar: (id: number, workDays: string, holidays: string) =>
    invoke<void>("update_project_calendar", { id, workDays, holidays }),

  deleteProject: (id: number) => invoke<void>("delete_project", { id }),

  loadProject: (id: number) => invoke<ProjectData>("load_project", { id }),

  /**
   * 整项目事务性替换。调用方必须防抖 —— 见 persistence.ts。
   * 之所以不是增量写入，理由见 src-tauri/src/db.rs 的 save_project 注释。
   */
  saveProject: (id: number, tasks: TaskRow[], dependencies: DependencyRow[]) =>
    invoke<void>("save_project", { id, tasks, dependencies }),

  createBaseline: (projectId: number, name: string) =>
    invoke<BaselineRow>("create_baseline", { projectId, name }),

  loadBaseline: (baselineId: number) =>
    invoke<BaselineTaskRow[]>("load_baseline", { baselineId }),

  deleteBaseline: (baselineId: number) =>
    invoke<void>("delete_baseline", { baselineId }),

  listPeople: () => invoke<Person[]>("list_people"),

  createPerson: (name: string, color: string) =>
    invoke<Person>("create_person", { name, color }),

  /** avatar 传 undefined = 不改动，传 "" = 清除 */
  updatePerson: (id: number, name: string, color: string, avatar?: string) =>
    invoke<void>("update_person", { id, name, color, avatar }),

  deletePerson: (id: number) => invoke<void>("delete_person", { id }),

  countPersonTasks: (id: number) => invoke<number>("count_person_tasks", { id }),

  loadTaskNotes: (taskId: number) => invoke<TaskNotes>("load_task_notes", { taskId }),

  /**
   * [taskId, 未解决风险数][]。
   *
   * 角标现在不走它了 —— 全局风险清单本来就要查全项目明细，角标从同一份
   * 结果里算（store.refreshRisks），少一次往返，也不会出现「清单里三条、
   * 角标显示两条」的错位。留着这条是因为它是纯计数，将来做跨项目概览时
   * 不必为了一个数字把所有风险正文拉过来。
   */
  countOpenRisks: (projectId: number) =>
    invoke<[number, number][]>("count_open_risks", { projectId }),

  /**
   * 整个项目的风险点，一次查完 —— 导出用。
   * 库层已排好序（未解决在前 → 等级高在前 → 记录早在前），前端不再排。
   */
  loadProjectRisks: (projectId: number) =>
    invoke<Risk[]>("load_project_risks", { projectId }),

  loadDailyNotes: (projectId: number) =>
    invoke<DailyNote[]>("load_daily_notes", { projectId }),

  /** taskId 传 null 就是项目级的当天记录 */
  addDailyNote: (projectId: number, taskId: number | null, day: string, content: string) =>
    invoke<DailyNote>("add_daily_note", { projectId, taskId, day, content }),

  updateDailyNote: (id: number, day: string, content: string) =>
    invoke<void>("update_daily_note", { id, day, content }),

  deleteDailyNote: (id: number) => invoke<void>("delete_daily_note", { id }),

  addRisk: (taskId: number, content: string, level: number) =>
    invoke<Risk>("add_risk", { taskId, content, level }),

  /** 改措辞或等级。**不碰开关状态** —— 关闭必须走 resolveRisk */
  updateRisk: (id: number, content: string, level: number) =>
    invoke<void>("update_risk", { id, content, level }),

  /**
   * 关闭一条风险。返回关闭时刻（Unix 秒）。
   * 处置说明是必填的，库层也拦一道 —— 一旦允许空说明，它就会变成默认路径。
   */
  resolveRisk: (id: number, resolution: string) =>
    invoke<number>("resolve_risk", { id, resolution }),

  /** 重新打开：问题又回来了，或者上次那个「已解决」下早了 */
  reopenRisk: (id: number) => invoke<void>("reopen_risk", { id }),

  deleteRisk: (id: number) => invoke<void>("delete_risk", { id }),

  addComment: (taskId: number, content: string) =>
    invoke<Comment>("add_comment", { taskId, content }),

  deleteComment: (id: number) => invoke<void>("delete_comment", { id }),

  /** 结构性风险的体检报告；空数组表示没查出问题 */
  checkIntegrity: () => invoke<string[]>("check_integrity"),

  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),

  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  dataDir: () => invoke<string>("data_dir"),

  revealDataDir: () => invoke<void>("reveal_data_dir"),

  backupNow: () => invoke<string>("backup_now"),

  /**
   * 把导出好的文件写到 path。内容用 base64 传 ——
   * JSON 数字数组要 4 倍体积，raw IPC body 又装不下同一次调用里的 path。
   */
  writeExport: (path: string, base64: string) =>
    invoke<string>("write_export", { path, base64 }),

  /** 在访达 / 资源管理器里定位刚导出的文件 */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  /* ---------------- 项目文件（.ganttproj）---------------- */

  /**
   * 把一个项目导出成 .ganttproj。
   *
   * 和上面那个 writeExport 不是一回事：writeExport 是「前端拼好字节，Rust
   * 只管落盘」，服务于 Excel / 时间线 HTML 那种依赖渲染层的排版件。
   * 项目文件的数据全在库里，前端插不上手也不需要插手 —— 整件事在 Rust 侧
   * 完成，这里只传一个路径过去（见 src-tauri/src/transfer.rs）。
   */
  exportProjectFile: (projectId: number, path: string) =>
    invoke<string>("export_project", { projectId, path }),

  /** 读文件、校验、和本机项目对号，但一个字都不写库 */
  inspectImport: (path: string) => invoke<ImportPreview>("inspect_import", { path }),

  /**
   * 真正落库。文件会被重新读、重新校验一遍 —— 预检和确认之间隔着用户的
   * 思考时间，那期间文件可能被云盘换掉或者随 U 盘被拔走。
   *
   * `backupStamp` 由这边给：本机时区只有渲染层知道，Rust 的 std 拿不到，
   * 自己拼会拼出 UTC —— 下午两点做的备份文件名写着 06:02 没人看得懂。
   */
  commitImport: (
    path: string,
    targetId: number | null,
    name: string,
    backupStamp: string,
  ) => invoke<ImportOutcome>("commit_import", { path, targetId, name, backupStamp }),
};

/* ---------------- 项目文件相关的类型 ---------------- */

/** 预检对比表的一列：本机版和文件版各占一列，用同一个形状好并排渲染 */
export interface SideSummary {
  name: string;
  taskCount: number;
  peopleCount: number;
  riskCount: number;
  commentCount: number;
  dailyNoteCount: number;
  startDate: string | null;
  endDate: string | null;
  /** Unix 秒字符串 */
  updatedAt: string;
}

export interface ImportPreview {
  /** 非空 = 不能导入。全有或全无，有一条就一条都不写 */
  problems: string[];
  /** 能导入，但用户应该知道的事 */
  warnings: string[];
  file: SideSummary;
  /** 本机匹配到的项目；null = 全新项目 */
  existing: SideSummary | null;
  /** "uuid" | "name"，说明是怎么认出来的 */
  matchedBy: string | null;
  targetId: number | null;
  /** 覆盖会把本机项目改成这个名字；null = 名字没变 */
  renameTo: string | null;
  /** renameTo 撞上了本机另一个项目，用户必须当场改名 */
  nameConflict: boolean;
  suggestedName: string;
}

export interface ImportOutcome {
  projectId: number;
  name: string;
  overwritten: boolean;
  /** 覆盖前旧版被存到了哪里；「撤销」就是把它再导入一次 */
  backupPath: string | null;
  taskCount: number;
  newPeople: string[];
}
