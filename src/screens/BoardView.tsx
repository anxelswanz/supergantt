/**
 * 看板视图。
 *
 * 四列全部由 core/board.ts 推导，任务上没有 status 字段（那里有为什么）。
 * 拖动卡片不是"改状态"，而是**写回底层字段** —— 拖进"进行中"就是填实施
 * 开始日，拖进"受阻"就是开一条阻碍。所以看板和甘特、时间线、复盘永远自洽：
 * 它们看的是同一批字段，只是问法不同。
 *
 * 这里还有两件独立于列的事，摆在顶部工具条上：
 *   · **阻碍**（Blockers）—— 已经在挡路的。未关闭的每天自动加一天，
 *     并顺延任务的计划结束日，直到有人手动关掉（core/blocked.ts）
 *   · **风险**（Risks）—— 可能会挡路的。挂在任务上，按等级排，逐条手动关闭
 *
 * 两者在卡片上是**两个独立标识**，不再合并成一个含糊的「卡住」：
 * 看的人要能一眼分出「今天就得去处理」和「安排人盯着」。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  BOARD_COLUMNS,
  boardTasks,
  canRecordBlocker,
  columnOf,
  moveToColumn,
  type BoardColumn,
} from "../core/board";
import {
  BLOCK_REASONS,
  blockedSpanDays,
  describeBlocked,
  openBlocks,
  type BlockReason,
} from "../core/blocked";
import { RISK_COLORS, riskFlags, riskLevelLabel, type RiskFlag } from "../core/risks";
import { withAlpha } from "../gantt/coloring";
import { RiskPanel } from "./RiskPanel";
import { BlockerPanel } from "./BlockerPanel";
import { BlockedDetail } from "./BlockedDetail";
import { AnimatePresence } from "motion/react";
import { today } from "../gantt/time";
import { resolve, type ResolvedTask } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";
import type { Person } from "../db/api";
import { Avatar } from "./Avatar";
import { PRIORITY_COLORS } from "../gantt/theme";
import { dayToIso, isoToDay } from "../gantt/time";

/** 列头的颜色。受阻用红，其余走中性 —— 只有一件事需要被一眼看到 */
const COLUMN_TINT: Record<BoardColumn, string> = {
  todo: "var(--text-dim)",
  doing: "var(--accent)",
  blocked: "#f43f5e",
  done: "#10b981",
};

