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

/** 左侧任务网格。信息密集区，表现力克制，键盘录入优先。 */

/* ------------------------------------------------------------------ */
/* 列定义                                                              */
/* ------------------------------------------------------------------ */

/** 列宽与对齐只在这里定义一次，表头和数据行都从这里取，否则会逐列累积错位。 */
const COLUMNS = [
  { key: "priority", label: "紧急", width: 52, align: "left", keep: 5 },
  { key: "start", label: "开始", width: 84, align: "left", keep: 2 },
  { key: "end", label: "结束", width: 84, align: "left", keep: 1 },
  // 要放下自然日、工作日和受阻天数
  { key: "duration", label: "工期", width: 82, align: "right", keep: 6 },
  { key: "progress", label: "进度", width: 52, align: "right", keep: 3 },
  { key: "assignee", label: "负责人", width: 124, align: "left", keep: 4 },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

/** 单元格左右内边距，表头和数据行共用。 */
const CELL_PAD = 8;

/** 任务名列最窄宽度 */
const NAME_MIN = 120;

/**
 * 面板变窄时按 keep 从小到大隐藏列：先丢右侧甘特图已经表达过的信息
 * （日期、进度、负责人），工期和受阻天数图上读不出，留到最后。
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

  // 保持声明顺序：列的左右次序固定，不能按 keep 排
  return COLUMNS.filter((c) => chosen.includes(c));
}

/** 任务名列基础左内边距，层级缩进在此之上叠加 */
const NAME_PAD = 10;
const INDENT = 14;

const W = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])) as Record<
  (typeof COLUMNS)[number]["key"],
  number
>;

/** 所有列都显示时的固定列总宽 */
export const FIXED_COLS_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);

/** 面板最小宽度：只剩任务名列 */
export const MIN_PANEL_WIDTH = NAME_MIN + CELL_PAD * 2;

type Field = "name" | "start" | "end" | "duration" | "progress";

/** 对照模式下多出来的偏差列 */
const DEVIATION_WIDTH = 56;

/** 实施视图下改成实施口径的列名 */
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

  // 按今天算一次传下去，别让每行各取一遍
  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()]),
    [taskMap, revision],
  );

  const [editing, setEditing] = useState<{ id: number; field: Field } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新建后直接进重命名：双击已让位给「打开详情」，否则连按 Enter 建任务就断了
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

  // 挂载首帧 ResizeObserver 还给不出高度，按一屏估算，避免空列表闪一下
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
            title={c.key === "duration" ? "工期天数：前面是自然日，后面的小字是工作日" : undefined}
          >
            {headerLabel(c.key, viewMode)}
          </div>
        ))}
        {compareOn && (
          <div
            className="shrink-0 truncate text-right"
            style={{ width: DEVIATION_WIDTH, paddingLeft: CELL_PAD, paddingRight: CELL_PAD }}
            title="实际结束日期比计划结束日期多的天数"
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
 * 跟随光标的拖拽标签。portal 到 body：外层 motion.div 转场时的 transform
 * 会让 position:fixed 相对它定位，标签就会飘走。
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
        background: valid ? "var(--accent)" : "var(--danger)",
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

/** 数据单元格统一外壳。宽度和内边距只来自 COLUMNS 与 CELL_PAD，内容不许自带横向 padding。 */
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
    // 改开始日期保持工期，结束日期跟着推
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
  /** 此刻是否受阻；与风险是两件事，标识也分开 */
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
  // 父任务日期是汇总值；实施视图里没动过的也不能直接改数字，要去甘特图拖虚线
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
              /*
               * 全名放在第一行。
               *
               * 名字列吃掉的是面板的剩余宽度，长名字必然被截断，而 title 是
               * 唯一能把它看全的地方 —— 原先这里只写「双击打开详情」，等于
               * 用一句操作提示占掉了那个位置：名字越长，悬停越没用。
               * 里程碑的 ◆ 是装饰，不进 tooltip。
               */
              title={task.name ? `${task.name}\n双击打开详情` : "双击打开详情"}
            >
              {task.milestone ? "◆ " : ""}
              {task.name || "未命名任务"}
            </span>

            {/* ⛔ 受阻是已在发生，⚠ 是风险可能发生；颜色分开，免得混成一个「有问题」 */}
            {blockedNow && (
              <span
                title="有未关闭的阻碍，今天正在受影响"
                className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none text-[var(--danger)]"
                style={{ background: "color-mix(in srgb, var(--danger) 14%, transparent)" }}
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

            {/* 行级操作收进悬停出现的 ⋯ 菜单，给任务名让出宽度 */}
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
        // 父任务日期由子任务汇总，只读
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
      {/* 工作日与自然日只在不同时才并排显示，差异本身就是信号 */}
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
              : `自然日 ${natural} 天，工作日 ${working} 天` +
                (blocked > 0 ? `，其中 ${blocked} 天受阻` : "") +
                "。双击修改"
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
          {/* 这里是累计受阻天数（含已关掉的），与名字旁「⛔受阻」不同 */}
          {blocked > 0 && (
            <span
              title={`累计 ${blocked} 天没能正常推进`}
              className="ml-1.5 rounded px-1 font-mono text-[9px] font-semibold leading-none text-[var(--warn)]"
              style={{ background: "color-mix(in srgb, var(--warn) 16%, transparent)" }}
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
      {/* 父任务进度由子任务汇总，不可手填 */}
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
                : "进度只能在「实施」视图里修改"
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
              // 与甘特图计划条同一规则：超出计划红、计划内绿
              style={{ color: gap.end > 0 ? "var(--danger)" : "var(--ok)" }}
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
          ? "还没开始。到甘特图上拖虚线设置实施日期，或点这里采用计划日期"
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

/** 紧急程度列：点开即改。 */
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
        title={`${PRIORITY_LABELS[priority]}，点击修改`}
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

/** 头像 + 名字，点击从已有人员里选。 */
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
      {/* 不带横向 padding：内边距由 Cell 提供，否则会与表头错开 */}
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
              还没有负责人，到「设置 → 负责人」里添加。
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
        // 阻止冒泡，否则 Enter 会触发工作区的「新建任务」
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

/** 行的上下 28% 判为插到前/后，中间 44% 判为变成子任务 */
const EDGE = 0.28;
/** 移动超过这个距离才算拖拽，否则会误伤单击和双击 */
const DRAG_THRESHOLD = 5;
/** 距容器上下边缘小于这个距离时自动滚动 */
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

  // 拖到边缘时自动滚动，否则长列表拖不到远处
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
    // 从按钮、输入框上起手不算拖拽
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

    // 里程碑不接受子任务：中间区退化成「插到它后面」，避免中途没有落点提示
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

  const color = drop.valid ? "var(--accent)" : "var(--danger)";

  // 变成子任务用整行高亮框，插到前后用线：两种落点后果不同
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
            : "color-mix(in srgb, var(--danger) 8%, transparent)",
        }}
      />
    );
  }

  // 指示线缩进到落点的层级
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
