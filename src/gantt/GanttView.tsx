import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { AXIS_HEIGHT, getTheme, ROW_HEIGHTS } from "./theme";
import { drawContent, drawInteraction, drawStatic, type GanttMilestone } from "./render";
import { resolve, type ResolvedTask } from "./model";
import { Viewport, ZOOM_PRESETS, type ZoomPreset } from "./viewport";
import { dayToIso, isoToDay, today } from "./time";
import { cursorFor, hitTest, snapProgress, tapAdoptsPlanDates, type DragMode } from "./hitTest";
import { makeBarPainter } from "./coloring";
import {
  BLOCK_REASONS,
  clampToTask,
  newBlockId,
  type BlockReason,
  type BlockedPeriod,
} from "../core/blocked";
import { moveBy, resizeEnd, resizeStart } from "../core/dateLink";
import { makeCommand } from "../core/edits";
import { useAppStore } from "../store/useAppStore";
import { activeSpan } from "../core/viewMode";
import { resolveDark } from "../core/themeMode";

/** 甘特图画布：三层 Canvas 各自判脏重绘，拖拽时只刷交互层。 */

export interface GanttHandle {
  zoomToPreset: (p: ZoomPreset) => void;
  goToday: () => void;
  fitAll: () => void;
  currentPreset: () => ZoomPreset;
}

/** 拖动/单击判定阈值（px）。不能按日期差判：月视图下 20px 不足一天，拖动会被误判成单击。 */
const CLICK_SLOP = 4;

interface Props {
  scrollY: number;
  onScroll: (y: number) => void;
  onViewportReady?: (vp: Viewport, invalidate: () => void) => void;
}

