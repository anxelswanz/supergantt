import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { resolve } from "../gantt/model";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { withAlpha } from "../gantt/coloring";
import { dayToIso } from "../gantt/time";
import { setEnd, setStart } from "../core/dateLink";
import { api, type Comment, type Risk } from "../db/api";
import {
  BLOCK_REASONS,
  blockedDays,
  blockedSpanDays,
  reasonLabel,
  type BlockedPeriod,
} from "../core/blocked";
import { isInProgress } from "../core/board";
import { canAddRisk, RISK_COLORS, RISK_LEVELS, sortRisks } from "../core/risks";
import { RiskRow } from "./RiskRow";
import { BlockedDetail } from "./BlockedDetail";
import { today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { Avatar } from "./Avatar";
import { MenuItem, Popover } from "./Popover";
import { DatePicker } from "./DatePicker";
import { ALT_LABEL, shortcut } from "../core/keys";

/**
 * 任务详情抽屉。
 *
 * 做成右侧抽屉而不是居中弹窗：甘特图是这个应用的主体，看一条任务的细节时
 * 通常还想同时看到它在时间轴上的位置。居中弹窗会把整张图盖掉。
 *
 * 风险点和评论**不走命令栈**。它们不是排期数据 —— ⌘Z 应该撤销的是
 * 「我刚才把这条任务拖错了」，而不是把你刚敲的一条评论悄悄抹掉。
 * 所以它们即写即存，删除用二次确认而不是靠撤销兜底。
 */

export function TaskDetail() {
  const detailId = useAppStore((s) => s.detailId);
  const openDetail = useAppStore((s) => s.openDetail);
  const revision = useAppStore((s) => s.revision);
  const taskMap = useAppStore((s) => s.tasks);
  const calendar = useAppStore((s) => s.calendar);
  const people = useAppStore((s) => s.people);
  const patchTask = useAppStore((s) => s.patchTask);
  const assignPerson = useAppStore((s) => s.assignPerson);
  const setPriority = useAppStore((s) => s.setPriority);
  const projectRisks = useAppStore((s) => s.projectRisks);
  const updateBlocked = useAppStore((s) => s.updateBlocked);
  const removeBlocked = useAppStore((s) => s.removeBlocked);
  const addBlocker = useAppStore((s) => s.addBlocker);
  const closeBlocker = useAppStore((s) => s.closeBlocker);

  const task = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()]).find((t) => t.id === detailId) ?? null,
    [taskMap, revision, detailId],
  );

  const [comments, setComments] = useState<Comment[]>([]);
  /** 双击某一行打开的阻碍详情。存 id 而不是对象 —— 对象会在编辑后变旧 */
  const [blockedDetailId, setBlockedDetailId] = useState<string | null>(null);

  /**
   * 风险从 store 里取，不再由这个面板自己查一份。
   *
   * 两份拷贝意味着两个真相：在全局风险清单里关掉一条，抽屉这边还显示未关闭，
   * 用户会以为哪一边坏了。评论只有这里一个入口，仍旧本地加载。
   */
  const risks = useMemo(
    () => sortRisks(projectRisks.filter((r) => r.taskId === detailId)),
    [projectRisks, detailId],
  );

  const reload = useCallback(async () => {
    if (detailId == null) return;
    const notes = await api.loadTaskNotes(detailId).catch(() => null);
    if (notes) setComments(notes.comments);
  }, [detailId]);

  useEffect(() => {
    setComments([]);
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || detailId == null) return;
      // 阻碍详情开着的时候，Esc 是它的 —— 让位给最上面那一层。
      // 不让位的话，用户想关掉一个小面板，整个抽屉跟着没了：两个监听器
      // 都挂在 window 的捕获阶段，先挂载的这个会先跑，stopPropagation 拦不住
      if (blockedDetailId != null) return;
      e.stopPropagation();
      openDetail(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detailId, openDetail, blockedDetailId]);

  if (detailId == null || !task) return null;

  const parent = task.parentId != null ? taskMap.get(task.parentId) : null;
  const person = people.find((p) => p.id === task.personId) ?? null;
  const natural = calendar.countCalendarDays(task.startDay, task.endDay);
  const working = calendar.countWorkdays(task.startDay, task.endDay);
  const span = { startDay: task.startDay, endDay: task.endDay };

  const afterNotesChange = () => {
    void reload();
  };

  // 每次渲染都从任务里重新取那条阻碍：详情面板保存后要立刻反映新值，
  // 而且这条被删掉时面板会自己消失，不必单独收拾
  const blockedDetail =
    blockedDetailId != null
      ? (task.blocked.find((p) => p.id === blockedDetailId) ?? null)
      : null;

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 200, damping: 26 }}
      className="flex w-[380px] shrink-0 flex-col border-l border-[var(--rule)] bg-[var(--surface)]"
    >
      {/* 标题 */}
      {/* shrink-0：下面那个滚动区是 flex-1（basis 0%），收缩权重为 0，
          容器一旦装不下，被压扁的会是这行标题 */}
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--rule)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <InlineText
            value={task.name}
            placeholder="未命名任务"
            className="w-full text-sm font-semibold text-[var(--text)]"
            onCommit={(v) => v !== task.name && patchTask(task.id, { name: v }, "重命名任务")}
          />
          {parent && (
            <div className="mt-0.5 truncate text-[10px] text-[var(--text-dim)]">
              属于 {parent.name || "未命名任务"}
            </div>
          )}
        </div>
        <button
          onClick={() => openDetail(null)}
          title="关闭 (Esc)"
          className="grid size-6 shrink-0 place-items-center rounded text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 基本信息 */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 px-4 py-3.5">
          <Field label="开始">
            {task.hasChildren ? (
              <ReadOnly>{dayToIso(task.startDay)}</ReadOnly>
            ) : (
              <DateField
                day={task.startDay}
                onPick={(d) => patchTask(task.id, setStart(span, d), "改开始日期")}
              />
            )}
          </Field>

          <Field label="结束">
            {task.hasChildren || task.milestone ? (
              <ReadOnly>{dayToIso(task.endDay)}</ReadOnly>
            ) : (
              <DateField
                day={task.endDay}
                minDay={task.startDay}
                onPick={(d) => patchTask(task.id, setEnd(span, d), "改结束日期")}
              />
            )}
          </Field>

          <Field label="工期">
            <span className="font-mono text-[11px] tabular-nums text-[var(--text)]">
              {natural} 天
              {working !== natural && (
                <span className="ml-1.5 text-[10px] text-[var(--text-dim)]">
                  工作日 {working} 天
                </span>
              )}
            </span>
          </Field>

          <Field label="紧急程度">
            <PriorityPicker
              value={task.priority}
              onPick={(p) => setPriority(task.id, p)}
            />
          </Field>

          <Field label="负责人">
            <PersonPicker
              people={people}
              person={person}
              onPick={(pid) => assignPerson(task.id, pid)}
            />
          </Field>

          <Field label="进度">
            {task.hasChildren ? (
              <ReadOnly>{Math.round(task.progress * 100)}%（由子任务汇总）</ReadOnly>
            ) : (
              <ProgressField
                value={task.progress}
                onChange={(v) => patchTask(task.id, { progress: v }, "调整进度")}
              />
            )}
          </Field>
        </div>

        <Divider />

        {/* 受阻时段排在风险之前：它是**已经发生**的事实，
            风险是「可能会发生」—— 先看已发生的更符合复盘顺序 */}
        <BlockedSection
          task={task}
          canAdd={isInProgress(task, today())}
          onAdd={() => addBlocker(task.id, "other")}
          onClose={(id) => closeBlocker(task.id, id)}
          onUpdate={(p) => updateBlocked(task.id, p)}
          onRemove={(id) => removeBlocked(task.id, id)}
          onOpenDetail={setBlockedDetailId}
        />

        <Divider />

        <RiskSection
          taskId={task.id}
          risks={risks}
          canAdd={canAddRisk(task, today())}
        />

        <Divider />

        <CommentSection
          taskId={task.id}
          comments={comments}
          onChanged={afterNotesChange}
        />
      </div>

      {blockedDetail && (
        <BlockedDetail
          taskId={task.id}
          period={blockedDetail}
          onClose={() => setBlockedDetailId(null)}
        />
      )}
    </motion.aside>
  );
}

