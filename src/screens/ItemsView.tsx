import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type Priority, type ResolvedTask } from "../gantt/model";
import { columnOf, isInProgress } from "../core/board";
import { today } from "../gantt/time";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { withAlpha } from "../gantt/coloring";
import { RISK_COLORS, RISK_LEVELS } from "../core/risks";
import { reasonLabel } from "../core/blocked";
import { shortcut } from "../core/keys";
import {
  BLOCKER_KIND,
  EMPTY_FILTER,
  RISK_KIND,
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
import { FilterSelect, type SelectOption } from "./FilterSelect";
import { Avatar } from "./Avatar";
import type { Person } from "../db/api";
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
              tasks={tasks}
              taskName={taskName(row.taskId)}
              person={personOf(row.personId)}
              people={people}
              day={day}
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
                    tasks={tasks}
                    taskName={taskName(row.taskId)}
                    person={personOf(row.personId)}
                    people={people}
                    day={day}
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
  kinds: { key: string; label: string; color: string }[];
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
  const inputRef = useRef<HTMLInputElement>(null);

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
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && dropdownOpen.current === 0) void submit();
        }}
        placeholder="记一条…（↵ 保存并接着记）"
        className="min-w-[160px] flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
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

function Row({
  row,
  kinds,
  tasks,
  taskName,
  person,
  people,
  day,
  autoSort,
  onOpenBlocked,
  onPromote,
}: {
  row: ItemRow;
  kinds: { key: string; label: string; color: string; requiresNote: boolean; builtin: boolean }[];
  tasks: ResolvedTask[];
  taskName: string | null;
  person: Person | null;
  people: Person[];
  day: number;
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

  const policy = closePolicy(row, kinds as never);

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

  const circleTitle =
    policy === "forbidden"
      ? row.dangling
        ? "这一行指向的东西已经被删了 —— 先重新分拣"
        : "还没分拣的事项不能关闭：先决定它是什么"
      : policy === "note"
        ? "关闭：写一句「怎么解决的」"
        : policy === "blocker"
          ? "标记为已解决：区间收到昨天，卡片当场离开受阻列"
          : "标记完成";

  return (
    <div
      className={`group rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)] ${
        row.closed ? "opacity-55" : ""
      }`}
      style={
        row.blocker?.live ? { background: withAlpha(BLOCKER_KIND.color, 0.06) } : undefined
      }
    >
      <div className="flex items-center gap-2">
        {/* 圆圈。点下去的后果按类型不同 —— 见 core/items.closePolicy */}
        <button
          onClick={toggleClose}
          disabled={policy === "forbidden" && !row.closed}
          title={circleTitle}
          className="grid size-4 shrink-0 place-items-center rounded-full border text-[9px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-35"
          style={{
            borderColor: row.closed ? "var(--text-dim)" : "var(--rule)",
            color: "var(--text-dim)",
          }}
        >
          {row.closed ? "✓" : ""}
        </button>

        {/* 优先级。没填过的显示一个空槽，不伪造一个「中」 */}
        <PriorityTag value={row.priority} onPick={setPriority} />

        {/* 类型。未分拣时点它出分拣菜单 —— 那是这个视图最高频的动作 */}
        <button
          ref={setSortAnchor}
          onClick={() => {
            if (row.source === "note") setSortOpen((v) => !v);
          }}
          disabled={row.source !== "note"}
          title={
            row.source !== "note"
              ? `${kindLabel(row.kind, kinds as never)}：这是一个实体，类型由它自己决定`
              : "分拣：决定这是什么"
          }
          className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold leading-none disabled:cursor-default"
          style={{
            background: withAlpha(kindColor(row.kind, kinds as never), 0.16),
            color: kindColor(row.kind, kinds as never),
          }}
        >
          {kindLabel(row.kind, kinds as never)}
          {row.source === "note" && row.kind == null ? " ▾" : ""}
        </button>

        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            row.closed ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"
          }`}
          title={row.title}
        >
          {row.title || "（没写内容）"}
        </span>

        {/* 悬挂引用：实体被单独删掉了。原始那句话必须留着 */}
        {row.dangling && (
          <span
            className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold leading-none text-rose-500"
            style={{ background: "rgba(244,63,94,0.12)" }}
            title="它当初分拣成的那个阻碍/风险已经被删掉了"
          >
            已被删除
          </span>
        )}

        {/* 这条实体是从事项分拣来的 */}
        {row.fromNoteId != null && (
          <span
            className="shrink-0 text-[10px] text-[var(--text-dim)]"
            title="这一条是从一则事项分拣出来的"
          >
            ⤴
          </span>
        )}

        {/* 阻碍/风险各自的那点额外信息 */}
        {row.blocker && (
          <span
            className="shrink-0 font-mono text-[9px] tabular-nums"
            style={{ color: row.blocker.live ? BLOCKER_KIND.color : "var(--text-dim)" }}
            title={`${reasonLabel(row.blocker.period.reason)}　${
              row.blocker.live ? "持续中" : "已结束"
            }`}
          >
            {row.blocker.days} 天
          </span>
        )}
        {row.risk && (
          <span
            className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none"
            style={{
              background: withAlpha(RISK_COLORS[row.risk.level] ?? RISK_COLORS[1], 0.16),
              color: RISK_COLORS[row.risk.level] ?? RISK_COLORS[1],
            }}
            title="风险等级：多严重（和优先级「先做哪个」是两个轴）"
          >
            {RISK_LEVELS[row.risk.level] ?? "中"}
          </span>
        )}

        <PersonTag row={row} person={person} people={people} />
        <TaskTag row={row} tasks={tasks} taskName={taskName} day={day} />

        <span className="w-9 shrink-0 text-right font-mono text-[9px] tabular-nums text-[var(--text-dim)]">
          {shortDate(row.createdAt)}
        </span>

        <RowMenu row={row} onOpenBlocked={onOpenBlocked} onPromote={onPromote} />
      </div>

      {/* 结论。写了的话一直显示 —— 复盘时值钱的正是这一句 */}
      {row.resolution && (
        <div className="mt-0.5 pl-[26px] text-[10px] leading-snug text-emerald-600">
          结论：{row.resolution}
        </div>
      )}

      {/* 悬挂引用的出路。不给出路的话，用户唯一能做的就是删掉重记一遍 */}
      {row.dangling && row.note && (
        <div className="mt-1 flex items-center gap-1.5 pl-[26px]">
          <button
            onClick={() => setSortOpen(true)}
            className="rounded border border-[var(--rule)] px-1.5 py-0.5 text-[9px] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            重新分拣
          </button>
          <button
            onClick={() => void store.getState().unpromoteNote(row.note!.id)}
            className="rounded border border-[var(--rule)] px-1.5 py-0.5 text-[9px] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            改回未分拣
          </button>
        </div>
      )}

      {/* 写结论的输入框。它长得像 checkbox，但点下去的后果是「开始写一句话」——
          这一步摩擦是故意的，它正是「关闭要留下怎么关的」这条规则的全部意义 */}
      {writing && (
        <div className="mt-1 flex items-start gap-1.5 pl-[26px]">
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
            className="min-w-0 flex-1 resize-none rounded border border-[var(--rule)] bg-[var(--surface)] px-1.5 py-1 text-[10px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={submitClose}
            disabled={!how.trim()}
            className="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40"
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

/* ------------------------------------------------------------------ */
/* 行内的几个小控件                                                     */
/* ------------------------------------------------------------------ */

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
        title={value == null ? "还没填优先级 —— 点一下填" : "先做哪个"}
        className="w-7 shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-semibold leading-none"
        style={
          value == null
            ? { border: "1px dashed var(--rule)", color: "var(--text-dim)" }
            : {
                background: withAlpha(PRIORITY_COLORS[value], 0.16),
                color: PRIORITY_COLORS[value],
              }
        }
      >
        {value == null ? "—" : `P${value}`}
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

/**
 * 负责人。
 *
 * 事项行上可改；实体行上**只读** —— 阻碍和风险挂在活上，「谁的」就是那条活的
 * 负责人。在这里单独改一个会立刻和任务详情里显示的那个不一致，而那是两份真相。
 */
function PersonTag({
  row,
  person,
  people,
}: {
  row: ItemRow;
  person: Person | null;
  people: Person[];
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const editable = row.source === "note";

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => editable && setOpen((v) => !v)}
        disabled={!editable}
        title={
          editable
            ? person?.name ?? "未指派 —— 点一下指派"
            : `${person?.name ?? "未指派"}：跟着它挂的那条活走`
        }
        className="shrink-0 disabled:cursor-default"
      >
        <Avatar person={person} size={16} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={168}>
        <div className="max-h-56 overflow-y-auto">
          <MenuItem
            active={person == null}
            onClick={() => {
              setOpen(false);
              if (row.note) void useAppStore.getState().patchItemNote(row.note.id, { personId: null });
            }}
          >
            未指派
          </MenuItem>
          {people.map((p) => (
            <MenuItem
              key={p.id}
              active={p.id === person?.id}
              onClick={() => {
                setOpen(false);
                if (row.note)
                  void useAppStore.getState().patchItemNote(row.note.id, { personId: p.id });
              }}
            >
              <span className="flex items-center gap-2">
                <Avatar person={p} size={16} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </span>
            </MenuItem>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** 关联的活。同上：事项行可改，实体行只读（实体就挂在那条活上） */
function TaskTag({
  row,
  tasks,
  taskName,
  day,
}: {
  row: ItemRow;
  tasks: ResolvedTask[];
  taskName: string | null;
  day: number;
}) {
  const editable = row.source === "note";
  const openDetail = useAppStore((s) => s.openDetail);

  const options = useMemo<SelectOption<number | null>[]>(() => {
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

  if (!editable) {
    return (
      <button
        onClick={() => row.taskId != null && openDetail(row.taskId)}
        disabled={row.taskId == null}
        title={row.taskId == null ? "没挂在任务上" : "打开这条任务"}
        className="w-28 shrink-0 truncate text-right text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] hover:underline disabled:no-underline disabled:hover:text-[var(--text-dim)]"
      >
        {taskName ?? "—"}
      </button>
    );
  }

  return (
    <div className="w-28 shrink-0">
      <FilterSelect
        value={row.taskId}
        options={options}
        onPick={(id) => {
          if (row.note) void useAppStore.getState().patchItemNote(row.note.id, { taskId: id });
        }}
        placeholder="—"
        title="关联的活。进行中的排在前面"
        width={112}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 分拣菜单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分拣去向。
 *
 * **阻碍和风险会创建真实实体，代办/问题/自定义只是打上类型。**
 * 这个区别不是实现细节，它是整条功能的核心（设计稿 §6.3）：一个只打标签的
 * 「阻碍」不会推排期、不会进复盘的归因图、不会让卡片进受阻列 —— 于是同一个词
 * 在三个地方指不同的事，用户没法知道哪个算数。
 *
 * 所以菜单里这两组之间有一条分隔线，而且写明了前者「会建一条真实的阻碍/风险」。
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
  kinds: { key: string; label: string; color: string; requiresNote: boolean; builtin: boolean }[];
  onPromote: (noteId: number, target: PromoteTarget) => void;
}) {
  const noteId = row.note?.id;
  const unpromote = useAppStore((s) => s.unpromoteNote);
  const patch = useAppStore((s) => s.patchItemNote);

  if (noteId == null) return null;

  const pickKind = (key: string | null) => {
    onClose();
    void patch(noteId, { kind: key });
  };

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} width={204}>
      <div className="px-2.5 pb-1 pt-0.5 text-[9px] leading-snug text-[var(--text-dim)]">
        会建一条真实的实体 —— 它会推排期、进复盘、上看板
      </div>
      <MenuItem
        onClick={() => {
          onClose();
          onPromote(noteId, "blocker");
        }}
      >
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ background: BLOCKER_KIND.color }} />
          分拣为阻碍…
        </span>
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          onPromote(noteId, "risk");
        }}
      >
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ background: RISK_KIND.color }} />
          分拣为风险…
        </span>
      </MenuItem>

      <MenuDivider />
      <div className="px-2.5 pb-1 text-[9px] leading-snug text-[var(--text-dim)]">
        只是打上类型，留在事项里
      </div>
      {kinds.map((k) => (
        <MenuItem key={k.key} active={row.kind === k.key} onClick={() => pickKind(k.key)}>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full" style={{ background: k.color }} />
            <span className="min-w-0 flex-1 truncate">{k.label}</span>
            {k.requiresNote && (
              <span className="shrink-0 text-[8px] text-[var(--text-dim)]">需结论</span>
            )}
          </span>
        </MenuItem>
      ))}

      {(row.kind != null || row.dangling) && (
        <>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              onClose();
              // 悬挂的那条要走 unpromote（它要清掉 promotedKind/Ref）；
              // 只打过类型的那条清掉 kind 就够了
              if (row.dangling) void unpromote(noteId);
              else pickKind(null);
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
  onOpenBlocked,
  onPromote,
}: {
  row: ItemRow;
  onOpenBlocked: (ref: { taskId: number; periodId: string }) => void;
  onPromote: (noteId: number, target: PromoteTarget) => void;
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
        {row.taskId != null && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              store.getState().openDetail(row.taskId!);
            }}
          >
            打开这条任务
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
        {row.source === "note" && row.note && !row.dangling && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              onPromote(row.note!.id, "blocker");
            }}
          >
            分拣为阻碍…
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
