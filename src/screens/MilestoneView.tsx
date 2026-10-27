import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type ResolvedTask } from "../gantt/model";
import { dayToIso, isoToDay, today } from "../gantt/time";
import { DatePicker } from "./DatePicker";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import type { Milestone } from "../db/api";

/**
 * 里程碑视图 —— 用户自己设立的**项目节点**，不是任务表里的一个勾。
 *
 * 任务表里那个 `milestone` 布尔问的是「这条活本身是不是个节点」，
 * 它依附在任务上；这里的每一条能脱离任务存在、能挂若干条任务、有自己的
 * 名称/日期/说明/颜色，并且**在甘特图上叠画出来**（见 gantt/render.ts）。
 *
 * ## 为什么关联任务而不复制任务
 *
 * 关联是一根引用：任务改名、改期、删掉，里程碑跟着看到同一件事。
 * 复制一份快照会立刻分叉 —— 那条活往后挪了两周，里程碑上写的还是老日期。
 * 所以这里只存 id，显示时现查。
 *
 * ## 为什么这页不进撤销栈
 *
 * 和事项、风险、逐日记录同一类：它们是**独立记录**，不是任务表的编辑。
 * ⌘Z 该撤销的是刚才在甘特里拖的那一条，而不是把你刚写下的节点悄悄抹掉。
 * 所以增删改全部即写即存。
 */

/** 可选颜色。和项目色、优先级色同一套灰度下都读得出来 */
const COLORS = [
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#0ea5e9",
  "#10b981",
  "#6366f1",
  "#64748b",
];

/** 拖拽起手的阈值，和事项页同一手感 */
const DRAG_THRESHOLD = 4;