/* ------------------------------------------------------------------ */
/* 受阻时段                                                            */
/* ------------------------------------------------------------------ */

function BlockedSection({
  task,
  canAdd,
  onAdd,
  onClose,
  onUpdate,
  onRemove,
  onOpenDetail,
}: {
  task: { id: number; blocked: BlockedPeriod[]; hasChildren: boolean; milestone: boolean };
  /** 只有进行中的活能新开阻碍（core/board.isInProgress） */
  canAdd: boolean;
  onAdd: () => void;
  onClose: (id: string) => void;
  onUpdate: (period: BlockedPeriod) => void;
  onRemove: (id: string) => void;
  onOpenDetail: (id: string) => void;
}) {
  const day = today();
  const total = blockedDays(task.blocked);
  const open = task.blocked.filter((p) => p.open === true).length;
  // 没关掉的排最上面：它们是唯一需要今天采取行动的
  const sorted = [...task.blocked].sort(
    (a, b) => Number(b.open === true) - Number(a.open === true) || a.from - b.from,
  );

  return (
    <section className="px-4 py-3.5">
      <SectionTitle
        title="阻碍"
        count={
          open > 0
            ? `${open} 条未关闭 · 共 ${total} 天`
            : total > 0
              ? `共 ${total} 天`
              : undefined
        }
        danger={total > 0}
        action={
          canAdd ? (
            <button
              onClick={onAdd}
              title="从今天开始记一条还没解决的阻碍"
              className="rounded-full border border-[var(--rule)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:border-[#f43f5e] hover:text-[#f43f5e]"
            >
              ＋ 新建
            </button>
          ) : undefined
        }
      />

      {task.blocked.length === 0 && (
        <EmptyHint>
          {task.hasChildren
            ? "父任务的区间是子任务的并集，阻碍要记在具体的子任务上。"
            : task.milestone
              ? "里程碑是一个时间点，没有可标记的区间。"
              : canAdd
                ? `「＋ 新建」记下此刻卡在什么上；已经过去的那几天，在甘特条上按住 ${ALT_LABEL} 拖一段。`
                : "只有进行中的任务能记阻碍 —— 还没开工的活该改的是计划日期。"}
        </EmptyHint>
      )}

      <div className="flex flex-col gap-1">
        {sorted.map((period) => (
          <BlockedRow
            key={period.id}
            period={period}
            day={day}
            onClose={() => onClose(period.id)}
            onUpdate={onUpdate}
            onRemove={() => onRemove(period.id)}
            onOpenDetail={() => onOpenDetail(period.id)}
          />
        ))}
      </div>
    </section>
  );
}