export function GanttView({ scrollY, onScroll, onViewportReady }: Props) {
  const revision = useAppStore((s) => s.revision);
  const taskMap = useAppStore((s) => s.tasks);
  const calendar = useAppStore((s) => s.calendar);
  const colorBy = useAppStore((s) => s.colorBy);
  const rowHeight = ROW_HEIGHTS[useAppStore((s) => s.rowHeightKey)];
  const openDetail = useAppStore((s) => s.openDetail);
  const viewMode = useAppStore((s) => s.viewMode);
  const compareOn = useAppStore((s) => s.compareOn);
  const projectColor = useAppStore((s) => s.project?.color ?? "#2f6d5e");
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const run = useAppStore((s) => s.run);
  const runMerge = useAppStore((s) => s.runMerge);
  const addBlocked = useAppStore((s) => s.addBlocked);
  const adoptPlanDates = useAppStore((s) => s.adoptPlanDates);

  const tasks = useMemo(
    () => resolve([...taskMap.values()]),
    // revision 是就地修改的 Map 的变化信号
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskMap, revision],
  );

  /** 项目级里程碑 → 画布形状。导入的旧库可能带坏日期，直接丢掉，免得整个画布抛异常。 */
  const milestones = useAppStore((s) => s.milestones);
  const ganttMilestones = useMemo<GanttMilestone[]>(
    () =>
      milestones.flatMap((m) => {
        const day = isoToDay(m.date);
        return Number.isFinite(day)
          ? [{ id: m.id, name: m.name, day, color: m.color }]
          : [];
      }),
    [milestones],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLCanvasElement>(null);
  const interactRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef(new Viewport());

  // 拆成两个 selector：zustand v5 无默认浅比较，返回新数组会在 React 19 下持续重渲染
  const themeMode = useAppStore((s) => s.themeMode);
  const systemDark = useAppStore((s) => s.systemDark);
  const isDark = resolveDark(themeMode, systemDark);
  const [size, setSize] = useState({ w: 0, h: 0 });

  /** ⌥ 拖完、等用户在就地菜单里选原因的那一段 */
  const [pendingBlock, setPendingBlock] = useState<{
    taskId: number;
    period: BlockedPeriod;
    x: number;
    y: number;
  } | null>(null);

  /** 三层各自的脏标记 —— 拖拽时只有 interact 会被置脏 */
  const dirty = useRef({ static: true, content: true, interact: true });
  const markAll = () => {
    dirty.current.static = true;
    dirty.current.content = true;
    dirty.current.interact = true;
  };

  // 取色器要扫任务表，只在依赖变化时重建
  const painter = useMemo(
    () => makeBarPainter(tasks, colorBy, isDark, projectColor),
    [tasks, colorBy, isDark, projectColor],
  );

  /** 每行要画的受阻区间：折叠的父任务汇总后代区间；展开的父任务不画（子行已画）。 */
  const blockedOf = useMemo(() => {
    const all = [...taskMap.values()];
    const cache = new Map<number, BlockedPeriod[]>();

    const collect = (id: number, into: BlockedPeriod[]) => {
      for (const t of all) {
        if (t.parentId !== id) continue;
        into.push(...t.blocked);
        collect(t.id, into);
      }
    };

    for (const t of tasks) {
      if (t.hasChildren && t.collapsed) {
        const merged: BlockedPeriod[] = [...t.blocked];
        collect(t.id, merged);
        cache.set(t.id, merged);
      } else if (t.hasChildren) {
        cache.set(t.id, []);
      } else {
        cache.set(t.id, t.blocked);
      }
    }
    return (task: ResolvedTask) => cache.get(task.id) ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, taskMap, revision]);

  const live = useRef({
    tasks,
    isDark,
    selectedId,
    calendar,
    painter,
    colorBy,
    blockedOf,
    viewMode,
    compareOn,
    milestones: ganttMilestones,
    dragLabel: null as null | { index: number; label: string; snapped: boolean },
    cursorX: null as number | null,
    hoverId: null as number | null,
    marking: null as null | { index: number; from: number; to: number },
  });
  live.current.tasks = tasks;
  live.current.isDark = isDark;
  live.current.selectedId = selectedId;
  live.current.calendar = calendar;
  live.current.painter = painter;
  live.current.colorBy = colorBy;
  live.current.blockedOf = blockedOf;
  live.current.viewMode = viewMode;
  live.current.compareOn = compareOn;
  live.current.milestones = ganttMilestones;

  const maxScroll = () =>
    Math.max(0, tasks.length * rowHeight - (size.h - AXIS_HEIGHT));

  /* ---------------- 尺寸 / DPR / 主题 ---------------- */

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const vp = vpRef.current;
    vp.width = size.w;
    vp.height = size.h;
    const dpr = window.devicePixelRatio || 1;
    for (const ref of [staticRef, contentRef, interactRef]) {
      const c = ref.current;
      if (!c) continue;
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
      c.style.width = `${size.w}px`;
      c.style.height = `${size.h}px`;
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    markAll();
  }, [size]);

  useEffect(() => {
    dirty.current.content = true;
    dirty.current.interact = true;
  }, [tasks, selectedId, painter, colorBy, blockedOf, viewMode, compareOn, ganttMilestones]);

  // 改工作日历会影响底纹和星期行，切主题会改全部三层的颜色 —— 都要整幅重画
  useEffect(() => {
    markAll();
  }, [calendar, isDark]);

  // 行高变了几何全变，三层都要重画
  useEffect(() => {
    vpRef.current.rowHeight = rowHeight;
    markAll();
  }, [rowHeight]);

  useEffect(() => {
    vpRef.current.scrollY = scrollY;
    dirty.current.content = true;
    dirty.current.interact = true;
  }, [scrollY]);

  /* ---------------- 渲染循环 ---------------- */

  useEffect(() => {
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const vp = vpRef.current;

      // 缩放动画未收敛时，几何全变了，三层都得重画
      if (vp.step(dt)) markAll();

      if (vp.width > 0) {
        const theme = getTheme(live.current.isDark);
        if (dirty.current.static) {
          const ctx = staticRef.current?.getContext("2d");
          if (ctx) drawStatic(ctx, vp, theme, live.current.calendar);
          dirty.current.static = false;
        }
        if (dirty.current.content) {
          const ctx = contentRef.current?.getContext("2d");
          if (ctx)
            drawContent(
              ctx,
              vp,
              theme,
              live.current.tasks,
              live.current.painter,
              live.current.colorBy,
              live.current.isDark,
              live.current.blockedOf,
              live.current.viewMode,
              live.current.compareOn,
              live.current.milestones,
            );
          dirty.current.content = false;
        }
        if (dirty.current.interact) {
          const ctx = interactRef.current?.getContext("2d");
          if (ctx)
            drawInteraction(ctx, vp, theme, live.current.tasks, {
              selectedId: live.current.selectedId,
              dragging: live.current.dragLabel,
              cursorX: live.current.cursorX,
              hoverId: live.current.hoverId,
              marking: live.current.marking,
              mode: live.current.viewMode,
            });
          dirty.current.interact = false;
        }
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------------- 滚轮 ---------------- */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // 不 preventDefault 的话 Cmd+滚轮 会被 WebView 当成页面缩放抢走
      e.preventDefault();
      const vp = vpRef.current;
      const x = e.clientX - el.getBoundingClientRect().left;

      if (e.metaKey || e.ctrlKey) {
        vp.zoomAt(x, Math.exp(-e.deltaY * 0.0022));
        markAll();
      } else if (e.shiftKey) {
        vp.panBy(-e.deltaY);
        markAll();
      } else {
        if (e.deltaX) {
          vp.panBy(-e.deltaX);
          markAll();
        }
        if (e.deltaY) {
          onScroll(Math.min(maxScroll(), Math.max(0, vp.scrollY + e.deltaY)));
        }
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [tasks.length, size.h, rowHeight, onScroll]);

  /* ---------------- 拖拽 ---------------- */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    let drag: {
      mode: DragMode;
      task: ResolvedTask;
      index: number;
      /** 按下那一刻这条任务在当前视图下的区间 —— 拖动的基准 */
      span: { startDay: number; endDay: number };
      startX: number;
      /** 按下时鼠标相对真实进度位置的偏移。手柄被钳进安全区（hitTest.progressGripX），不记偏移进度会跳。 */
      grabOffset: number;
      /** 拖动父任务时要一起平移的整棵子树 */
      subtree: number[];
      /** 指针是否移动超过 CLICK_SLOP；区分单击采用计划与拖动落笔。不能看 onMove 是否触发过（挪 1px 也会来）。 */
      moved: boolean;
      /** 抓到的是否是未动过的虚线影子（hitTest 判定） */
      ghost: boolean;
    } | null = null;
    let panning = false;
    let lastPanX = 0;

    /** ⌥ 拖出受阻区间（裸拖拽已被移动/改工期/调进度占满） */
    let marking: { task: ResolvedTask; index: number; fromDay: number; toDay: number } | null = null;

    const localX = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left;
    const localY = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;

    const descendantsOf = (id: number): number[] => {
      const out: number[] = [];
      const walk = (parentId: number) => {
        for (const t of live.current.tasks) {
          if (t.parentId === parentId) {
            out.push(t.id);
            walk(t.id);
          }
        }
      };
      walk(id);
      return out;
    };

    const onDown = (e: PointerEvent) => {
      const vp = vpRef.current;
      const hit = hitTest(vp, live.current.tasks, localX(e), localY(e), live.current.viewMode);

      // ⌥ 标受阻：父任务（汇总值）和里程碑（无区间）不接
      if (e.altKey && hit && !hit.task.hasChildren && !hit.task.milestone) {
        const day = Math.floor(vp.dayAt(localX(e)));
        marking = { task: hit.task, index: hit.index, fromDay: day, toDay: day };
        select(hit.task.id);
        el.setPointerCapture(e.pointerId);
        dirty.current.interact = true;
        return;
      }

      if (hit?.mode) {
        select(hit.task.id);
        const px = localX(e);
        const dragged = activeSpan(hit.task, live.current.viewMode).span;
        const barX1 = vp.xOf(dragged.startDay);
        const barW = vp.xOf(dragged.endDay + 1) - barX1;

        drag = {
          mode: hit.mode,
          task: hit.task,
          index: hit.index,
          span: dragged,
          startX: px,
          grabOffset:
            hit.mode === "progress" ? px - (barX1 + barW * hit.task.progress) : 0,
          subtree: hit.task.hasChildren ? descendantsOf(hit.task.id) : [],
          moved: false,
          ghost: hit.ghost,
        };
        el.setPointerCapture(e.pointerId);
        return;
      }

      if (hit) select(hit.task.id);
      panning = true;
      lastPanX = e.clientX;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };

    const onMove = (e: PointerEvent) => {
      const vp = vpRef.current;

      if (marking) {
        marking.toDay = Math.floor(vp.dayAt(localX(e)));
        const from = Math.min(marking.fromDay, marking.toDay);
        const to = Math.max(marking.fromDay, marking.toDay);
        live.current.marking = { index: marking.index, from, to };
        live.current.dragLabel = {
          index: marking.index,
          label: `受阻 ${dayToIso(from)} → ${dayToIso(to)}`,
          snapped: false,
        };
        dirty.current.interact = true;
        return;
      }

      if (panning) {
        vp.panBy(e.clientX - lastPanX);
        lastPanX = e.clientX;
        markAll();
        return;
      }

      if (!drag) {
        const hit = hitTest(vp, live.current.tasks, localX(e), localY(e), live.current.viewMode);
        el.style.cursor = cursorFor(hit?.mode ?? null);
        // 游标和同期高亮只在交互层，移动鼠标不重绘条子
        live.current.cursorX = localX(e);
        live.current.hoverId = hit?.mode ? hit.task.id : null;
        dirty.current.interact = true;
        return;
      }

      const { tasks: current } = live.current;
      const fresh = current.find((t) => t.id === drag!.task.id);
      if (!fresh) return;

      if (Math.abs(localX(e) - drag.startX) >= CLICK_SLOP) drag.moved = true;

      const store = useAppStore.getState();
      const original = store.tasks.get(drag.task.id);
      if (!original) return;

      if (drag.mode === "progress") {
        const cur = activeSpan(fresh, live.current.viewMode).span;
        const x1 = vp.xOf(cur.startDay);
        const width = vp.xOf(cur.endDay + 1) - x1;
        const { value, snapped } = snapProgress(
          (localX(e) - drag.grabOffset - x1) / width,
        );
        runMerge(
          makeCommand("调整进度", store.tasks, [
            { id: fresh.id, changes: { progress: value } },
          ]),
        );
        live.current.dragLabel = {
          index: drag.index,
          label: `${Math.round(value * 100)}%`,
          snapped,
        };
      } else {
        const deltaDays = Math.round((localX(e) - drag.startX) / vp.pxPerDay);
        const base = drag.span;

        let span: { startDay: number; endDay: number };
        let label: string;

        const cal = live.current.calendar;
        // 同时报自然日和工作日，跨周末的工时缩水拖动当下就能看见
        const span2 = (s: { startDay: number; endDay: number }) =>
          `${cal.countCalendarDays(s.startDay, s.endDay)} 天 · ${cal.countWorkdays(
            s.startDay,
            s.endDay,
          )} 工作日`;

        if (drag.mode === "move") {
          span = moveBy(base, deltaDays);
          label = `${dayToIso(span.startDay)} → ${dayToIso(span.endDay)} · ${span2(span)}`;
        } else if (drag.mode === "resizeStart") {
          span = resizeStart(base, base.startDay + deltaDays);
          label = `${dayToIso(span.startDay)} · ${span2(span)}`;
        } else {
          span = resizeEnd(base, base.endDay + deltaDays);
          label = `${dayToIso(span.endDay)} · ${span2(span)}`;
        }

        const isActual = live.current.viewMode === "actual";
        const shift = span.startDay - base.startDay;
        const commandLabel =
          drag.mode === "move"
            ? drag.subtree.length > 0
              ? `平移 ${drag.subtree.length} 个任务`
              : isActual
                ? "调整实施日期"
                : "移动任务"
            : isActual
              ? "调整实施工期"
              : "调整工期";

        // 父任务日期是汇总值，只能整组平移子任务
        const targets =
          drag.subtree.length > 0
            ? drag.subtree.map((id) => {
                const child = store.tasks.get(id)!;
                const childSpan = isActual
                  ? child.actualStartDay != null && child.actualEndDay != null
                    ? { startDay: child.actualStartDay, endDay: child.actualEndDay }
                    : { startDay: child.startDay, endDay: child.endDay }
                  : { startDay: child.startDay, endDay: child.endDay };
                return { id, changes: moveBy(childSpan, shift) };
              })
            : [{ id: fresh.id, changes: span }];

        runMerge(
          makeCommand(
            commandLabel,
            store.tasks,
            // 实施视图写 actual* 字段；拖未动过的虚线即落笔成实施条
            targets.map(({ id, changes }) =>
              isActual
                ? {
                    id,
                    changes: {
                      actualStartDay: changes.startDay,
                      actualEndDay: changes.endDay,
                    },
                  }
                : { id, changes },
            ),
          ),
        );
        live.current.dragLabel = { index: drag.index, label, snapped: false };
      }

      dirty.current.content = true;
      dirty.current.interact = true;
    };

    const onUp = (e: PointerEvent) => {
      if (marking) {
        const { task } = marking;
        const from = Math.min(marking.fromDay, marking.toDay);
        const to = Math.max(marking.fromDay, marking.toDay);
        // 裁到任务区间内
        const clipped = clampToTask(
          { id: newBlockId(), from, to, reason: "other" },
          task,
        );
        marking = null;
        live.current.marking = null;
        live.current.dragLabel = null;
        dirty.current.interact = true;
        el.releasePointerCapture(e.pointerId);

        if (clipped) {
          // 松手处就地选原因，不默认「其他」
          setPendingBlock({
            taskId: task.id,
            period: clipped,
            x: e.clientX,
            y: e.clientY,
          });
        }
        return;
      }

      // 单击虚线 = 采用计划日期。实施日期在松手时从 store 重取，不用 drag 快照（中途可能被改过）。
      if (drag?.ghost) {
        const latest = useAppStore.getState().tasks.get(drag.task.id);
        if (
          tapAdoptsPlanDates({
            viewMode: live.current.viewMode,
            ghost: drag.ghost,
            moved: drag.moved,
            actualStartDay: latest?.actualStartDay,
          })
        ) {
          adoptPlanDates(drag.task.id);
          dirty.current.content = true;
        }
      }

      drag = null;
      panning = false;
      live.current.dragLabel = null;
      dirty.current.interact = true;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = "default";
    };

    // 双击开详情（单击已是选中 + 起手拖拽）
    const onDouble = (e: PointerEvent) => {
      const hit = hitTest(vpRef.current, live.current.tasks, localX(e), localY(e), live.current.viewMode);
      if (hit?.mode) openDetail(hit.task.id);
    };
    el.addEventListener("dblclick", onDouble as EventListener);

    /** 右键某一天记一笔：命中任务则挂到该任务，点空白写成项目级记录。 */
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const vp = vpRef.current;
      const day = Math.floor(vp.dayAt(localX(e as unknown as PointerEvent)));
      const hit = hitTest(
        vp,
        live.current.tasks,
        localX(e as unknown as PointerEvent),
        localY(e as unknown as PointerEvent),
        live.current.viewMode,
      );
      // 父任务不接记录（汇总值）
      const taskId = hit?.mode && !hit.task.hasChildren ? hit.task.id : null;
      if (taskId != null) select(taskId);
      useAppStore.getState().startNoteAt(taskId, day);
    };
    el.addEventListener("contextmenu", onContext);

    const onLeave = () => {
      live.current.cursorX = null;
      live.current.hoverId = null;
      dirty.current.interact = true;
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("dblclick", onDouble as EventListener);
      el.removeEventListener("contextmenu", onContext);
    };
  }, [run, runMerge, select, openDetail]);

  /* ---------------- 对外句柄 ---------------- */

  useEffect(() => {
    if (size.w === 0 || !onViewportReady) return;
    onViewportReady(vpRef.current, markAll);
  }, [size.w, onViewportReady]);

  const didInit = useRef(false);
  useEffect(() => {
    if (size.w === 0 || didInit.current) return;
    didInit.current = true;
    const vp = vpRef.current;
    vp.anchorDay = today();
    vp.anchorX = size.w * 0.3;
    markAll();
  }, [size.w]);

  return (
    <div
      ref={wrapRef}
      className="relative min-w-0 flex-1 select-none overflow-hidden"
      style={{ touchAction: "none" }}
    >
      <canvas ref={staticRef} className="absolute inset-0" />
      <canvas ref={contentRef} className="absolute inset-0" />
      <canvas ref={interactRef} className="absolute inset-0" />

      {pendingBlock && (
        <BlockReasonMenu
          x={pendingBlock.x}
          y={pendingBlock.y}
          onPick={(reason, note) => {
            const { taskId, period } = pendingBlock;
            setPendingBlock(null);
            addBlocked(taskId, { ...period, reason, ...(note ? { note } : {}) });
          }}
          onCancel={() => setPendingBlock(null)}
        />
      )}
    </div>
  );
}

