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
  closeBlocked,
  extendOpenBlocks,
  fitBlocked,
  reclamp,
  type BlockedPeriod,
  type BlockReason,
} from "../core/blocked";
import { canRecordBlocker, openBlockerOn } from "../core/board";
import { riskFlags, type RiskFlag } from "../core/risks";
import type { Span, ViewMode } from "../core/viewMode";
import { isAppView, type AppView } from "../core/views";
import type { DailyNote, Risk } from "../db/api";

/**
 * 一条待写入的逐日记录。
 * 带 id = 在改已有的那条；不带 = 新写一条。
 */
export interface NoteDraft {
  id?: number;
  taskId: number | null;
  /** 天序号。落库时才转成 ISO */
  day: number;
  content?: string;
}
import { today } from "../gantt/time";

/**
 * 应用状态。
 *
 * 任务表是一个**就地修改**的 Map，不是不可变对象 —— 拖拽时每帧都会改它，
 * 每帧复制 500 个任务是纯粹的浪费。React 靠 `revision` 计数器感知变化：
 * 命令栈每次落地就 +1，读取方 memo 在 revision 上。
 *
 * 代价是必须纪律性地「只经由命令栈修改 tasks」。这条纪律换来的是
 * 撤销/重做/落库三件事自动全部正确 —— 没有任何一条写路径能绕过它们。
 */

export type Screen = { name: "list" } | { name: "workspace"; projectId: number };

/** 拖放落点：目标行的上缘 / 中间 / 下缘 */
export type DropPosition = "before" | "inside" | "after";

interface AppState {
  screen: Screen;
  projects: ProjectSummary[];
  loadingProjects: boolean;

  project: Project | null;
  /** 工作日历。渲染、工期换算、自动重排都读它（DESIGN.md §1.5） */
  calendar: WorkCalendar;
  tasks: TaskMap;
  dependencies: DependencyRow[];
  revision: number;

  stack: CommandStack | null;
  persistence: Persistence | null;
  detachGuards: (() => void) | null;

  /**
   * 甘特条按哪一维数据着色（DESIGN.md §11）。
   * 这是视图偏好而非项目数据 —— 存全局 settings，不进撤销栈，也不随项目走。
   */
  colorBy: ColorBy;

  /** 行高档位。和着色一样属于视图偏好，存全局 settings */
  rowHeightKey: RowHeightKey;

  /**
   * 顶层视图：甘特 / 看板 / 时间线 / 复盘（core/views.ts）。
   * 同一批任务的四种看法，切换它不改任何数据。
   */
  activeView: AppView;

  /**
   * 计划 / 实施。切的是「读哪一组日期」，不是换一张表。
   * 只对甘特视图有意义 —— 另外三个视图各自有固定的数据归属。
   */
  viewMode: ViewMode;
  /** 实施侧是否叠加显示计划条 */
  compareOn: boolean;

  /**
   * 负责人。全局共享，不按项目隔离 —— 同一个人通常同时出现在多个项目里。
   * 它不是任务数据，所以不进撤销栈：删掉一个人再按 ⌘Z，用户预期撤销的是
   * 刚才的任务编辑，而不是把人变回来。
   */
  people: Person[];

  /** 左侧网格的选中行；跨组件共享，因为快捷键在 window 上监听 */
  selectedId: number | null;

  /** 详情面板正在看哪个任务；null 表示关闭 */
  detailId: number | null;

  /**
   * 新建任务后要自动进入重命名的那一行。
   *
   * 双击已经被「打开详情」占用，所以新建之后必须自动进编辑态 ——
   * 否则连按 Enter 批量建任务，每一条都得再想办法进重命名，速度就没了。
   */
  pendingEditId: number | null;

  /**
   * taskId → 未关闭的风险（条数 + 最高一档）。网格和看板卡片的角标靠它。
   *
   * 带上等级是因为角标要按严重程度上色 —— 一条低风险和三条高风险
   * 用同一个灰点表示，等于把最该看的那条藏起来了。
   */
  openRisks: Map<number, RiskFlag>;

  /**
   * 当前项目的全部风险，全局风险清单的数据源。
   *
   * 和逐日记录一样即写即存、不进撤销栈：⌘Z 该撤销的是刚才那次拖拽，
   * 而不是把你刚记下的一条风险悄悄抹掉。
   */
  projectRisks: Risk[];

