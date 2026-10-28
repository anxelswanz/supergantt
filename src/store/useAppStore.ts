import { create } from "zustand";
import { CommandStack } from "../core/commandStack";
import { makeCommand, type Command, type Edit, type TaskMap } from "../core/edits";
import {
  api,
  type DependencyRow,
  type Person,
  type Project,
  type ProjectSummary,
} from "../db/api";
import { rowToTask } from "../db/convert";
import { installFlushGuards, Persistence } from "../db/persistence";
import type { Task } from "../gantt/model";
import { WorkCalendar } from "../core/calendar";
import type { ColorBy } from "../gantt/coloring";
import { ROW_HEIGHTS, type RowHeightKey } from "../gantt/theme";
import {
  applyThemeMode,
  readStoredThemeMode,
  readSystemDark,
  storeThemeMode,
  type ThemeMode,
} from "../core/themeMode";
import {
  closeBlocked,
  extendOpenBlocks,
  fitBlocked,
  reclamp,
  type BlockedPeriod,
  type BlockReason,
} from "../core/blocked";
import { rolloverOverdue } from "../core/rollover";
import { canRecordBlocker, openBlockerOn } from "../core/board";
import { riskFlags, type RiskFlag } from "../core/risks";
import type { Span, ViewMode } from "../core/viewMode";
import {
  DEFAULT_ENABLED,
  isViewKey,
  parseEnabledViews,
  parseViewOrder,
  serializeEnabledViews,
  toggleView,
  type AppView,
  type BuiltinView,
} from "../core/views";
import { BUILTIN_KINDS, blockerRef, parseBlockerRef, parseItemOrder } from "../core/items";
import type { DailyNote, ItemKind, ItemNote, Risk, Milestone } from "../db/api";

/** 一条待写入的逐日记录。带 id = 改已有的那条；不带 = 新写 */
export interface NoteDraft {
  id?: number;
  taskId: number | null;
  /** 天序号。落库时才转成 ISO */
  day: number;
  content?: string;
}
import { today } from "../gantt/time";

/**
 * tasks 是就地修改的 Map（拖拽每帧都改），React 靠 `revision` 感知变化。
 * 只许经由命令栈修改 tasks，否则撤销/落库会漏。
 */

export type Screen = { name: "list" } | { name: "workspace"; projectId: number };

/** 拖放落点：目标行的上缘 / 中间 / 下缘 */
export type DropPosition = "before" | "inside" | "after";

interface AppState {
  screen: Screen;
  projects: ProjectSummary[];
  loadingProjects: boolean;

  project: Project | null;
  calendar: WorkCalendar;
  tasks: TaskMap;
  dependencies: DependencyRow[];
  revision: number;

  stack: CommandStack | null;
  persistence: Persistence | null;
  detachGuards: (() => void) | null;

  /** 视图偏好：存全局 settings，不进撤销栈，不随项目走（以下几项同） */
  colorBy: ColorBy;
  rowHeightKey: RowHeightKey;

  /** 存 localStorage 而非 settings 表，否则启动会先画一帧错的主题 */
  themeMode: ThemeMode;

  /** 始终维护，只由 App 的 matchMedia 监听写入 */
  systemDark: boolean;

  activeView: AppView;

  /** 甘特永远在里面。插件视图不归它管 */
  enabledViews: BuiltinView[];

  /** 完整 key 列表（含插件视图）；空 = 默认顺序 */
  viewOrder: string[];

  /** 只对甘特视图有意义 */
  viewMode: ViewMode;
  /** 实施侧是否叠加显示计划条 */
  compareOn: boolean;

  /** 全局共享，不按项目隔离；不进撤销栈 */
  people: Person[];

  /** 放在 store 是因为快捷键在 window 上监听 */
  selectedId: number | null;

  detailId: number | null;

  /** 新建后自动进入重命名的那一行（双击已被「打开详情」占用） */
  pendingEditId: number | null;

  /** taskId → 未关闭风险的条数 + 最高一档，角标按等级上色 */
  openRisks: Map<number, RiskFlag>;

  /** 风险、逐日记录、事项、里程碑都即写即存，不进命令栈 */
  projectRisks: Risk[];

  /** 两个入口（时间线「记一笔」/ 甘特右键某天），所以放 store */
  noteDraft: NoteDraft | null;

  dailyNotes: DailyNote[];

  /** 库层已按创建时间倒序排好 */
  itemNotes: ItemNote[];

  /**
   * 事项清单的手动顺序：行 key（`note:1` / `blocker:12/b1` / `risk:3`）；空 = 时间倒序。
   * 行来自三张表，所以存 key 而不是 sort_order 列；按项目存 settings。
   */
  itemOrder: string[];

  /** 库层已按手动顺序排好 */
  milestones: Milestone[];

  /** 全局表。初值用常量，否则首帧类型标签显示成裸 key */
  itemKinds: ItemKind[];

  /** `Ctrl+K` 弹窗；全局快捷键和事项视图「＋」两个入口 */
  quickNoteOpen: boolean;

  /** 录入弹窗 ⌘↵ 后要给哪一行弹分拣菜单（一次性信号） */
  pendingSortNoteId: number | null;

  /** null = 关着，字符串 = 开在那一页。分拣菜单「新建类型…」要直达设置 */
  settingsTab: string | null;

  /** 全库下一个可用的任务 id，见 nextId */
  nextTaskId: number;
  saving: boolean;
  saveError: unknown;

