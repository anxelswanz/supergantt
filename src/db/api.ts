/** Rust 命令的类型化包装。渲染层不写 SQL，schema 只有 src-tauri/src/db.rs 知道。 */

import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: number;
  /** 跨机器的项目身份：`id` 只在本库有效，导入时靠 uuid 认出同一项目。 */
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
  /** 受阻时段的 JSON 数组 */
  blocked: string;
  /** 实施逾期时自动顺延计划结束日 */
  autoRollover: boolean;
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
  /** 怎么关掉的 */
  resolution: string | null;
  /** P0–P3，和 `level`（严重度）是两个轴；null = 没填过，不伪造「中」 */
  priority: number | null;
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

/** 逐日记录。`day` 是说的哪天（时间线按它排），`createdAt` 是什么时候写的，补记时两者不同。 */
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

/** 一条事项（QuickNote）：不需要日期就能存在的记录。 */
export interface ItemNote {
  id: number;
  projectId: number;
  name: string;
  /** 类型 key（见 ItemKind）；null = 未分拣，不是「其他」 */
  kind: string | null;
  /** P0–P3，和任务的紧急度同一把刻度 */
  priority: number;
  personId: number | null;
  /** 关联的活。任务删掉后变 null，但这条记录留着（ON DELETE SET NULL） */
  taskId: number | null;
  /** 非 null = 已经分拣成一个真实实体 */
  promotedKind: "blocker" | "risk" | null;
  /** 阻碍 `"<taskId>/<periodId>"`，风险 `"<riskId>"`；可能悬挂（实体已删），属预期状态 */
  promotedRef: string | null;
  /** Unix 秒；null = 还开着（没有单独的 closed 布尔） */
  closedAt: number | null;
  resolution: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 事项类型，全局共用。阻碍和风险不在此表，由 promotedKind + promotedRef 表达。 */
export interface ItemKind {
  /** 'todo' | 'issue' | 'custom:<uuid>' */
  key: string;
  label: string;
  color: string;
  /** 关闭时是否必须写一句结论 */
  requiresNote: boolean;
  /** 内置行：可改名改色，不可删 */
  builtin: boolean;
  sortOrder: number;
}

/** 独立的里程碑，可挂多条任务；和 `TaskRow.milestone`（任务本身是节点）不是一回事。 */
export interface Milestone {
  id: number;
  projectId: number;
  name: string;
  /** ISO 'YYYY-MM-DD' */
  date: string;
  color: string;
  description: string;
  sortOrder: number;
  /** 关联的任务 id。空数组 = 没关联任何任务 */
  taskIds: number[];
  /** Unix 秒 */
  createdAt: number;
  updatedAt: number;
}

/** AI 复盘行。background/snapshot/questions 是 JSON 串，由 aiReview/types.ts 解析。 */
export interface AiReviewRow {
  id: number;
  projectId: number;
  title: string;
  /** 'ask1' | 'answer1' | 'ask2' | 'answer2' | 'write' | 'done' */
  stage: string;
  background: string;
  snapshot: string;
  questions: string;
  /** 生成的 Markdown，用户可以直接改 */
  document: string;
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

/** 插件子目录的文件原文，未校验 —— manifest.ts 要原文才能报出错误位置。 */
export interface RawPlugin {
  /** 目录名。插件身份就是它 —— manifest 里的 id 必须与之一致 */
  dir_name: string;
  path: string;
  /** manifest.json 原文；文件不存在时为 null */
  manifest_raw: string | null;
  /** 入口文件原文；读不出来时为 null */
  entry_raw: string | null;
  /** 与 manifest 同级的 styles.css，有就自动注入 */
  css_raw: string | null;
}

/** 随应用附带的插件。两份 manifest 都是原文，校验和版本比较在 TS 侧 */
export interface BundledPlugin {
  dir_name: string;
  manifest_raw: string | null;
  /** 已安装版本的 manifest；null = 还没装 */
  installed_manifest_raw: string | null;
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