  /**
   * 正在写/正在改的那一条逐日记录。
   *
   * 放在 store 而不是时间线组件内部，是因为它有**两个入口**：时间线里的
   * 「记一笔」，和甘特条上右键某一天。后者要先切到时间线视图再把草稿递过去，
   * 跨组件传递必须走共享状态。
   */
  noteDraft: NoteDraft | null;

  /**
   * 当前项目的全部逐日记录，时间线视图的数据源。
   *
   * 和风险、评论一样是**即写即存**的独立实体，不进命令栈 —— ⌘Z 撤销的
   * 应该是刚才那次拖拽，而不是把你写下的一句当日总结抹掉。
   */
  dailyNotes: DailyNote[];

  /** 全局下一个可用的任务 id，由 load_project 给出。见 nextId 的说明 */
  nextTaskId: number;
  saving: boolean;
  saveError: unknown;

  openDetail: (id: number | null) => void;
  consumePendingEdit: () => void;
  /** 重新拉一遍项目风险，并据此重算角标。任何风险的增删改之后都要调 */
  refreshRisks: () => Promise<void>;
  addRisk: (taskId: number, content: string, level: number) => Promise<void>;
  /** 关闭一条风险，必须带上处置说明 —— 打个勾就完事的关闭是没有价值的记录 */
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
  /**
   * 新记一条阻碍。默认是未关闭的、从今天起算（把卡片拖进受阻列走的也是它）。
   *
   * `span` / `live` 是补记用的：一条上个月卡过三天、现在已经做完的活，
   * 既不该从今天起算，也不该继续往后长。
   */
  addBlocker: (
    taskId: number,
    reason: BlockReason,
    note?: string,
    span?: { from: number; to: number },
    live?: boolean,
  ) => void;
  /** 手动关掉一条阻碍 —— 未关闭的阻碍只有这一个出口 */
  closeBlocker: (taskId: number, periodId: string) => void;
  /**
   * 跨天：把没关掉的阻碍延到今天，并顺延对应任务的计划结束日。
   * 不进撤销栈（见 CommandStack.applySystem）。
   */
  extendOpenBlockers: () => void;
  updateBlocked: (taskId: number, period: BlockedPeriod) => void;
  removeBlocked: (taskId: number, periodId: string) => void;
  setColorBy: (mode: ColorBy) => void;
  setRowHeight: (key: RowHeightKey) => void;
  setNoteDraft: (draft: NoteDraft | null) => void;
  /** 在甘特上右键某天：切到时间线并把草稿准备好 */
  startNoteAt: (taskId: number | null, day: number) => void;
  loadDailyNotes: () => Promise<void>;
  addDailyNote: (taskId: number | null, day: string, content: string) => Promise<void>;
  editDailyNote: (id: number, day: string, content: string) => Promise<void>;
  removeDailyNote: (id: number) => Promise<void>;
  setActiveView: (view: AppView) => void;
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

/** 项目卡片的强调色候选 —— 每个项目一个，贯穿到甘特条形成识别。 */
export const PROJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
];

const COLOR_BY_KEY = "bar_color_by";
const ROW_HEIGHT_KEY = "row_height";
const VIEW_MODE_KEY = "view_mode";
const ACTIVE_VIEW_KEY = "active_view";