function BlockedRow({
  period,
  day,
  onClose,
  onUpdate,
  onRemove,
  onOpenDetail,
}: {
  period: BlockedPeriod;
  day: number;
  onClose: () => void;
  onUpdate: (period: BlockedPeriod) => void;
  onRemove: () => void;
  onOpenDetail: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const live = period.open === true;
  const days = blockedSpanDays(period, day);

  // 两行：上行是「归类 + 区间 + 天数」，下行是自己写的说明。
  // 挤成一行的话，说明文字只剩几十像素，等于没法写
  return (
    <div
      // 双击整行打开详情：行里放得下的只有摘要，改天数、开关「持续中」
      // 这些都需要更大的地方（BlockedDetail）。双击而不是单击 ——
      // 行内那几个控件（改归类、写说明）单击就要用，不能被抢走
      onDoubleClick={onOpenDetail}
      title="双击查看 / 调整这条阻碍"
      className="group rounded-md px-2 py-1.5 hover:bg-[var(--row-hover)]"
      style={live ? { background: "rgba(244,63,94,0.06)" } : undefined}
    >
      <div className="flex items-center gap-2">
        <button
          ref={setAnchor}
          onClick={() => setOpen((v) => !v)}
          title="改归类"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-600"
          style={{ background: "rgba(245,158,11,0.16)" }}
        >
          {reasonLabel(period.reason)}
        </button>
        <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={132}>
          {BLOCK_REASONS.map((r) => (
            <MenuItem
              key={r.key}
              active={r.key === period.reason}
              onClick={() => {
                setOpen(false);
                onUpdate({ ...period, reason: r.key });
              }}
            >
              {r.label}
            </MenuItem>
          ))}
        </Popover>

        <span className="min-w-0 flex-1 truncate font-mono text-[10px] tabular-nums text-[var(--text)]">
          {dayToIso(period.from)} → {live ? "至今" : dayToIso(period.to)}
        </span>
        <span
          className="shrink-0 font-mono text-[10px] tabular-nums"
          style={{ color: live ? "#f43f5e" : "var(--text-dim)" }}
        >
          {days} 天
        </span>

        {/* 双击是隐藏手势，不能是进详情的唯一路 —— 悬停时给一个看得见的入口 */}
        <button
          onClick={onOpenDetail}
          title="打开详情：调天数、开关「持续中」"
          className="shrink-0 rounded px-1 text-[10px] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--accent)] group-hover:opacity-100"
        >
          详情
        </button>

        {/* 受阻时段进了撤销栈，所以删除不需要二次确认 —— ⌘Z 就能回来 */}
        <button
          onClick={onRemove}
          title={`删除（${shortcut("mod", "Z")} 可撤销）`}
          className="shrink-0 rounded px-1 text-[10px] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
        >
          ✕
        </button>
      </div>

      {/* 未关闭的那条要说清它正在做什么 —— 它每天都在动这条任务的日期，
          用户有权知道系统替他改了多少，而不是某天发现工期莫名其妙长了 */}
      {live && (
        <div className="mt-1 flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold leading-none text-white"
            style={{ background: "#f43f5e" }}
          >
            未关闭
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">
            {period.pushed
              ? `已自动顺延工期 ${period.pushed} 天`
              : "每天跨天自动延长，并同步顺延工期"}
          </span>
          <button
            onClick={onClose}
            className="ml-auto shrink-0 rounded-full border border-[var(--rule)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:border-emerald-500 hover:text-emerald-600"
          >
            ✓ 关闭
          </button>
        </div>
      )}

      {/* 关掉之后顺延过的天数仍然留着 —— 回答「这条活为什么比原计划长」 */}
      {!live && period.pushed ? (
        <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">
          曾自动顺延工期 {period.pushed} 天
        </div>
      ) : null}

      <InlineText
        value={period.note ?? ""}
        placeholder="具体是什么？（比如：三号机主轴异响，等厂家上门）"
        className="mt-0.5 w-full text-[11px] text-[var(--text)] placeholder:text-[var(--text-dim)] placeholder:opacity-70"
        onCommit={(v) => {
          const note = v.trim();
          if (note === (period.note ?? "")) return;
          onUpdate({ ...period, ...(note ? { note } : { note: undefined }) });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 风险点                                                              */
/* ------------------------------------------------------------------ */

function RiskSection({
  taskId,
  risks,
  canAdd,
}: {
  taskId: number;
  /** 已经按「未关闭 → 等级高 → 记得早」排好（core/risks.sortRisks） */
  risks: Risk[];
  canAdd: boolean;
}) {
  const addRisk = useAppStore((s) => s.addRisk);
  const [draft, setDraft] = useState("");
  const [level, setLevel] = useState(1);

  const open = risks.filter((r) => !r.resolved);

  const add = async () => {
    if (!draft.trim()) return;
    await addRisk(taskId, draft, level);
    setDraft("");
  };

  return (
    <section className="px-4 py-3.5">
      <SectionTitle
        title="风险"
        count={open.length > 0 ? `${open.length} 条未关闭` : undefined}
        danger={open.length > 0}
      />

      {/* 只有进行中的活能记风险。禁用输入框而不是藏起来 ——
          藏起来的话，用户会以为这个功能没做；写清楚原因才能让他知道下一步做什么 */}
      {canAdd ? (
        <div className="mb-2 flex items-start gap-1.5">
          <div className="flex shrink-0 overflow-hidden rounded-md border border-[var(--rule)]">
            {RISK_LEVELS.map((label, i) => (
              <button
                key={label}
                onClick={() => setLevel(i)}
                title={`${label}风险`}
                className="px-1.5 py-1 text-[10px] font-medium transition-colors"
                style={
                  level === i
                    ? { background: RISK_COLORS[i], color: "#fff" }
                    : { color: "var(--text-dim)" }
                }
              >
                {label}
              </button>
            ))}
          </div>
          {/*
            用 textarea 而不是 input：一条风险说清楚往往要一整句话，单行输入框
            里只看得见光标附近那一小段，写到一半就无法回头检查自己写了什么。
            高度跟着内容长，所以短风险不会白占地方。
          */}
          <GrowingTextarea
            value={draft}
            onChange={setDraft}
            onSubmit={() => void add()}
            placeholder={`记一条风险…（${shortcut("shift", "↵")} 换行）`}
          />
        </div>
      ) : (
        <EmptyHint>
          风险只能记在进行中的任务上。这条活还没开工或已经完成 ——
          前者该改的是计划，后者该记的是复盘。
        </EmptyHint>
      )}

      {risks.length === 0 && canAdd && (
        <EmptyHint>还没有记录风险。想到什么先写下来，别指望记得住。</EmptyHint>
      )}

      <div className="flex flex-col gap-1">
        {risks.map((risk) => (
          <RiskRow key={risk.id} risk={risk} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

function CommentSection({
  taskId,
  comments,
  onChanged,
}: {
  taskId: number;
  comments: Comment[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const add = async () => {
    if (!draft.trim()) return;
    await api.addComment(taskId, draft.trim()).catch(() => {});
    setDraft("");
    onChanged();
  };

  return (
    <section className="px-4 py-3.5">
      <SectionTitle title="评论" count={comments.length ? `${comments.length} 条` : undefined} />

      <div className="mb-2">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // ⌘Enter 提交；单独的 Enter 留给换行，因为评论经常是多行的
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
          }}
          rows={2}
          placeholder={`写点什么…（${shortcut("mod", "Enter")} 提交）`}
          className="w-full resize-none rounded-md border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-[11px] leading-relaxed outline-none focus:border-[var(--accent)]"
        />
        {draft.trim() && (
          <button
            onClick={() => void add()}
            className="mt-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white"
          >
            提交
          </button>
        )}
      </div>

      {comments.length === 0 && <EmptyHint>还没有评论。</EmptyHint>}

      <div className="flex flex-col gap-1.5">
        {comments.map((c) => (
          <CommentRow key={c.id} comment={c} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function CommentRow({ comment, onChanged }: { comment: Comment; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="group rounded-md bg-[var(--surface-alt)] px-2.5 py-2">
      <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text)]">
        {comment.content}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[9px] text-[var(--text-dim)]">
          {formatTime(comment.createdAt)}
        </span>
        <button
          onClick={() => {
            if (!confirming) return setConfirming(true);
            void api.deleteComment(comment.id).then(onChanged);
          }}
          onBlur={() => setConfirming(false)}
          className={`ml-auto rounded px-1 text-[9px] transition-opacity ${
            confirming
              ? "bg-rose-500 text-white opacity-100"
              : "text-[var(--text-dim)] opacity-0 hover:text-rose-500 group-hover:opacity-100"
          }`}
        >
          {confirming ? "确认" : "删除"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

/**
 * 高度跟随内容的输入框。
 *
 * 换行行为刻意和下面的评论区**相反**：这里 ↵ 提交、⇧↵ 换行，评论区是
 * ⌘↵ 提交、↵ 换行。因为一条风险绝大多数时候就是一句话，连着记三条风险时
 * 每条都要按 ⌘↵ 是纯粹的摩擦；而评论天然是多段的，↵ 必须留给换行。
 *
 * 测高的办法是先把 height 清零再读 scrollHeight —— 不清零的话 scrollHeight
 * 永远不小于当前高度，框只会变高、删掉文字后再也缩不回去。
 */
function GrowingTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  maxHeight = 120,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // 详情抽屉浮在工作区之上，工作区在 window 上监听 Enter「新建任务」。
        // 不拦住的话，敲完风险按回车会顺手建出一条空任务。
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className="min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1 text-[11px] leading-relaxed outline-none focus:border-[var(--accent)]"
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function ReadOnly({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono text-[11px] tabular-nums text-[var(--text-dim)]"
      title="由子任务汇总，不可直接编辑"
    >
      {children}
    </span>
  );
}

function Divider() {
  return <div className="mx-4 h-px bg-[var(--rule)]" />;
}

function SectionTitle({
  title,
  count,
  danger,
  action,
}: {
  title: string;
  count?: string;
  danger?: boolean;
  /** 右侧的小按钮，如「＋ 新建」。没有就不占位 */
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h3 className="text-[11px] font-bold text-[var(--text)]">{title}</h3>
      {count && (
        <span className={`text-[10px] ${danger ? "text-rose-500" : "text-[var(--text-dim)]"}`}>
          {count}
        </span>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-2 text-[10px] leading-relaxed text-[var(--text-dim)]">{children}</div>
  );
}

function DateField({
  day,
  minDay,
  onPick,
}: {
  day: number;
  minDay?: number;
  onPick: (day: number) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <DatePicker
        value={day}
        minDay={minDay}
        onCommit={(d) => {
          setEditing(false);
          onPick(d);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="rounded border border-transparent px-1 py-0.5 font-mono text-[11px] tabular-nums text-[var(--text)] hover:border-[var(--rule)]"
    >
      {dayToIso(day)}
    </button>
  );
}

function PriorityPicker({
  value,
  onPick,
}: {
  value: number;
  onPick: (p: 0 | 1 | 2 | 3) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        className="rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none"
        style={{
          background: withAlpha(PRIORITY_COLORS[value], 0.16),
          color: PRIORITY_COLORS[value],
        }}
      >
        {PRIORITY_LABELS[value]}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={104}>
        {PRIORITY_LABELS.map((label, p) => (
          <MenuItem
            key={label}
            active={p === value}
            onClick={() => {
              setOpen(false);
              onPick(p as 0 | 1 | 2 | 3);
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

function PersonPicker({
  people,
  person,
  onPick,
}: {
  people: { id: number; name: string; color: string; avatar: string | null; sortOrder: number }[];
  person: { id: number; name: string; color: string; avatar: string | null; sortOrder: number } | null;
  onPick: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--row-hover)]"
      >
        <Avatar person={person} size={18} />
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            person ? "text-[var(--text)]" : "text-[var(--text-dim)]"
          }`}
        >
          {person?.name ?? "未指派"}
        </span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={176}>
        <div className="max-h-56 overflow-y-auto">
          <MenuItem
            active={person == null}
            onClick={() => {
              setOpen(false);
              onPick(null);
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
                onPick(p.id);
              }}
            >
              <span className="flex items-center gap-2">
                <Avatar person={p} size={18} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </span>
            </MenuItem>
          ))}
        </div>
      </Popover>
    </>
  );
}

function ProgressField({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="min-w-0 flex-1 accent-[var(--accent)]"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--text)]">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function InlineText({
  value,
  placeholder,
  className = "",
  onCommit,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => onCommit(draft.trim())}
      className={`rounded border border-transparent bg-transparent px-1 py-0.5 outline-none hover:border-[var(--rule)] focus:border-[var(--accent)] ${className}`}
    />
  );
}

/** Unix 秒 → 本地时间。库里存的是时间戳，本地化只发生在显示这一层。 */
function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