  openDetail: (id: number | null) => void;
  consumePendingEdit: () => void;
  /** 任何风险的增删改之后都要调，同时重算角标 */
  refreshRisks: () => Promise<void>;
  addRisk: (taskId: number, content: string, level: number) => Promise<void>;
  /** 必须带处置说明 */
  resolveRisk: (id: number, resolution: string) => Promise<void>;
  reopenRisk: (id: number) => Promise<void>;
  removeRisk: (id: number) => Promise<void>;
  loadSettings: () => Promise<void>;
  loadPeople: () => Promise<void>;
  addPerson: (name: string) => Promise<void>;
  savePerson: (id: number, name: string, color: string, avatar?: string) => Promise<void>;
  removePerson: (id: number) => Promise<void>;
  assignPerson: (taskId: number, personId: number | null) => void;
  setPriority: (taskId: number, priority: 0 | 1 | 2 | 3) => void;
  addBlocked: (taskId: number, period: BlockedPeriod) => void;
  /** 默认未关闭、从今天起算；`span` / `live` 给补记用 */
  addBlocker: (
    taskId: number,
    reason: BlockReason,
    note?: string,
    span?: { from: number; to: number },
    live?: boolean,
  ) => void;
  closeBlocker: (taskId: number, periodId: string) => void;
  /** 跨天顺延，不进撤销栈（CommandStack.applySystem） */
  extendOpenBlockers: () => void;
  updateBlocked: (taskId: number, period: BlockedPeriod) => void;
  removeBlocked: (taskId: number, periodId: string) => void;
  setColorBy: (mode: ColorBy) => void;
  setRowHeight: (key: RowHeightKey) => void;
  setThemeMode: (mode: ThemeMode) => void;
  /** 只有 App 的 matchMedia 监听调它 */
  setSystemDark: (systemDark: boolean) => void;
  setNoteDraft: (draft: NoteDraft | null) => void;
  /** 切到时间线并准备好草稿 */
  startNoteAt: (taskId: number | null, day: number) => void;
  loadDailyNotes: () => Promise<void>;
  addDailyNote: (taskId: number | null, day: string, content: string) => Promise<void>;
  editDailyNote: (id: number, day: string, content: string) => Promise<void>;
  removeDailyNote: (id: number) => Promise<void>;
  setActiveView: (view: AppView) => void;
  setViewEnabled: (view: BuiltinView, on: boolean) => void;
  /** 空数组 = 恢复默认 */
  setViewOrder: (order: string[]) => void;

  /* ---------------- 事项 ---------------- */

  setQuickNoteOpen: (open: boolean) => void;
  setPendingSortNote: (id: number | null) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  loadItemNotes: () => Promise<void>;
  /** 空数组 = 恢复时间倒序 */
  setItemOrder: (order: string[]) => void;
  loadItemKinds: () => Promise<void>;
  /** 返回新建的那条，录入弹窗据此判断成没成 */
  addItemNote: (
    name: string,
    priority: 0 | 1 | 2 | 3,
    personId: number | null,
    taskId: number | null,
  ) => Promise<ItemNote | null>;
  /** 不碰关闭状态和晋升去向，那两件事各有入口 */
  patchItemNote: (id: number, changes: Partial<ItemNote>) => Promise<void>;
  /** 库层按类型校验结论是否必填 */
  closeItemNote: (id: number, resolution: string | null) => Promise<void>;
  reopenItemNote: (id: number) => Promise<void>;
  removeItemNote: (id: number) => Promise<void>;
  promoteToBlocker: (
    noteId: number,
    taskId: number,
    reason: BlockReason,
    note?: string,
  ) => Promise<void>;
  promoteToRisk: (noteId: number, taskId: number, level: number) => Promise<void>;
  /** 删掉实体，事项退回「未分拣」 */
  unpromoteNote: (noteId: number) => Promise<void>;
  /** 把阻碍 / 风险收回成事项，返回事项 id。分拣来的走 unpromoteNote，否则新建一条再删实体 */
  reclaimToNote: (args: {
    source: "blocker" | "risk";
    /** 来源事项；null = 这条实体不是分拣来的 */
    noteId: number | null;
    taskId: number | null;
    periodId?: string;
    riskId?: number;
    content: string;
    priority: 0 | 1 | 2 | 3 | null;
  }) => Promise<number | null>;
  saveItemKind: (
    key: string,
    label: string,
    color: string,
    requiresNote: boolean,
  ) => Promise<void>;
  /** 返回被退回「未分拣」的事项条数 */
  removeItemKind: (key: string) => Promise<number>;
  setRiskPriority: (id: number, priority: 0 | 1 | 2 | 3 | null) => Promise<void>;

  /* ---------------- 里程碑 ---------------- */

  loadMilestones: () => Promise<void>;
  /** 失败返回 null */
  addMilestone: (
    name: string,
    date: string,
    color: string,
    description: string,
    taskIds: number[],
  ) => Promise<Milestone | null>;
  /** 不碰排序 */
  patchMilestone: (
    id: number,
    changes: {
      name?: string;
      date?: string;
      color?: string;
      description?: string;
      taskIds?: number[];
    },
  ) => Promise<void>;
  /** ids 是完整的目标顺序 */
  reorderMilestones: (ids: number[]) => Promise<void>;
  removeMilestone: (id: number) => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setCompareOn: (on: boolean) => void;
  setActualSpan: (taskId: number, span: Span | null, label?: string) => void;
  adoptPlanDates: (taskId: number) => void;
  moveTask: (id: number, delta: -1 | 1) => void;
  reparentTask: (id: number, targetId: number, position: DropPosition) => void;
  canDrop: (id: number, targetId: number, position: DropPosition) => boolean;
  loadProjects: () => Promise<void>;
  createProject: (name: string, color: string) => Promise<number>;
  setCalendar: (calendar: WorkCalendar) => void;
  deleteProject: (id: number) => Promise<void>;
  openProject: (id: number) => Promise<void>;
  closeProject: () => Promise<void>;