export const useAppStore = create<AppState>((set, get) => {
  /**
   * 新任务的 ID 由前端分配，但**基准必须来自数据库**。
   *
   * 曾经这里是「当前项目里最大的 id + 1」。而 tasks.id 是全局主键 ——
   * 在项目 B 里造出的 id 会撞上项目 A 已有的行，保存时 upsert 就把
   * 项目 A 的那条任务整个改写掉了，静默的跨项目数据损坏。
   *
   * 现在以 load_project 返回的全库最大 id 为起点，本会话内单调递增。
   */
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

  /** 同一父节点下的兄弟，按 sortOrder 排序 —— 与 resolve() 的展平顺序一致。 */
  const siblingsOf = (parentId: number | null): Task[] =>
    [...get().tasks.values()]
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  /**
   * 求「插在 after 之后」的 sortOrder。
   *
   * 取前后两个兄弟的中点，所以插入一行只产生一行变更，不用给后面所有行重新编号。
   * 反复在同一处插入会让间隔指数级变小，但 double 有 52 位尾数，
   * 连续对半分约 50 次才会退化 —— 真实使用中到不了，先不做重新编号。
   */
  const orderAfter = (parentId: number | null, afterId: number | null): number => {
    const siblings = siblingsOf(parentId);
    if (siblings.length === 0) return 0;

    const index = afterId == null ? -1 : siblings.findIndex((t) => t.id === afterId);
    if (index < 0) return siblings[siblings.length - 1].sortOrder + 1; // 追加到末尾
    if (index === siblings.length - 1) return siblings[index].sortOrder + 1;
    return (siblings[index].sortOrder + siblings[index + 1].sortOrder) / 2;
  };

  /** 新建任务的公共部分：日期与负责人继承参照任务，用户连按 Enter 时只需改名字。 */
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
      // 新建的任务默认「还没动过」，实施视图里显示为计划的虚线轮廓
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
    activeView: "gantt",
    viewMode: "plan",
    compareOn: false,
    people: [],
    selectedId: null,
    detailId: null,
    pendingEditId: null,
    openRisks: new Map(),
    projectRisks: [],
    dailyNotes: [],
    noteDraft: null,
    nextTaskId: 1,
    saving: false,
    saveError: null,

    async loadSettings() {
      const [color, row, view, active] = await Promise.all([
        api.getSetting(COLOR_BY_KEY).catch(() => null),
        api.getSetting(ROW_HEIGHT_KEY).catch(() => null),
        api.getSetting(VIEW_MODE_KEY).catch(() => null),
        api.getSetting(ACTIVE_VIEW_KEY).catch(() => null),
      ]);
      if (color && ["stage", "assignee", "priority", "none"].includes(color)) {
        set({ colorBy: color as ColorBy });
      }
      if (row && row in ROW_HEIGHTS) set({ rowHeightKey: row as RowHeightKey });
      if (view === "plan" || view === "actual") set({ viewMode: view });
      if (isAppView(active)) set({ activeView: active });
    },

    setColorBy(mode) {
      set({ colorBy: mode });
      void api.setSetting(COLOR_BY_KEY, mode).catch(() => {});
    },

    setRowHeight(key) {
      set({ rowHeightKey: key });
      void api.setSetting(ROW_HEIGHT_KEY, key).catch(() => {});
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
        // 时间线读不出来不该拦住整个应用 —— 视图里会显示成空
        set({ dailyNotes: [] });
      }
    },

    async addDailyNote(taskId, day, content) {
      const { project } = get();
      if (!project || !content.trim()) return;
      const note = await api.addDailyNote(project.id, taskId, day, content);
      // 库里按 day 正序返回，这里插进来时保持同一个顺序，
      // 免得刚写的一条跳到列表末尾
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

    setViewMode(mode) {
      // 切回计划视图时顺手关掉对照 —— 对照只在看实施时才有意义
      set({ viewMode: mode, ...(mode === "plan" ? { compareOn: false } : {}) });
      void api.setSetting(VIEW_MODE_KEY, mode).catch(() => {});
    },

    setCompareOn(on) {
      set({ compareOn: on });
    },

    /**
     * 写实施区间。传 null 表示清空（回到「还没动过」）。
     *
     * 两端必须同空同有 —— 半填状态没有语义，而且会让每一处取区间的地方
     * 都多一个分支。库层有触发器兜底，这里是第一道。
     */
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

    /** 一键照计划填实施日期 —— 「完全按计划走」那种情况的快捷方式 */
    adoptPlanDates(taskId) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().setActualSpan(
        taskId,
        { startDay: task.startDay, endDay: task.endDay },
        "采用计划日期",
      );
    },

    /**
     * 拖放是否合法。
     *
     * 拖拽过程中每帧都要问一次（决定要不要画落点指示），所以它必须是纯查询、
     * 没有副作用，而且和真正执行时用的是同一套判断 —— 两处规则一旦分叉，
     * 就会出现「指示线画出来了但松手没反应」这种最让人困惑的表现。
     */
    canDrop(id, targetId, position) {
      const { tasks } = get();
      const task = tasks.get(id);
      const target = tasks.get(targetId);
      if (!task || !target || id === targetId) return false;

      // 不能把一个任务拖进它自己的后代 —— 那会造出一个脱离树的环，
      // 展平时直接无限递归
      for (let cur = target.parentId; cur != null; cur = tasks.get(cur)?.parentId ?? null) {
        if (cur === id) return false;
      }

      // 里程碑是时间轴上的一个点，不是容器，不接受子任务
      if (position === "inside" && target.milestone) return false;

      return true;
    },

    /**
     * 把任务挂到别处：变成某个任务的子任务，或插到某个任务前 / 后。
     *
     * 和 moveTask 一样走「整组兄弟重新编号」，而不是给一个中点值：
     * 重新编号顺带修好历史遗留的重复 sortOrder，且这一整批变更打包成
     * **一条**命令，⌘Z 一次就完整回滚（父子关系 + 全组顺序）。
     */
    reparentTask(id, targetId, position) {
      const { tasks, stack } = get();
      if (!stack || !get().canDrop(id, targetId, position)) return;

      const task = tasks.get(id)!;
      const target = tasks.get(targetId)!;
      const newParentId = position === "inside" ? targetId : target.parentId;

      // 目标层级里的兄弟，先把被拖的那个摘出去再算插入位置
      const siblings = siblingsOf(newParentId).filter((t) => t.id !== id);
      let index: number;
      if (position === "inside") {
        index = siblings.length; // 追加为最后一个子任务
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

    /**
     * 在兄弟之间上移 / 下移一行。
     *
     * 只在同一个父节点下移动，越过首尾就不动 —— 这是大纲编辑器的通用约定。
     * 「移出当前层级」是另一个语义，交给 ⌘[ 取消缩进，两件事混在一起
     * 会让用户按一下方向键突然跳到别的分支下面。
     *
     * 实现上不是交换两个 sortOrder，而是**把整组兄弟重新按位置编号**。
     * 交换的写法在两个 sortOrder 恰好相等时（历史数据、导入数据都可能）
     * 会静默失效；重新编号顺带把这类退化值一并修好。
     */
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

    /**
     * 一次查全项目的风险，角标在前端从这份数据推导。
     *
     * 之前这里查的是 count_open_risks（只回条数）。全局风险清单要的是明细，
     * 角标要的是等级 —— 两个都从同一份结果算出来，就不会出现清单里三条高风险、
     * 角标却显示两条的错位。
     */
    async refreshRisks() {
      const { project } = get();
      if (!project) return;
      const rows = await api.loadProjectRisks(project.id).catch(() => []);
      // IPC 的返回值只是「承诺」是数组，不是保证。拿到别的东西就当空 ——
      // 一个坏掉的查询不该让整张看板白屏
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
      // 新人的颜色按现有人数轮转，保证「按负责人着色」下彼此不同
      const color = PROJECT_COLORS[get().people.length % PROJECT_COLORS.length];
      await api.createPerson(name, color);
      await get().loadPeople();
    },

    async savePerson(id, name, color, avatar) {
      await api.updatePerson(id, name, color, avatar);
      await get().loadPeople();
      // 头像和颜色会直接影响甘特条着色，得让画布重绘
      set({ revision: get().revision + 1 });
    },

    async removePerson(id) {
      await api.deletePerson(id);
      await get().loadPeople();

      // 库层是 ON DELETE SET NULL，但内存里的任务还指着这个人。
      // 不同步的话，下一次整项目保存会把已删除的 id 写回去，触发外键错误。
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

    /**
     * 受阻时段走 patchTask，所以自动进撤销栈、自动随整项目保存 ——
     * 它由拖拽手势创建，而条子上其他拖拽全都能 ⌘Z，这一个必须一致。
     */
    addBlocked(taskId, period) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      get().patchTask(taskId, { blocked: [...task.blocked, period] }, "标记受阻时段");
    },

    /**
     * 改一条阻碍。区间超出任务时**拉长任务**而不是裁掉这一段 ——
     * 裁回去的表现是「调了没反应」，最难查的那种 bug（见 blocked.fitBlocked）。
     */
    updateBlocked(taskId, period) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      const changes = fitBlocked(task, period, today());
      if (!changes) return;
      get().patchTask(taskId, changes, "修改阻碍");
    },

    /**
     * 新建阻碍。走命令栈，所以误点一下可以 ⌘Z ——
     * 它是用户主动开的，和自动延长不是一回事。
     */
    addBlocker(taskId, reason, note, span, live = true) {
      const task = get().tasks.get(taskId);
      if (!task) return;
      // 准入判据在 core 里，这里再挡一次：UI 会禁用按钮，但 store 是
      // 唯一的写入口，规则只写在界面上等于没写。
      // 注意它比风险那边宽一格 —— 已完成的活允许补记（canRecordBlocker）
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
     * 每日跨天：没关掉的阻碍往后长一天，任务的计划结束日跟着顺延。
     *
     * 全项目一次算完、一条命令落地：一条一条写会让持久化层被触发 N 次，
     * 而它每次都是整项目全量写回。
     */
    extendOpenBlockers() {
      const { tasks, stack } = get();
      if (!stack) return;
      const day = today();

      const changes: Array<{ id: number; changes: Partial<Task> }> = [];
      for (const task of tasks.values()) {
        const patch = extendOpenBlocks(task, day);
        if (patch) changes.push({ id: task.id, changes: patch });
      }
      if (changes.length === 0) return;

      stack.applySystem(makeCommand("自动延长阻碍", tasks, changes));
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
      // 关掉应用过了一夜再打开，没关的阻碍要先补上这几天
      get().extendOpenBlockers();
    },

    async closeProject() {
      const { persistence, detachGuards } = get();

      // 必须等落库完成再离开，否则最后 400ms 的编辑会随着卸载丢掉。
      //
      // 而且**保存失败时绝不能继续离开** —— 离开会把内存里的任务表整个丢掉，
      // 那才是真正的数据丢失。之前这里是 `.catch(() => {})`，
      // 把失败吞掉之后照样清空，等于给自己开了一条静默丢数据的通道。
      if (persistence) {
        try {
          await persistence.flush();
        } catch (err) {
          set({ saveError: err, revision: get().revision + 1 });
          return; // 留在项目里，让用户看到「● 未保存」并有机会重试
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
        noteDraft: null,
      });
      await get().loadProjects();
    },

    /**
     * 改工作日历。立刻生效于界面，异步落库 ——
     * 它不属于任务数据，所以不进命令栈（改日历不该被 ⌘Z 撤销掉，
     * 那会让用户以为自己撤销的是刚才的任务编辑）。
     */
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

    /**
     * 新建同级任务，插在选中行**紧接着的下一行**（而不是列表末尾）。
     */
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

    /**
     * 在指定任务下新建子任务，追加为它的最后一个子节点。
     *
     * 和「新建同级 + 缩进」两步走等价，但少一步、且不依赖「前面必须有兄弟」
     * 这个前提 —— 一个刚建好、还没有任何兄弟的任务也能直接挂子任务。
     */
    addSubtask(parentId) {
      const { tasks, stack } = get();
      const parent = tasks.get(parentId);
      if (!stack || !parent) return;

      const id = nextId();
      const existing = siblingsOf(parentId);
      const sortOrder =
        existing.length > 0 ? existing[existing.length - 1].sortOrder + 1 : 0;

      // 日期参照最后一个已有子任务，没有的话参照父任务
      const task = draftTask(id, parentId, sortOrder, existing.at(-1) ?? parent);

      const edits = [{ kind: "insert" as const, row: task }];
      // 挂到折叠的父节点下，新任务会凭空消失 —— 顺手展开
      const expand = parent.collapsed
        ? makeCommand("", tasks, [{ id: parentId, changes: { collapsed: false } }])
        : null;

      stack.execute({
        label: "新建子任务",
        edits: [...(expand?.edits ?? []), ...edits],
      });
      set({ selectedId: id, pendingEditId: id });
    },

    /** 删除任务及其全部后代 —— 打包成一条命令，撤销一次整棵子树回来。 */
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

    /** 缩进：认前一个兄弟做父节点。这是建立层级最快的方式，比拖拽快得多。 */
    indentTask(id) {
      const { tasks, stack } = get();
      const task = tasks.get(id);
      if (!stack || !task) return;

      const siblings = siblingsOf(task.parentId);
      const index = siblings.findIndex((t) => t.id === id);
      if (index <= 0) return; // 没有前一个兄弟，无处可缩进

      const newParent = siblings[index - 1];
      const cousins = siblingsOf(newParent.id);
      stack.execute(
        makeCommand("缩进任务", tasks, [
          {
            id,
            changes: {
              parentId: newParent.id,
              // 成为新父节点的最后一个子任务
              sortOrder: cousins.length > 0 ? cousins[cousins.length - 1].sortOrder + 1 : 0,
            },
          },
          // 缩进到一个折叠的父节点里，任务会凭空消失，所以顺手展开
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
              // 落在原父任务的紧后面，而不是跳到列表末尾
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

/** 供持久化层订阅用：把 edits 落库之外的副作用集中在这里。 */
export type { Edit };
