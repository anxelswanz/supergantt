import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type Priority } from "../gantt/model";
import { columnOf } from "../core/board";
import { today } from "../gantt/time";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { shortcut } from "../core/keys";
import { FilterSelect, type SelectOption } from "./FilterSelect";

/**
 * 快速记录（`⌘K` / `Ctrl+K`）。
 *
 * ## 为什么是全局快捷键
 *
 * 事情不挑你在哪个视图时发生 —— 会上那句话可能在你正看甘特图时冒出来。
 * 只在事项视图里能记，等于把「快」这个唯一的核心指标让掉一半。
 *
 * ## 为什么存完不关窗
 *
 * `Enter` 保存后弹窗留着、标题清空、焦点回到标题，可以连着记五条。
 * 关窗再按一次 `⌘K` 的代价看起来很小，但它正好打断「把脑子里那一串
 * 倒出来」这个动作 —— 而那是这个功能最主要的使用场景（开完会）。
 *
 * ## 为什么不在这里选类型
 *
 * **刻意的。** 录入界面每多一个字段，记下来的概率就低一分；而「这是什么」
 * 往往要等记完才想清楚。分拣是分开的动作，在事项视图里做（设计稿 §4.2）。
 * `⌘Enter` 是给「我已经知道这是什么」准备的：存下并立刻跳过去分拣。
 */

const day = () => today();

export function QuickNote() {
  const open = useAppStore((s) => s.quickNoteOpen);
  const setOpen = useAppStore((s) => s.setQuickNoteOpen);
  const people = useAppStore((s) => s.people);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const addItemNote = useAppStore((s) => s.addItemNote);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingSortNote = useAppStore((s) => s.setPendingSortNote);

  const [name, setName] = useState("");
  const [personId, setPersonId] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [priority, setPriority] = useState<Priority>(2);
  const [saved, setSaved] = useState(0);
  /** 负责人是手选的还是跟着任务自动填的 —— 自动填不覆盖手选 */
  const touchedPerson = useRef(false);
  /** 有下拉开着时 Enter 归它，不触发保存 */
  const dropdownOpen = useRef(0);

  const nameRef = useRef<HTMLInputElement>(null);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  /**
   * 任务下拉：**进行中的在前**，其余在后。
   *
   * 要关联的活多半是正在做的那几条。父任务也列出来 —— 事项只是「关联」到
   * 一条活上，不像阻碍那样要落到叶子上，所以这里不筛掉它们。
   */
  const taskOptions = useMemo<SelectOption<number | null>[]>(() => {
    const d = day();
    const rank = (t: (typeof tasks)[number]) => {
      const col = columnOf(t, d);
      return col === "blocked" ? 0 : col === "doing" ? 1 : col === "todo" ? 2 : 3;
    };
    const sorted = [...tasks].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder);
    return [
      { value: null, label: "不关联任务" },
      ...sorted.map((t) => {
        const col = columnOf(t, d);
        return {
          value: t.id as number | null,
          label: `#${t.id} ${t.name || "未命名"}`,
          search: t.name,
          hint:
            col === "blocked" ? "受阻" : col === "doing" ? "进行中" : col === "done" ? "已完成" : "",
        };
      }),
    ];
  }, [tasks]);

  const personOptions = useMemo<SelectOption<number | null>[]>(
    () => [
      { value: null, label: "未指派" },
      ...people.map((p) => ({ value: p.id as number | null, label: p.name, color: p.color })),
    ],
    [people],
  );

  const priorityOptions = useMemo<SelectOption<Priority>[]>(
    () =>
      PRIORITY_LABELS.map((label, i) => ({
        value: i as Priority,
        label,
        color: PRIORITY_COLORS[i],
      })),
    [],
  );

  // 每次打开都是一张白纸。上一次的负责人/任务留着反而危险 ——
  // 连记时很容易把第三条挂到第一条的那个人头上
  useEffect(() => {
    if (!open) return;
    setName("");
    setPersonId(null);
    setTaskId(null);
    setPriority(2);
    setSaved(0);
    touchedPerson.current = false;
    dropdownOpen.current = 0;
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  /** 选定任务时自动预选它的负责人 —— 只在用户没手选过的时候 */
  const pickTask = (id: number | null) => {
    setTaskId(id);
    if (touchedPerson.current || id == null) return;
    const owner = taskMap.get(id)?.personId ?? null;
    if (owner != null) setPersonId(owner);
  };

  const submit = async (thenSort: boolean) => {
    const text = name.trim();
    if (!text) return;
    const row = await addItemNote(text, priority, personId, taskId);
    if (!row) return;

    if (thenSort) {
      // 「存下并立刻分拣」：关窗、切到事项视图、把那一行标出来。
      // 分拣菜单本身在列表行上 —— 在这里再画一个等于同一个菜单两份实现
      setOpen(false);
      setActiveView("items");
      setPendingSortNote(row.id);
      return;
    }

    // 存完不关窗：清标题、焦点回标题，接着记下一条。
    // 负责人/任务/优先级**留着** —— 连记的那几条多半属于同一条活
    setName("");
    setSaved((n) => n + 1);
    nameRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-start justify-center bg-black/30 pt-[14vh] backdrop-blur-[1px]"
      onPointerDown={() => setOpen(false)}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key !== "Enter") return;
          // 下拉开着时 Enter 是「选中这一项」，不是「保存」
          if (dropdownOpen.current > 0) return;
          e.preventDefault();
          void submit(e.metaKey || e.ctrlKey);
        }}
        className="w-[440px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--rule)] bg-[var(--surface)] shadow-2xl"
      >
        <div className="px-3.5 pt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-xs font-semibold text-[var(--text)]">快速记录</span>
            <span className="text-[10px] text-[var(--text-dim)]">
              先记下来，什么时候想清楚它是什么再分拣
            </span>
            {saved > 0 && (
              <span className="ml-auto text-[10px] font-medium text-emerald-600">
                已记 {saved} 条
              </span>
            )}
          </div>

          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="会上提到的那件事…"
            className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />

          {/* Tab 顺序就是这个顺序：标题 → 负责人 → 任务 → 优先级 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pb-3">
            <FilterSelect
              value={personId}
              options={personOptions}
              onPick={(id) => {
                touchedPerson.current = true;
                setPersonId(id);
              }}
              onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
              placeholder="未指派"
              title="负责人（单人。任务已经是单人，这里跟着一致）"
              width={128}
            />
            <FilterSelect
              value={taskId}
              options={taskOptions}
              onPick={pickTask}
              onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
              placeholder="不关联任务"
              title="关联的活。进行中的排在前面；选了会自动带上它的负责人"
              width={178}
            />
            <FilterSelect
              value={priority}
              options={priorityOptions}
              onPick={setPriority}
              onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
              title="先做哪个"
              width={100}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--rule)] bg-[var(--surface-alt)] px-3.5 py-2 text-[10px] text-[var(--text-dim)]">
          <span>
            <Key>↵</Key> 保存并继续
          </span>
          <span>
            <Key>{shortcut("mod", "↵")}</Key> 存下并分拣
          </span>
          <span className="ml-auto">
            <Key>Esc</Key> 关闭
          </span>
        </div>
      </motion.div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--rule)] bg-[var(--surface)] px-1 font-mono text-[9px] text-[var(--text)]">
      {children}
    </kbd>
  );
}
