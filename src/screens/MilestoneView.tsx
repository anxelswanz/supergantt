import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type ResolvedTask } from "../gantt/model";
import { dayToDate, dayToIso, isoToDay, today } from "../gantt/time";
import { groupMilestones, milestoneInfo, type MilestoneInfo, type MilestoneStatus } from "../core/milestones";
import { DatePicker } from "./DatePicker";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import type { Milestone } from "../db/api";

/**
 * 里程碑视图：独立于任务表的项目节点，关联任务只存 id（任务改名改期这里跟着变）。
 * 和事项、风险一样是独立记录：不进撤销栈，即写即存。
 *
 * ## 这一页要回答的问题
 *
 * 「下一个节点还有几天、来不来得及」。所以最近的那个未完成里程碑做成一块大倒计时牌，
 * 下面一条按真实日期比例画的时间轴（今天一道朱砂线），再往下按「逾期 → 接下来 → 已达成」分组。
 * 状态判定在 core/milestones.ts：关联任务全做完才算达成，没关联任务的只看日期。
 *
 * 列表按日期排，不再支持拖拽排序 —— 里程碑本来就是按时间走的，手排的顺序和日期一冲突，
 * 倒计时那一栏就会忽前忽后。
 */

const COLORS = [
  "#b0752a",
  "#a83e3e",
  "#5a5490",
  "#1f5f74",
  "#35705c",
  "#2f6d5e",
  "#64748b",
];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekday = (day: number) => WEEKDAYS[dayToDate(day).getUTCDay()];
/** 今年的省掉年份 */
const fmtDay = (day: number, thisYear: number) => {
  const d = dayToDate(day);
  return d.getUTCFullYear() === thisYear ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日` : dayToIso(day);
};

const TONE = {
  upcoming: "var(--accent)",
  soon: "var(--warn)",
  overdue: "var(--danger)",
  hit: "var(--ok)",
};
/** 一周以内的倒计时换成琥珀色：该盯紧了 */
const toneOf = (s: MilestoneStatus) =>
  s.kind === "overdue" ? TONE.overdue : s.kind === "hit" ? TONE.hit : s.daysLeft <= 7 ? TONE.soon : TONE.upcoming;

export function MilestoneView() {
  const milestones = useAppStore((s) => s.milestones);
  const addMilestone = useAppStore((s) => s.addMilestone);
  const patchMilestone = useAppStore((s) => s.patchMilestone);
  const removeMilestone = useAppStore((s) => s.removeMilestone);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const loadMilestones = useAppStore((s) => s.loadMilestones);

  /** null = 不在编辑；0 = 新建；其余 = 编辑那一条 */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [hitOpen, setHitOpen] = useState(false);

  // 进这一页时再读一次库：任务关联可能在别处（比如撤销）被改过
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

  const now = today();
  const thisYear = dayToDate(now).getUTCFullYear();
  const infos = useMemo(() => milestones.map((m) => milestoneInfo(m, taskById, now)), [milestones, taskById, now]);
  const groups = useMemo(() => groupMilestones(infos), [infos]);

  const startEdit = (id: number) => setEditingId(id);

  const row = (info: MilestoneInfo, i: number) => (
    <motion.div
      key={info.milestone.id}
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30, delay: Math.min(i, 10) * 0.025 }}
    >
      {editingId === info.milestone.id ? (
        <div className="rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)]">
          <MilestoneEditor
            tasks={tasks}
            initial={{
              name: info.milestone.name,
              date: info.milestone.date,
              color: info.milestone.color,
              description: info.milestone.description,
              taskIds: info.milestone.taskIds,
            }}
            onCancel={() => setEditingId(null)}
            onSave={async (draft) => {
              await patchMilestone(info.milestone.id, draft);
              setEditingId(null);
              return true;
            }}
            onDelete={() => {
              setEditingId(null);
              setConfirmDelete(info.milestone.id);
            }}
          />
        </div>
      ) : (
        <MilestoneRow
          info={info}
          thisYear={thisYear}
          onEdit={() => startEdit(info.milestone.id)}
          onDelete={() => setConfirmDelete(info.milestone.id)}
        />
      )}
    </motion.div>
  );

  const counts = [
    groups.upcoming.length > 0 && `${groups.upcoming.length} 个未到期`,
    groups.overdue.length > 0 && `${groups.overdue.length} 个逾期`,
    groups.hit.length > 0 && `${groups.hit.length} 个已达成`,
  ].filter(Boolean);

  return (
    <MotionConfig reducedMotion="user">
      {/* 工作区的内容区是横向 flex：不写 flex-1 的话这一页会缩成内容那么宽、贴在左边 */}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--rule)] px-6 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text)]">里程碑</h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">
              {counts.length ? counts.join(" · ") : "项目关键节点，会标在甘特图上"}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1040px] px-6 py-5">
            <AnimatePresence initial={false}>
              {editingId === 0 && (
                <motion.div
                  key="create"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="mb-4 rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)]"
                >
                  <MilestoneEditor
                    tasks={tasks}
                    initial={{ name: "", date: dayToIso(today()), color: COLORS[0], description: "", taskIds: [] }}
                    onCancel={() => setEditingId(null)}
                    onSave={async (draft) => {
                      const created = await addMilestone(draft.name, draft.date, draft.color, draft.description, draft.taskIds);
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
              <>
                {groups.next && editingId !== groups.next.milestone.id && (
                  <Countdown info={groups.next} thisYear={thisYear} onEdit={() => startEdit(groups.next!.milestone.id)} />
                )}

                {infos.length > 1 && <Timeline infos={infos} today={now} thisYear={thisYear} onPick={startEdit} />}

                {groups.overdue.length > 0 && (
                  <Group title="逾期" note="日期过了，关联任务还没做完" tone={TONE.overdue} count={groups.overdue.length}>
                    {groups.overdue.map(row)}
                  </Group>
                )}
                {groups.upcoming.length > 0 && (
                  <Group title="接下来" note="按日期排，最近的在前" tone={TONE.upcoming} count={groups.upcoming.length}>
                    {groups.upcoming.map(row)}
                  </Group>
                )}
                {groups.hit.length > 0 && (
                  <Group
                    title="已达成"
                    note="关联任务全部做完（没关联任务的按日期算）"
                    tone={TONE.hit}
                    count={groups.hit.length}
                    collapsed={!hitOpen}
                    onToggle={() => setHitOpen((v) => !v)}
                  >
                    {groups.hit.map(row)}
                  </Group>
                )}
              </>
            )}
          </div>
        </div>

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
      </div>
    </MotionConfig>
  );
}

/* ------------------------------------------------------------------ */
/* 倒计时牌                                                            */
/* ------------------------------------------------------------------ */

/**
 * 最近的那个未完成里程碑。数字是这一页唯一的大字：一眼就该看到「还有几天」。
 * 一周以内换琥珀色；就是今天时写「今天」
 */
function Countdown({ info, thisYear, onEdit }: { info: MilestoneInfo; thisYear: number; onEdit: () => void }) {
  const { milestone: m, status, tasks, done, progress } = info;
  if (status.kind !== "upcoming") return null;
  const tone = toneOf(status);
  const isToday = status.daysLeft === 0;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      aria-label="下一个里程碑"
      className="relative mb-5 grid grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-[14px] border border-[var(--rule)] bg-[var(--surface-alt)]"
    >
      {/* 左：倒计时。底下一层极淡的方格纸，和书写区的横线纸是一套语言 */}
      <div
        className="relative flex flex-col justify-center border-r border-[var(--rule)] px-7 py-6"
        style={{
          backgroundImage:
            "linear-gradient(var(--rule) 1px, transparent 1px), linear-gradient(90deg, var(--rule) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
          backgroundPosition: "-1px -1px",
        }}
      >
        <div className="text-[11px] font-medium tracking-[0.08em] text-[var(--text-dim)]">下一个里程碑</div>
        {isToday ? (
          <div className="mt-2 text-[56px] font-semibold leading-none tracking-tight" style={{ color: tone }}>
            今天
          </div>
        ) : (
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[13px] text-[var(--text-dim)]">还有</span>
            <motion.span
              key={status.daysLeft}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[64px] font-semibold leading-none tabular-nums tracking-tight"
              style={{ color: tone }}
            >
              {status.daysLeft}
            </motion.span>
            <span className="text-[15px] font-medium" style={{ color: tone }}>
              天
            </span>
          </div>
        )}
        <div className="mt-3 text-[12px] tabular-nums text-[var(--text)]">
          {fmtDay(info.day, thisYear)} · {weekday(info.day)}
        </div>
      </div>

      {/* 右：它是什么、做到哪了 */}
      <div className="flex min-w-0 flex-col justify-center gap-3 px-7 py-6">
        <div className="flex items-start gap-3">
          <span className="mt-[7px] size-2.5 shrink-0 rotate-45" style={{ background: m.color }} aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-[20px] font-semibold leading-snug text-[var(--text)]">{m.name}</h3>
            {m.description && <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-dim)]">{m.description}</p>}
          </div>
          <button
            onClick={onEdit}
            className="shrink-0 rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[11px] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
          >
            编辑
          </button>
        </div>

        {progress == null ? (
          <p className="text-[11.5px] text-[var(--text-dim)]">没有关联任务：到了日期就算达成。关联任务后，全部做完才算达成。</p>
        ) : (
          <>
            <ProgressBar value={progress} tone={tone} label={`关联任务 ${done}/${tasks.length} 完成`} />
            <ul className="flex flex-wrap gap-1.5">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex max-w-[16rem] items-center gap-1.5 rounded-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-0.5 text-[11px]"
                  title={`${t.name} · ${Math.round(t.progress * 100)}%`}
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: t.progress >= 1 ? TONE.hit : t.progress > 0 ? tone : "var(--rule-strong)" }}
                  />
                  <span className={`truncate ${t.progress >= 1 ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"}`}>
                    {t.name}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </motion.section>
  );
}

