import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { AXIS_HEIGHT, getTheme, ROW_HEIGHTS } from "./theme";
import { drawContent, drawInteraction, drawStatic } from "./render";
import { resolve, type ResolvedTask } from "./model";
import { Viewport, ZOOM_PRESETS, type ZoomPreset } from "./viewport";
import { dayToIso, today } from "./time";
import { cursorFor, hitTest, snapProgress, type DragMode } from "./hitTest";
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

/**
 * 甘特图画布。
 *
 * 三层 Canvas 叠加，各自独立判断是否重绘。拖拽过程中静态层和内容层完全不动，
 * 只有交互层每帧刷新 —— 这是「不掉帧」的结构保证（DESIGN.md §6.2）。
 */

export interface GanttHandle {
  zoomToPreset: (p: ZoomPreset) => void;
  goToday: () => void;
  fitAll: () => void;
  currentPreset: () => ZoomPreset;
}

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
  const projectColor = useAppStore((s) => s.project?.color ?? "#6366f1");
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const run = useAppStore((s) => s.run);
  const runMerge = useAppStore((s) => s.runMerge);
  const addBlocked = useAppStore((s) => s.addBlocked);

  const tasks = useMemo(
    () => resolve([...taskMap.values()]),
    // revision 是就地修改的 Map 的变化信号，见 useAppStore 的说明
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskMap, revision],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLCanvasElement>(null);
  const interactRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef(new Viewport());

  const [isDark, setIsDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
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

  // 取色器只在任务集合、着色依据或主题变化时重建 —— 它内部要扫两遍任务表，
  // 不能每帧算一次
  const painter = useMemo(
    () => makeBarPainter(tasks, colorBy, isDark, projectColor),
    [tasks, colorBy, isDark, projectColor],
  );

  /**
   * 每一行要画的受阻区间。
   *
   * 折叠起来的父任务要**汇总后代的**区间 —— 否则一折叠，所有问题就整个藏起来了。
   * 展开时父条不画，因为子任务自己那几行已经画过，重复画只会满屏斜纹。
   */
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
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setIsDark(mq.matches);
      markAll();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    dirty.current.content = true;
    dirty.current.interact = true;
  }, [tasks, selectedId, isDark, painter, colorBy, blockedOf, viewMode, compareOn]);

  // 改工作日历会影响底纹和星期行，那都在静态层
  useEffect(() => {
    markAll();
  }, [calendar]);

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
      /**
       * 按下时鼠标相对**真实进度位置**的偏移。
       *
       * 手柄的绘制位置被钳进了两端手柄之间的安全区（见 hitTest.progressGripX），
       * 所以 0% 时它并不在条子最左边。不记这个偏移的话，一按下去进度就会
       * 从 0 跳到「手柄所在位置对应的值」—— 用户会以为自己手抖了。
       */
      grabOffset: number;
      /** 拖动父任务时要一起平移的整棵子树 */
      subtree: number[];
    } | null = null;
    let panning = false;
    let lastPanX = 0;

    /**
     * ⌥ 拖出受阻区间。
     *
     * 条子上的裸拖拽已经被占满了：中间=移动、两端=改工期、进度边界=调进度。
     * 加修饰键是唯一不冲突的做法，而且和「⌥↑↓ 移动任务」的修饰键语义一致。
     */
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

      // ⌥ 按住：标受阻区间。父任务日期是汇总值、里程碑没有区间，
      // 两者都不该直接标 —— 受阻要记在真正在做的那条任务上
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
        // 时间游标和同期高亮都只画在交互层，所以移动鼠标不会触发条子重绘
        live.current.cursorX = localX(e);
        live.current.hoverId = hit?.mode ? hit.task.id : null;
        dirty.current.interact = true;
        return;
      }

      const { tasks: current } = live.current;
      const fresh = current.find((t) => t.id === drag!.task.id);
      if (!fresh) return;

      const store = useAppStore.getState();
      const original = store.tasks.get(drag.task.id);
      if (!original) return;

      if (drag.mode === "progress") {
        const cur = activeSpan(fresh, live.current.viewMode).span;
        const x1 = vp.xOf(cur.startDay);
        const width = vp.xOf(cur.endDay + 1) - x1;
        // 减掉抓取偏移，按下的那一刻进度才不会跳
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
        // 拖动时同时报自然日和工作日 —— 「5 天的活跨了周末只剩 3 天工时」
        // 这件事必须在做决定的当下就看见，事后再发现已经晚了
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

        // 父任务的日期是汇总值，改不了它本身 —— 要动就整组平移子任务
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
            // 实施视图下写的是另一组字段。拖一条还没动过的虚线，
            // 落笔即把它变成真正的实施条 —— 这就是「在计划基础上拖拽变动」
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
        // 裁到任务区间内 —— 飘在条子外的一段没有视觉锚点，也说不清属于谁
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
          // 松手处就地弹菜单选原因。默认成「其他」等于没记 —— 人不会回头补
          setPendingBlock({
            taskId: task.id,
            period: clipped,
            x: e.clientX,
            y: e.clientY,
          });
        }
        return;
      }

      drag = null;
      panning = false;
      live.current.dragLabel = null;
      dirty.current.interact = true;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = "default";
    };

    // 双击条子开详情，和左侧网格双击行同一个效果。
    // 用双击而不是单击：单击已经是「选中 + 起手拖拽」，单击就弹面板的话
    // 每次想拖动都会误开
    const onDouble = (e: PointerEvent) => {
      const hit = hitTest(vpRef.current, live.current.tasks, localX(e), localY(e), live.current.viewMode);
      if (hit?.mode) openDetail(hit.task.id);
    };
    el.addEventListener("dblclick", onDouble as EventListener);

    /**
     * 右键某一天：给那天记一笔。
     *
     * 条子上的裸手势已经占满了（中间移动、两端改工期、进度手柄、⌥ 标受阻），
     * 右键是这里唯一还空着的入口，而且语义天然 —— 指着某一天说"这天怎么了"。
     *
     * 落点带着两个信息：**哪一天**（横坐标换算）和**哪条活**（命中检测）。
     * 点在空白处就只带日期，写成项目级记录 —— 「今天下雨全场停工」不属于
     * 任何一条任务，硬塞给某条活会让它在复盘里被算到那条活头上。
     */
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
      // 父任务不接记录：它没有自己的工作内容，记在它上面等于记在一个汇总值上
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

/**
 * 松手处的原因菜单。
 *
 * 不用通用 Popover：那个要一个 DOM 锚点，而这里的锚点是一个转瞬即逝的
 * 鼠标位置。Esc 或点外面都算取消**整次创建**，不会留下一条「其他」。
 */
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