  /** 整项目事务性替换，调用方必须防抖（persistence.ts）。 */
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

  /** [taskId, 未解决风险数][]。角标已改从 refreshRisks 结果算，这里留作纯计数接口。 */
  countOpenRisks: (projectId: number) =>
    invoke<[number, number][]>("count_open_risks", { projectId }),

  /** 整项目风险，库层已排序（未解决 → 等级高 → 记录早）。 */
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

  /** 改措辞或等级，不碰开关状态（关闭走 resolveRisk） */
  updateRisk: (id: number, content: string, level: number) =>
    invoke<void>("update_risk", { id, content, level }),

  /** 关闭风险，返回关闭时刻（Unix 秒）；处置说明必填，库层也拦。 */
  resolveRisk: (id: number, resolution: string) =>
    invoke<number>("resolve_risk", { id, resolution }),

  reopenRisk: (id: number) => invoke<void>("reopen_risk", { id }),

  deleteRisk: (id: number) => invoke<void>("delete_risk", { id }),

  /** 只改优先级；不走 updateRisk 是为了不回传正文、盖掉并发编辑。 */
  setRiskPriority: (id: number, priority: number | null) =>
    invoke<void>("set_risk_priority", { id, priority }),

  /* ---------------- 事项 ---------------- */

  /** 一个项目的全部事项，库层已按创建时间倒序排好 */
  loadItemNotes: (projectId: number) =>
    invoke<ItemNote[]>("load_item_notes", { projectId }),

  /** 记一条。不收类型，分拣是单独的动作 */
  addItemNote: (
    projectId: number,
    name: string,
    priority: number,
    personId: number | null,
    taskId: number | null,
  ) => invoke<ItemNote>("add_item_note", { projectId, name, priority, personId, taskId }),

  /** 改字段，不碰关闭状态和晋升去向；`kind` 传 null = 改回未分拣。 */
  updateItemNote: (
    id: number,
    name: string,
    kind: string | null,
    priority: number,
    personId: number | null,
    taskId: number | null,
  ) => invoke<void>("update_item_note", { id, name, kind, priority, personId, taskId }),

  /** 关闭。返回关闭时刻（Unix 秒）。库层按类型校验结论是否必填 */
  closeItemNote: (id: number, resolution: string | null) =>
    invoke<number>("close_item_note", { id, resolution }),

  reopenItemNote: (id: number) => invoke<void>("reopen_item_note", { id }),

  deleteItemNote: (id: number) => invoke<void>("delete_item_note", { id }),

  /** 分拣成风险：同一事务里建风险行并写回晋升去向。 */
  promoteNoteToRisk: (
    noteId: number,
    taskId: number,
    content: string,
    level: number,
    priority: number | null,
  ) => invoke<Risk>("promote_note_to_risk", { noteId, taskId, content, level, priority }),

  /** 分拣成阻碍：只记引用；阻碍实体在 tasks.blocked，由命令栈 + 整项目保存写出，不在本事务内。 */
  promoteNoteToBlocker: (noteId: number, promotedRef: string) =>
    invoke<void>("promote_note_to_blocker", { noteId, promotedRef }),

  /** 撤销分拣并删实体；返回原引用，调用方据此摘掉阻碍区间（风险已在库层删）。 */
  unpromoteNote: (noteId: number) =>
    invoke<string | null>("unpromote_note", { noteId }),

  listItemKinds: () => invoke<ItemKind[]>("list_item_kinds"),

  /** 新建或改一个类型。`builtin` 由库决定，这里传不了 */
  saveItemKind: (key: string, label: string, color: string, requiresNote: boolean) =>
    invoke<void>("save_item_kind", { key, label, color, requiresNote }),

  /** 删一个自定义类型。返回被退回「未分拣」的事项条数 */
  deleteItemKind: (key: string) => invoke<number>("delete_item_kind", { key }),

  addComment: (taskId: number, content: string) =>
    invoke<Comment>("add_comment", { taskId, content }),