function ProgressBar({ value, tone, label }: { value: number; tone: string; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-[var(--text-dim)]">{label}</span>
        <span className="font-medium tabular-nums text-[var(--text)]">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunk)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: tone }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 22 }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 时间轴                                                              */
/* ------------------------------------------------------------------ */

/**
 * 按真实日期比例画的一条轴：每周一道细刻度、每月一道标签，今天一道朱砂线，
 * 里程碑是菱形（和甘特图上同一个形状），颜色说状态。点菱形进编辑
 */
function Timeline({
  infos,
  today,
  thisYear,
  onPick,
}: {
  infos: MilestoneInfo[];
  today: number;
  thisYear: number;
  onPick: (id: number) => void;
}) {
  const days = infos.map((i) => i.day);
  const lo = Math.min(today, ...days) - 4;
  const hi = Math.max(today, ...days) + 4;
  const span = Math.max(1, hi - lo);
  const x = (d: number) => `${((d - lo) / span) * 100}%`;

  const months: number[] = [];
  const weeks: number[] = [];
  for (let d = lo; d <= hi; d++) {
    const dt = dayToDate(d);
    if (dt.getUTCDate() === 1) months.push(d);
    if (dt.getUTCDay() === 1) weeks.push(d);
  }

  return (
    <section aria-label="里程碑时间轴" className="mb-6 rounded-[14px] border border-[var(--rule)] px-6 pb-4 pt-9">
      <div className="relative h-10">
        {/* 轴线 */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--rule-strong)]" />
        {weeks.map((d) => (
          <div key={`w${d}`} className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-[var(--rule-strong)]" style={{ left: x(d) }} />
        ))}
        {months.map((d) => (
          <div key={`m${d}`} className="absolute top-[calc(50%+10px)] -translate-x-1/2 text-[10px] tabular-nums text-[var(--text-dim)]" style={{ left: x(d) }}>
            {dayToDate(d).getUTCMonth() + 1}月
          </div>
        ))}
        {/* 今天 */}
        <div className="absolute -top-6 bottom-0 w-px" style={{ left: x(today), background: "var(--today)" }}>
          <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap text-[10px] font-medium" style={{ color: "var(--today)" }}>
            今天
          </span>
        </div>
        {infos.map((i) => {
          const tone = toneOf(i.status);
          return (
            <button
              key={i.milestone.id}
              onClick={() => onPick(i.milestone.id)}
              title={`${i.milestone.name} · ${fmtDay(i.day, thisYear)} · ${statusText(i.status)}`}
              aria-label={`${i.milestone.name}，${statusText(i.status)}`}
              className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1.5"
              style={{ left: x(i.day) }}
            >
              <span
                className="block size-3 rotate-45 border-2 transition-transform group-hover:scale-125"
                style={{
                  borderColor: tone,
                  background: i.status.kind === "hit" ? tone : "var(--surface)",
                }}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

const statusText = (s: MilestoneStatus) =>
  s.kind === "upcoming"
    ? s.daysLeft === 0
      ? "就是今天"
      : `还有 ${s.daysLeft} 天`
    : s.kind === "overdue"
      ? `已逾期 ${s.daysLate} 天`
      : s.delta < 0
        ? `提前 ${-s.delta} 天达成`
        : s.delta === 0
          ? "按期达成"
          : `晚 ${s.delta} 天达成`;

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

function Group({
  title,
  note,
  tone,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  note: string;
  tone: string;
  count: number;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const head = (
    <>
      <span className="size-1.5 rounded-full" style={{ background: tone }} />
      <span className="text-[12px] font-semibold text-[var(--text)]">{title}</span>
      <span className="text-[11px] tabular-nums text-[var(--text-dim)]">{count}</span>
      <span className="text-[11px] text-[var(--text-dim)]">· {note}</span>
    </>
  );
  return (
    <section className="mb-5">
      {onToggle ? (
        <button onClick={onToggle} aria-expanded={!collapsed} className="mb-2 flex items-center gap-2 hover:opacity-80">
          <span className={`text-[10px] text-[var(--text-dim)] transition-transform ${collapsed ? "" : "rotate-90"}`}>›</span>
          {head}
        </button>
      ) : (
        <div className="mb-2 flex items-center gap-2">{head}</div>
      )}
      {!collapsed && <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

/** 一行：左边倒计时块（一行里唯一的大数字），中间名字和关联任务，右边进度和日期 */
function MilestoneRow({
  info,
  thisYear,
  onEdit,
  onDelete,
}: {
  info: MilestoneInfo;
  thisYear: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { milestone: m, status, tasks, done, progress } = info;
  const tone = toneOf(status);
  const hit = status.kind === "hit";

  const big =
    status.kind === "upcoming" ? (status.daysLeft === 0 ? "今天" : String(status.daysLeft)) : status.kind === "overdue" ? String(status.daysLate) : "✓";
  const unit =
    status.kind === "upcoming"
      ? status.daysLeft === 0
        ? ""
        : "天后"
      : status.kind === "overdue"
        ? "天 · 逾期"
        : status.delta < 0
          ? `提前 ${-status.delta} 天`
          : status.delta === 0
            ? "按期"
            : `晚 ${status.delta} 天`;

  return (
    <div
      className={`group flex items-stretch overflow-hidden rounded-xl border bg-[var(--surface)] transition-colors hover:border-[var(--rule-strong)] ${
        status.kind === "overdue" ? "border-[color-mix(in_srgb,var(--danger)_35%,transparent)]" : "border-[var(--rule)]"
      }`}
    >
      <div
        className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-0.5 border-r border-[var(--rule)] py-3"
        style={{ background: `color-mix(in srgb, ${tone} 7%, transparent)` }}
        title={statusText(status)}
      >
        <span className="text-[24px] font-semibold leading-none tabular-nums" style={{ color: tone }}>
          {big}
        </span>
        {unit && (
          <span className="text-[10.5px] font-medium" style={{ color: tone }}>
            {unit}
          </span>
        )}
      </div>

      <button onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left">
        <span className="size-2.5 shrink-0 rotate-45" style={{ background: m.color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13.5px] font-medium ${hit ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}>
            {m.name}
          </span>
          {(m.description || tasks.length > 0) && (
            <span className="mt-0.5 block truncate text-[11px] text-[var(--text-dim)]">
              {m.description || tasks.map((t) => t.name).join("、")}
            </span>
          )}
        </span>

        {progress != null && (
          <span className="w-[120px] shrink-0">
            <span className="mb-1 flex justify-between text-[10.5px] tabular-nums text-[var(--text-dim)]">
              <span>
                {done}/{tasks.length} 任务
              </span>
              <span>{Math.round(progress * 100)}%</span>
            </span>
            <span className="block h-1 overflow-hidden rounded-full bg-[var(--surface-sunk)]">
              <span className="block h-full rounded-full" style={{ width: `${Math.round(progress * 100)}%`, background: tone }} />
            </span>
          </span>
        )}

        <span className="w-[88px] shrink-0 text-right text-[11.5px] tabular-nums">
          <span className="block text-[var(--text)]">{fmtDay(info.day, thisYear)}</span>
          <span className="block text-[10.5px] text-[var(--text-dim)]">{weekday(info.day)}</span>
        </span>
      </button>

      <div className="flex shrink-0 items-center pr-2">
        <RowActions milestone={m} onEdit={onEdit} onDelete={onDelete} />
      </div>
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
      setError("请填写名称");
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await onSave({ ...draft, name: draft.name.trim() });
    setSaving(false);
    if (!ok) setError("保存失败，请检查名称和日期后重试");
  };

  return (
    <div
      className="rounded-xl border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
      onKeyDown={(e) => {
        // Enter 是保存，不能冒泡成工作区的「新建任务」
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
          placeholder="里程碑名称，例如：样机验收"
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
              title="标记颜色，甘特图上同步使用"
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
          placeholder="说明（可选）：交付什么、谁验收"
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
                  title="取消关联，不会删除任务"
                  className="text-[var(--text-dim)] hover:text-[var(--danger)]"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-[var(--danger)]">{error}</p>}

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
            className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10"
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

/** 用项目自己的日历，不用原生 date input（见 DatePicker） */
function DateField({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const day = isoToDay(value);

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen(true)}
        title="里程碑日期"
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
        title="选择要关联的任务"
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
                  <span className="truncate">{t.name || "未命名"}</span>
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
          设好日期后，里程碑会以菱形标在甘特图上。
        </p>
        <button
          onClick={onCreate}
          className="mt-4 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)" }}
        >
          ＋ 新建里程碑
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
          删除后无法撤销。关联的任务不受影响。
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
            className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            删除
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