export function BoardView() {
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const people = useAppStore((s) => s.people);
  const selectedId = useAppStore((s) => s.selectedId);
  const patchTask = useAppStore((s) => s.patchTask);
  const select = useAppStore((s) => s.select);
  const openDetail = useAppStore((s) => s.openDetail);
  const projectRisks = useAppStore((s) => s.projectRisks);
  const addBlocker = useAppStore((s) => s.addBlocker);
  const closeBlocker = useAppStore((s) => s.closeBlocker);

  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => boardTasks(resolve([...taskMap.values()])),
    [taskMap, revision],
  );

  /** 父任务的名字链，卡片上显示成面包屑 —— 否则"三层楼砌墙"这种名字全一样的活分不清 */
  const pathOf = useMemo(() => {
    const all = new Map([...taskMap.values()].map((t) => [t.id, t]));
    return (task: ResolvedTask): string => {
      const parts: string[] = [];
      let pid = task.parentId;
      while (pid != null) {
        const p = all.get(pid);
        if (!p) break;
        parts.unshift(p.name || "未命名");
        pid = p.parentId;
      }
      return parts.join(" / ");
    };
  }, [taskMap]);

  const grouped = useMemo(() => {
    const out: Record<BoardColumn, ResolvedTask[]> = {
      todo: [], doing: [], blocked: [], done: [],
    };
    for (const t of tasks) out[columnOf(t, day)].push(t);
    return out;
  }, [tasks, day]);

  /** taskId → 未关闭的风险。卡片角标按它显示，和受阻是两个独立标识 */
  const flags = useMemo(() => riskFlags(projectRisks), [projectRisks]);

  /**
   * 能记阻碍的活：已经开工的都算 —— 进行中的、卡住的，以及**已经做完的**。
   * 最后一种是补记：复盘会上想起来「上个月这条活等了三天料」，
   * 那时它早就在已完成列里了（core/board.canRecordBlocker）。
   */
  const blockable = useMemo(
    () => tasks.filter((t) => canRecordBlocker(t, day)),
    [tasks, day],
  );

  const [composing, setComposing] = useState(false);
  /** 右侧面板一次只开一个 —— 两个 380px 抽屉并排会把看板挤没 */
  const [panel, setPanel] = useState<"blockers" | "risks" | null>(null);
  /** 拖进"卡住"列时要先问清原因 —— 不问就只能记成「其他」，归因视图里等于没记 */
  const [askReason, setAskReason] = useState<number | null>(null);
  /**
   * 从阻碍清单点开的那一条。存 id 不存对象 —— 对象在编辑之后就是旧的了
   * （和 TaskDetail 同一套）。那条记录被删掉或整段丢掉时，这里查不到，
   * 面板自然不渲染
   */
  const [blockedDetail, setBlockedDetail] = useState<
    { taskId: number; periodId: string } | null
  >(null);
  const blockedPeriod = blockedDetail
    ? (taskMap
        .get(blockedDetail.taskId)
        ?.blocked.find((p) => p.id === blockedDetail.periodId) ?? null)
    : null;

  const drop = (taskId: number, column: BoardColumn) => {
    const task = taskMap.get(taskId);
    if (!task) return;
    if (column === "blocked") {
      setAskReason(taskId);
      return;
    }
    const changes = moveToColumn(task, column, day, "other");
    if (changes) patchTask(task.id, changes, `移到「${labelOf(column)}」`);
  };
  const dnd = useCardDrag(drop);

  const openRiskCount = projectRisks.filter((r) => !r.resolved).length;
  const openBlockerCount = tasks.reduce((n, t) => n + openBlocks(t.blocked).length, 0);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* min-w-0：flex item 默认 min-width:auto，列区会顶着不肯收缩，
          把右边的风险面板整个推出可视区。列区自己有横向滚动，缩得起 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/*
          两个入口并排摆在看板顶上，因为它们是同一件事的两半：
          阻碍 = 已经在挡路的，风险 = 可能会挡路的。分开记、分开关，
          但要在同一个地方能想起来去看。
        */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
          <span className="text-[10px] text-[var(--text-dim)]">
            列是算出来的：拖卡片改的是底层日期与进度，不是某个状态字段
          </span>

          <div className="ml-auto flex items-center gap-2">
            {/* 两个清单入口，各自打开一个面板。新建入口收在面板里 ——
                在那儿能先看见已经记过什么，不容易重复记一条 */}
            <button
              onClick={() => setPanel((p) => (p === "blockers" ? null : "blockers"))}
              title="全项目的阻碍，含已经关掉的历史记录"
              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={
                panel === "blockers"
                  ? { borderColor: "var(--accent)", color: "var(--accent)" }
                  : { borderColor: "var(--rule)", color: "var(--text-dim)" }
              }
            >
              ⛔ 阻碍清单
              {openBlockerCount > 0 && (
                <span className="ml-1 text-[#f43f5e]">{openBlockerCount}</span>
              )}
            </button>

            <button
              onClick={() => setPanel((p) => (p === "risks" ? null : "risks"))}
              title="全项目的风险，含已经关掉的"
              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={
                panel === "risks"
                  ? { borderColor: "var(--accent)", color: "var(--accent)" }
                  : { borderColor: "var(--rule)", color: "var(--text-dim)" }
              }
            >
              ⚠ 风险清单
              {openRiskCount > 0 && (
                <span className="ml-1 text-[#f59e0b]">{openRiskCount}</span>
              )}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {BOARD_COLUMNS.map((col) => {
        const items = grouped[col.key];
        const isOver = dnd.overCol === col.key;
        return (
          <div
            key={col.key}
            ref={dnd.columnRef(col.key)}
            data-board-column={col.key}
            className="flex min-h-0 w-[280px] shrink-0 flex-col rounded-xl border transition-colors"
            style={{
              borderColor: isOver ? COLUMN_TINT[col.key] : "var(--rule)",
              background: isOver ? "var(--row-hover)" : "var(--surface-alt)",
            }}
          >
            <div className="shrink-0 px-3 pt-3 pb-2">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-xs font-semibold"
                  style={{ color: COLUMN_TINT[col.key] }}
                >
                  {col.label}
                </span>
                <span className="text-xs text-[var(--text-dim)]">{items.length}</span>
              </div>
              {/* 判据写在列头下面：列是算出来的，不写出来没人猜得到卡片为什么在这 */}
              <div className="mt-0.5 text-[10px] leading-tight text-[var(--text-dim)]">
                {col.rule}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {items.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  path={pathOf(task)}
                  people={people}
                  selected={task.id === selectedId}
                  dragging={dnd.dragId === task.id}
                  day={day}
                  risk={flags.get(task.id) ?? null}
                  onCloseBlocker={(periodId) => closeBlocker(task.id, periodId)}
                  onPointerDown={(e) => dnd.start(task.id, task.name || "未命名", e)}
                  onClick={() => select(task.id)}
                  onDoubleClick={() => openDetail(task.id)}
                />
              ))}
              {items.length === 0 && (
                <div className="grid h-16 place-items-center rounded-lg border border-dashed border-[var(--rule)] text-[11px] text-[var(--text-dim)]">
                  空
                </div>
              )}
            </div>
          </div>
        );
      })}

        </div>
      </div>

      {/* 跟手的小标签：拖的是哪张卡，一眼就知道 */}
      {dnd.ghost && (
        <div
          className="pointer-events-none fixed z-50 max-w-[240px] truncate rounded-lg border border-[var(--accent)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] shadow-lg"
          style={{ left: dnd.ghost.x + 12, top: dnd.ghost.y + 8 }}
        >
          {dnd.ghost.name}
        </div>
      )}

      <AnimatePresence>
        {panel === "blockers" && (
          <BlockerPanel
            onClose={() => setPanel(null)}
            onCompose={() => setComposing(true)}
            onOpenBlocked={(taskId, periodId) => setBlockedDetail({ taskId, periodId })}
          />
        )}
        {panel === "risks" && <RiskPanel onClose={() => setPanel(null)} />}
      </AnimatePresence>

      {composing && (
        <BlockerComposer
          candidates={blockable}
          day={day}
          onSubmit={(taskId, reason, note, span, live) => {
            addBlocker(taskId, reason, note, span, live);
            setComposing(false);
          }}
          onCancel={() => setComposing(false)}
        />
      )}

      {blockedDetail && blockedPeriod && (
        <BlockedDetail
          taskId={blockedDetail.taskId}
          period={blockedPeriod}
          onClose={() => setBlockedDetail(null)}
        />
      )}

      {askReason != null && (
        <ReasonPicker
          onPick={(reason) => {
            const task = taskMap.get(askReason);
            setAskReason(null);
            if (!task) return;
            const changes = moveToColumn(task, "blocked", day, reason);
            if (changes) patchTask(task.id, changes, "标记受阻");
          }}
          onCancel={() => setAskReason(null)}
        />
      )}
    </div>
  );
}