export { ZOOM_PRESETS };
export type { ZoomPreset };

/** 松手处的原因菜单（锚点是鼠标位置，不用 Popover）。Esc/点外面取消整次创建。 */
function BlockReasonMenu({
  x,
  y,
  onPick,
  onCancel,
}: {
  x: number;
  y: number;
  onPick: (reason: BlockReason, note?: string) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest("[data-block-menu]")) onCancel();
    };
    const id = setTimeout(() => {
      window.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onDown);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onCancel]);

  return createPortal(
    <motion.div
      data-block-menu
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      style={{
        position: "fixed",
        left: Math.min(x + 8, window.innerWidth - 156),
        top: Math.min(y + 8, window.innerHeight - 210),
        width: 148,
      }}
      className="z-[300] overflow-hidden rounded-lg border border-[var(--rule)] bg-[var(--surface)] py-1 shadow-2xl"
    >
      <div className="px-2.5 py-1 text-[9px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
        受阻原因
      </div>
      {BLOCK_REASONS.map((r) => (
        <button
          key={r.key}
          onClick={() => onPick(r.key)}
          className="flex w-full items-center px-2.5 py-1.5 text-left text-[11px] text-[var(--text)] hover:bg-[var(--row-hover)]"
        >
          {r.label}
        </button>
      ))}

      {/* 自己写。归类仍记为「其他」，但显示时以这行文字为准 —— 
          类型是给统计用的，人要看的是具体发生了什么 */}
      <div className="mt-1 border-t border-[var(--rule)] px-1.5 pb-0.5 pt-1.5">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && custom.trim()) onPick("other", custom.trim());
            if (e.key === "Escape") onCancel();
          }}
          placeholder="或自己写…"
          className="w-full rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-1.5 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
        />
      </div>
    </motion.div>,
    document.body,
  );
}