  run: (command: Command | null) => void;
  runMerge: (command: Command | null) => void;
  undo: () => void;
  redo: () => void;

  select: (id: number | null) => void;
  addTaskAfter: (siblingId: number | null) => void;
  addSubtask: (parentId: number) => void;
  deleteTask: (id: number) => void;
  indentTask: (id: number) => void;
  outdentTask: (id: number) => void;
  toggleCollapse: (id: number) => void;
  patchTask: (id: number, changes: Partial<Task>, label: string) => void;
}

export const PROJECT_COLORS = [
  "#2f6d5e",
  "#1f5f74",
  "#35705c",
  "#b0752a",
  "#a83e3e",
  "#5a5490",
];

const COLOR_BY_KEY = "bar_color_by";
const ROW_HEIGHT_KEY = "row_height";
const VIEW_MODE_KEY = "view_mode";
const ACTIVE_VIEW_KEY = "active_view";
const ENABLED_VIEWS_KEY = "enabled_views";
const VIEW_ORDER_KEY = "view_order";
const itemOrderKey = (projectId: number) => `items_order.${projectId}`;

export const useAppStore = create<AppState>((set, get) => {
  /** tasks.id 是全库主键，基准必须用 load_project 给的全库最大 id，否则 upsert 会改写别的项目的行 */
  const nextId = () => {
    const base = get().nextTaskId;
    let max = base - 1;
    for (const id of get().tasks.keys()) max = Math.max(max, id);
    const id = max + 1;
    set({ nextTaskId: id + 1 });
    return id;
  };

  const bump = () =>
    set((s) => ({
      revision: s.revision + 1,
      saving: s.persistence?.hasUnsaved ?? false,
      saveError: s.persistence?.lastError ?? null,
    }));

  /** 排序必须与 resolve() 的展平顺序一致 */
  const siblingsOf = (parentId: number | null): Task[] =>
    [...get().tasks.values()]
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  /** 取前后兄弟的中点，只改一行。同一处连续对半约 50 次才会耗尽 double 精度 */
  const orderAfter = (parentId: number | null, afterId: number | null): number => {
    const siblings = siblingsOf(parentId);
    if (siblings.length === 0) return 0;

    const index = afterId == null ? -1 : siblings.findIndex((t) => t.id === afterId);
    if (index < 0) return siblings[siblings.length - 1].sortOrder + 1;
    if (index === siblings.length - 1) return siblings[index].sortOrder + 1;
    return (siblings[index].sortOrder + siblings[index + 1].sortOrder) / 2;
  };

  /** 日期与负责人继承参照任务，连按 Enter 时只需改名字 */
  const draftTask = (
    id: number,
    parentId: number | null,
    sortOrder: number,
    like: Task | null,
  ): Task => {
    const start = like ? like.startDay : today();
    const duration = like ? like.endDay - like.startDay + 1 : 3;
    return {
      id,
      parentId,
      name: "",
      startDay: start,
      endDay: start + duration - 1,
      progress: 0,
      priority: 2,
      personId: like?.personId ?? null,
      milestone: false,
      weight: null,
      collapsed: false,
      pinned: false,
      sortOrder,
      blocked: [],
      autoRollover: false,
      actualStartDay: null,
      actualEndDay: null,
    };
  };

  return {
    screen: { name: "list" },
    projects: [],
    loadingProjects: false,

    project: null,
    calendar: WorkCalendar.default(),
    tasks: new Map(),
    dependencies: [],
    revision: 0,

    stack: null,
    persistence: null,
    detachGuards: null,

    colorBy: "stage",
    rowHeightKey: "normal",
    themeMode: readStoredThemeMode(),
    // 模块加载时就执行，测试的 matchMedia 桩还没装上，所以不能直接调 matchMedia
    systemDark: readSystemDark(),
    activeView: "gantt",
    enabledViews: [...DEFAULT_ENABLED],
    viewOrder: [],
    viewMode: "plan",
    compareOn: false,
    people: [],
    selectedId: null,
    detailId: null,
    pendingEditId: null,
    openRisks: new Map(),
    projectRisks: [],
    dailyNotes: [],
    itemNotes: [],
    itemOrder: [],
    milestones: [],
    itemKinds: BUILTIN_KINDS,
    quickNoteOpen: false,
    pendingSortNoteId: null,
    settingsTab: null,
    noteDraft: null,
    nextTaskId: 1,
    saving: false,
    saveError: null,

    async loadSettings() {
      const [color, row, view, active, enabled, order] = await Promise.all([
        api.getSetting(COLOR_BY_KEY).catch(() => null),
        api.getSetting(ROW_HEIGHT_KEY).catch(() => null),
        api.getSetting(VIEW_MODE_KEY).catch(() => null),
        api.getSetting(ACTIVE_VIEW_KEY).catch(() => null),
        api.getSetting(ENABLED_VIEWS_KEY).catch(() => null),
        api.getSetting(VIEW_ORDER_KEY).catch(() => null),
      ]);
      if (color && ["stage", "assignee", "priority", "none"].includes(color)) {
        set({ colorBy: color as ColorBy });
      }
      if (row && row in ROW_HEIGHTS) set({ rowHeightKey: row as RowHeightKey });
      if (view === "plan" || view === "actual") set({ viewMode: view });
      set({ enabledViews: parseEnabledViews(enabled) });
      set({ viewOrder: parseViewOrder(order) });
      // 只挡格式不合法的；插件已删 / 视图已关的 key 由 Workspace 查注册表后回退到甘特
      if (isViewKey(active)) set({ activeView: active });
    },

    setColorBy(mode) {
      set({ colorBy: mode });
      void api.setSetting(COLOR_BY_KEY, mode).catch(() => {});
    },

    setRowHeight(key) {
      set({ rowHeightKey: key });
      void api.setSetting(ROW_HEIGHT_KEY, key).catch(() => {});
    },

    setThemeMode(mode) {
      set({ themeMode: mode });
      storeThemeMode(mode);
      // 必须同步写 DOM，不能等 React 重渲染：Canvas 和 DOM 要同一帧换色
      applyThemeMode(mode, get().systemDark);
    },

    setSystemDark(systemDark) {
      // 只有「跟随系统」才落到 DOM
      set((s) => {
        if (s.themeMode === "system") applyThemeMode("system", systemDark);
        return { systemDark };
      });
    },

    setNoteDraft(draft) {
      set({ noteDraft: draft });
    },

    startNoteAt(taskId, day) {
      set({ activeView: "timeline", noteDraft: { taskId, day } });
      void api.setSetting(ACTIVE_VIEW_KEY, "timeline").catch(() => {});
    },

    async loadDailyNotes() {
      const { project } = get();
      if (!project) return set({ dailyNotes: [] });
      try {
        set({ dailyNotes: await api.loadDailyNotes(project.id) });
      } catch {
        set({ dailyNotes: [] });
      }
    },

    async addDailyNote(taskId, day, content) {
      const { project } = get();
      if (!project || !content.trim()) return;
      const note = await api.addDailyNote(project.id, taskId, day, content);
      // 保持库里的 day 正序
      set({
        dailyNotes: [...get().dailyNotes, note].sort(
          (a, b) => a.day.localeCompare(b.day) || a.id - b.id,
        ),
      });
    },

    async editDailyNote(id, day, content) {
      if (!content.trim()) return;
      await api.updateDailyNote(id, day, content);
      set({
        dailyNotes: get()
          .dailyNotes.map((n) => (n.id === id ? { ...n, day, content } : n))
          .sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id),
      });
    },

    async removeDailyNote(id) {
      await api.deleteDailyNote(id);
      set({ dailyNotes: get().dailyNotes.filter((n) => n.id !== id) });
    },

    setActiveView(view) {
      set({ activeView: view });
      void api.setSetting(ACTIVE_VIEW_KEY, view).catch(() => {});
    },

    /** 关掉正在看的视图时同时切回甘特 */
    setViewEnabled(view, on) {
      const next = toggleView(get().enabledViews, view, on);
      set({ enabledViews: next });
      void api.setSetting(ENABLED_VIEWS_KEY, serializeEnabledViews(next)).catch(() => {});
      if (!on && get().activeView === view) get().setActiveView("gantt");
    },

    setViewOrder(order) {
      set({ viewOrder: order });
      void api.setSetting(VIEW_ORDER_KEY, order.length ? JSON.stringify(order) : "").catch(() => {});
    },

    /* ---------------- 事项 ---------------- */

    setQuickNoteOpen(open) {
      set({ quickNoteOpen: open });
    },

    setPendingSortNote(id) {
      set({ pendingSortNoteId: id });
    },

    openSettings(tab = "appearance") {
      set({ settingsTab: tab });
    },

    closeSettings() {
      set({ settingsTab: null });
    },

    async loadItemNotes() {
      const { project } = get();
      if (!project) return set({ itemNotes: [], itemOrder: [] });
      const [notes, order] = await Promise.all([
        api.loadItemNotes(project.id).catch(() => [] as ItemNote[]),
        api.getSetting(itemOrderKey(project.id)).catch(() => null),
      ]);
      set({ itemNotes: notes, itemOrder: parseItemOrder(order) });
    },

    setItemOrder(order) {
      const { project } = get();
      set({ itemOrder: order });
      if (!project) return;
      void api
        .setSetting(itemOrderKey(project.id), order.length ? JSON.stringify(order) : "")
        .catch(() => {});
    },

    async loadItemKinds() {
      try {
        const kinds = await api.listItemKinds();
        // 库里必有内置两类（ensure_builtin_kinds），空结果说明读失败，保留常量兜底
        if (Array.isArray(kinds) && kinds.length > 0) set({ itemKinds: kinds });
      } catch {
        set({ itemKinds: BUILTIN_KINDS });
      }
    },

    /* ---------------- 里程碑 ---------------- */

    async loadMilestones() {
      const { project } = get();
      if (!project) return set({ milestones: [] });
      // invoke 可能正常返回 null（catch 不触发），而 GanttView 会直接 flatMap 结果
      const rows = await api.loadMilestones(project.id).catch(() => [] as Milestone[]);
      set({ milestones: Array.isArray(rows) ? rows : [] });
    },

    async addMilestone(name, date, color, description, taskIds) {
      const { project } = get();
      if (!project) return null;
      try {
        const created = await api.addMilestone(
          project.id,
          name,
          date,
          color,
          description,
          taskIds,
        );
        set({ milestones: [...get().milestones, created] });
        return created;
      } catch {
        return null;
      }
    },

    async patchMilestone(id, changes) {
      const current = get().milestones.find((m) => m.id === id);
      if (!current) return;
      const next = { ...current, ...changes };
      try {
        await api.updateMilestone(
          id,
          next.name,
          next.date,
          next.color,
          next.description,
          next.taskIds,
        );
        set({
          milestones: get().milestones.map((m) => (m.id === id ? next : m)),
        });
      } catch {
        await get().loadMilestones();
      }
    },

    async reorderMilestones(ids) {
      const { project } = get();
      if (!project) return;
      const byId = new Map(get().milestones.map((m) => [m.id, m]));
      const ordered = ids.map((id) => byId.get(id)).filter((m): m is Milestone => !!m);
      const rest = get().milestones.filter((m) => !ids.includes(m.id));
      set({ milestones: [...ordered, ...rest] });
      try {
        await api.reorderMilestones(project.id, ids);
      } catch {
        await get().loadMilestones();
      }
    },

    async removeMilestone(id) {
      try {
        await api.deleteMilestone(id);
        set({ milestones: get().milestones.filter((m) => m.id !== id) });
      } catch {
        await get().loadMilestones();
      }
    },

    async addItemNote(name, priority, personId, taskId) {
      const { project } = get();
      if (!project || !name.trim()) return null;
      try {
        const row = await api.addItemNote(project.id, name, priority, personId, taskId);
        // 保持库里的创建时间倒序
        set({ itemNotes: [row, ...get().itemNotes] });
        return row;
      } catch {
        return null;
      }
    },

    /** 乐观更新；失败时以库为准重拉，不回滚到旧值 */
    async patchItemNote(id, changes) {
      const before = get().itemNotes.find((n) => n.id === id);
      if (!before) return;
      const next = { ...before, ...changes };
      set({ itemNotes: get().itemNotes.map((n) => (n.id === id ? next : n)) });
      try {
        await api.updateItemNote(
          id,
          next.name,
          next.kind,
          next.priority,
          next.personId,
          next.taskId,
        );
      } catch {
        await get().loadItemNotes();
      }
    },

    async closeItemNote(id, resolution) {
      try {
        const closedAt = await api.closeItemNote(id, resolution);
        set({
          itemNotes: get().itemNotes.map((n) =>
            n.id === id ? { ...n, closedAt, resolution: resolution?.trim() || null } : n,
          ),
        });
      } catch {
        await get().loadItemNotes();
      }
    },

    async reopenItemNote(id) {
      await api.reopenItemNote(id).catch(() => {});
      set({
        itemNotes: get().itemNotes.map((n) =>
          n.id === id ? { ...n, closedAt: null, resolution: null } : n,
        ),
      });
    },

    async removeItemNote(id) {
      await api.deleteItemNote(id).catch(() => {});
      set({ itemNotes: get().itemNotes.filter((n) => n.id !== id) });
    },

    /**
     * 先建实体（纯内存 patchTask，不会失败）再记引用；阻碍不在事项 IPC 的事务里。
     * 反过来的话落库失败会留下指向不存在阻碍的引用。
     */
    async promoteToBlocker(noteId, taskId, reason, note) {
      const { tasks } = get();
      const task = tasks.get(taskId);
      const row = get().itemNotes.find((n) => n.id === noteId);
      if (!task || !row || row.promotedKind != null) return;

      const day = today();
      if (!canRecordBlocker(task, day)) return;

      const changes = openBlockerOn(task, day, reason, note ?? row.name);
      const period = changes.blocked?.[changes.blocked.length - 1];
      if (period) period.priority = row.priority as 0 | 1 | 2 | 3;
      get().patchTask(taskId, changes, "分拣为阻碍");
      if (!period) return;

      const ref = blockerRef(taskId, period.id);
      try {
        await api.promoteNoteToBlocker(noteId, ref);
        set({
          itemNotes: get().itemNotes.map((n) =>
            n.id === noteId ? { ...n, promotedKind: "blocker", promotedRef: ref } : n,
          ),
        });
      } catch {
        await get().loadItemNotes();
      }
    },

    /** 库层一个事务里建风险行 + 写回引用 */
    async promoteToRisk(noteId, taskId, level) {
      const row = get().itemNotes.find((n) => n.id === noteId);
      if (!row || row.promotedKind != null) return;
      try {
        await api.promoteNoteToRisk(noteId, taskId, row.name, level, row.priority);
      } catch {
        return;
      }
      await Promise.all([get().loadItemNotes(), get().refreshRisks()]);
    },

    /** 风险由库层同事务删掉；阻碍由库层返回引用，前端走命令栈摘掉 */
    async unpromoteNote(noteId) {
      let ref: string | null = null;
      try {
        ref = await api.unpromoteNote(noteId);
      } catch {
        return;
      }

      const parsed = ref ? parseBlockerRef(ref) : null;
      if (parsed) {
        const task = get().tasks.get(parsed.taskId);
        // 引用可能已悬挂
        if (task?.blocked.some((p) => p.id === parsed.periodId)) {
          get().removeBlocked(parsed.taskId, parsed.periodId);
        }
      }
      await Promise.all([get().loadItemNotes(), get().refreshRisks()]);
    },

    /** 会丢掉区间、pushed、归类、风险等级与处置说明，调用方要告知用户 */
    async reclaimToNote({ source, noteId, taskId, periodId, riskId, content, priority }) {
      if (noteId != null) {
        await get().unpromoteNote(noteId);
        return noteId;
      }

      // 先建事项再删实体，否则新建失败等于静默删掉
      const row = await get().addItemNote(content, priority ?? 2, null, taskId);
      if (!row) return null;

      if (source === "blocker" && taskId != null && periodId) {
        get().removeBlocked(taskId, periodId);
      } else if (source === "risk" && riskId != null) {
        await get().removeRisk(riskId);
      }
      return row.id;
    },

    async saveItemKind(key, label, color, requiresNote) {
      await api.saveItemKind(key, label, color, requiresNote).catch(() => {});
      await get().loadItemKinds();
    },

    /** 用着它的事项由库层退回「未分拣」（query::delete_item_kind） */
    async removeItemKind(key) {
      let reverted = 0;
      try {
        reverted = await api.deleteItemKind(key);
      } catch {
        return 0;
      }
      await Promise.all([get().loadItemKinds(), get().loadItemNotes()]);
      return reverted;
    },

    async setRiskPriority(id, priority) {
      await api.setRiskPriority(id, priority).catch(() => {});
      await get().refreshRisks();
    },

    setViewMode(mode) {
      set({ viewMode: mode, ...(mode === "plan" ? { compareOn: false } : {}) });
      void api.setSetting(VIEW_MODE_KEY, mode).catch(() => {});
    },

    setCompareOn(on) {
      set({ compareOn: on });
    },

    /** null = 清空。两端必须同空同有，库层触发器兜底 */
    setActualSpan(taskId, span, label = "调整实施日期") {
      const task = get().tasks.get(taskId);
      if (!task) return;

      const changes: Partial<Task> =
        span == null
          ? { actualStartDay: null, actualEndDay: null }
          : {
              actualStartDay: Math.floor(Math.min(span.startDay, span.endDay)),
              actualEndDay: Math.floor(Math.max(span.startDay, span.endDay)),
            };

      // 受阻时段贴着「实际没推进」，所以基准跟着当前有效区间走
      const effective =
        span ?? { startDay: task.startDay, endDay: task.endDay };
      const blocked = reclamp(task.blocked, {
        startDay: Math.floor(Math.min(effective.startDay, effective.endDay)),
        endDay: Math.floor(Math.max(effective.startDay, effective.endDay)),
      });
      if (blocked.length !== task.blocked.length) changes.blocked = blocked;

      get().run(makeCommand(label, get().tasks, [{ id: taskId, changes }]));
    },

    adoptPlanDates(taskId) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().setActualSpan(
        taskId,
        { startDay: task.startDay, endDay: task.endDay },
        "采用计划日期",
      );
    },

    /** 拖拽每帧都调，必须无副作用；reparentTask 用同一套判断 */
    canDrop(id, targetId, position) {
      const { tasks } = get();
      const task = tasks.get(id);
      const target = tasks.get(targetId);
      if (!task || !target || id === targetId) return false;

      // 拖进自己的后代会成环，展平时无限递归
      for (let cur = target.parentId; cur != null; cur = tasks.get(cur)?.parentId ?? null) {
        if (cur === id) return false;
      }

      if (position === "inside" && target.milestone) return false;

      return true;
    },

    /** 整组兄弟重新编号（顺带修好重复的 sortOrder），打包成一条命令 */
    reparentTask(id, targetId, position) {
      const { tasks, stack } = get();
      if (!stack || !get().canDrop(id, targetId, position)) return;

      const task = tasks.get(id)!;
      const target = tasks.get(targetId)!;
      const newParentId = position === "inside" ? targetId : target.parentId;

      const siblings = siblingsOf(newParentId).filter((t) => t.id !== id);
      let index: number;
      if (position === "inside") {
        index = siblings.length;
      } else {
        const at = siblings.findIndex((t) => t.id === targetId);
        index = position === "before" ? at : at + 1;
      }

      const reordered = [...siblings];
      reordered.splice(index, 0, task);

      const changes = reordered.map((t, i) => ({
        id: t.id,
        changes:
          t.id === id
            ? { sortOrder: i, parentId: newParentId }
            : { sortOrder: i },
      }));

      // 挂进折叠的父节点，任务会凭空消失 —— 顺手展开
      if (position === "inside" && target.collapsed) {
        changes.push({ id: targetId, changes: { collapsed: false } as never });
      }

      stack.execute(
        makeCommand(position === "inside" ? "移入子任务" : "移动任务", tasks, changes),
      );
      set({ selectedId: id });
    },

    /** 只在同一父节点内移动。重新编号而非交换：两个 sortOrder 相等时交换会静默失效 */
    moveTask(id, delta) {
      const { tasks, stack } = get();
      const task = tasks.get(id);
      if (!stack || !task) return;

      const siblings = siblingsOf(task.parentId);
      const from = siblings.findIndex((t) => t.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= siblings.length) return;

      const reordered = [...siblings];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);

      stack.execute(
        makeCommand(
          delta < 0 ? "上移任务" : "下移任务",
          tasks,
          reordered.map((t, index) => ({ id: t.id, changes: { sortOrder: index } })),
        ),
      );
    },

    openDetail(id) {
      set({ detailId: id, ...(id != null ? { selectedId: id } : {}) });
    },

    consumePendingEdit() {
      set({ pendingEditId: null });
    },

    /** 清单和角标从同一份结果算，避免两者对不上 */
    async refreshRisks() {
      const { project } = get();
      if (!project) return;
      const rows = await api.loadProjectRisks(project.id).catch(() => []);
      // IPC 不保证返回数组
      const risks = Array.isArray(rows) ? rows : [];
      set({
        projectRisks: risks,
        openRisks: riskFlags(risks),
        revision: get().revision + 1,
      });
    },

    async addRisk(taskId, content, level) {
      const text = content.trim();
      if (!text) return;
      await api.addRisk(taskId, text, level).catch(() => {});
      await get().refreshRisks();
    },

    async resolveRisk(id, resolution) {
      if (!resolution.trim()) return;
      await api.resolveRisk(id, resolution.trim()).catch(() => {});
      await get().refreshRisks();
    },

    async reopenRisk(id) {
      await api.reopenRisk(id).catch(() => {});
      await get().refreshRisks();
    },

    async removeRisk(id) {
      await api.deleteRisk(id).catch(() => {});
      await get().refreshRisks();
    },

    async loadPeople() {
      set({ people: await api.listPeople().catch(() => []) });
    },

    async addPerson(name) {
      const color = PROJECT_COLORS[get().people.length % PROJECT_COLORS.length];
      await api.createPerson(name, color);
      await get().loadPeople();
    },

    async savePerson(id, name, color, avatar) {
      await api.updatePerson(id, name, color, avatar);
      await get().loadPeople();
      set({ revision: get().revision + 1 });
    },

    async removePerson(id) {
      await api.deletePerson(id);
      await get().loadPeople();

      // 库层 ON DELETE SET NULL 不影响内存；不同步的话下次保存会写回已删 id，触发外键错误
      const { tasks } = get();
      const orphaned = [...tasks.values()].filter((t) => t.personId === id);
      if (orphaned.length > 0) {
        get().run(
          makeCommand(
            "清除负责人",
            tasks,
            orphaned.map((t) => ({ id: t.id, changes: { personId: null } })),
          ),
        );
      } else {
        set({ revision: get().revision + 1 });
      }
    },

    assignPerson(taskId, personId) {
      get().patchTask(taskId, { personId }, "指派负责人");
    },

    setPriority(taskId, priority) {
      get().patchTask(taskId, { priority }, "改紧急程度");
    },

    addBlocked(taskId, period) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().patchTask(taskId, { blocked: [...task.blocked, period] }, "标记受阻时段");
    },

    /** 超出任务时拉长任务而不是裁掉（blocked.fitBlocked） */
    updateBlocked(taskId, period) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      const changes = fitBlocked(task, period, today());
      if (!changes) return;
      get().patchTask(taskId, changes, "修改阻碍");
    },

    addBlocker(taskId, reason, note, span, live = true) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      // UI 已禁用按钮，store 作为唯一写入口再挡一次
      const day = today();
      if (!canRecordBlocker(task, day)) return;
      get().patchTask(
        taskId,
        openBlockerOn(task, day, reason, note, span, live),
        live ? "新建阻碍" : "补记阻碍",
      );
    },

    closeBlocker(taskId, periodId) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().patchTask(
        taskId,
        { blocked: closeBlocked(task.blocked, periodId, today()) },
        "关闭阻碍",
      );
    },

    /**
     * 未关阻碍顺延 + autoRollover 逾期顺延，全项目一条命令落地（持久化是整项目全量写）。
     * 两条路径命中同一任务时取最大值，不叠加，否则同一天算两次。
     */
    extendOpenBlockers() {
      const { tasks, stack } = get();
      if (!stack) return;
      const day = today();

      // 只顺延叶子：父任务日期由 resolve 汇总，推了也会被覆盖
      const parents = new Set<number>();
      for (const task of tasks.values()) {
        if (task.parentId != null) parents.add(task.parentId);
      }

      const changes: Array<{ id: number; changes: Partial<Task> }> = [];
      for (const task of tasks.values()) {
        const blockerPatch = extendOpenBlocks(task, day);
        const overduePatch = parents.has(task.id) ? null : rolloverOverdue(task, day);
        if (!blockerPatch && !overduePatch) continue;

        const end = Math.max(
          blockerPatch?.endDay ?? task.endDay,
          overduePatch?.endDay ?? task.endDay,
        );
        const merged: Partial<Task> = { ...blockerPatch, ...overduePatch, endDay: end };
        // 逾期顺延不动实施日期
        if (blockerPatch?.actualEndDay != null) merged.actualEndDay = blockerPatch.actualEndDay;
        changes.push({ id: task.id, changes: merged });
      }
      if (changes.length === 0) return;

      stack.applySystem(makeCommand("自动顺延排期", tasks, changes));
      bump();
    },

    removeBlocked(taskId, periodId) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().patchTask(
        taskId,
        { blocked: task.blocked.filter((p) => p.id !== periodId) },
        "删除受阻时段",
      );
    },

    async loadProjects() {
      set({ loadingProjects: true });
      try {
        set({ projects: await api.listProjects() });
      } finally {
        set({ loadingProjects: false });
      }
    },

    async createProject(name, color) {
      const project = await api.createProject(name, color);
      await get().loadProjects();
      return project.id;
    },

    async deleteProject(id) {
      await api.deleteProject(id);
      await get().loadProjects();
    },

    async openProject(id) {
      const data = await api.loadProject(id);
      const tasks: TaskMap = new Map(
        data.tasks.map((row) => [row.id, rowToTask(row)]),
      );

      const persistence = new Persistence(id, tasks, () => get().dependencies);
      persistence.primeRowCache(data.tasks);

      const stack = new CommandStack(tasks);
      persistence.attach(stack);
      stack.subscribe(() => bump());

      const detachGuards = installFlushGuards(persistence);

      set({
        people: data.people ?? [],
        nextTaskId: Math.max(1, data.nextTaskId ?? 1),
        screen: { name: "workspace", projectId: id },
        project: data.project,
        calendar: WorkCalendar.fromProject(
          data.project.workDays,
          data.project.holidays,
        ),
        tasks,
        dependencies: data.dependencies,
        stack,
        persistence,
        detachGuards,
        selectedId: null,
        detailId: null,
        pendingEditId: null,
        revision: get().revision + 1,
      });

      void get().refreshRisks();
      void get().loadDailyNotes();
      void get().loadItemNotes();
      void get().loadMilestones();
      // 全局表，但要在事项视图首次渲染前到位
      void get().loadItemKinds();
      // 补上应用关着期间跨过的天
      get().extendOpenBlockers();
    },

    async closeProject() {
      const { persistence, detachGuards } = get();

      // 必须等落库完成；保存失败绝不能离开，否则内存里的任务表整个丢掉
      if (persistence) {
        try {
          await persistence.flush();
        } catch (err) {
          set({ saveError: err, revision: get().revision + 1 });
          return;
        }
      }

      persistence?.detach();
      detachGuards?.();

      set({
        screen: { name: "list" },
        project: null,
        calendar: WorkCalendar.default(),
        tasks: new Map(),
        dependencies: [],
        stack: null,
        persistence: null,
        detachGuards: null,
        selectedId: null,
        detailId: null,
        openRisks: new Map(),
        projectRisks: [],
        dailyNotes: [],
        // itemKinds 是全局表，不清
        itemNotes: [],
        milestones: [],
        quickNoteOpen: false,
        pendingSortNoteId: null,
        noteDraft: null,
      });
      await get().loadProjects();
    },

    /** 不属于任务数据，不进命令栈 */
    setCalendar(calendar) {
      const { project } = get();
      set({ calendar, revision: get().revision + 1 });
      if (!project) return;
      const { workDays, holidays } = calendar.toJson();
      void api.updateProjectCalendar(project.id, workDays, holidays).catch(() => {});
    },

    run(command) {
      get().stack?.execute(command);
    },

    runMerge(command) {
      get().stack?.executeOrMerge(command);
    },

    undo() {
      get().stack?.undo();
    },

    redo() {
      get().stack?.redo();
    },

    select(id) {
      set({ selectedId: id });
    },

    /** 插在选中行紧接着的下一行，而不是末尾 */
    addTaskAfter(siblingId) {
      const { tasks, stack } = get();
      if (!stack) return;

      const sibling = siblingId != null ? tasks.get(siblingId) ?? null : null;
      const id = nextId();
      const task = draftTask(
        id,
        sibling?.parentId ?? null,
        orderAfter(sibling?.parentId ?? null, sibling?.id ?? null),
        sibling,
      );

      stack.execute({ label: "新建任务", edits: [{ kind: "insert", row: task }] });
      set({ selectedId: id, pendingEditId: id });
    },

    /** 追加为最后一个子节点 */
    addSubtask(parentId) {
      const { tasks, stack } = get();
      const parent = tasks.get(parentId);
      if (!stack || !parent) return;

      const id = nextId();
      const existing = siblingsOf(parentId);
      const sortOrder =
        existing.length > 0 ? existing[existing.length - 1].sortOrder + 1 : 0;

      const task = draftTask(id, parentId, sortOrder, existing.at(-1) ?? parent);

      const edits = [{ kind: "insert" as const, row: task }];
      // 父节点折叠着的话新任务会看不见，顺手展开
      const expand = parent.collapsed
        ? makeCommand("", tasks, [{ id: parentId, changes: { collapsed: false } }])
        : null;

      stack.execute({
        label: "新建子任务",
        edits: [...(expand?.edits ?? []), ...edits],
      });
      set({ selectedId: id, pendingEditId: id });
    },

    /** 连同全部后代打包成一条命令 */
    deleteTask(id) {
      const { tasks, stack } = get();
      const target = tasks.get(id);
      if (!stack || !target) return;

      const doomed: Task[] = [];
      const collect = (parentId: number) => {
        for (const t of tasks.values()) {
          if (t.parentId === parentId) {
            collect(t.id);
            doomed.push(t);
          }
        }
      };
      collect(id);
      doomed.push(target); // 后代先删，父最后 —— 求逆时顺序颠倒，父会先插回来

      stack.execute({
        label: doomed.length > 1 ? `删除 ${doomed.length} 个任务` : "删除任务",
        edits: doomed.map((row) => ({ kind: "delete" as const, row })),
      });
      set({
        selectedId: null,
        detailId: doomed.some((t) => t.id === get().detailId) ? null : get().detailId,
      });
    },

    /** 认前一个兄弟做父节点 */
    indentTask(id) {
      const { tasks, stack } = get();
      const task = tasks.get(id);
      if (!stack || !task) return;

      const siblings = siblingsOf(task.parentId);
      const index = siblings.findIndex((t) => t.id === id);
      if (index <= 0) return;

      const newParent = siblings[index - 1];
      const cousins = siblingsOf(newParent.id);
      stack.execute(
        makeCommand("缩进任务", tasks, [
          {
            id,
            changes: {
              parentId: newParent.id,
              sortOrder: cousins.length > 0 ? cousins[cousins.length - 1].sortOrder + 1 : 0,
            },
          },
          // 父节点折叠着的话任务会看不见，顺手展开
          ...(newParent.collapsed
            ? [{ id: newParent.id, changes: { collapsed: false } }]
            : []),
        ]),
      );
    },

    outdentTask(id) {
      const { tasks, stack } = get();
      const task = tasks.get(id);
      if (!stack || !task || task.parentId == null) return;
      const parent = tasks.get(task.parentId);
      const grandParentId = parent?.parentId ?? null;

      stack.execute(
        makeCommand("取消缩进", tasks, [
          {
            id,
            changes: {
              parentId: grandParentId,
              // 落在原父任务紧后面
              sortOrder: orderAfter(grandParentId, parent?.id ?? null),
            },
          },
        ]),
      );
    },

    toggleCollapse(id) {
      const { tasks } = get();
      const task = tasks.get(id);
      if (!task) return;
      get().run(
        makeCommand(task.collapsed ? "展开" : "折叠", tasks, [
          { id, changes: { collapsed: !task.collapsed } },
        ]),
      );
    },

    patchTask(id, changes, label) {
      get().run(makeCommand(label, get().tasks, [{ id, changes }]));
    },
  };
});

export type { Edit };