const labelOf = (c: BoardColumn) =>
  BOARD_COLUMNS.find((x) => x.key === c)?.label ?? c;

/** 按下之后挪过这么多像素才算开始拖 —— 否则每次点选都会闪一下拖拽态 */
const DRAG_THRESHOLD = 5;

/**
 * 卡片拖拽，用指针事件实现。
 *
 * 不用 HTML5 的 draggable：Tauri 在 Windows 上默认接管窗口的拖放（项目列表
 * 要接住从资源管理器拖进来的 .ganttproj / .db），代价是网页里的 HTML5 拖拽
 * 整个失效 —— 卡片按住了拖不动。macOS 上一切正常，所以这种 bug 只有换到
 * 另一台机器上才看得见。指针事件不经过那一层，两个平台行为一致；
 * 左侧网格的行拖拽用的也是这一套。
 */
function useCardDrag(onDrop: (taskId: number, column: BoardColumn) => void) {
  const columns = useRef(new Map<BoardColumn, HTMLElement>());
  // 拖拽横跨好几次渲染，落下时要用最新的那个回调，而不是按下时的快照
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const stopRef = useRef<(() => void) | null>(null);

  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<BoardColumn | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);

  // 拖到一半视图被切走：别把监听器留在 window 上
  useEffect(() => () => stopRef.current?.(), []);

  const columnRef = (key: BoardColumn) => (el: HTMLElement | null) => {
    if (el) columns.current.set(key, el);
    else columns.current.delete(key);
  };

  const columnAt = (x: number, y: number): BoardColumn | null => {
    for (const [key, el] of columns.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return key;
    }
    return null;
  };

  const start = (taskId: number, name: string, e: React.PointerEvent) => {
    // 只认主键；卡片上的「✓ 关闭」这类按钮是它们自己的交互
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, select")) return;
    stopRef.current?.();

    const origin = { x: e.clientX, y: e.clientY };
    let active = false;
    let over: BoardColumn | null = null;

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD) return;
        active = true;
        setDragId(taskId);
      }
      over = columnAt(ev.clientX, ev.clientY);
      setOverCol(over);
      setGhost({ x: ev.clientX, y: ev.clientY, name });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      stopRef.current = null;
      setDragId(null);
      setOverCol(null);
      setGhost(null);
    };
    const up = () => {
      const target = active ? over : null;
      stop();
      if (target) dropRef.current(taskId, target);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    stopRef.current = stop;
  };

  return { dragId, overCol, ghost, columnRef, start };
}