export function MilestoneView() {
  const milestones = useAppStore((s) => s.milestones);
  const addMilestone = useAppStore((s) => s.addMilestone);
  const patchMilestone = useAppStore((s) => s.patchMilestone);
  const removeMilestone = useAppStore((s) => s.removeMilestone);
  const reorderMilestones = useAppStore((s) => s.reorderMilestones);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const loadMilestones = useAppStore((s) => s.loadMilestones);

  /** null = 不在编辑；0 = 新建；其余 = 编辑那一条 */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  // 打开项目时已经拉过一次，但用户可能在别处（比如撤销）改过任务关联，
  // 进这一页时再对一次库，代价是一次本地查询
  useEffect(() => {
    void loadMilestones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const drag = useMilestoneDrag((from, to, place) => {
    const ids = milestones.map((m) => m.id);
    const fromIndex = ids.indexOf(from);
    const toIndex = ids.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || from === to) return;
    ids.splice(fromIndex, 1);
    const target = ids.indexOf(to);
    ids.splice(place === "before" ? target : target + 1, 0, from);
    void reorderMilestones(ids);
  });

  const rowRef = (id: number) => (el: HTMLElement | null) => drag.rowRef(id)(el);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface)]">
      {/* 头部：标题 + 新建。和事项页同一结构，用户不用重新学 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--rule)] px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text)]">里程碑</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">
            项目关键节点。设好日期后会在甘特图上标出来，也可以关联若干条任务
          </p>
        </div>
        <button
          onClick={() => setEditingId(0)}
          className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)" }}
        >
          ＋ 新建里程碑
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <AnimatePresence initial={false}>
          {editingId === 0 && (
            <motion.div
              key="create"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className="mb-3"
            >
              <MilestoneEditor
                tasks={tasks}
                initial={{
                  name: "",
                  date: dayToIso(today()),
                  color: COLORS[0],
                  description: "",
                  taskIds: [],
                }}
                onCancel={() => setEditingId(null)}
                onSave={async (draft) => {
                  const created = await addMilestone(
                    draft.name,
                    draft.date,
                    draft.color,
                    draft.description,
                    draft.taskIds,
                  );
                  if (created) setEditingId(null);
                  return !!created;
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {milestones.length === 0 && editingId !== 0 ? (
          <EmptyState onCreate={() => setEditingId(0)} />
        ) : (
          <div className="flex flex-col gap-2">
            {milestones.map((m) => {
              const linked = m.taskIds
                .map((id) => taskById.get(id))
                .filter((t): t is ResolvedTask => !!t);

              return (
                <div key={m.id} ref={rowRef(m.id)}>
                  <motion.div
                    layout="position"
                    className={`rounded-xl border bg-[var(--surface-alt)] transition-colors ${
                      drag.over?.id === m.id ? "border-[var(--accent)]" : "border-[var(--rule)]"
                    } ${drag.dragId === m.id ? "opacity-60" : ""}`}
                  >
                    {editingId === m.id ? (
                      <MilestoneEditor
                        tasks={tasks}
                        initial={{
                          name: m.name,
                          date: m.date,
                          color: m.color,
                          description: m.description,
                          taskIds: m.taskIds,
                        }}
                        onCancel={() => setEditingId(null)}
                        onSave={async (draft) => {
                          await patchMilestone(m.id, draft);
                          setEditingId(null);
                          return true;
                        }}
                        onDelete={() => {
                          setEditingId(null);
                          setConfirmDelete(m.id);
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        {/* 拖拽把手。用 span 不用 button：起拖逻辑会跳过按在按钮上的
                            按下（那是按钮自己的事），把手若是按钮就永远起不了拖 */}
                        <span
                          onPointerDown={(e) => drag.start(m.id, e)}
                          title="拖动调整顺序"
                          className="cursor-grab touch-none select-none px-1 text-[13px] leading-none text-[var(--text-dim)] opacity-60 hover:opacity-100"
                        >
                          ⋮⋮
                        </span>

                        <span
                          className="size-3 shrink-0 rounded-full"
                          style={{ background: m.color }}
                        />

                        <button
                          onClick={() => setEditingId(m.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm font-medium text-[var(--text)]">
                            {m.name}
                          </span>
                          {m.description && (
                            <span className="mt-0.5 block truncate text-[11px] text-[var(--text-dim)]">
                              {m.description}
                            </span>
                          )}
                        </button>

                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums"
                          style={{
                            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                            color: "var(--accent)",
                          }}
                          title="这一天在甘特图上会画一个菱形标记"
                        >
                          {m.date}
                        </span>

                        {linked.length > 0 && (
                          <span
                            className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--row-hover)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
                            title={linked.map((t) => t.name).join("\n")}
                          >
                            {linked.slice(0, 2).map((t) => (
                              <span key={t.id} className="max-w-[9rem] truncate">
                                {t.name}
                              </span>
                            ))}
                            {linked.length > 2 && <span>+{linked.length - 2}</span>}
                          </span>
                        )}

                        <RowActions
                          milestone={m}
                          onEdit={() => setEditingId(m.id)}
                          onDelete={() => setConfirmDelete(m.id)}
                        />
                      </div>
                    )}
                  </motion.div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 删除确认：里程碑删了就没了，关联只是引用，不该有「撤销一下就好」的错觉 */}
      <AnimatePresence>
        {confirmDelete != null && (
          <ConfirmDelete
            name={milestones.find((m) => m.id === confirmDelete)?.name ?? ""}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={async () => {
              const id = confirmDelete;
              setConfirmDelete(null);
              await removeMilestone(id);
            }}
          />
        )}
      </AnimatePresence>

      {/* 拖动时跟着指针的小牌子 —— 和大列表同一套反馈 */}
      {drag.ghost && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg bg-[var(--surface)] px-2.5 py-1 text-xs shadow-lg ring-1 ring-[var(--rule)]"
          style={{ left: drag.ghost.x + 12, top: drag.ghost.y + 10 }}
        >
          {drag.ghost.title}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 行内编辑 / 新建                                                     */
/* ------------------------------------------------------------------ */

interface Draft {
  name: string;
  date: string;
  color: string;
  description: string;
  taskIds: number[];
}

function MilestoneEditor({
  initial,
  tasks,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Draft;
  tasks: ResolvedTask[];
  onSave: (draft: Draft) => Promise<boolean>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const commit = async () => {
    if (saving) return;
    if (!draft.name.trim()) {
      setError("名称不能为空");
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await onSave({ ...draft, name: draft.name.trim() });
    setSaving(false);
    if (!ok) setError("保存失败 —— 名称、日期和关联任务都检查一下");
  };

  return (
    <div
      className="rounded-xl border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
      onKeyDown={(e) => {
        // 编辑框里的 Enter 是「保存」，不是工作区的「新建任务」
        if (e.key === "Enter" && !e.shiftKey && !(e.target as HTMLElement).closest("textarea")) {
          e.preventDefault();
          e.stopPropagation();
          void commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={nameRef}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="里程碑名称，比如「样机验收」"
          className="min-w-[12rem] flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />

        <DateField
          value={draft.date}
          onChange={(date) => setDraft({ ...draft, date })}
        />

        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setDraft({ ...draft, color: c })}
              title="这一条的颜色（在甘特图上也是它）"
              className="grid size-6 place-items-center rounded-full"
              style={{ background: c }}
            >
              {draft.color === c && (
                <span className="text-[11px] font-bold text-white">✓</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="说明（可选）：这一站要交付什么、谁验收"
          className="min-w-[16rem] flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />

        <TaskPicker
          tasks={tasks}
          selected={draft.taskIds}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onChange={(taskIds) => setDraft({ ...draft, taskIds })}
        />
      </div>

      {draft.taskIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {draft.taskIds.map((id) => {
            const t = taskById.get(id);
            return (
              <span
                key={id}
                className="flex items-center gap-1 rounded-full bg-[var(--row-hover)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
              >
                {t?.name ?? `#${id}`}
                <button
                  onClick={() =>
                    setDraft({ ...draft, taskIds: draft.taskIds.filter((x) => x !== id) })
                  }
                  title="取消关联（不会删掉任务）"
                  className="text-[var(--text-dim)] hover:text-rose-500"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-rose-500">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void commit()}
          disabled={saving}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          取消
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-rose-500 transition-colors hover:bg-rose-500/10"
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

/** 日期输入。点开是项目里那套日历，不用原生 date input（理由见 DatePicker） */
function DateField({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const day = isoToDay(value);

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen(true)}
        title="设立里程碑的日期"
        className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-xs tabular-nums text-[var(--text)] transition-colors hover:border-[var(--accent)]"
      >
        {value}
      </button>
      {open && (
        <div className="relative">
          <DatePicker
            value={Number.isFinite(day) ? day : today()}
            onCommit={(d) => {
              onChange(dayToIso(d));
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 任务多选                                                            */
/* ------------------------------------------------------------------ */

function TaskPicker({
  tasks,
  selected,
  open,
  onOpenChange,
  onChange,
}: {
  tasks: ResolvedTask[];
  selected: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (ids: number[]) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => t.name.toLowerCase().includes(q));
  }, [tasks, query]);

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => onOpenChange(!open)}
        title="关联若干条任务；关联是引用，任务改名改期这里跟着变"
        className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
      >
        {selected.length > 0 ? `已关联 ${selected.length} 条任务` : "关联任务…"}
      </button>

      <Popover anchor={anchor} open={open} onClose={() => onOpenChange(false)} width={280}>
        <div className="p-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务…"
            className="mb-1 w-full rounded-md border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-[var(--text-dim)]">
                没有匹配的任务
              </p>
            )}
            {filtered.map((t) => {
              const on = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggle(t.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--row-hover)]"
                >
                  <span className="grid size-3.5 shrink-0 place-items-center rounded border border-[var(--rule)] text-[9px] text-white"
                    style={on ? { background: "var(--accent)", borderColor: "var(--accent)" } : undefined}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="truncate">{t.name || "（未命名）"}</span>
                </button>
              );
            })}
          </div>
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 行尾菜单 / 空状态 / 删除确认                                        */
/* ------------------------------------------------------------------ */

function RowActions({
  milestone,
  onEdit,
  onDelete,
}: {
  milestone: Milestone;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        title="更多"
        className="rounded-lg px-2 py-1 text-sm leading-none text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
      >
        ⋯
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={160}>
        <MenuItem
          onClick={() => {
            setOpen(false);
            onEdit();
          }}
        >
          编辑
        </MenuItem>
        <MenuDivider />
        <MenuItem
          danger
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          删除里程碑
        </MenuItem>
      </Popover>
      {/* 保留 title 里的完整信息：列表里只看得到名字，悬停能确认是哪一条 */}
      <span className="sr-only">{milestone.description}</span>
    </>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="grid place-items-center py-20 text-center">
      <div className="max-w-sm">
        <p className="text-sm font-medium text-[var(--text)]">还没有里程碑</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-dim)]">
          里程碑是项目走到哪算一站的标记，不是任务。设好日期后，它会以菱形出现在甘特图上；
          也可以关联若干条任务，一眼看出那一站由哪些活支撑。
        </p>
        <button
          onClick={onCreate}
          className="mt-4 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)" }}
        >
          ＋ 新建第一个里程碑
        </button>
      </div>
    </div>
  );
}

function ConfirmDelete({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 6 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="w-full max-w-sm rounded-2xl bg-[var(--surface)] p-4 shadow-xl ring-1 ring-[var(--rule)]"
      >
        <p className="text-sm font-semibold text-[var(--text)]">删除「{name}」？</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-dim)]">
          只删这个节点，关联的任务不受影响，甘特图上的标记也会一起消失。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            删除
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* 拖拽排序                                                            */
/* ------------------------------------------------------------------ */

/**
 * 指针事件实现，和事项页的行拖拽同一套理由：Tauri 在 Windows 上接管了窗口的
 * 拖放，HTML5 draggable 在那里整个失效。
 */
function useMilestoneDrag(
  onDrop: (from: number, to: number, place: "before" | "after") => void,
) {
  const rows = useRef(new Map<number, HTMLElement>());
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const stopRef = useRef<(() => void) | null>(null);

  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<{ id: number; place: "before" | "after" } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const rowRef = (id: number) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  };

  const targetAt = (y: number, self: number) => {
    for (const [id, el] of rows.current) {
      const box = el.getBoundingClientRect();
      if (y < box.top || y > box.bottom || id === self) continue;
      return {
        id,
        place: (y < box.top + box.height / 2 ? "before" : "after") as "before" | "after",
      };
    }
    return null;
  };

  const start = (id: number, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const hit = e.target as HTMLElement;
    if (hit.closest("button, input, textarea, select, a, [contenteditable]")) return;
    e.preventDefault();
    stopRef.current?.();

    const origin = { x: e.clientX, y: e.clientY };
    let active = false;
    let target: { id: number; place: "before" | "after" } | null = null;
    const title =
      useAppStore.getState().milestones.find((m) => m.id === id)?.name ?? "";

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD) return;
        active = true;
        setDragId(id);
      }
      target = targetAt(ev.clientY, id);
      setOver(target);
      setGhost({ x: ev.clientX, y: ev.clientY, title });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      stopRef.current = null;
      setDragId(null);
      setOver(null);
      setGhost(null);
    };
    const up = () => {
      const t = active ? target : null;
      stop();
      if (t) dropRef.current(id, t.id, t.place);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    stopRef.current = stop;
  };

  return { dragId, over, ghost, rowRef, start };
}
