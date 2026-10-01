import { Fragment, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type Priority, type ResolvedTask } from "../gantt/model";
import { columnOf, isInProgress } from "../core/board";
import { today } from "../gantt/time";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { withAlpha } from "../gantt/coloring";
import { RISK_LEVELS } from "../core/risks";
import { reasonLabel } from "../core/blocked";
import { shortcut } from "../core/keys";
import {
  BLOCKER_KIND,
  EMPTY_FILTER,
  RISK_KIND,
  SORT_ACTION_LABEL,
  UNSORTED_KIND,
  closePolicy,
  filterItems,
  hasFilter,
  kindColor,
  kindLabel,
  mergeItems,
  shortDate,
  sortItems,
  type ItemFilter,
  type ItemRow,
} from "../core/items";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import { GrowingTextarea, type GrowingTextareaHandle } from "./GrowingTextarea";
import { FilterSelect, type SelectOption } from "./FilterSelect";
import type { ItemKind, Person } from "../db/api";
import { BlockedDetail } from "./BlockedDetail";
import { PromoteDialog, type PromoteTarget } from "./PromoteDialog";

/**
 * 事项视图 —— 系统里唯一一个**不需要日期**的面。
 *
 * 另外四个视图全部在处理已经放进计划里的活：它们都要求一件事先被翻译成
 * 「任务 + 日期 + 负责人」才接得住。而现实里最先出现的东西只有一句话 ——
 * 会上的一句话、邮件里的一个隐患。这个视图是那次翻译发生**之前**的收容区。
 *
 * ## 三个来源合并成一张清单
 *
 * 合并规则全在 `core/items.ts`（纯函数 + 单测），这里只负责渲染和交互。
 * 其中最容易被漏掉、而漏掉之后最伤的一条是：**不是从事项分拣来的实体也要
 * 显示** —— ⌥ 在甘特条上标的阻碍、任务详情里直接建的风险。漏了它，
 * 用户会得到一个「同一个东西在两个地方说法不同」的工具。
 *
 * ## 为什么按时间倒序而不按类型分组
 *
 * 因为**分拣不该改变行的位置**。记完抬头一看那条还在原地；按类型分组的话，
 * 每点一次分拣那一行就跳到别处去了，而分拣恰恰是这个视图最高频的动作。
 */
