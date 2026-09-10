import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolve, type ResolvedTask } from "../gantt/model";
import {
  AXIS_HEIGHT,
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  ROW_HEIGHTS,
} from "../gantt/theme";
import { withAlpha } from "../gantt/coloring";
import { dayToIso } from "../gantt/time";
import { setDuration, setEnd, setStart } from "../core/dateLink";
import { useAppStore, type DropPosition } from "../store/useAppStore";
import { activeSpan, canEdit, deviation, type ViewMode } from "../core/viewMode";
import { DatePicker, parseDate } from "./DatePicker";
import type { WorkCalendar } from "../core/calendar";
import { blockedDays } from "../core/blocked";
import { isBlockedOn } from "../core/board";
import { RISK_COLORS, riskLevelLabel, type RiskFlag } from "../core/risks";
import { today } from "../gantt/time";
import type { Person } from "../db/api";
import { Avatar } from "./Avatar";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import { shortcut } from "../core/keys";

/**
 * 左侧任务网格。
 *
 * 这是信息密集区，表现力主动克制（DESIGN.md §5）—— 大圆角和强动效放在这里
 * 只会让它更难用。生动的部分留给右侧甘特区和各种转场。
 *
 * 批量录入速度是甘特工具的生死线：表单式录 80 个任务要点 400 次鼠标，
 * 用户会直接退回 Excel。所以这里的一等公民是键盘。
 */

/* ------------------------------------------------------------------ */
/* 列定义                                                              */
/* ------------------------------------------------------------------ */

/**
 * 列宽与对齐**只在这里定义一次**，表头和数据行都从这里取。
 *
 * 之前表头和数据行各写各的宽度与内边距，于是每一列的文字都错开几像素 ——
 * 表头写 `pl-3`、数据格写 `px-2`、负责人格子里还嵌了一个自带 padding 的按钮，
 * 越往右误差越大。单元格必须是同一个盒子，才不会再分叉。
 */
const COLUMNS = [
  { key: "priority", label: "紧急", width: 52, align: "left", keep: 5 },
  { key: "start", label: "开始", width: 84, align: "left", keep: 2 },
  { key: "end", label: "结束", width: 84, align: "left", keep: 1 },
  // 要放下「自然日 · 工作日」再追一个受阻天数，比单个数字宽不少
  { key: "duration", label: "工期", width: 82, align: "right", keep: 6 },
  { key: "progress", label: "进度", width: 52, align: "right", keep: 3 },
  { key: "assignee", label: "负责人", width: 124, align: "left", keep: 4 },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

/** 单元格左右内边距。表头和数据行共用，是对齐的唯一保证。 */
const CELL_PAD = 8;

/** 任务名列最窄到这里。再窄就连一个短任务名都放不下，面板失去意义 */
const NAME_MIN = 120;

/**
 * 面板变窄时，按 keep 从小到大依次隐藏列。
 *
 * 顺序不是随便定的 —— 先丢的是**右边甘特图已经说过一遍**的信息：
 * 结束和开始日期看条子的位置就知道，进度条子上直接写着百分比，
 * 负责人可以靠「按负责人着色」认出来。工期和受阻天数图上读不出来，所以留到最后。
 *
 * 之前这里是一个写死的最小宽度（固定列总宽 + 150），加了紧急度列之后
 * 直接把下限顶到 628px，面板往左拉一点就拉不动了。
 */
export function visibleColumns(width: number): typeof COLUMNS[number][] {
  const byKeep = [...COLUMNS].sort((a, b) => b.keep - a.keep);
  const chosen: typeof COLUMNS[number][] = [];
  let used = 0;

  for (const col of byKeep) {
    if (used + col.width + NAME_MIN > width) break;
    chosen.push(col);
    used += col.width;
  }

  // 保持声明顺序，不能按 keep 的顺序排 —— 列的左右次序是固定的
  return COLUMNS.filter((c) => chosen.includes(c));
}

/** 任务名列的基础左内边距；层级缩进在此之上叠加 */
const NAME_PAD = 10;
const INDENT = 14;

const W = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])) as Record<
  (typeof COLUMNS)[number]["key"],
  number
>;

/** 所有列都显示时的固定列总宽，用作面板的默认宽度基准 */
export const FIXED_COLS_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);

/** 面板能缩到的最小宽度：只剩任务名，其余列全部隐藏 */
export const MIN_PANEL_WIDTH = NAME_MIN + CELL_PAD * 2;

type Field = "name" | "start" | "end" | "duration" | "progress";

/** 对照模式下多出来的偏差列 */
const DEVIATION_WIDTH = 56;

/** 实施视图下把「开始 / 结束 / 工期」换成实施口径的说法 */
function headerLabel(key: string, mode: ViewMode): string {
  if (mode !== "actual") {
    return COLUMNS.find((c) => c.key === key)?.label ?? "";
  }
  switch (key) {
    case "start":
      return "实际开始";
    case "end":
      return "实际结束";
    case "duration":
      return "实际工期";
    default:
      return COLUMNS.find((c) => c.key === key)?.label ?? "";
  }
}