function Card({
  task,
  path,
  people,
  selected,
  dragging,
  day,
  risk,
  onCloseBlocker,
  onPointerDown,
  onClick,
  onDoubleClick,
}: {
  task: ResolvedTask;
  path: string;
  people: Person[];
  selected: boolean;
  dragging: boolean;
  day: number;
  /** 未关闭的风险；没有就是 null */
  risk: RiskFlag | null;
  onCloseBlocker: (periodId: string) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const person = people.find((p) => p.id === task.personId) ?? null;
  const pct = Math.round(task.progress * 100);
  const late = task.actualEndDay != null && task.actualEndDay > task.endDay;

  /**
   * 卡片上的两个标识，来源不同、动作也不同：
   *
   *   · 阻碍 —— 没关掉的那几条，每条单独一行，就地能关
   *   · 风险 —— 一个角标，点开详情或风险清单去处理
   *
   * 之前这里只有一个含糊的「卡住」，两件事混在一个红条里：看的人既不知道
   * 是已经挡住了还是可能会挡住，也不知道该现在打电话还是排进周会。
   */
  const live = openBlocks(task.blocked);
  // 没有未关闭的阻碍，但今天落在一段历史标注里（⌥ 拖出来的那种）——
  // 同样是卡着，只是没有可关的对象
  const marked =
    live.length === 0
      ? task.blocked.find((b) => b.from <= day && day <= b.to)
      : undefined;

  return (
    <motion.div
      layout
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="cursor-grab rounded-lg border bg-[var(--surface)] p-2.5 active:cursor-grabbing"
      style={{
        borderColor: selected ? "var(--accent)" : "var(--rule)",
        opacity: dragging ? 0.4 : 1,
      }}
    >
      {path && (
        <div className="mb-1 truncate text-[10px] text-[var(--text-dim)]">{path}</div>
      )}
      <div className="flex items-start gap-1.5">
        {task.priority === 0 && (
          <span
            className="mt-[3px] size-2 shrink-0 rotate-45"
            style={{ background: PRIORITY_COLORS[0] }}
            title="P0 紧急"
          />
        )}
        <span className="text-xs leading-snug font-medium text-[var(--text)]">
          {task.name || "未命名"}
        </span>
      </div>

      {(live.length > 0 || risk) && (
        <div className="mt-1.5 flex flex-col gap-1">
          {live.map((b) => (
            <div
              key={b.id}
              className="group/blk flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] text-[#f43f5e] ring-1 ring-[#f43f5e]/30"
            >
              <span className="min-w-0 flex-1 truncate">
                {describeBlocked(b)} · 已 {blockedSpanDays(b, day)} 天
              </span>
              {/* 就地关闭：卡片是最常看到阻碍的地方，让人为了关一条阻碍
                  再点进详情，等于保证没人会去关 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseBlocker(b.id);
                }}
                title="这条阻碍已解决"
                className="shrink-0 rounded px-1 font-medium text-[var(--text-dim)] opacity-0 transition-opacity hover:text-emerald-600 group-hover/blk:opacity-100"
              >
                ✓ 关闭
              </button>
            </div>
          ))}

          {marked && (
            <div className="truncate rounded px-1.5 py-0.5 text-[10px] text-[#f43f5e] ring-1 ring-[#f43f5e]/30">
              {describeBlocked(marked)} · 已 {blockedSpanDays(marked, day)} 天
            </div>
          )}

          {risk && (
            <div
              className="flex items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-[10px]"
              style={{
                color: RISK_COLORS[risk.top],
                background: withAlpha(RISK_COLORS[risk.top], 0.12),
              }}
            >
              ⚠ {risk.count} 条风险未关闭 · 最高{riskLevelLabel(risk.top)}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Avatar person={person} size={16} />
        <span className="text-[10px] text-[var(--text-dim)]">
          {task.actualStartDay != null
            ? `${dayToIso(task.actualStartDay)} 起`
            : `计划 ${dayToIso(task.startDay)}`}
        </span>
        {late && (
          <span className="text-[10px] font-medium text-[#f43f5e]" title="实施结束晚于计划">
            超期
          </span>
        )}
        <span className="ml-auto text-[10px] font-medium text-[var(--text-dim)]">
          {pct}%
        </span>
      </div>

      {/* 进度条。看板上不给拖 —— 拖进度是甘特的事，这里一个手势只干一件事 */}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-alt)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "var(--accent)" }}
        />
      </div>
    </motion.div>
  );
}

/**
 * 独立新建一条阻碍。
 *
 * 和「把卡片拖进受阻列」的区别只在入口：那条路先有任务、再问原因；
 * 这条路是周会上想起来「三号机还等着厂家」，先选活再说卡在什么上。
 * 两条路产出的是同一种东西 —— 一条未关闭的阻碍（core/board.newBlocker）。
 *
 * 任务下拉里只有**进行中**的活。这是产品定的规矩，理由在 board.isInProgress：
 * 还没开工的活谈不上推不动，已完成的活挂一条没关的阻碍就是个假警报。
 */
function BlockerComposer({
  candidates,
  day,
  onSubmit,
  onCancel,
}: {
  candidates: ResolvedTask[];
  day: number;
  onSubmit: (
    taskId: number,
    reason: BlockReason,
    note: string | undefined,
    span: { from: number; to: number },
    live: boolean,
  ) => void;
  onCancel: () => void;
}) {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [reason, setReason] = useState<BlockReason>("material");
  const [note, setNote] = useState("");

  const target = taskId ?? candidates[0]?.id ?? null;
  const task = candidates.find((t) => t.id === target) ?? null;

  /**
   * 两种默认值，按选中的那条活自己决定：
   *
   *   · 还在做的  —— 「此刻卡着」：从今天起算，持续中开着（原来的行为）
   *   · 已经做完的 —— 「补记」：持续中关掉，日期落在它自己的区间末尾。
   *     补记的是过去的事，从今天起算会凭空把一条做完的活拽回受阻列
   */
  const [live, setLive] = useState(true);
  const [from, setFrom] = useState(day);
  const [until, setUntil] = useState(day);

  // 换一条活就重算默认值 —— 把上一条活的日期留在这儿，多半是错的
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!task) return;
    const done = task.progress >= 1;
    const anchor = done ? (task.actualEndDay ?? task.endDay) : day;
    setLive(!done);
    setFrom(anchor);
    setUntil(anchor);
  }, [task?.id, day]);

  // 和阻碍详情面板同一套口径：持续中的终点就是今天，手填的只夹前面那一头
  const to = live ? Math.max(from, day) : Math.max(from, until);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30" onClick={onCancel}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[340px] rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3.5 shadow-xl"
      >
        <div className="text-xs font-semibold text-[var(--text)]">
          {live ? "新建阻碍" : "补记阻碍"}
        </div>
        <div className="mt-0.5 mb-2.5 text-[10px] leading-relaxed text-[var(--text-dim)]">
          {live
            ? "持续中：终止日每天自动跟到今天，并同步顺延这条活的计划结束日，直到有人手动关掉它。"
            : "已经过去的一段：按下面填的日期记下来，不再自动延长。"}
        </div>

        <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
          卡住的是哪条活
        </label>
        <select
          value={target ?? ""}
          onChange={(e) => setTaskId(Number(e.target.value))}
          className="mb-2.5 w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--text)]"
        >
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "未命名"}
              {t.progress >= 1 ? "（已完成）" : ""}
            </option>
          ))}
        </select>

        {/* 日期。已完成的活默认填好它自己的区间末尾，改不改都行 */}
        <div className="mb-2.5 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
              从哪天起
            </label>
            <input
              type="date"
              value={dayToIso(from)}
              title="这段受阻的第一天"
              onChange={(e) => {
                if (!e.target.value) return;
                setFrom(isoToDay(e.target.value));
              }}
              className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--text)]"
            />
          </div>
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
              到哪天为止
            </label>
            <input
              type="date"
              value={dayToIso(to)}
              min={dayToIso(from)}
              disabled={live}
              title={
                live
                  ? "持续中：终点就是今天，明天会自动变成明天"
                  : "这段受阻的最后一天"
              }
              onChange={(e) => {
                if (!e.target.value) return;
                setUntil(Math.max(from, isoToDay(e.target.value)));
              }}
              className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--text)] disabled:opacity-55"
            />
          </div>
        </div>

        {/* 持续中开关。已完成的活默认关着 —— 补记一段历史不该让它重新卡住 */}
        <button
          onClick={() => {
            if (live) setUntil(Math.max(from, day));
            setLive((v) => !v);
          }}
          className="mb-2.5 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors"
          style={{
            borderColor: live ? "#f43f5e" : "var(--rule)",
            background: live ? "rgba(244,63,94,0.06)" : "transparent",
          }}
        >
          <span
            className="grid h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors"
            style={{ background: live ? "#f43f5e" : "var(--rule)" }}
          >
            <span
              className="block size-3 rounded-full bg-white transition-transform"
              style={{ transform: live ? "translateX(12px)" : "translateX(0)" }}
            />
          </span>
          <span className="text-[11px] font-medium text-[var(--text)]">持续中</span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
            共 {to - from + 1} 天
          </span>
        </button>

        <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
          卡在什么上
        </label>
        <div className="mb-2.5 grid grid-cols-3 gap-1.5">
          {BLOCK_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              className="rounded-lg border px-2 py-1.5 text-[11px] transition-colors"
              style={
                reason === r.key
                  ? { borderColor: "#f43f5e", color: "#f43f5e" }
                  : { borderColor: "var(--rule)", color: "var(--text-dim)" }
              }
            >
              {r.label}
            </button>
          ))}
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="具体是什么？（比如：三号机主轴异响，等厂家上门）"
          className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />

        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={onCancel}
            className="ml-auto rounded-lg px-3 py-1 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            onClick={() =>
              target != null && onSubmit(target, reason, note, { from, to }, live)
            }
            disabled={target == null}
            className="rounded-lg px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            style={{ background: "#f43f5e" }}
          >
            记下来
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * 拖进"受阻"列时问一句为什么。
 *
 * 多这一步是故意的：受阻原因是复盘视图里唯一能回答"这个月的时间去哪了"的
 * 数据。默认记成「其他」的话，月底那张归因图上会有一整块无法解释的面积。
 */
function ReasonPicker({
  onPick,
  onCancel,
}: {
  onPick: (r: BlockReason) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[280px] rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3 shadow-xl"
      >
        <div className="mb-2 text-xs font-semibold text-[var(--text)]">卡在什么上？</div>
        <div className="grid grid-cols-2 gap-1.5">
          {BLOCK_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => onPick(r.key)}
              className="rounded-lg border border-[var(--rule)] px-2 py-1.5 text-xs text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
            >
              {r.label}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
