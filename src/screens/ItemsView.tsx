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
  MANY_KINDS,
  applyManualOrder,
  closePolicy,
  filterItems,
  frequentKinds,
  hasFilter,
  kindColor,
  kindLabel,
  mergeItems,
  moveItem,
  searchKinds,
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
import { ExportButton } from "./ExportButton";

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
 *
 * 用户也可以拖行首的 ⋮⋮ 手动排。排过之后顺序存在 settings 里（按项目），
 * 新记的那条排在最上面；头部能一键恢复时间顺序。
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
  const itemOrder = useAppStore((s) => s.itemOrder);
  const setItemOrder = useAppStore((s) => s.setItemOrder);

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
      applyManualOrder(
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
        itemOrder,
      ),
    [notes, tasks, risks, day, itemOrder],
  );
  const manual = itemOrder.length > 0;

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

  /**
   * 挪一行。操作的是**全部行**的顺序（见 core/items.moveItem），
   * 所以有筛选时拖动，被筛掉的那些不会跟着乱。
   */
  const move = (from: string, to: string, place: "before" | "after") =>
    setItemOrder(moveItem(rows.map((r) => r.key), from, to, place));

  /** ⋯ 菜单里的上移 / 下移：和**屏幕上**相邻的那一行换位置 */
  const moveBy = (row: ItemRow, list: ItemRow[], delta: -1 | 1) => {
    const i = list.findIndex((r) => r.key === row.key);
    const next = list[i + delta];
    if (next) move(row.key, next.key, delta < 0 ? "before" : "after");
  };

  const drag = useRowDrag(move);

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

  // 头部计数说的是「整个项目还有多少没处理」，不跟着筛选器变 ——
  // 筛出来多少条写在筛选栏自己那一行
  const openTotal = rows.filter((r) => !r.closed).length;
  const unsorted = rows.filter((r) => r.kind == null && !r.closed).length;
  const filtering = hasFilter(filter);
  // 未关闭里一条都没命中、而已关闭里有：直接摊开。不然用户看到的是「没有」，
  // 而答案其实就折在下面
  const showClosed = closedOpen || (filtering && open.length === 0 && closed.length > 0);

  return (
    <div className="flex min-h-0 w-full flex-col bg-[var(--surface)]">
      {/* 头部：计数 + 筛选器 */}
      <div className="shrink-0 border-b border-[var(--rule)] px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">事项</h2>
          <span className="text-[10px] text-[var(--text-dim)]">
            {openTotal} 条未关闭
            {unsorted > 0 && ` · ${unsorted} 条还没分拣`}
            {manual ? " · 手动排序" : " · 按记录时间倒序"}
          </span>
          {manual && (
            <button
              onClick={() => setItemOrder([])}
              title="丢掉手动排的顺序，回到按记录时间倒序"
              className="text-[10px] text-[var(--text-dim)] underline-offset-2 transition-colors hover:text-[var(--text)] hover:underline"
            >
              恢复时间顺序
            </button>
          )}

          {/*
            不再放「＋ 记一条」按钮：下面就是常驻录入行，同一个视图里两个入口
            做同一件事只会让人犹豫点哪个。⌘K 那个弹窗是给**别的**视图用的，
            这里只提一句它的存在
          */}
          <button
            onClick={() => setQuickNoteOpen(true)}
            title="在任何视图下都能唤出快速记录"
            className="ml-auto shrink-0 text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
          >
            <Kbd>{shortcut("mod", "K")}</Kbd> 随处记一条
          </button>

          {/* 导出的是**筛出来的这些**，按屏幕上的顺序 —— 见 export/items.ts */}
          <ExportButton
            label="⤓ 导出 Excel"
            title={
              filtering
                ? `把筛出来的 ${visible.length} 条事项导出成 Excel`
                : "把全部事项导出成 Excel（先筛选就只导筛出来的）"
            }
            size="sm"
            run={async () =>
              (await import("../export/run")).exportItemsToExcel({
                rows: [...open, ...closed],
                kinds,
                people,
                taskName,
                filterSummary: describeFilter(filter, { kinds, people, taskName }),
              })
            }
          />
        </div>

        <Filters
          filter={filter}
          onChange={setFilter}
          kinds={kinds}
          people={people}
          tasks={tasks}
          matched={visible.length}
        />
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
            {!filtering ? (
              <>
                {closed.length > 0 ? "全部处理完了。" : "还没有事项。"}想到什么就在上面记一句 ——
                <br />
                不用先想清楚它是什么，也不用填日期。
              </>
            ) : closed.length > 0 ? (
              <>未关闭的事项里没有匹配的，下面是已关闭里命中的 {closed.length} 条。</>
            ) : (
              <>
                这些筛选条件下没有事项。
                <div className="mt-2">
                  <button
                    onClick={() => setFilter(EMPTY_FILTER)}
                    className="rounded-md border border-[var(--rule)] px-2.5 py-1 text-[10px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    清除筛选
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {open.map((row, i) => (
            <Row
              key={row.key}
              row={row}
              kinds={kinds}
              taskName={taskName(row.taskId)}
              person={personOf(row.personId)}
              autoSort={row.note?.id != null && row.note.id === autoSort}
              onOpenBlocked={setBlockedDetail}
              onPromote={(noteId, target) => setPromoting({ noteId, target })}
              drag={drag}
              onMoveUp={i > 0 ? () => moveBy(row, open, -1) : undefined}
              onMoveDown={i < open.length - 1 ? () => moveBy(row, open, 1) : undefined}
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
              <span className="w-2">{showClosed ? "▾" : "▸"}</span>
              已关闭 ({closed.length})
            </button>
            {showClosed && (
              <div className="mt-0.5 flex flex-col gap-0.5">
                {closed.map((row, i) => (
                  <Row
                    key={row.key}
                    row={row}
                    kinds={kinds}
                    taskName={taskName(row.taskId)}
                    person={personOf(row.personId)}
                    onOpenBlocked={setBlockedDetail}
                    onPromote={(noteId, target) => setPromoting({ noteId, target })}
                    drag={drag}
                    onMoveUp={i > 0 ? () => moveBy(row, closed, -1) : undefined}
                    onMoveDown={i < closed.length - 1 ? () => moveBy(row, closed, 1) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 跟手的小标签：拖的是哪一条，一眼就知道 */}
      {drag.ghost && (
        <div
          className="pointer-events-none fixed z-50 max-w-[260px] truncate rounded-lg border border-[var(--accent)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text)] shadow-lg"
          style={{ left: drag.ghost.x + 12, top: drag.ghost.y + 8 }}
        >
          {drag.ghost.title}
        </div>
      )}

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
 * 一个搜索框 + 三个可叠加的筛选器。
 *
 * 类型筛选器里有一项「未分拣」—— `null` 是一个真实的值，不是「不筛」。
 * 「现在有哪些还没想清楚」是这个视图被打开的主要理由之一。
 *
 * ## 搜索在最前
 *
 * 和 Linear / GitHub Issues 一样：找一条记得大概说了什么的事项，是比
 * 「按维度收窄」更常见的动作，它不该排在三个 chip 后面、缩成一个小框。
 *
 * ## 为什么没有「仅未关闭」
 *
 * 已关闭的本来就折在列表底部，不点开就看不到 —— 那个开关做的事和折叠
 * 一模一样，却还会把「有筛选」的状态点亮，让空状态说出「这些筛选条件下
 * 没有事项」这种误导的话。
 */
function Filters({
  filter,
  onChange,
  kinds,
  people,
  tasks,
  matched,
}: {
  filter: ItemFilter;
  onChange: (f: ItemFilter) => void;
  kinds: ItemKind[];
  people: { id: number; name: string; color: string }[];
  tasks: ResolvedTask[];
  /** 筛完还剩几条（含已关闭）。只在有筛选时显示 */
  matched: number;
}) {
  const kindOptions = [
    { value: null as string | null, label: UNSORTED_KIND.label, color: UNSORTED_KIND.color },
    { value: BLOCKER_KIND.key, label: BLOCKER_KIND.label, color: BLOCKER_KIND.color },
    { value: RISK_KIND.key, label: RISK_KIND.label, color: RISK_KIND.color },
    ...kinds.map((k) => ({ value: k.key as string | null, label: k.label, color: k.color })),
  ];

  // 旧状态里可能还留着 onlyOpen（界面上已经没有开关了）—— 当作没开
  const active = hasFilter({ ...filter, onlyOpen: false });

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <label className="flex h-6 w-44 items-center gap-1.5 rounded-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 transition-colors focus-within:border-[var(--accent)]">
        <span className="text-[11px] leading-none text-[var(--text-dim)]" aria-hidden>
          ⌕
        </span>
        <input
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.query) {
              e.stopPropagation();
              onChange({ ...filter, query: "" });
            }
          }}
          placeholder="搜索标题或结论…"
          className="min-w-0 flex-1 bg-transparent text-[10px] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
        />
        {filter.query && (
          <button
            onClick={() => onChange({ ...filter, query: "" })}
            title="清空搜索"
            className="text-[10px] leading-none text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            ×
          </button>
        )}
      </label>

      <span className="mx-0.5 h-3.5 w-px bg-[var(--rule)]" aria-hidden />

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
      {/*
        按关联的任务筛。任务通常比类型和负责人多得多，选项一多就自动给搜索框
        （见 Chips）；按名字和 #编号都能搜到
      */}
      <Chips
        label="任务"
        options={[
          { value: null as number | null, label: "未关联任务", color: UNSORTED_KIND.color },
          ...tasks.map((t) => ({
            value: t.id as number | null,
            label: `#${t.id} ${t.name || "未命名"}`,
          })),
        ]}
        selected={filter.tasks ?? []}
        onChange={(sel) => onChange({ ...filter, tasks: sel })}
        width={240}
      />

      {active && (
        <span className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-dim)]">
          筛出 {matched} 条
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="rounded-md px-1.5 py-0.5 font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            清除全部
          </button>
        </span>
      )}
    </div>
  );
}

/** 键帽。只用来**提一句**快捷键，不是可点的东西 */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-1 font-sans text-[9px] leading-[14px] text-[var(--text-dim)]">
      {children}
    </kbd>
  );
}

/**
 * 一个多选筛选器。空选 = 不筛这一维。
 *
 * 选项多了（> MANY_KINDS）就给搜索框。类型和负责人两维都会长 ——
 * 类型是用户自己加的，负责人是全局表 —— 而滚着找三十项里的那一个，
 * 和没有这个筛选器差不多。
 */
function Chips<T>({
  label,
  options,
  selected,
  onChange,
  width = 172,
}: {
  label: string;
  options: { value: T; label: string; color?: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  /** 弹出层宽度。任务名长，那一维给宽一点 */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const on = selected.length > 0;
  const many = options.length > MANY_KINDS;

  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const close = () => {
    setOpen(false);
    // 留着上次那个词，下次打开就是筛过的，而用户不记得自己筛过
    setQuery("");
  };

  const toggle = (value: T) =>
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );

  // 选中了什么就写什么（「类型：阻碍 +1」），而不是「类型 2」——
  // 后者逼人点开才知道自己筛的是哪两个
  const first = options.find((o) => o.value === selected[0]);
  const summary = on
    ? `${label}：${first?.label ?? "?"}${selected.length > 1 ? ` +${selected.length - 1}` : ""}`
    : `${label} ▾`;

  return (
    <>
      <span
        ref={setAnchor}
        className="inline-flex h-6 items-center rounded-full border text-[10px] font-medium transition-colors"
        style={
          on
            ? {
                borderColor: "var(--accent)",
                color: "var(--accent)",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              }
            : { borderColor: "var(--rule)", color: "var(--text-dim)" }
        }
      >
        <button
          onClick={() => (open ? close() : setOpen(true))}
          title={on ? options.filter((o) => selected.includes(o.value)).map((o) => o.label).join("、") : undefined}
          className={`h-full max-w-[160px] truncate pl-2.5 ${on ? "pr-1" : "pr-2.5"} hover:text-[var(--text)]`}
          style={on ? { color: "inherit" } : undefined}
        >
          {summary}
        </button>
        {/* 一键去掉这一维。不给的话清一个维度要「点开 → 滚到底 → 不筛这一维」三步 */}
        {on && (
          <button
            onClick={() => onChange([])}
            title={`清除「${label}」筛选`}
            aria-label={`清除${label}筛选`}
            className="grid h-full place-items-center rounded-r-full pl-0.5 pr-2 leading-none opacity-70 hover:opacity-100"
          >
            ×
          </button>
        )}
      </span>
      <Popover anchor={anchor} open={open} onClose={close} width={width}>
        {many && (
          <div className="px-1.5 pb-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={`搜${label}…`}
              className="w-full rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-1.5 py-1 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        )}

        <div className="max-h-56 overflow-y-auto">
          {shown.map((o) => {
            const picked = selected.includes(o.value);
            return (
              <MenuItem key={String(o.value)} active={picked} onClick={() => toggle(o.value)}>
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
          {shown.length === 0 && (
            <div className="px-2.5 py-1.5 text-[10px] text-[var(--text-dim)]">
              没有匹配的
            </div>
          )}
        </div>

        {on && (
          <>
            <MenuDivider />
            <MenuItem onClick={() => onChange([])}>清除这一项筛选</MenuItem>
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
      {/* 和标题框同高：它是这一行的终点，不该比旁边的下拉还矮 */}
      <button
        onClick={() => void submit()}
        disabled={!name.trim()}
        title="保存并接着记"
        className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: "var(--accent)" }}
      >
        记下来
        <span className="text-[10px] opacity-70">↵</span>
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
  drag,
  onMoveUp,
  onMoveDown,
}: {
  row: ItemRow;
  kinds: ItemKind[];
  /** 只进 title，不占版面 —— 见上面那段 */
  taskName: string | null;
  person: Person | null;
  autoSort?: boolean;
  onOpenBlocked: (ref: { taskId: number; periodId: string }) => void;
  onPromote: (noteId: number, target: PromoteTarget) => void;
  drag: RowDrag;
  /** 已经在最上面 / 最下面时不传 */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
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

  // 取消也清掉草稿 —— 下次再点圆圈是一次新的关闭，不该冒出上次写了一半的话
  const cancelClose = () => {
    setHow("");
    setWriting(false);
  };

  const closeLabel = row.source === "risk" ? "关闭风险" : "关闭事项";

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

  const dropAt = drag.over?.key === row.key ? drag.over.place : null;

  return (
    <div
      ref={drag.rowRef(row.key, row.closed)}
      className="group relative rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)]"
      style={{
        // 持续中的阻碍是唯一一类「现在就要人去处理」的行，给它一道底色。
        // 其余一律不上色 —— 一张人人高亮的列表等于没有高亮
        background:
          row.blocker?.live && !row.closed ? withAlpha(BLOCKER_KIND.color, 0.05) : undefined,
        opacity: drag.dragKey === row.key ? 0.4 : 1,
      }}
    >
      {/* 落点指示线：落下之后这一条会出现在线的位置 */}
      {dropAt && (
        <span
          className="pointer-events-none absolute inset-x-1 h-0.5 rounded-full"
          style={{ background: "var(--accent)", [dropAt === "before" ? "top" : "bottom"]: -1.5 }}
        />
      )}
      {/*
        拖动手柄。只有它能起拖 —— 整行可拖的话，选中标题里的文字、
        点圆圈和类型按钮都会和拖动抢同一个按下。

        绝对定位在行的左内边距里：不占布局，附注行和结论框的缩进不用跟着改
      */}
      <span
        onPointerDown={(e) => drag.start(row, e)}
        title="拖动调整顺序"
        aria-hidden
        className="absolute left-0 top-1.5 grid h-5 w-2 cursor-grab select-none place-items-center text-[9px] leading-none tracking-[-2px] text-[var(--text-dim)] opacity-0 transition-opacity active:cursor-grabbing group-hover:opacity-100"
      >
        ⋮⋮
      </span>
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
          固定宽度的槽位，标签靠右贴齐、**自己截断**。
          
          固定宽度的理由：「加入到事项 ▾」比「阻碍」宽一倍多，不给槽位的话
          右侧那几列会被它顶得一行一个位置 —— 一列对不齐的数字比没有这一列
          更难读。
          
          截断的理由：类型名是用户起的。一个叫「等客户确认图纸」的类型
          本来会溢出槽位、压到行尾的 ⋯ 上。设置里那个输入框已经限了长度
          （见 Settings.KindRow），这里是第二道 —— 旧数据和导入的数据不受
          那个限制管。完整的名字在 title 里。
        */}
        <span className="flex w-[76px] shrink-0 justify-end overflow-hidden">
          <KindButton
            ref={setSortAnchor}
            row={row}
            kinds={kinds}
            // 实体行也能点 —— 改类型要先拆实体，代价在菜单里写明
            onClick={() => setSortOpen((v) => !v)}
          />
        </span>

        <RowMenu
          row={row}
          taskName={taskName}
          onOpenBlocked={onOpenBlocked}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />
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
      {/*
        布局和应用里其他对话框一致（PromoteDialog / BlockedDetail）：
        输入框占满一行，按钮在它**下方靠右**，次要的「取消」在左、主动作在最右。
        之前是「关闭」在左「取消」在右、挤在输入框旁边 —— 和别处顺序相反，
        手按习惯点最右边那个，结果点到的是取消。

        主按钮也不再只写「关闭」：这一行里「关闭」既可能是关掉这个输入框，
        也可能是关掉这条事项，正好是两个相反的结果。
      */}
      {writing && (
        <div className="mt-1.5 pl-[67px] pr-7">
          <div className="rounded-lg border border-[var(--accent)] bg-[var(--surface)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)]">
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
                if (e.key === "Escape") cancelClose();
              }}
              rows={2}
              placeholder={
                row.source === "risk" ? "这个风险是怎么处置的？" : "怎么解决的？一句话就够"
              }
              className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            />
            <div className="flex items-center gap-2 border-t border-[var(--rule)] px-2 py-1.5">
              <span className="text-[9px] text-[var(--text-dim)]">
                <Kbd>↵</Kbd> {closeLabel}　<Kbd>{shortcut("shift", "↵")}</Kbd> 换行　<Kbd>Esc</Kbd> 取消
              </span>
              <button
                onClick={cancelClose}
                className="ml-auto rounded-md px-2.5 py-1 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
              >
                取消
              </button>
              <button
                onClick={submitClose}
                disabled={!how.trim()}
                title={how.trim() ? undefined : "先写一句结论"}
                className="rounded-md px-3 py-1 text-[11px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--accent)" }}
              >
                {closeLabel}
              </button>
            </div>
          </div>
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
      className="max-w-full truncate rounded-md px-1.5 py-[3px] text-[9px] font-semibold leading-none transition-colors hover:brightness-95"
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
  const notes = useAppStore((s) => s.itemNotes);
  const entity = row.source !== "note";

  const [query, setQuery] = useState("");
  const many = kinds.length > MANY_KINDS;
  const filtered = useMemo(() => searchKinds(kinds, query), [kinds, query]);
  const frequent = useMemo(() => frequentKinds(kinds, notes), [kinds, notes]);

  // 每次重开都从空搜索开始 —— 留着上次那个词，菜单一打开就是筛过的，
  // 而用户不记得自己筛过
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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

      {/*
        类型多了之后才给搜索框。三五个类型的时候它是纯噪音，
        二十个的时候不给就得滚着找 —— 见 core/items.MANY_KINDS。
      */}
      {many && (
        <div className="px-1.5 pb-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 不外泄：Esc 在 Popover 那层是关窗，Enter 在工作区是新建任务
              e.stopPropagation();
              if (e.key === "Enter" && filtered.length > 0) {
                e.preventDefault();
                void pickKind(filtered[0].key);
              }
            }}
            placeholder="搜类型…"
            className="w-full rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-1.5 py-1 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      )}

      {/*
        「常用」单独一组放在上面，下面那份完整清单**顺序不变**。
        整个菜单按频次重排的话，用户记住「问题在第二个」之后某天它会跳走，
        而他看不出发生了什么（见 core/items.frequentKinds）。
      */}
      {many && !query && frequent.length > 0 && (
        <>
          <div className="px-2.5 pb-0.5 text-[9px] text-[var(--text-dim)]">
            这个项目常用
          </div>
          {frequent.map((k) => (
            <KindMenuItem
              key={`freq-${k.key}`}
              kind={k}
              active={row.kind === k.key}
              onClick={() => void pickKind(k.key)}
            />
          ))}
          <MenuDivider />
        </>
      )}

      {/* 限高 + 滚动。不加的话二十个类型会让菜单比屏幕还高，
          而底下那句「新建类型…」就永远点不到了 */}
      <div className="max-h-[184px] overflow-y-auto">
        {filtered.map((k) => (
          <KindMenuItem
            key={k.key}
            kind={k}
            active={row.kind === k.key}
            onClick={() => void pickKind(k.key)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-2.5 py-1.5 text-[10px] text-[var(--text-dim)]">
            没有匹配的类型
          </div>
        )}
      </div>

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

/** 分拣菜单里的一个类型。常用组和完整清单共用，免得两处各写一遍样式 */
function KindMenuItem({
  kind,
  active,
  onClick,
}: {
  kind: ItemKind;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <MenuItem active={active} onClick={onClick}>
      <span className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: kind.color }} />
        <span className="min-w-0 flex-1 truncate">{kind.label}</span>
        {kind.requiresNote && (
          <span className="shrink-0 text-[8px] text-[var(--text-dim)]">需结论</span>
        )}
      </span>
    </MenuItem>
  );
}

/* ------------------------------------------------------------------ */
/* 行尾菜单                                                            */
/* ------------------------------------------------------------------ */

function RowMenu({
  row,
  taskName,
  onOpenBlocked,
  onMoveUp,
  onMoveDown,
}: {
  row: ItemRow;
  taskName: string | null;
  onOpenBlocked: (ref: { taskId: number; periodId: string }) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
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
        aria-label="更多操作"
        // 平时隐身，悬停 / 键盘聚焦 / 菜单开着时都要看得见 —— 只认悬停的话，
        // 键盘用户 Tab 到它时是在对着一块空白按回车
        className={`grid size-5 shrink-0 place-items-center rounded text-[11px] leading-none text-[var(--text-dim)] transition-opacity hover:bg-[var(--row-hover)] hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100 ${
          open ? "bg-[var(--row-hover)] opacity-100" : "opacity-0"
        }`}
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

        {/* 拖不动的时候（触控板、键盘）也得有办法排 */}
        {(onMoveUp || onMoveDown) && (
          <>
            <MenuDivider />
            {onMoveUp && (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onMoveUp();
                }}
              >
                上移一位
              </MenuItem>
            )}
            {onMoveDown && (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onMoveDown();
                }}
              >
                下移一位
              </MenuItem>
            )}
          </>
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

/* ------------------------------------------------------------------ */
/* 手动排序                                                            */
/* ------------------------------------------------------------------ */

/** 按下之后挪过这么多像素才算开始拖 —— 否则点一下手柄会闪一下拖拽态 */
const DRAG_THRESHOLD = 4;

type RowDrag = ReturnType<typeof useRowDrag>;

/**
 * 行拖拽，用指针事件实现 —— 和看板卡片同一个理由（BoardView.useCardDrag）：
 * Tauri 在 Windows 上接管了窗口的拖放，HTML5 draggable 在那里整个失效。
 *
 * 只能落在**同一区**（未关闭 / 已关闭）的行上：把一条未关闭的拖进已关闭区
 * 不会关掉它，落点指示线却在暗示它会 —— 那条线就成了谎话。
 */
function useRowDrag(onDrop: (from: string, to: string, place: "before" | "after") => void) {
  const rows = useRef(new Map<string, { el: HTMLElement; closed: boolean }>());
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const stopRef = useRef<(() => void) | null>(null);

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; place: "before" | "after" } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null);

  // 拖到一半视图被切走：别把监听器留在 window 上
  useEffect(() => () => stopRef.current?.(), []);

  const rowRef = (key: string, closed: boolean) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, { el, closed });
    else rows.current.delete(key);
  };

  const targetAt = (y: number, closed: boolean, self: string) => {
    for (const [key, r] of rows.current) {
      if (r.closed !== closed) continue;
      const box = r.el.getBoundingClientRect();
      if (y < box.top || y > box.bottom) continue;
      if (key === self) return null;
      return { key, place: (y < box.top + box.height / 2 ? "before" : "after") as "before" | "after" };
    }
    return null;
  };

  const start = (row: ItemRow, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 不让按下拖动的同时选中一片文字
    stopRef.current?.();

    const origin = { x: e.clientX, y: e.clientY };
    let active = false;
    let target: { key: string; place: "before" | "after" } | null = null;

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD) return;
        active = true;
        setDragKey(row.key);
      }
      target = targetAt(ev.clientY, row.closed, row.key);
      setOver(target);
      setGhost({ x: ev.clientX, y: ev.clientY, title: row.title || "（没写内容）" });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      stopRef.current = null;
      setDragKey(null);
      setOver(null);
      setGhost(null);
    };
    const up = () => {
      const t = active ? target : null;
      stop();
      if (t) dropRef.current(row.key, t.key, t.place);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    stopRef.current = stop;
  };

  return { dragKey, over, ghost, rowRef, start };
}

/**
 * 筛选条件 → 一句人读的话，写进导出文件的表头。
 * 一份 5 行的表，收到的人要能看出那是「全部只有 5 条」还是「筛出来 5 条」。
 */
function describeFilter(
  f: ItemFilter,
  ctx: {
    kinds: ItemKind[];
    people: { id: number; name: string }[];
    taskName: (id: number | null) => string | null;
  },
): string {
  const parts: string[] = [];
  if (f.query.trim()) parts.push(`搜索「${f.query.trim()}」`);
  if (f.kinds.length) parts.push(`类型：${f.kinds.map((k) => kindLabel(k, ctx.kinds)).join("、")}`);
  if (f.priorities.length)
    parts.push(`优先级：${f.priorities.map((p) => `P${p}`).join("、")}`);
  if (f.people.length)
    parts.push(
      `负责人：${f.people
        .map((id) => (id == null ? "未指派" : (ctx.people.find((p) => p.id === id)?.name ?? `#${id}`)))
        .join("、")}`,
    );
  if (f.tasks?.length)
    parts.push(
      `关联任务：${f.tasks.map((id) => (id == null ? "未关联任务" : ctx.taskName(id))).join("、")}`,
    );
  return parts.join("；");
}