interface Props {
  width: number;
  height: number;
  scrollY: number;
  onScroll: (y: number) => void;
}

export function TaskGrid({ width, height, scrollY, onScroll }: Props) {
  const revision = useAppStore((s) => s.revision);
  const taskMap = useAppStore((s) => s.tasks);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const toggleCollapse = useAppStore((s) => s.toggleCollapse);
  const patchTask = useAppStore((s) => s.patchTask);
  const addSubtask = useAppStore((s) => s.addSubtask);
  const indentTask = useAppStore((s) => s.indentTask);
  const outdentTask = useAppStore((s) => s.outdentTask);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const calendar = useAppStore((s) => s.calendar);
  const people = useAppStore((s) => s.people);
  const assignPerson = useAppStore((s) => s.assignPerson);
  const setPriority = useAppStore((s) => s.setPriority);
  const openDetail = useAppStore((s) => s.openDetail);
  const detailId = useAppStore((s) => s.detailId);
  const openRisks = useAppStore((s) => s.openRisks);
  const pendingEditId = useAppStore((s) => s.pendingEditId);
  const consumePendingEdit = useAppStore((s) => s.consumePendingEdit);
  const moveTask = useAppStore((s) => s.moveTask);
  const reparentTask = useAppStore((s) => s.reparentTask);
  const canDrop = useAppStore((s) => s.canDrop);
  const viewMode = useAppStore((s) => s.viewMode);
  const compareOn = useAppStore((s) => s.compareOn);
  const setActualSpan = useAppStore((s) => s.setActualSpan);
  const rowHeight = ROW_HEIGHTS[useAppStore((s) => s.rowHeightKey)];

  // 「此刻卡不卡着」是按今天判的。算一次传下去，别让每一行各自去取一遍
  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()]),
    [taskMap, revision],
  );

  const [editing, setEditing] = useState<{ id: number; field: Field } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新建任务后直接进重命名。双击已经让位给「打开详情」，
  // 没有这个自动跳转，连按 Enter 批量建任务就没法接着打字了。
  useEffect(() => {
    if (pendingEditId == null) return;
    setEditing({ id: pendingEditId, field: "name" });
    consumePendingEdit();
  }, [pendingEditId, consumePendingEdit]);

  // 甘特图那侧滚动时把容器同步过来，两侧行高严格对齐
  useEffect(() => {
    const el = scrollRef.current;
    if (el && Math.abs(el.scrollTop - scrollY) > 1) el.scrollTop = scrollY;
  }, [scrollY]);

  // ResizeObserver 要到挂载后才给出高度。这一帧如果按 0 算，虚拟化窗口是空的，
  // 用户会看到一闪而过的空列表；先按一屏估算，测量到真值后自然收敛。
  const bodyHeight = height > 0 ? height - AXIS_HEIGHT : 900;
  const first = Math.max(0, Math.floor(scrollY / rowHeight) - 2);
  const last = Math.min(tasks.length, Math.ceil((scrollY + bodyHeight) / rowHeight) + 2);
  const visible = tasks.slice(first, last);

  const columns = useMemo(() => visibleColumns(width), [width]);
  const shown = useMemo(
    () => new Set<ColumnKey>(columns.map((c) => c.key)),
    [columns],
  );
  const fixedWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const nameWidth = Math.max(NAME_MIN, width - fixedWidth);

  const dnd = useRowDrag({
    tasks,
    rowHeight,
    scrollRef,
    canDrop,
    onDrop: reparentTask,
  });

  return (
    <div className="flex shrink-0 flex-col overflow-hidden" style={{ width }}>
      {/* 表头。宽度与内边距和数据行取自同一处定义 */}
      <div
        className="flex shrink-0 items-end border-b border-[var(--rule)] bg-[var(--surface-alt)] pb-2 text-[11px] font-semibold text-[var(--text-dim)]"
        style={{ height: AXIS_HEIGHT }}
      >
        <div
          className="shrink-0 truncate"
          style={{ width: nameWidth, paddingLeft: NAME_PAD, paddingRight: CELL_PAD }}
        >
          任务
        </div>
        {columns.map((c) => (
          <div
            key={c.key}
            className={`shrink-0 truncate ${c.align === "right" ? "text-right" : ""}`}
            style={{ width: c.width, paddingLeft: CELL_PAD, paddingRight: CELL_PAD }}
            title={c.key === "duration" ? "自然日 · 工作日" : undefined}
          >
            {headerLabel(c.key, viewMode)}
          </div>
        ))}
        {compareOn && (
          <div
            className="shrink-0 truncate text-right"
            style={{ width: DEVIATION_WIDTH, paddingLeft: CELL_PAD, paddingRight: CELL_PAD }}
            title="实施相对计划的偏移天数"
          >
            偏差
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
        onPointerMove={dnd.onPointerMove}
        onPointerUp={dnd.onPointerUp}
        onPointerCancel={dnd.onPointerUp}
      >
        <div style={{ height: Math.max(tasks.length * rowHeight, 1) }}>
          {visible.map((task, i) => (
            <Row
              key={task.id}
              task={task}
              calendar={calendar}
              people={people}
              nameWidth={nameWidth}
              shown={shown}
              rowHeight={rowHeight}
              top={(first + i) * rowHeight}
              selected={task.id === selectedId}
              active={task.id === detailId}
              risk={openRisks.get(task.id) ?? null}
              blockedNow={isBlockedOn(task, day)}
              onOpenDetail={() => openDetail(task.id)}
              onRename={() => setEditing({ id: task.id, field: "name" })}
              striped={(first + i) % 2 === 1}
              editing={editing?.id === task.id ? editing.field : null}
              onSelect={() => select(task.id)}
              onEdit={(field) => {
                select(task.id);
                setEditing({ id: task.id, field });
              }}
              onEditDone={() => setEditing(null)}
              onToggle={() => toggleCollapse(task.id)}
              onAddSubtask={() => addSubtask(task.id)}
              onIndent={() => indentTask(task.id)}
              onOutdent={() => outdentTask(task.id)}
              onDelete={() => deleteTask(task.id)}
              onMove={(d) => moveTask(task.id, d)}
              dragging={dnd.draggingId === task.id}
              onDragStart={(e) => dnd.onPointerDown(task.id, e)}
              viewMode={viewMode}
              compareOn={compareOn}
              onSetActual={(span) => setActualSpan(task.id, span)}
              onAssign={(pid) => assignPerson(task.id, pid)}
              onPriority={(p) => setPriority(task.id, p)}
              onCommit={(field, raw) => {
                setEditing(null);
                commitField(task, field, raw, patchTask);
              }}
              onCommitDay={(field, day) => {
                setEditing(null);
                commitDay(task, field, day, patchTask);
              }}
            />
          ))}

          {/* 落点指示。画在内容层之上、行之外，所以不受行的 overflow 影响 */}
          {dnd.drop && (
            <DropIndicator
              drop={dnd.drop}
              rowHeight={rowHeight}
              tasks={tasks}
              nameWidth={nameWidth}
            />
          )}
        </div>

        {tasks.length === 0 && (
          <div className="px-4 py-6 text-xs text-[var(--text-dim)]">
            还没有任务。按{" "}
            <kbd className="rounded border border-[var(--rule)] px-1 py-0.5 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            新建。
          </div>
        )}
      </div>

      <DragGhost ghost={dnd.ghost} valid={dnd.drop?.valid ?? true} />
    </div>
  );
}

/**
 * 跟随光标的拖拽标签。
 *
 * portal 到 body：工作区外层是一个带 layoutId 的 motion.div，它会在转场时
 * 施加 transform，而 transform 会让 position:fixed 相对于它而不是视口定位 ——
 * 标签就会飘到离光标很远的地方。
 */
function DragGhost({
  ghost,
  valid,
}: {
  ghost: { x: number; y: number; name: string } | null;
  valid: boolean;
}) {
  if (!ghost) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[300] max-w-[220px] truncate rounded-md px-2 py-1 text-[11px] font-medium shadow-lg"
      style={{
        left: ghost.x + 12,
        top: ghost.y + 10,
        background: valid ? "var(--accent)" : "#f43f5e",
        color: "#fff",
      }}
    >
      {ghost.name}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* 单元格外壳                                                          */
/* ------------------------------------------------------------------ */

/**
 * 所有数据单元格的统一外壳。宽度和内边距只来自 COLUMNS 与 CELL_PAD，
 * 内容组件不许自己再加横向 padding —— 否则又会和表头错开。
 */
function Cell({
  w,
  align = "left",
  className = "",
  title,
  onDoubleClick,
  onClick,
  children,
}: {
  w: number;
  align?: "left" | "right";
  className?: string;
  title?: string;
  onDoubleClick?: () => void;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex h-full shrink-0 items-center overflow-hidden ${
        align === "right" ? "justify-end" : ""
      } ${className}`}
      style={{ width: w, paddingLeft: CELL_PAD, paddingRight: CELL_PAD }}
      title={title}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 提交                                                                */
/* ------------------------------------------------------------------ */

type Patch = (id: number, changes: Partial<ResolvedTask>, label: string) => void;

function commitDay(task: ResolvedTask, field: Field, day: number, patch: Patch) {
  const span = { startDay: task.startDay, endDay: task.endDay };
  if (field === "start") {
    // 改开始日期保持工期，结束日期跟着推（DESIGN.md §1.6）
    patch(task.id, setStart(span, day), "改开始日期");
  } else if (field === "end") {
    patch(task.id, setEnd(span, day), "改结束日期");
  }
}

function commitField(task: ResolvedTask, field: Field, raw: string, patch: Patch) {
  const span = { startDay: task.startDay, endDay: task.endDay };

  switch (field) {
    case "name":
      if (raw !== task.name) patch(task.id, { name: raw }, "重命名任务");
      return;

    case "progress": {
      const pct = Number(raw.replace("%", ""));
      if (!Number.isFinite(pct)) return;
      const value = Math.min(1, Math.max(0, pct / 100));
      if (value !== task.progress) patch(task.id, { progress: value }, "调整进度");
      return;
    }

    case "duration": {
      const days = Number(raw);
      if (!Number.isFinite(days)) return;
      // 改工期保持开始日期
      patch(task.id, setDuration(span, days), "改工期");
      return;
    }

    case "start":
    case "end": {
      const day = parseDate(raw);
      if (day != null) commitDay(task, field, day, patch);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 行                                                                  */
/* ------------------------------------------------------------------ */

function Row({
  task,
  calendar,
  people,
  nameWidth,
  shown,
  rowHeight,
  top,
  selected,
  active,
  risk,
  blockedNow,
  striped,
  editing,
  onSelect,
  onOpenDetail,
  onRename,
  onEdit,
  onEditDone,
  onToggle,
  onAddSubtask,
  onIndent,
  onOutdent,
  onDelete,
  onMove,
  viewMode,
  compareOn,
  onSetActual,
  dragging,
  onDragStart,
  onAssign,
  onPriority,
  onCommit,
  onCommitDay,
}: {
  task: ResolvedTask;
  calendar: WorkCalendar;
  people: Person[];
  nameWidth: number;
  shown: Set<ColumnKey>;
  rowHeight: number;
  top: number;
  selected: boolean;
  active: boolean;
  /** 未关闭的风险：几条、最高一档。没有就是 null */
  risk: RiskFlag | null;
  /** 此刻是不是卡着 —— 和风险是两件事，标识也必须是两个 */
  blockedNow: boolean;
  striped: boolean;
  editing: Field | null;
  onSelect: () => void;
  onOpenDetail: () => void;
  onRename: () => void;
  onEdit: (f: Field) => void;
  onEditDone: () => void;
  onToggle: () => void;
  onAddSubtask: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  viewMode: ViewMode;
  compareOn: boolean;
  onSetActual: (span: { startDay: number; endDay: number } | null) => void;
  dragging: boolean;
  onDragStart: (e: React.PointerEvent) => void;
  onAssign: (personId: number | null) => void;
  onPriority: (priority: 0 | 1 | 2 | 3) => void;
  onCommit: (f: Field, raw: string) => void;
  onCommitDay: (f: Field, day: number) => void;
}) {
  const { span, ghost } = activeSpan(task, viewMode);
  const natural = calendar.countCalendarDays(span.startDay, span.endDay);
  const working = calendar.countWorkdays(span.startDay, span.endDay);
  const blocked = blockedDays(task.blocked);
  // 父任务的日期两个视图下都是汇总值；实施视图里还没动过的也不能直接改数字
  // （要动就去甘特图上拖那条虚线，那样语义明确：一拖就变成实施）
  const dateReadOnly = task.hasChildren || (viewMode === "actual" && ghost);
  const gap = compareOn ? deviation(task) : null;

  return (
    <div
      className="group absolute flex w-full items-stretch text-xs"
      style={{
        height: rowHeight,
        top,
        background: active
          ? "color-mix(in srgb, var(--accent) 18%, transparent)"
          : selected
            ? "color-mix(in srgb, var(--accent) 12%, transparent)"
            : striped
              ? "var(--row-stripe)"
              : "transparent",
        boxShadow: selected || active ? "inset 2px 0 0 var(--accent)" : undefined,
        // 被拖的那一行淡出，让人清楚「正在搬的是它」
        opacity: dragging ? 0.4 : 1,
      }}
      onPointerDown={(e) => {
        onSelect();
        onDragStart(e);
      }}
      onDoubleClick={onOpenDetail}
    >
      {/* 任务名：缩进 + 折叠箭头 + 悬停出现的加子任务按钮 */}
      <div
        className="flex h-full shrink-0 items-center gap-1"
        style={{
          width: nameWidth,
          paddingLeft: NAME_PAD + task.depth * INDENT,
          paddingRight: CELL_PAD,
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (task.hasChildren) onToggle();
          }}
          className={`grid size-4 shrink-0 place-items-center rounded text-[9px] text-[var(--text-dim)] ${
            task.hasChildren ? "hover:bg-[var(--row-hover)]" : "invisible"
          }`}
        >
          <span
            className="transition-transform duration-150"
            style={{ transform: task.collapsed ? "rotate(-90deg)" : "none" }}
          >
            ▼
          </span>
        </button>

        {editing === "name" ? (
          <EditInput
            initial={task.name}
            onCommit={(v) => onCommit("name", v)}
            onCancel={onEditDone}
          />
        ) : (
          <>
            <span
              className={`min-w-0 flex-1 truncate ${
                task.hasChildren ? "font-semibold text-[var(--text)]" : "text-[var(--text)]"
              } ${task.name ? "" : "italic text-[var(--text-dim)]"}`}
              title="双击打开详情"
            >
              {task.milestone ? "◆ " : ""}
              {task.name || "未命名任务"}
            </span>

            {/*
              两个独立的标识，不再合并成一个含糊的「卡住」：

                ⛔ 受阻 = 已经在发生，工期正在被吃掉，今天就得有人去处理
                ⚠ 风险 = 可能会发生，要安排人盯着

              颜色也分开：受阻恒为红，风险按等级取色。一个红点同时表示这两件事，
              看的人分不出哪个该现在打电话。
            */}
            {blockedNow && (
              <span
                title="有一条还没关掉的阻碍"
                className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none text-[#f43f5e]"
                style={{ background: "rgba(244,63,94,0.14)" }}
              >
                ⛔受阻
              </span>
            )}
            {risk && (
              <span
                title={`${risk.count} 条未关闭的风险，最高：${riskLevelLabel(risk.top)}`}
                className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none"
                style={{
                  color: RISK_COLORS[risk.top],
                  background: withAlpha(RISK_COLORS[risk.top], 0.14),
                }}
              >
                ⚠{risk.count}
              </span>
            )}

            {/* 行级操作收进一个悬停出现的 ⋯ 菜单。
                任务名列要留给名字本身，摆两三个常驻按钮会把它挤掉；
                而且这些操作都各自有快捷键，菜单主要承担「发现」而不是「高频使用」 */}
            <RowMenu
              task={task}
              onOpenDetail={onOpenDetail}
              onRename={onRename}
              onAddSubtask={onAddSubtask}
              onIndent={onIndent}
              onOutdent={onOutdent}
              onDelete={onDelete}
              onMove={onMove}
              viewMode={viewMode}
              ghost={ghost}
              onAdoptPlan={() => onSetActual({ startDay: task.startDay, endDay: task.endDay })}
              onClearActual={() => onSetActual(null)}
            />
          </>
        )}
      </div>

      {shown.has("priority") && (
        <PriorityCell priority={task.priority} onPick={onPriority} />
      )}

      {shown.has("start") && (
      <DateCell
        w={W.start}
        editing={editing === "start"}
        // 父任务日期是子任务汇总出来的，只读（DESIGN.md §1.3）
        readOnly={dateReadOnly}
        placeholder={ghost ? "未开始" : undefined}
        day={span.startDay}
        onEdit={() => onEdit("start")}
        onCommit={(d) => onCommitDay("start", d)}
        onCancel={onEditDone}
      />
      )}

      {shown.has("end") && (
      <DateCell
        w={W.end}
        editing={editing === "end"}
        readOnly={dateReadOnly || task.milestone}
        placeholder={ghost ? "未开始" : undefined}
        day={span.endDay}
        minDay={span.startDay}
        onEdit={() => onEdit("end")}
        onCommit={(d) => onCommitDay("end", d)}
        onCancel={onEditDone}
      />
      )}

      {shown.has("duration") && (
      <>
      {/* 工期：自然日为主，工作日为辅。两个数只在不同时才都显示 ——
          没跨休息日时「7·7」纯属噪音，差异本身就是信号（DESIGN.md §1.5） */}
      {editing === "duration" ? (
        <Cell w={W.duration}>
          <EditInput
            initial={String(natural)}
            onCommit={(v) => onCommit("duration", v)}
            onCancel={onEditDone}
            align="right"
          />
        </Cell>
      ) : (
        <Cell
          w={W.duration}
          align="right"
          className={dateReadOnly || task.milestone ? "opacity-60" : "cursor-text"}
          title={
            dateReadOnly
              ? "由子任务汇总"
              : `自然日 ${natural} 天 / 工作日 ${working} 天` +
                (blocked > 0 ? ` / 其中 ${blocked} 天受阻` : "") +
                "（双击修改）"
          }
          onDoubleClick={
            dateReadOnly || task.milestone ? undefined : () => onEdit("duration")
          }
        >
          <span className="font-mono text-[11px] tabular-nums text-[var(--text)]">
            {natural}
          </span>
          {working !== natural && (
            <span className="ml-1 font-mono text-[10px] tabular-nums text-[var(--text-dim)] opacity-70">
              ·{working}
            </span>
          )}
          {/* 受阻天数和工期是同一个问题的两面，放一起才能直接对比。
              这里是**累计**天数（含已经关掉的），和名字旁那个「⛔受阻」不是
              一回事 —— 那个说的是此刻还卡不卡着 */}
          {blocked > 0 && (
            <span
              title={`累计 ${blocked} 天没能正常推进`}
              className="ml-1.5 rounded px-1 font-mono text-[9px] font-semibold leading-none text-amber-600"
              style={{ background: "rgba(245,158,11,0.16)" }}
            >
              阻{blocked}
            </span>
          )}
        </Cell>
      )}
      </>
      )}

      {shown.has("progress") && (
      <>
      {/* 进度：父任务由子任务汇总，不可手填（DESIGN.md §1.2） */}
      {editing === "progress" ? (
        <Cell w={W.progress}>
          <EditInput
            initial={String(Math.round(task.progress * 100))}
            onCommit={(v) => onCommit("progress", v)}
            onCancel={onEditDone}
            align="right"
          />
        </Cell>
      ) : (
        <Cell
          w={W.progress}
          align="right"
          className={
            task.hasChildren || !canEdit("progress", viewMode)
              ? "opacity-60"
              : "cursor-text"
          }
          title={
            task.hasChildren
              ? "由子任务汇总"
              : canEdit("progress", viewMode)
                ? "双击修改"
                : "进度在「实施」视图里修改"
          }
          onDoubleClick={
            task.hasChildren || !canEdit("progress", viewMode)
              ? undefined
              : () => onEdit("progress")
          }
        >
          <span className="font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
            {Math.round(task.progress * 100)}%
          </span>
        </Cell>
      )}
      </>
      )}

      {shown.has("assignee") && (
        <AssigneeCell
          people={people}
          personId={task.personId}
          readOnly={!canEdit("assignee", viewMode)}
          onAssign={onAssign}
        />
      )}

      {compareOn && (
        <Cell
          w={DEVIATION_WIDTH}
          align="right"
          title={gap ? "实施相对计划：开始 / 结束" : "还没开始实施"}
        >
          {gap ? (
            <span
              className="font-mono text-[10px] font-semibold tabular-nums"
              // 和甘特图上的计划条同一条规则：超出计划红、落在计划内绿。
              // 三处用不同配色会让人以为它们说的是不同的事
              style={{ color: gap.end > 0 ? "#dc2626" : "#059669" }}
            >
              {gap.end > 0 ? `+${gap.end}` : gap.end}d
            </span>
          ) : (
            <span className="font-mono text-[10px] text-[var(--text-dim)] opacity-50">—</span>
          )}
        </Cell>
      )}
    </div>
  );
}

function DateCell({
  w,
  day,
  minDay,
  editing,
  readOnly,
  placeholder,
  onEdit,
  onCommit,
  onCancel,
}: {
  w: number;
  day: number;
  minDay?: number;
  editing: boolean;
  readOnly?: boolean;
  /** 有值时说明这只是计划的影子，显示占位而不是日期 */
  placeholder?: string;
  onEdit: () => void;
  onCommit: (day: number) => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <Cell w={w}>
        <DatePicker value={day} minDay={minDay} onCommit={onCommit} onCancel={onCancel} />
      </Cell>
    );
  }
  return (
    <Cell
      w={w}
      className={readOnly ? "opacity-60" : "cursor-pointer"}
      title={
        placeholder
          ? "还没开始 —— 到甘特图上拖那条虚线，或点它采用计划日期"
          : readOnly
            ? "由子任务汇总"
            : `${dayToIso(day)}（单击选择日期）`
      }
      // 日期改成单击即开 —— 它是最常改的字段，双击是多余的一道门槛
      onClick={readOnly ? undefined : onEdit}
    >
      <span
        className={`truncate font-mono text-[11px] tabular-nums ${
          placeholder ? "italic opacity-45" : ""
        } text-[var(--text-dim)]`}
      >
        {placeholder ?? dayToIso(day).slice(5)}
      </span>
    </Cell>
  );
}

/* ------------------------------------------------------------------ */
/* 紧急程度                                                            */
/* ------------------------------------------------------------------ */

/**
 * 紧急程度列。
 *
 * 这个字段之前只能看不能改 —— 数据模型里有、甘特条上画了、却没有任何入口，
 * 等于是个装饰。现在是一个显式的列，点开就能改。
 */
function PriorityCell({
  priority,
  onPick,
}: {
  priority: number;
  onPick: (p: 0 | 1 | 2 | 3) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const color = PRIORITY_COLORS[priority];

  return (
    <Cell w={W.priority}>
      <button
        ref={setAnchor}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={`${PRIORITY_LABELS[priority]}（点击修改）`}
        className="rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-transform active:scale-95"
        style={{ background: withAlpha(color, 0.16), color }}
      >
        P{priority}
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={104}>
        {PRIORITY_LABELS.map((label, p) => (
          <MenuItem
            key={label}
            active={p === priority}
            onClick={() => {
              setOpen(false);
              onPick(p as 0 | 1 | 2 | 3);
            }}
          >
            <span className="flex items-center gap-2">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: PRIORITY_COLORS[p] }}
              />
              {label}
            </span>
          </MenuItem>
        ))}
      </Popover>
    </Cell>
  );
}

/* ------------------------------------------------------------------ */
/* 行级操作菜单                                                        */
/* ------------------------------------------------------------------ */

function RowMenu({
  task,
  onOpenDetail,
  onRename,
  onAddSubtask,
  onIndent,
  onOutdent,
  onDelete,
  onMove,
  viewMode,
  ghost,
  onAdoptPlan,
  onClearActual,
}: {
  task: ResolvedTask;
  onOpenDetail: () => void;
  onRename: () => void;
  onAddSubtask: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  viewMode: ViewMode;
  ghost: boolean;
  onAdoptPlan: () => void;
  onClearActual: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const actualEditable = viewMode === "actual" && !task.hasChildren;

  return (
    <>
      <button
        ref={setAnchor}
        title="更多操作"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`grid size-4 shrink-0 place-items-center rounded text-[13px] leading-none text-[var(--text-dim)] transition-opacity hover:bg-[var(--row-hover)] hover:text-[var(--text)] ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        ⋯
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={172}>
        <MenuItem
          hint="双击"
          onClick={() => {
            setOpen(false);
            onOpenDetail();
          }}
        >
          详情、风险与评论
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOpen(false);
            onRename();
          }}
        >
          重命名
        </MenuItem>
        <MenuDivider />
        <MenuItem
          hint={shortcut("shift", "↵")}
          onClick={() => {
            setOpen(false);
            onAddSubtask();
          }}
        >
          添加子任务
        </MenuItem>
        {actualEditable && (
          <>
            <MenuItem
              onClick={() => {
                setOpen(false);
                onAdoptPlan();
              }}
            >
              采用计划日期
            </MenuItem>
            {!ghost && (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onClearActual();
                }}
              >
                清除实施日期
              </MenuItem>
            )}
            <MenuDivider />
          </>
        )}
        <MenuItem
          hint={shortcut("alt", "↑")}
          onClick={() => {
            setOpen(false);
            onMove(-1);
          }}
        >
          上移
        </MenuItem>
        <MenuItem
          hint={shortcut("alt", "↓")}
          onClick={() => {
            setOpen(false);
            onMove(1);
          }}
        >
          下移
        </MenuItem>
        <MenuDivider />
        <MenuItem
          hint={shortcut("mod", "]")}
          onClick={() => {
            setOpen(false);
            onIndent();
          }}
        >
          缩进
        </MenuItem>
        <MenuItem
          hint={shortcut("mod", "[")}
          disabled={task.parentId == null}
          onClick={() => {
            setOpen(false);
            onOutdent();
          }}
        >
          取消缩进
        </MenuItem>
        <MenuDivider />
        <MenuItem
          danger
          hint="⌫"
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          {task.hasChildren ? "删除（含子任务）" : "删除"}
        </MenuItem>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