  deleteComment: (id: number) => invoke<void>("delete_comment", { id }),

  /** 结构性风险的体检报告；空数组表示没查出问题 */
  checkIntegrity: () => invoke<string[]>("check_integrity"),

  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),

  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  /** 按前缀取一组设置。插件系统用它一次性读回全部 plugin.<id>.* */
  listSettingsWithPrefix: (prefix: string) =>
    invoke<[string, string][]>("list_settings_with_prefix", { prefix }),

  /* ---------------- 里程碑 ---------------- */

  /** 一个项目的全部里程碑，库层已按手动顺序排好 */
  loadMilestones: (projectId: number) =>
    invoke<Milestone[]>("load_milestones", { projectId }),

  addMilestone: (
    projectId: number,
    name: string,
    date: string,
    color: string,
    description: string,
    taskIds: number[],
  ) => invoke<Milestone>("add_milestone", { projectId, name, date, color, description, taskIds }),

  /** 改字段（名称、日期、颜色、说明、关联任务）。不碰排序 */
  updateMilestone: (
    id: number,
    name: string,
    date: string,
    color: string,
    description: string,
    taskIds: number[],
  ) => invoke<void>("update_milestone", { id, name, date, color, description, taskIds }),

  /** 只改排序。ids 是完整的目标顺序 */
  reorderMilestones: (projectId: number, ids: number[]) =>
    invoke<void>("reorder_milestones", { projectId, ids }),

  deleteMilestone: (id: number) => invoke<void>("delete_milestone", { id }),

  /* ---------------- AI 复盘 ---------------- */

  /** 一个项目的全部复盘，最近动过的在前。连快照和文档一起取 */
  listAiReviews: (projectId: number) =>
    invoke<AiReviewRow[]>("list_ai_reviews", { projectId }),

  /** 开始一次复盘。背景和快照在这一刻定下来，之后不再变 */
  createAiReview: (projectId: number, title: string, background: string, snapshot: string) =>
    invoke<AiReviewRow>("create_ai_review", { projectId, title, background, snapshot }),

  /** 存进度。**不碰背景和快照。** 返回新的 updatedAt（Unix 秒） */
  saveAiReview: (id: number, title: string, stage: string, questions: string, document: string) =>
    invoke<number>("save_ai_review", { id, title, stage, questions, document }),

  deleteAiReview: (id: number) => invoke<void>("delete_ai_review", { id }),

  /** 本机有没有装 claude */
  aiReviewAvailable: () => invoke<boolean>("ai_review_available"),

  /** 问 Claude 一次，返回 run id。程序与参数由 Rust 写死，这里只给提示词和 schema。 */
  aiReviewRun: (prompt: string, schema: string | null) =>
    invoke<number>("ai_review_run", { prompt, schema }),

  /* ---------------- 插件 ---------------- */

  /** 扫描插件目录。只读文件，不解析 —— 校验在 TS 侧（plugins/manifest.ts） */
  listPlugins: () => invoke<RawPlugin[]>("list_plugins"),

  /** 插件目录的绝对路径 */
  pluginsDir: () => invoke<string>("plugins_dir"),

  /** 在资源管理器 / 访达里打开插件目录 */
  revealPluginsDir: () => invoke<void>("reveal_plugins_dir"),

  /** 随应用附带、可以在设置里一键安装的插件 */
  listBundledPlugins: () => invoke<BundledPlugin[]>("list_bundled_plugins"),
  /** 安装或更新一个附带插件。更新时保留插件的 data/ */
  installBundledPlugin: (id: string) => invoke<void>("install_bundled_plugin", { id }),
  /** 删掉插件代码，保留 data/（重装后数据还在）。调用前先停用 */
  uninstallPlugin: (id: string) => invoke<void>("uninstall_plugin", { id }),

