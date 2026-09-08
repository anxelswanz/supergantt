import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { GanttView } from "../gantt/GanttView";
import { FIXED_COLS_WIDTH, MIN_PANEL_WIDTH, TaskGrid } from "./TaskGrid";
import { ZOOM_PRESETS, type ZoomPreset, type Viewport } from "../gantt/viewport";
import { today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { isMod } from "../core/keys";
import { canEdit, VIEW_LABELS, type ViewMode } from "../core/viewMode";
import { APP_VIEWS, type AppView } from "../core/views";
import { BoardView } from "./BoardView";
import { TimelineView } from "./TimelineView";
import { ReviewView } from "./ReviewView";
import { api } from "../db/api";
import { Settings } from "./Settings";
import { TaskDetail } from "./TaskDetail";
import { MenuItem, Popover } from "./Popover";
import { ExportButton } from "./ExportButton";
import { AnimatePresence } from "motion/react";

const PRESET_LABELS: Record<ZoomPreset, string> = {
  day: "日",
  week: "周",
  month: "月",
  year: "年",
};

/**
 * 面板能缩到只剩任务名一列 —— 其余列会随宽度依次隐藏（见 TaskGrid.visibleColumns）。
 * 之前这里写死成「固定列总宽 + 150」，每加一列下限就往右顶一截，
 * 最后变成往左拉一点就拉不动。
 */
const MIN_GRID_WIDTH = MIN_PANEL_WIDTH;
const MAX_GRID_WIDTH = 900;
const DEFAULT_GRID_WIDTH = FIXED_COLS_WIDTH + 240;
const GRID_WIDTH_KEY = "grid_width";

export function Workspace() {
  const project = useAppStore((s) => s.project);
  const closeProject = useAppStore((s) => s.closeProject);
  const stack = useAppStore((s) => s.stack);
  const saveError = useAppStore((s) => s.saveError);
  const selectedId = useAppStore((s) => s.selectedId);
  const detailId = useAppStore((s) => s.detailId);
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const viewMode = useAppStore((s) => s.viewMode);
  const compareOn = useAppStore((s) => s.compareOn);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setCompareOn = useAppStore((s) => s.setCompareOn);

  const [scrollY, setScrollY] = useState(0);
  const [preset, setPreset] = useState<ZoomPreset>("week");
  const [height, setHeight] = useState(0);
  const [gridWidth, setGridWidth] = useState(DEFAULT_GRID_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const invalidateRef = useRef<() => void>(() => {});

  /* ---------------- 面板宽度：读取与持久化 ---------------- */

  useEffect(() => {
    void api
      .getSetting(GRID_WIDTH_KEY)
      .then((raw) => {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) setGridWidth(clampWidth(value));
      })
      .catch(() => {});
  }, []);

  const persistWidth = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveWidth = (value: number) => {
    if (persistWidth.current) clearTimeout(persistWidth.current);
    // 拖动过程中每像素写一次库毫无意义，停手之后再存
    persistWidth.current = setTimeout(() => {
      void api.setSetting(GRID_WIDTH_KEY, String(Math.round(value))).catch(() => {});
    }, 300);
  };

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = gridWidth;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = clampWidth(startWidth + ev.clientX - startX);
      setGridWidth(next);
      // 画布宽度跟着变，几何全变了，必须整层重绘
      invalidateRef.current();
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      saveWidth(clampWidth(startWidth + ev.clientX - startX));
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  const onViewportReady = useCallback((vp: Viewport, invalidate: () => void) => {
    vpRef.current = vp;
    invalidateRef.current = invalidate;
  }, []);

  const jump = useCallback((p: ZoomPreset) => {
    vpRef.current?.zoomToPreset(p);
    invalidateRef.current();
    setPreset(p);
  }, []);

  const goToday = useCallback(() => {
    vpRef.current?.centerOn(today());
    invalidateRef.current();
  }, []);

  /* ---------------- 跨天：延长没关掉的阻碍 ---------------- */

  /**
   * 每分钟看一眼「今天」变了没有，变了就把未关闭的阻碍往后延一天，
   * 并顺延对应任务的计划结束日（store.extendOpenBlockers）。
   *
   * 为什么不是每天零点设一个定时器：`setTimeout` 到明天零点的那种写法，
   * 在合盖睡眠的笔记本上根本不会准时醒 —— 睡了一夜再打开，定时器要么
   * 迟到几小时，要么被系统合并掉。轮询一个廉价的整数比较，反而不会漏。
   *
   * 回到窗口时也查一次：白天大部分时间这个应用在后台，跨天那一刻
   * 用户多半没看着屏幕，等他切回来时数据必须已经是对的。
   */
  useEffect(() => {
    let last = today();
    const tick = () => {
      const now = today();
      if (now === last) return;
      last = now;
      useAppStore.getState().extendOpenBlockers();
    };
    const timer = setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);

  /* ---------------- 全局快捷键 ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useAppStore.getState();
      // 正在输入框里打字时，除了 ⌘Z 之外一律放行给输入框
      const inInput =
        e.target instanceof HTMLElement &&
        /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

      if (isMod(e) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
        return;
      }
      if (inInput) return;

      // 增删任务、缩进这些结构性操作只属于计划表
      if (!canEdit("structure", store.viewMode)) {
        const structural =
          e.key === "Enter" ||
          e.key === "Backspace" ||
          e.key === "Delete" ||
          (isMod(e) && (e.key === "]" || e.key === "["));
        if (structural) {
          e.preventDefault();
          return;
        }
      }

      if (isMod(e) && e.key === "]") {
        e.preventDefault();
        if (store.selectedId != null) store.indentTask(store.selectedId);
        return;
      }
      if (isMod(e) && e.key === "[") {
        e.preventDefault();
        if (store.selectedId != null) store.outdentTask(store.selectedId);
        return;
      }
      // ⌘1–⌘4 切顶层视图。裸 1–4 留给甘特的缩放档位 ——
      // 两者不冲突，因为缩放只在甘特里有意义
      if (isMod(e) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        store.setActiveView(APP_VIEWS[Number(e.key) - 1].key);
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void store.persistence?.flush();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // ⇧Enter 建子任务，Enter 建同级 —— 两者都不需要事后再缩进一次
        if (e.shiftKey && store.selectedId != null) store.addSubtask(store.selectedId);
        else store.addTaskAfter(store.selectedId);
        return;
      }
      // ⌥↑ / ⌥↓ 在兄弟之间上下移动。用 Option 而不是裸方向键，
      // 是给将来的「方向键切换选中行」留出位置
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        if (store.selectedId != null) {
          store.moveTask(store.selectedId, e.key === "ArrowUp" ? -1 : 1);
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (store.selectedId != null) {
          e.preventDefault();
          store.deleteTask(store.selectedId);
        }
        return;
      }
      // 下面两个只操作甘特的相机，别的视图里按了不该有任何反应
      if (store.activeView !== "gantt") return;

      if (e.key === "t" || e.key === "T") {
        goToday();
        return;
      }
      const presetKeys: Record<string, ZoomPreset> = {
        "1": "day",
        "2": "week",
        "3": "month",
        "4": "year",
      };
      if (presetKeys[e.key]) jump(presetKeys[e.key]);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToday, jump]);

  if (!project) return null;

  const accent = project.color;

  return (
    <motion.div
      layoutId={`project-${project.id}`}
      className="flex h-full w-full flex-col overflow-hidden bg-[var(--surface)]"
      style={{ "--accent": accent } as React.CSSProperties}
    >
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--rule)] px-3 py-2">
        <button
          onClick={() => void closeProject()}
          className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ← 项目
        </button>

        <span className="size-2.5 rounded-full" style={{ background: accent }} />
        <span className="text-sm font-semibold text-[var(--text)]">{project.name}</span>

        {/* 顶层视图。同一批任务的四种问法，切换它不改任何数据 */}
        <div className="ml-1 flex items-center gap-1 rounded-full bg-[var(--surface-alt)] p-1">
          {APP_VIEWS.map((v, i) => (
            <button
              key={v.key}
              onClick={() => setActiveView(v.key)}
              title={`${v.hint}　⌘${i + 1}`}
              className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
              style={
                activeView === v.key
                  ? { background: accent, color: "#fff" }
                  : { color: "var(--text-dim)" }
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* 计划 / 实施是**甘特内部**的开关：切的是读哪一组日期。
            别的视图各有固定的数据归属，给它们一个不起作用的开关只会误导 */}
        {activeView === "gantt" && (
          <div className="flex items-center gap-1 rounded-full border border-[var(--rule)] p-1">
            {(["plan", "actual"] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                title={m === "plan" ? "拖拽改的是计划日期" : "拖拽改的是实施日期，并可拖进度"}
                className="rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                style={
                  viewMode === m
                    ? { background: "var(--row-hover)", color: "var(--text)" }
                    : { color: "var(--text-dim)" }
                }
              >
                {VIEW_LABELS[m]}
              </button>
            ))}
          </div>
        )}

        {/* 对照只在实施侧有意义 —— 它是把计划条叠回来，不是第三张表 */}
        {activeView === "gantt" && viewMode === "actual" && (
          <button
            onClick={() => setCompareOn(!compareOn)}
            title="叠加显示计划条与偏差天数"
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              compareOn
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--rule)] text-[var(--text-dim)] hover:text-[var(--text)]"
            }`}
          >
            对照
          </button>
        )}

        <div className="ml-2 flex items-center gap-1">
          <ToolButton
            disabled={!stack?.canUndo}
            title={stack?.undoLabel ? `撤销「${stack.undoLabel}」` : "撤销"}
            onClick={() => useAppStore.getState().undo()}
          >
            ↩
          </ToolButton>
          <ToolButton
            disabled={!stack?.canRedo}
            title={stack?.redoLabel ? `重做「${stack.redoLabel}」` : "重做"}
            onClick={() => useAppStore.getState().redo()}
          >
            ↪
          </ToolButton>
        </div>

        {canEdit("structure", viewMode) && <NewTaskButton selectedId={selectedId} />}

        <div className="ml-auto flex items-center gap-1">
          {activeView === "gantt" && (
            <>
              <div className="flex items-center gap-1 rounded-full bg-[var(--surface-alt)] p-1">
                {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => jump(p)}
                    className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
                    style={
                      preset === p
                        ? { background: accent, color: "#fff" }
                        : { color: "var(--text-dim)" }
                    }
                  >
                    {PRESET_LABELS[p]}
                  </button>
                ))}
              </div>

              <button
                onClick={goToday}
                className="rounded-full border border-[var(--rule)] px-3 py-1 text-xs font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
              >
                今天
              </button>
            </>
          )}
        </div>

        {/* 放在工具条而不是设置面板里：导出是面向产出的动作，不是配置。
            埋进设置里等于没有 —— 需要它的人正准备开周会，不会想到去齿轮图标下面翻。
            时间线自己那份 HTML 导出在 TimelineView 里，跟着它的内容走 */}
        <ExportButton
          label="⤓ 导出"
          title="把整个项目导出成 Excel：甘特图 + 风险点记录"
          run={async () => (await import("../export/run")).exportProjectToExcel()}
        />

        <button
          onClick={() => setSettingsOpen(true)}
          title="设置：着色、负责人、工作日历、数据"
          className="grid size-9 place-items-center rounded-lg text-[19px] leading-none text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ⚙
        </button>

        <SaveIndicator error={saveError} />
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1">
        {/* 甘特：左网格 + 右画布。另外三个视图各自占满，不带网格 ——
            网格是甘特的一部分（行必须逐行对齐），不是全局的侧栏 */}
        {activeView === "gantt" && (
          <>
            <TaskGrid
              width={gridWidth}
              height={height}
              scrollY={scrollY}
              onScroll={setScrollY}
            />

            {/* 分隔条：命中区 9px，视觉 1px —— 抓得住又不抢视觉 */}
            <div
              onPointerDown={startResize}
              onDoubleClick={() => {
                setGridWidth(DEFAULT_GRID_WIDTH);
                saveWidth(DEFAULT_GRID_WIDTH);
                invalidateRef.current();
              }}
              title="拖动调整宽度，双击复位"
              className="group relative w-[9px] shrink-0 cursor-col-resize"
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--rule)] transition-colors group-hover:bg-[var(--accent)]" />
            </div>

            <GanttView
              scrollY={scrollY}
              onScroll={setScrollY}
              onViewportReady={onViewportReady}
            />
          </>
        )}

        {activeView === "board" && <BoardView />}
        {activeView === "timeline" && <TimelineView />}
        {activeView === "review" && <ReviewView />}

        <AnimatePresence>{detailId != null && <TaskDetail />}</AnimatePresence>
      </div>

      <AnimatePresence>
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>

      {/* 状态栏：把快捷键摆在明面上，否则没人会发现它们 */}
      <div className="flex shrink-0 items-center gap-4 border-t border-[var(--rule)] px-3 py-1.5 text-[10px] text-[var(--text-dim)]">
        <span className="font-medium text-[var(--text)]">⌘1–4 切视图</span>
        <span>Enter 新建</span>
        <span>⇧Enter 子任务</span>
        <span>⌘] / ⌘[ 缩进</span>
        <span>⌘Z 撤销</span>
        <span>⌫ 删除</span>
        <HintsFor view={activeView} viewMode={viewMode} />
      </div>
    </motion.div>
  );
}

/**
 * 状态栏里随视图变的那一段。
 *
 * 快捷键摆在明面上，否则没人会发现它们；但把四个视图的提示全列出来
 * 又会让这一行长到看不完 —— 只显示当前视图用得上的。
 */
function HintsFor({ view, viewMode }: { view: AppView; viewMode: ViewMode }) {
  switch (view) {
    case "gantt":
      return (
        <>
          <span>⌘滚轮 缩放</span>
          <span>1–4 缩放档位</span>
          <span>T 今天</span>
          <span>⌥↑↓ 移动</span>
          <span>⌥拖 标受阻</span>
          <span>右键某天 记一笔</span>
          <span>双击行看详情</span>
          <span className="ml-auto">
            {viewMode === "plan" ? "拖拽改计划日期" : "拖拽改实施日期 · 可拖进度"}
          </span>
        </>
      );
    case "board":
      return (
        <>
          <span>拖卡片改状态</span>
          <span>双击卡片看详情</span>
          <span className="ml-auto">列是算出来的，没有单独的状态字段</span>
        </>
      );
    case "timeline":
      return (
        <>
          <span>按天倒序</span>
          <span className="ml-auto">受阻、风险、当日记录都落在它们发生的那天</span>
        </>
      );
    case "review":
      return <span className="ml-auto">只读 · 数据来自计划与实施两组日期的差</span>;
  }
}

const clampWidth = (v: number) =>
  Math.min(MAX_GRID_WIDTH, Math.max(MIN_GRID_WIDTH, Math.round(v)));

function ToolButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg text-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * 只在**保存失败**时出现。
 *
 * 常态下的「已保存 / 保存中」是纯噪音 —— 它每隔几秒闪一次，却从不传递
 * 需要用户行动的信息。但失败必须明说：假装已保存是本地应用最不能犯的错，
 * 用户会在毫不知情的情况下关掉窗口。
 */
function SaveIndicator({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <span
      className="rounded-full bg-rose-500/12 px-2.5 py-1 text-xs font-medium text-rose-500"
      title={`${error}\n数据仍在内存中，⌘S 可重试`}
    >
      ● 未保存
    </span>
  );
}

/**
 * 新建任务：一个分体式按钮。
 *
 * 之前工具条上并排摆着「+ 任务 / + 子任务 / 删除」三个同等重量的按钮，
 * 既占地方，也把一个破坏性操作和两个建设性操作放在了同一排 ——
 * 手滑的代价不对等。
 *
 * 现在：主按钮承担最高频的「新建同级」，箭头折叠掉低频的变体；
 * 删除下沉到每一行自己的 ⋯ 菜单里 —— 那里它作用于哪个对象是明确的，
 * 而不是含糊的「当前选中项」。
 */
function NewTaskButton({ selectedId }: { selectedId: number | null }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-[var(--rule)]">
      <button
        onClick={() => useAppStore.getState().addTaskAfter(selectedId)}
        title="在选中行紧后面新建同级任务（Enter）"
        className="px-2.5 py-1 text-xs font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
      >
        + 任务
      </button>
      <span className="w-px bg-[var(--rule)]" />
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        title="更多新建方式"
        className="px-1.5 text-[9px] text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
      >
        ▼
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={176}>
        <MenuItem
          hint="↵"
          onClick={() => {
            setOpen(false);
            useAppStore.getState().addTaskAfter(selectedId);
          }}
        >
          新建同级任务
        </MenuItem>
        <MenuItem
          hint="⇧↵"
          disabled={selectedId == null}
          onClick={() => {
            setOpen(false);
            if (selectedId != null) useAppStore.getState().addSubtask(selectedId);
          }}
        >
          新建子任务
        </MenuItem>
      </Popover>
    </div>
  );
}