/** 头像 + 名字，点击从已有人员里选，不再手打文本。 */
function AssigneeCell({
  people,
  personId,
  readOnly,
  onAssign,
}: {
  people: Person[];
  personId: number | null;
  readOnly?: boolean;
  onAssign: (personId: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const person = people.find((p) => p.id === personId) ?? null;

  return (
    <Cell w={W.assignee}>
      {/* 按钮不带横向 padding —— 内边距一律由 Cell 提供，
          否则头像会比表头「负责人」三个字偏出去几像素 */}
      <button
        ref={setAnchor}
        onClick={(e) => {
          e.stopPropagation();
          if (!readOnly) setOpen((v) => !v);
        }}
        title={readOnly ? "负责人在「计划」视图里修改" : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded py-0.5 text-left ${
          readOnly ? "cursor-default opacity-70" : "hover:bg-[var(--row-hover)]"
        }`}
      >
        <Avatar person={person} size={18} />
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            person ? "text-[var(--text)]" : "text-[var(--text-dim)] opacity-60"
          }`}
        >
          {person?.name ?? "未指派"}
        </span>
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={176}
      >
        <div className="max-h-56 overflow-y-auto">
          <MenuItem
            active={personId == null}
            onClick={() => {
              setOpen(false);
              onAssign(null);
            }}
          >
            <span className="flex items-center gap-2 text-[var(--text-dim)]">
              <Avatar person={null} size={18} />
              未指派
            </span>
          </MenuItem>

          {people.map((p) => (
            <MenuItem
              key={p.id}
              active={p.id === personId}
              onClick={() => {
                setOpen(false);
                onAssign(p.id);
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar person={p} size={18} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </span>
            </MenuItem>
          ))}

          {people.length === 0 && (
            <div className="px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
              还没有负责人。
              <br />
              到「设置 → 负责人」里添加。
            </div>
          )}
        </div>
      </Popover>
    </Cell>
  );
}

function EditInput({
  initial,
  onCommit,
  onCancel,
  align = "left",
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      defaultValue={initial}
      className={`w-full min-w-0 rounded border border-[var(--accent)] bg-[var(--surface)] px-1 py-0.5 text-xs outline-none ${
        align === "right" ? "text-right" : ""
      }`}
      onKeyDown={(e) => {
        // 阻止冒泡，否则 Enter 会被工作区的「新建任务」快捷键接走
        e.stopPropagation();
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 拖放重挂                                                            */
/* ------------------------------------------------------------------ */

interface DropState {
  index: number;
  position: DropPosition;
  valid: boolean;
}

/** 落在行的上下 28% 判定为「插到前/后」，中间 44% 判定为「变成子任务」 */
const EDGE = 0.28;
/** 起手要移动这么多像素才算拖拽，否则单击选中和双击开详情都会被误判 */
const DRAG_THRESHOLD = 5;
/** 拖到距容器上下边缘这么近时自动滚动 */
const AUTOSCROLL_ZONE = 28;

function useRowDrag({
  tasks,
  rowHeight,
  scrollRef,
  canDrop,
  onDrop,
}: {
  tasks: ResolvedTask[];
  rowHeight: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  canDrop: (id: number, targetId: number, position: DropPosition) => boolean;
  onDrop: (id: number, targetId: number, position: DropPosition) => void;
}) {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);

  const armed = useRef<{ id: number; x: number; y: number } | null>(null);
  const active = useRef(false);
  const autoScroll = useRef(0);

  // 自动滚动。拖到边缘时列表自己往下走，否则长列表根本没法把任务拖到远处
  useEffect(() => {
    if (autoScroll.current === 0) return;
    let raf = 0;
    const step = () => {
      const el = scrollRef.current;
      if (el && autoScroll.current !== 0) el.scrollTop += autoScroll.current;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [drop, scrollRef]);

  const onPointerDown = (id: number, e: React.PointerEvent) => {
    // 从按钮、输入框上起手的不算拖拽 —— 那些是它们自己的交互
    if ((e.target as HTMLElement).closest("button, input, textarea")) return;
    armed.current = { id, x: e.clientX, y: e.clientY };
    active.current = false;
  };

  const locate = (clientY: number): DropState | null => {
    const el = scrollRef.current;
    if (!el || tasks.length === 0) return null;

    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    const raw = Math.floor(y / rowHeight);

    // 落在列表下方的空白处 = 追加到最后一行之后
    if (raw >= tasks.length) {
      return { index: tasks.length - 1, position: "after", valid: true };
    }

    const index = Math.max(0, raw);
    const offset = y - index * rowHeight;
    let position: DropPosition =
      offset < rowHeight * EDGE
        ? "before"
        : offset > rowHeight * (1 - EDGE)
          ? "after"
          : "inside";

    // 里程碑不接受子任务，中间区退化成「插到它后面」而不是直接判非法 ——
    // 拖到一半突然没有任何落点提示，用户会以为程序卡了
    if (position === "inside" && tasks[index].milestone) position = "after";

    return { index, position, valid: true };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = armed.current;
    if (!start) return;

    if (!active.current) {
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved < DRAG_THRESHOLD) return;
      active.current = true;
      setDraggingId(start.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    const el = scrollRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const fromTop = e.clientY - rect.top;
      const fromBottom = rect.bottom - e.clientY;
      autoScroll.current =
        fromTop < AUTOSCROLL_ZONE ? -8 : fromBottom < AUTOSCROLL_ZONE ? 8 : 0;
    }

    const found = locate(e.clientY);
    if (found) {
      const target = tasks[found.index];
      const valid =
        target.id !== start.id && canDrop(start.id, target.id, found.position);
      setDrop({ ...found, valid });
    } else {
      setDrop(null);
    }

    const dragged = tasks.find((t) => t.id === start.id);
    setGhost({
      x: e.clientX,
      y: e.clientY,
      name: dragged?.name || "未命名任务",
    });
  };

  const onPointerUp = () => {
    const start = armed.current;
    autoScroll.current = 0;

    if (active.current && start && drop?.valid) {
      onDrop(start.id, tasks[drop.index].id, drop.position);
    }

    armed.current = null;
    active.current = false;
    setDraggingId(null);
    setDrop(null);
    setGhost(null);
  };

  return {
    draggingId,
    drop,
    ghost,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

function DropIndicator({
  drop,
  rowHeight,
  tasks,
  nameWidth,
}: {
  drop: DropState;
  rowHeight: number;
  tasks: ResolvedTask[];
  nameWidth: number;
}) {
  const target = tasks[drop.index];
  if (!target) return null;

  const color = drop.valid ? "var(--accent)" : "#f43f5e";

  // 「变成子任务」用整行高亮框，「插到前后」用一条线 ——
  // 两种落点的后果完全不同，视觉上必须一眼分得开
  if (drop.position === "inside") {
    return (
      <div
        className="pointer-events-none absolute left-0 rounded-md"
        style={{
          top: drop.index * rowHeight,
          height: rowHeight,
          width: "100%",
          boxShadow: `inset 0 0 0 2px ${color}`,
          background: drop.valid
            ? "color-mix(in srgb, var(--accent) 10%, transparent)"
            : "rgba(244,63,94,0.08)",
        }}
      />
    );
  }

  // 指示线缩进到落点的实际层级，让人看清会落在哪一级
  const indent = NAME_PAD + target.depth * INDENT;

  return (
    <div
      className="pointer-events-none absolute h-0.5 rounded-full"
      style={{
        top: (drop.index + (drop.position === "after" ? 1 : 0)) * rowHeight - 1,
        left: indent,
        width: Math.max(40, nameWidth - indent),
        background: color,
      }}
    >
      <span
        className="absolute -left-1 -top-[3px] size-2 rounded-full"
        style={{ background: color }}
      />
    </div>
  );
}