export function ItemsView() {
  const notes = useAppStore((s) => s.itemNotes);
  const kinds = useAppStore((s) => s.itemKinds);
  const risks = useAppStore((s) => s.projectRisks);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const people = useAppStore((s) => s.people);
  const setQuickNoteOpen = useAppStore((s) => s.setQuickNoteOpen);
  const pendingSortNoteId = useAppStore((s) => s.pendingSortNoteId);
  const setPendingSortNote = useAppStore((s) => s.setPendingSortNote);

  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [closedOpen, setClosedOpen] = useState(false);
  /** 点开的那条阻碍详情。渲染在本视图根层 —— 它是 fixed 模态 */
  const [blockedDetail, setBlockedDetail] = useState<{ taskId: number; periodId: string } | null>(
    null,
  );
  /** 正在分拣的那条事项，以及分到哪去 */
  const [promoting, setPromoting] = useState<{ noteId: number; target: PromoteTarget } | null>(
    null,
  );

  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  const rows = useMemo(
    () =>
      sortItems(
        mergeItems({
          notes,
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            personId: t.personId,
            blocked: t.blocked,
          })),
          risks,
          today: day,
        }),
      ),
    [notes, tasks, risks, day],
  );

  const visible = useMemo(() => filterItems(rows, filter), [rows, filter]);
  const open = visible.filter((r) => !r.closed);
  const closed = visible.filter((r) => r.closed);

  const taskName = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return (id: number | null): string | null =>
      id == null ? null : `#${id} ${byId.get(id)?.name || "已删除"}`;
  }, [tasks]);

  const personOf = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p]));
    return (id: number | null) => (id == null ? null : byId.get(id) ?? null);
  }, [people]);

  const period = blockedDetail
    ? taskMap.get(blockedDetail.taskId)?.blocked.find((p) => p.id === blockedDetail.periodId)
    : undefined;

  /** 录入弹窗里的「存下并分拣」把那一行的 id 递过来了 —— 自动展开它的菜单 */
  const autoSort = pendingSortNoteId;
  useEffect(() => {
    if (autoSort == null) return;
    // 一次性信号，读完就清。不清的话这一行会在每次重渲染时反复弹菜单
    const id = setTimeout(() => setPendingSortNote(null), 2_000);
    return () => clearTimeout(id);
  }, [autoSort, setPendingSortNote]);

  const unsorted = rows.filter((r) => r.kind == null && !r.closed).length;

  return (
    <div className="flex min-h-0 w-full flex-col bg-[var(--surface)]">
      {/* 头部：计数 + 筛选器 */}
      <div className="shrink-0 border-b border-[var(--rule)] px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">事项</h2>
          <span className="text-[10px] text-[var(--text-dim)]">
            {open.length} 条未关闭
            {unsorted > 0 && ` · ${unsorted} 条还没分拣`}
            {" · 按记录时间倒序"}
          </span>

          <button
            onClick={() => setQuickNoteOpen(true)}
            title={`快速记录（${shortcut("mod", "K")} 在任何视图下都能用）`}
            className="ml-auto shrink-0 rounded-full border border-[var(--rule)] px-2.5 py-1 text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            ＋ 记一条　{shortcut("mod", "K")}
          </button>
        </div>

        <Filters filter={filter} onChange={setFilter} kinds={kinds} people={people} />
      </div>

      {/*
        常驻的录入行。事项视图里连记多条时，弹出层是多余的 ——
        但它和 ⌘K 那个弹窗写进的是同一条路径（store.addItemNote），
        不是第二套录入逻辑。
      */}
      <InlineComposer tasks={tasks} day={day} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {open.length === 0 && (
          <div className="px-2 py-10 text-center text-[11px] leading-relaxed text-[var(--text-dim)]">
            {hasFilter(filter)
              ? "这些筛选条件下没有事项。"
              : `还没有事项。想到什么先按 ${shortcut("mod", "K")} 记下来 ——`}
            <br />
            {hasFilter(filter)
              ? "清掉筛选器看看全部。"
              : "不用先想清楚它是什么，也不用填日期。"}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {open.map((row) => (
            <Row
              key={row.key}
              row={row}
              kinds={kinds}
              taskName={taskName(row.taskId)}
              person={personOf(row.personId)}
              autoSort={row.note?.id != null && row.note.id === autoSort}
              onOpenBlocked={setBlockedDetail}
              onPromote={(noteId, target) => setPromoting({ noteId, target })}
            />
          ))}
        </div>

        {/*
          已关闭折叠在底部，而不是隐藏。「这件事我们处理过、是这么处理的」
          本身是信息，但它不该和还没解决的东西抢同一块注意力。
        */}
        {closed.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setClosedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
            >
              <span className="w-2">{closedOpen ? "▾" : "▸"}</span>
              已关闭 ({closed.length})
            </button>
            {closedOpen && (
              <div className="mt-0.5 flex flex-col gap-0.5">
                {closed.map((row) => (
                  <Row
                    key={row.key}
                    row={row}
                    kinds={kinds}
                    taskName={taskName(row.taskId)}
                    person={personOf(row.personId)}
                    onOpenBlocked={setBlockedDetail}
                    onPromote={(noteId, target) => setPromoting({ noteId, target })}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {blockedDetail && period && (
        <BlockedDetail
          taskId={blockedDetail.taskId}
          period={period}
          onClose={() => setBlockedDetail(null)}
        />
      )}

      {promoting && (
        <PromoteDialog
          noteId={promoting.noteId}
          target={promoting.target}
          tasks={tasks}
          day={day}
          onClose={() => setPromoting(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 筛选器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 四个可叠加的筛选器 + 一个搜索框。
 *
 * 类型筛选器里有一项「未分拣」—— `null` 是一个真实的值，不是「不筛」。
 * 「现在有哪些还没想清楚」是这个视图被打开的主要理由之一。
 */
function Filters({
  filter,
  onChange,
  kinds,
  people,
}: {
  filter: ItemFilter;
  onChange: (f: ItemFilter) => void;
  kinds: ItemKind[];
  people: { id: number; name: string; color: string }[];
}) {
  const kindOptions = [
    { value: null as string | null, label: UNSORTED_KIND.label, color: UNSORTED_KIND.color },
    { value: BLOCKER_KIND.key, label: BLOCKER_KIND.label, color: BLOCKER_KIND.color },
    { value: RISK_KIND.key, label: RISK_KIND.label, color: RISK_KIND.color },
    ...kinds.map((k) => ({ value: k.key as string | null, label: k.label, color: k.color })),
  ];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Chips
        label="类型"
        options={kindOptions}
        selected={filter.kinds}
        onChange={(kindsSel) => onChange({ ...filter, kinds: kindsSel })}
      />
      <Chips
        label="优先级"
        options={PRIORITY_LABELS.map((label, i) => ({
          value: i as Priority,
          label,
          color: PRIORITY_COLORS[i],
        }))}
        selected={filter.priorities}
        onChange={(priorities) => onChange({ ...filter, priorities })}
      />
      <Chips
        label="负责人"
        options={[
          { value: null as number | null, label: "未指派", color: UNSORTED_KIND.color },
          ...people.map((p) => ({ value: p.id as number | null, label: p.name, color: p.color })),
        ]}
        selected={filter.people}
        onChange={(sel) => onChange({ ...filter, people: sel })}
      />

      <button
        onClick={() => onChange({ ...filter, onlyOpen: !filter.onlyOpen })}
        className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors"
        style={
          filter.onlyOpen
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : { borderColor: "var(--rule)", color: "var(--text-dim)" }
        }
      >
        仅未关闭
      </button>

      <input
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
        placeholder="搜索…"
        className="w-28 rounded-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-0.5 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />

      {hasFilter(filter) && (
        <button
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-[10px] text-[var(--text-dim)] underline hover:text-[var(--text)]"
        >
          清掉筛选
        </button>
      )}
    </div>
  );
}

/** 一个多选筛选器。空选 = 不筛这一维 */
function Chips<T>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; color?: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const on = selected.length > 0;

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors"
        style={
          on
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : { borderColor: "var(--rule)", color: "var(--text-dim)" }
        }
      >
        {label}
        {on ? ` ${selected.length}` : " ▾"}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={160}>
        <div className="max-h-64 overflow-y-auto">
          {options.map((o) => {
            const picked = selected.includes(o.value);
            return (
              <MenuItem
                key={String(o.value)}
                active={picked}
                onClick={() =>
                  onChange(
                    picked ? selected.filter((v) => v !== o.value) : [...selected, o.value],
                  )
                }
              >
                <span className="flex items-center gap-2">
                  <span className="w-2 shrink-0 text-[9px]">{picked ? "✓" : ""}</span>
                  {o.color && (
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: o.color }}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                </span>
              </MenuItem>
            );
          })}
        </div>
        {on && (
          <>
            <MenuDivider />
            <MenuItem onClick={() => onChange([])}>不筛这一维</MenuItem>
          </>
        )}
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 常驻录入行                                                          */
/* ------------------------------------------------------------------ */

function InlineComposer({ tasks, day }: { tasks: ResolvedTask[]; day: number }) {
  const addItemNote = useAppStore((s) => s.addItemNote);
  const people = useAppStore((s) => s.people);
  const taskMap = useAppStore((s) => s.tasks);

  const [name, setName] = useState("");
  const [personId, setPersonId] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [priority, setPriority] = useState<Priority>(2);
  const touchedPerson = useRef(false);
  const dropdownOpen = useRef(0);
  const inputRef = useRef<GrowingTextareaHandle>(null);

  const taskOptions = useMemo<SelectOption<number | null>[]>(() => {
    const rank = (t: ResolvedTask) => {
      const col = columnOf(t, day);
      return col === "blocked" ? 0 : col === "doing" ? 1 : col === "todo" ? 2 : 3;
    };
    return [
      { value: null, label: "不关联任务" },
      ...[...tasks]
        .sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder)
        .map((t) => ({
          value: t.id as number | null,
          label: `#${t.id} ${t.name || "未命名"}`,
          search: t.name,
        })),
    ];
  }, [tasks, day]);

  const submit = async () => {
    if (!name.trim()) return;
    const row = await addItemNote(name, priority, personId, taskId);
    if (!row) return;
    setName("");
    inputRef.current?.focus();
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--rule)] bg-[var(--surface-alt)] px-4 py-2">
      {/*
        标题框是一个**会换行、会长高**的多行框，不是单行输入框。
        一条事项常常是一整句话（「供应商说电机下周才能到，要不要先上二号线」），
        单行框里它会往左滚出去，写到一半就无法回头检查自己写了什么。

        它也比旁边那三个下拉明显大一号：这一行里只有它是必填的，其余三个
        不动也能直接 Enter 存下 —— 版面上的大小差别要把这件事说出来，
        否则四个等高的控件读起来像四个同等重要的字段。
      */}
      <GrowingTextarea
        ref={inputRef}
        value={name}
        onChange={setName}
        onSubmit={() => {
          // 下拉开着时 Enter 归下拉。正常情况下焦点在下拉自己的搜索框里，
          // 这个回调根本不会被调到 —— 留着是因为规则只写在一处就够了
          if (dropdownOpen.current === 0) void submit();
        }}
        placeholder="记一条…（↵ 保存并接着记，⇧↵ 换行）"
        minHeight={44}
        maxHeight={120}
        className="min-w-[200px] flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text)] focus:border-[var(--accent)]"
      />
      <FilterSelect
        value={personId}
        options={[
          { value: null, label: "未指派" },
          ...people.map((p) => ({ value: p.id as number | null, label: p.name, color: p.color })),
        ]}
        onPick={(id) => {
          touchedPerson.current = true;
          setPersonId(id);
        }}
        onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
        placeholder="未指派"
        width={110}
      />
      <FilterSelect
        value={taskId}
        options={taskOptions}
        onPick={(id) => {
          setTaskId(id);
          if (touchedPerson.current || id == null) return;
          const owner = taskMap.get(id)?.personId ?? null;
          if (owner != null) setPersonId(owner);
        }}
        onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
        placeholder="不关联任务"
        width={156}
      />
      <FilterSelect
        value={priority}
        options={PRIORITY_LABELS.map((label, i) => ({
          value: i as Priority,
          label,
          color: PRIORITY_COLORS[i],
        }))}
        onPick={setPriority}
        onOpenChange={(o) => (dropdownOpen.current += o ? 1 : -1)}
        width={92}
      />
      <button
        onClick={() => void submit()}
        disabled={!name.trim()}
        className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
        style={{ background: "var(--accent)" }}
      >
        记下来
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 一行                                                                */
/* ------------------------------------------------------------------ */

/**
 * 清单里的一行。
 *
 * ## 为什么是「一行主干 + 按需一行附注」
 *
 * 第一版把十来个元素挤在同一行里（圆圈、优先级、类型、标题、⤴、天数、
 * 等级、头像、任务名、日期、⋯）。那样做的后果不是「信息多」，而是
 * **没有重点**：标题 —— 唯一一个你需要读的东西 —— 和九个小标签抢同一条
 * 基线，眼睛找不到落点。
 *
 * 现在的分配是按「读一眼要回答什么」来的：
 *
 *   主干  —— 这是什么事（标题）、多急（P几）、什么时候记的、下一步点哪
 *   附注  —— 只有存在时才占一行：卡了几天、等级、结论、「已被删除」
 *
 * **行上不显示负责人和关联任务。** 它们在录入时照样能填（选了任务还会自动
 * 带上它的负责人），但清单是一张「还有什么没处理」的表，不是一张人员分工表 ——
 * 两列头像和任务名摊在那儿，挤掉的正是标题的宽度。要看的时候悬停就有。
 *
 * ## 为什么类型按钮在右边
 *
 * 它是这个视图里最高频的动作（分拣），而不是一个状态标签。左侧那一列的
 * 语义是「这条处理完了吗」（圆圈）；把一个要点的按钮塞在圆圈和标题之间，
 * 等于在用户读标题的路上放一个障碍物。右侧是动作区 —— 和行尾的 ⋯ 挨着，
 * 手不用在一行里来回跑。
 */
function Row({
  row,
  kinds,
  taskName,
  person,
  autoSort,
  onOpenBlocked,
  onPromote,
}: {
  row: ItemRow;
  kinds: ItemKind[];
  /** 只进 title，不占版面 —— 见上面那段 */
  taskName: string | null;
  person: Person | null;
  autoSort?: boolean;
  onOpenBlocked: (ref: { taskId: number; periodId: string }) => void;
  onPromote: (noteId: number, target: PromoteTarget) => void;
}) {
  const store = useAppStore;
  const [writing, setWriting] = useState(false);
  const [how, setHow] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);

  // 「存下并分拣」递过来的那一行：自动把分拣菜单展开
  useEffect(() => {
    if (autoSort) setSortOpen(true);
  }, [autoSort]);

  const policy = closePolicy(row, kinds);

  const toggleClose = () => {
    const s = store.getState();
    if (row.closed) {
      // 重开：三种来源各有自己的那条路
      if (row.source === "risk" && row.risk) void s.reopenRisk(row.risk.id);
      else if (row.source === "note" && row.note) void s.reopenItemNote(row.note.id);
      // 阻碍没有「重开」—— 一段已经过去的事实不该被改成「又卡上了」。
      // 真的又卡住了，那是一条新的阻碍（时间不一样，归因也可能不一样）
      return;
    }
    switch (policy) {
      case "click":
        if (row.note) void s.closeItemNote(row.note.id, null);
        return;
      case "note":
        setWriting(true);
        return;
      case "blocker":
        if (row.blocker) s.closeBlocker(row.blocker.taskId, row.blocker.period.id);
        return;
      case "forbidden":
        return;
    }
  };

  const submitClose = () => {
    const s = store.getState();
    if (!how.trim()) return;
    if (row.source === "risk" && row.risk) void s.resolveRisk(row.risk.id, how);
    else if (row.note) void s.closeItemNote(row.note.id, how);
    setHow("");
    setWriting(false);
  };

  const setPriority = (p: Priority) => {
    const s = store.getState();
    if (row.source === "note" && row.note) {
      void s.patchItemNote(row.note.id, { priority: p });
    } else if (row.source === "risk" && row.risk) {
      void s.setRiskPriority(row.risk.id, p);
    } else if (row.blocker) {
      // 阻碍的优先级住在那段区间的 JSON 里，所以走命令栈（可以 ⌘Z）
      s.updateBlocked(row.blocker.taskId, { ...row.blocker.period, priority: p });
    }
  };

  const circleTitle = row.closed
    ? row.source === "blocker"
      ? "这段阻碍已经结束了。又卡住了的话记一条新的 —— 时间和归因都不一样"
      : "重新打开"
    : policy === "forbidden"
      ? row.dangling
        ? "这一行指向的东西已经被删了 —— 先重新分拣"
        : "还没加入到事项分类里，谈不上完成 —— 先决定它是什么"
      : policy === "note"
        ? "关闭：写一句「怎么解决的」"
        : policy === "blocker"
          ? "标记为已解决：区间收到昨天，卡片当场离开受阻列"
          : "标记完成";

  /** 附注那一行。空的话整行就是单行，列表保持紧凑 */
  const meta: string[] = [];
  if (row.blocker) {
    // 归类只在它**不是**标题本身时才重复一遍。没写具体说明的那条阻碍，
    // 标题就是归类标签（describeBlocked 的回退），附注再写一次就成了
    // 「等料 / 等料 · 已卡 3 天」
    if (row.blocker.period.note?.trim()) meta.push(reasonLabel(row.blocker.period.reason));
    meta.push(row.blocker.live ? `已卡 ${row.blocker.days} 天` : `共 ${row.blocker.days} 天`);
    if (row.blocker.period.pushed) meta.push(`顺延工期 ${row.blocker.period.pushed} 天`);
  }
  if (row.risk) meta.push(`${RISK_LEVELS[row.risk.level] ?? "中"}风险`);

  /** 悬停才看得到的那些：负责人、关联任务 —— 不占版面，但不丢 */
  const hover = [
    row.title,
    person ? `负责人：${person.name}` : null,
    taskName ? `关联：${taskName}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className="group rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)]"
      style={
        // 持续中的阻碍是唯一一类「现在就要人去处理」的行，给它一道底色。
        // 其余一律不上色 —— 一张人人高亮的列表等于没有高亮
        row.blocker?.live && !row.closed
          ? { background: withAlpha(BLOCKER_KIND.color, 0.05) }
          : undefined
      }
    >
      <div className="flex items-center gap-2.5">
        {/* 圆圈。点下去的后果按类型不同 —— 见 core/items.closePolicy */}
        <button
          onClick={toggleClose}
          disabled={policy === "forbidden" && !row.closed}
          title={circleTitle}
          className="grid size-[15px] shrink-0 place-items-center rounded-full border text-[9px] leading-none transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-40 disabled:hover:border-[var(--rule)]"
          style={{
            borderColor: row.closed ? "var(--text-dim)" : "var(--rule)",
            color: "var(--text-dim)",
            background: row.closed ? "var(--row-hover)" : "transparent",
          }}
        >
          {row.closed ? "✓" : ""}
        </button>

        {/*
          日期在行首。

          清单是按记录时间倒序读的，把这一列摆在最左边，它就成了一道
          日期标尺 —— 顺着往下扫能看出「这几条是同一天记的」。摆在右边时
          它只是一个贴在行尾的属性，回答不了那个问题。

          固定宽度 + tabular-nums，所以标题的起点在每一行都对齐。
        */}
        <span
          className="w-[32px] shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-dim)]"
          title={`记录于 ${new Date(row.createdAt * 1000).toLocaleDateString("zh-CN")}`}
        >
          {shortDate(row.createdAt)}
        </span>

        {/*
          标题。拿掉两列之后它终于能铺满剩下的宽度 ——
          一条事项的全部价值就在这句话里，别的都是它的属性
        */}
        <span
          className={`min-w-0 flex-1 truncate text-[12px] leading-5 ${
            row.closed ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"
          }`}
          title={hover}
        >
          {row.title || "（没写内容）"}
        </span>

        {/* 从事项分拣出来的实体。放在标题右边紧挨着，它修饰的是「这条怎么来的」 */}
        {row.fromNoteId != null && (
          <span
            className="shrink-0 text-[10px] leading-none text-[var(--text-dim)]"
            title="这一条是从一则事项分拣出来的"
          >
            ⤴
          </span>
        )}

        {/* 右侧属性区：多急 · 什么时候记的 · 下一步点哪 */}
        <PriorityTag value={row.priority} onPick={setPriority} />

        {/*
          固定宽度的槽位，标签本身保持自然宽度、靠右贴齐。
          不给槽位的话，「加入到事项 ▾」比「阻碍」宽一倍多，右侧那几列
          会被它顶得一行一个位置 —— 一列对不齐的数字比没有这一列更难读
        */}
        <span className="flex w-[66px] shrink-0 justify-end">
          <KindButton
            ref={setSortAnchor}
            row={row}
            kinds={kinds}
            // 实体行也能点 —— 改类型要先拆实体，代价在菜单里写明
            onClick={() => setSortOpen((v) => !v)}
          />
        </span>

        <RowMenu row={row} taskName={taskName} onOpenBlocked={onOpenBlocked} />
      </div>

      {/*
        附注行。只在真的有内容时出现 —— 一条「打电话确认交期」的代办
        不该为了对齐而空占 18 像素。缩进对齐到标题的起点
      */}
      {(meta.length > 0 || row.resolution || row.dangling) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[67px] text-[10px] leading-snug">
          {row.dangling && (
            <>
              <span className="font-medium text-rose-500" title="它当初分拣成的那个阻碍/风险已经被删掉了">
                已被删除
              </span>
              {/* 悬挂引用的出路。不给出路的话，用户唯一能做的就是删掉重记一遍，
                  而「谁在什么时候说的」这个原始信息就此丢失 */}
              {row.note && (
                <>
                  <GhostButton onClick={() => setSortOpen(true)}>重新分拣</GhostButton>
                  <GhostButton
                    onClick={() => void store.getState().unpromoteNote(row.note!.id)}
                  >
                    改回未分拣
                  </GhostButton>
                </>
              )}
            </>
          )}

          {meta.map((m, i) => (
            <Fragment key={m}>
              {i > 0 && <span className="text-[var(--rule)]">·</span>}
              <span
                className="text-[var(--text-dim)]"
                style={
                  // 「已卡 N 天」染成阻碍色 —— 它是这一行里唯一还在变大的数字
                  row.blocker?.live && m.startsWith("已卡")
                    ? { color: BLOCKER_KIND.color, fontWeight: 500 }
                    : undefined
                }
              >
                {m}
              </span>
            </Fragment>
          ))}

          {/* 结论写了就一直显示 —— 复盘时值钱的正是这一句，不是那个勾 */}
          {row.resolution && (
            <span className="min-w-0 basis-full truncate text-emerald-600" title={row.resolution}>
              结论：{row.resolution}
            </span>
          )}
        </div>
      )}

      {/* 写结论的输入框。圆圈长得像 checkbox，但点下去的后果是「开始写一句话」——
          这一步摩擦是故意的，它正是「关闭要留下怎么关的」这条规则的全部意义 */}
      {writing && (
        <div className="mt-1 flex items-start gap-1.5 pl-[67px]">
          <textarea
            autoFocus
            value={how}
            onChange={(e) => setHow(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitClose();
              }
              if (e.key === "Escape") setWriting(false);
            }}
            rows={2}
            placeholder={`怎么解决的？（${shortcut("shift", "↵")} 换行）`}
            className="min-w-0 flex-1 resize-none rounded-md border border-[var(--rule)] bg-[var(--surface)] px-1.5 py-1 text-[10px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={submitClose}
            disabled={!how.trim()}
            className="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            关闭
          </button>
          <button
            onClick={() => setWriting(false)}
            className="shrink-0 px-1 py-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            取消
          </button>
        </div>
      )}

      <SortMenu
        anchor={sortAnchor}
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        row={row}
        kinds={kinds}
        onPromote={onPromote}
      />
    </div>
  );
}

/** 附注行里那种不抢眼的小按钮 */
function GhostButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded border border-[var(--rule)] px-1.5 leading-[14px] text-[9px] text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 行内的几个小控件                                                     */
/* ------------------------------------------------------------------ */

/**
 * 右侧那个类型按钮 —— 这个视图里最高频的动作。
 *
 * **三种形态都可点**，但点下去的后果差别很大，所以它们刻意长得不一样：
 *
 *   · **未分拣** —— 虚线框 + 「加入到事项」。它是一句召唤：一条还没决定是
 *     什么的事项，唯一有意义的下一步就是点它
 *   · **已打类型** —— 实色标签 + 类型名。改它只是改一个字段
 *   · **实体**（阻碍 / 风险）—— 实色标签。改它要**先拆掉实体**，
 *     累计天数、顺延记录、归类都会随之消失，所以菜单里会把这件事写出来
 *
 * 实体行一度是不可点的，理由是「身份由实体本身决定」。那条理由站不住：
 * 分错类型是常事（「这其实是个风险，不是阻碍」），而不给改的话用户唯一的
 * 出路是删掉重记一遍 —— 连那句原话一起丢。能改、但把代价说清楚，更好。
 */
const KindButton = forwardRef<
  HTMLButtonElement,
  { row: ItemRow; kinds: ItemKind[]; onClick: () => void }
>(function KindButton({ row, kinds, onClick }, ref) {
  const unsorted = row.source === "note" && row.kind == null;
  const entity = row.source !== "note";
  const color = kindColor(row.kind, kinds);

  return (
    <button
      ref={ref}
      onClick={onClick}
      title={
        unsorted
          ? "还没决定这是什么 —— 点一下分类：阻碍 / 风险 / 代办 / 问题"
          : entity
            ? `${kindLabel(row.kind, kinds)}：它在看板和复盘里也算数。点一下可以改类型（会拆掉这个实体）`
            : `${kindLabel(row.kind, kinds)}　点一下改分类`
      }
      className="shrink-0 rounded-md px-1.5 py-[3px] text-[9px] font-semibold leading-none transition-colors hover:brightness-95"
      style={
        unsorted
          ? { border: "1px dashed var(--rule)", color: "var(--text-dim)" }
          : { background: withAlpha(color, 0.14), color }
      }
    >
      {unsorted ? `${SORT_ACTION_LABEL} ▾` : `${kindLabel(row.kind, kinds)} ▾`}
    </button>
  );
});

function PriorityTag({
  value,
  onPick,
}: {
  value: Priority | null;
  onPick: (p: Priority) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        title={
          value == null
            ? "还没填优先级 —— 点一下填（历史的阻碍和风险确实没有，不伪造一个「中」）"
            : `${PRIORITY_LABELS[value]}　点一下改`
        }
        className="w-[22px] shrink-0 rounded-md py-[3px] text-center text-[9px] font-semibold leading-none"
        style={
          value == null
            ? { border: "1px dashed var(--rule)", color: "var(--text-dim)" }
            : {
                background: withAlpha(PRIORITY_COLORS[value], 0.14),
                color: PRIORITY_COLORS[value],
              }
        }
      >
        {value == null ? "–" : `P${value}`}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={104}>
        {PRIORITY_LABELS.map((label, p) => (
          <MenuItem
            key={label}
            active={p === value}
            onClick={() => {
              setOpen(false);
              onPick(p as Priority);
            }}
          >
            <span className="flex items-center gap-2">
              <span
                className="size-1.5 rounded-full"
                style={{ background: PRIORITY_COLORS[p] }}
              />
              {label}
            </span>
          </MenuItem>
        ))}
      </Popover>
    </>
  );
}
/* ------------------------------------------------------------------ */
/* 分拣菜单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分拣 / 改类型的菜单。
 *
 * ## 两组去向之间那条分隔线是整条功能的核心
 *
 * **阻碍和风险会创建真实实体，代办/问题/自定义只是打上类型。** 这个区别不是
 * 实现细节（设计稿 §6.3）：一个只打标签的「阻碍」不会推排期、不会进复盘的
 * 归因图、不会让卡片落进看板的受阻列 —— 于是同一个词在三个地方指不同的事，
 * 用户没法知道哪个算数。所以菜单里写明前者「会建一条真实的实体」。
 *
 * ## 实体行改类型要先拆掉实体
 *
 * 从阻碍改成风险，不是改一个字段，是**删掉一段受阻、再建一条风险**。
 * 那段区间累计的天数、顺延过的工期（pushed）、归类都随它消失 ——
 * 一条阻碍的身份就是那段区间，区间没了它就不是同一条了。
 *
 * 菜单顶上因此有一句红字。不写的话，用户会以为这和改个标签一样轻，
 * 而丢掉的是复盘时唯一能回答「时间去哪了」的那部分数据。
 *
 * 那句原话不会丢：拆实体的同时它被收回成一条事项（store.reclaimToNote），
 * 然后按新类型重新分拣。两步都在这里编排，所以「改类型」和「分拣」走的是
 * 同一套代码 —— 不会长出两种行为。
 */
function SortMenu({
  anchor,
  open,
  onClose,
  row,
  kinds,
  onPromote,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  row: ItemRow;
  kinds: ItemKind[];
  onPromote: (noteId: number, target: PromoteTarget) => void;
}) {
  const store = useAppStore;
  const openSettings = useAppStore((s) => s.openSettings);
  const entity = row.source !== "note";

  /**
   * 拿到一个可以打类型的事项 id。
   *
   * 事项行直接就是它自己；实体行要先收回 —— 这一步会删掉实体，
   * 是上面那段注释里说的「代价」真正发生的地方。
   */
  const noteIdFor = async (): Promise<number | null> => {
    if (row.note) return row.note.id;
    if (!entity) return null;
    return store.getState().reclaimToNote({
      source: row.source === "blocker" ? "blocker" : "risk",
      // 分拣来的实体退回它原来那条事项，不是新建一条 —— 否则「谁在什么
      // 时候记的」会被刷成现在
      noteId: row.fromNoteId,
      taskId: row.taskId,
      periodId: row.blocker?.period.id,
      riskId: row.risk?.id,
      content: row.title,
      priority: row.priority,
    });
  };

  const pickKind = async (key: string | null) => {
    onClose();
    const id = await noteIdFor();
    if (id == null) return;
    await store.getState().patchItemNote(id, { kind: key });
  };

  const pickEntity = async (target: PromoteTarget) => {
    onClose();
    // 同类型点自己：什么都不做。否则会白拆一次实体再建一个一样的
    if (row.kind === target) return;
    const id = await noteIdFor();
    if (id == null) return;
    onPromote(id, target);
  };

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} width={212}>
      {entity && (
        <div
          className="mx-1.5 mb-1 rounded border px-1.5 py-1 text-[9px] leading-snug"
          style={{
            borderColor: "rgba(244,63,94,0.3)",
            background: "rgba(244,63,94,0.06)",
            color: "#f43f5e",
          }}
        >
          改类型会拆掉这条{kindLabel(row.kind, kinds)}：
          {row.source === "blocker"
            ? "累计天数、顺延过的工期、归类都会消失"
            : "等级和处置说明都会消失"}
          。那句原话会退回成一条事项。
        </div>
      )}

      <div className="px-2.5 pb-1 pt-0.5 text-[9px] leading-snug text-[var(--text-dim)]">
        会建一条真实的实体 —— 它会推排期、进复盘、上看板
      </div>
      <MenuItem active={row.kind === "blocker"} onClick={() => void pickEntity("blocker")}>
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ background: BLOCKER_KIND.color }} />
          {row.kind === "blocker" ? "阻碍（当前）" : "改为阻碍…"}
        </span>
      </MenuItem>
      <MenuItem active={row.kind === "risk"} onClick={() => void pickEntity("risk")}>
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ background: RISK_KIND.color }} />
          {row.kind === "risk" ? "风险（当前）" : "改为风险…"}
        </span>
      </MenuItem>

      <MenuDivider />
      <div className="px-2.5 pb-1 text-[9px] leading-snug text-[var(--text-dim)]">
        只是打上类型，留在事项里
      </div>
      {kinds.map((k) => (
        <MenuItem key={k.key} active={row.kind === k.key} onClick={() => void pickKind(k.key)}>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full" style={{ background: k.color }} />
            <span className="min-w-0 flex-1 truncate">{k.label}</span>
            {k.requiresNote && (
              <span className="shrink-0 text-[8px] text-[var(--text-dim)]">需结论</span>
            )}
          </span>
        </MenuItem>
      ))}

      {/*
        自定义类型在「设置 → 事项类型」，而用户是在**这里**发现「没有我要的
        类型」的。那一刻给一条直达那一页的路，比让他自己去齿轮图标下面翻
        有用得多。
      */}
      <MenuItem
        onClick={() => {
          onClose();
          openSettings("kinds");
        }}
      >
        <span className="flex items-center gap-2 text-[var(--text-dim)]">
          <span className="size-1.5 rounded-full border border-dashed border-[var(--text-dim)]" />
          新建类型…
        </span>
      </MenuItem>

      {(row.kind != null || row.dangling) && (
        <>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              onClose();
              // 悬挂的那条要走 unpromote（它要清掉 promotedKind/Ref）；
              // 实体行要拆实体；只打过类型的那条清掉 kind 就够了
              if (row.dangling && row.note) void store.getState().unpromoteNote(row.note.id);
              else void pickKind(null);
            }}
          >
            改回未分拣
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* 行尾菜单                                                            */
/* ------------------------------------------------------------------ */

function RowMenu({
  row,
  taskName,
  onOpenBlocked,
}: {
  row: ItemRow;
  taskName: string | null;
  onOpenBlocked: (ref: { taskId: number; periodId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const store = useAppStore;

  const remove = () => {
    const s = store.getState();
    setOpen(false);
    setConfirming(false);
    if (row.blocker) s.removeBlocked(row.blocker.taskId, row.blocker.period.id);
    else if (row.risk) void s.removeRisk(row.risk.id);
    else if (row.note) void s.removeItemNote(row.note.id);
  };

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        title="更多"
        className="grid size-5 shrink-0 place-items-center rounded text-[11px] leading-none text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--row-hover)] hover:text-[var(--text)] group-hover:opacity-100"
      >
        ⋯
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
          setConfirming(false);
        }}
        align="right"
        width={188}
      >
        {row.blocker && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              onOpenBlocked({ taskId: row.blocker!.taskId, periodId: row.blocker!.period.id });
            }}
          >
            打开阻碍详情…
          </MenuItem>
        )}
        {/*
          菜单项里**写明是哪条任务**。行上已经不显示关联任务了（见 Row 的
          注释），一句「打开这条任务」等于让用户闭着眼点 —— 他看不出这一行
          挂着的是哪条活，也就不知道点下去会跳到哪。
        */}
        {row.taskId != null && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              store.getState().openDetail(row.taskId!);
            }}
          >
            打开 {taskName ?? `#${row.taskId}`}
          </MenuItem>
        )}
        {row.fromNoteId != null && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              void store.getState().unpromoteNote(row.fromNoteId!);
            }}
          >
            撤销分拣（删掉这个实体）
          </MenuItem>
        )}

        <MenuDivider />
        {confirming ? (
          <MenuItem danger onClick={remove}>
            真的删掉？这条点一下就没了
          </MenuItem>
        ) : (
          <MenuItem danger onClick={() => setConfirming(true)}>
            删除
          </MenuItem>
        )}
      </Popover>
    </>
  );
}

/** 事项视图里能挂实体的那些活 —— 给分拣对话框用，判据和别处共用一个 */
export const promotable = (tasks: ResolvedTask[], day: number): ResolvedTask[] =>
  tasks.filter((t) => !t.hasChildren && isInProgress(t, day));