  /* 下面这些只给 plugins/registry.ts 用，插件拿到的是自动带 id 的包装版 */
  pluginStorageRead: (id: string, name: string) =>
    invoke<string | null>("plugin_storage_read", { id, name }),
  pluginStorageWrite: (id: string, name: string, content: string) =>
    invoke<void>("plugin_storage_write", { id, name, content }),
  pluginWhich: (program: string) => invoke<string | null>("plugin_which", { program }),
  pluginSpawn: (id: string, program: string, args: string[], stdin: string | null) =>
    invoke<number>("plugin_spawn", { id, program, args, stdin }),
  pluginKill: (runId: number) => invoke<void>("plugin_kill", { runId }),
  pluginLinkSkill: (id: string, dir: string, name: string) =>
    invoke<string>("plugin_link_skill", { id, dir, name }),
  pluginUnlinkSkill: (id: string, name: string) =>
    invoke<void>("plugin_unlink_skill", { id, name }),

  dataDir: () => invoke<string>("data_dir"),

  revealDataDir: () => invoke<void>("reveal_data_dir"),

  backupNow: () => invoke<string>("backup_now"),

  /** 内容用 base64 传：JSON 数字数组要 4 倍体积，raw IPC body 又带不了 path。 */
  writeExport: (path: string, base64: string) =>
    invoke<string>("write_export", { path, base64 }),

  /** 在访达 / 资源管理器里定位刚导出的文件 */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  /* ---------------- 项目文件（.ganttproj）---------------- */

  /** 导出 .ganttproj。数据全在库里，整件事在 Rust 侧完成，与前端拼字节的 writeExport 不同。 */
  exportProjectFile: (projectId: number, path: string) =>
    invoke<string>("export_project", { projectId, path }),

  /** 读文件、校验、和本机项目对号，但一个字都不写库 */
  inspectImport: (path: string) => invoke<ImportPreview>("inspect_import", { path }),

  /**
   * 落库时重新读文件重校验 —— 预检和确认之间文件可能被换掉。
   * `backupStamp` 由渲染层给：Rust 的 std 拿不到本机时区。
   */
  commitImport: (
    path: string,
    targetId: number | null,
    name: string,
    backupStamp: string,
  ) => invoke<ImportOutcome>("commit_import", { path, targetId, name, backupStamp }),

  /* ---------------- 整库（.db）---------------- */

  /** 整库导出成独立 .db，换机器时一次搬走全部项目。 */
  exportDatabase: (path: string) => invoke<string>("export_database", { path }),

  /** 读另一台电脑的 .db、校验、和本机项目逐个对号，但一个字都不写库 */
  inspectDbImport: (path: string) =>
    invoke<DbImportPreview>("inspect_db_import", { path }),

  /** 真正落库：先整库拍快照，再把所有项目放进同一个事务写入 */
  commitDbImport: (path: string, backupStamp: string) =>
    invoke<DbImportOutcome>("commit_db_import", { path, backupStamp }),

  /** 把导入前的快照恢复回来 */
  undoDbImport: (backupPath: string) => invoke<void>("undo_db_import", { backupPath }),
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

/* ---------------- 整库导入相关的类型 ---------------- */

/** 源库里一个项目的去向 */
export interface DbImportItem {
  file: SideSummary;
  /** 本机会被覆盖的那个项目；null = 新建 */
  existing: SideSummary | null;
  /** "uuid" | "name" */
  matchedBy: string | null;
  targetId: number | null;
  /** 落库后的名字。和 file.name 不同 = 原名被本机另一个项目占着 */
  finalName: string;
}

export interface DbImportPreview {
  /** 非空 = 不能导入。全有或全无，有一条就一个项目都不写 */
  problems: string[];
  warnings: string[];
  projects: DbImportItem[];
  /** 没有任何项目用到、本机也还没有的负责人，会一并带过来 */
  extraPeople: string[];
}

export interface DbImportOutcome {
  created: number;
  overwritten: number;
  newPeople: string[];
  /** 导入前本机整库的快照；「撤销」就是把它恢复回来 */
  backupPath: string;
}
