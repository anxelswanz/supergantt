/**
 * 时间线视图：按天倒序的项目流水，聚合规则在 core/timeline.ts。
 * 「记一笔」和甘特条右键写的是同一张 daily_notes 表。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  buildCareers,
  buildTimeline,
  carriedBlocks,
  clipTimeline,
  type DayRange,
  type TimelineDay,
  type TimelineEvent,
} from "../core/timeline";
import { resolve } from "../gantt/model";
import { dayToDate, dayToIso, isoToDay, isWeekend, today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { api, type Risk } from "../db/api";
import { ExportButton } from "./ExportButton";
import { RangeFilter, formatRange, rangePresets, sameRange } from "./RangeFilter";
import { TimelineSide } from "./TimelineSide";
import { shortcut } from "../core/keys";

const KIND_STYLE: Record<
  TimelineEvent["kind"],
  { dot: string; label: string }
> = {
  start: { dot: "var(--accent)", label: "开工" },
  finish: { dot: "#10b981", label: "完成" },
  blocked: { dot: "var(--danger)", label: "受阻" },
  risk: { dot: "#f59e0b", label: "风险" },
  note: { dot: "var(--text-dim)", label: "记录" },
};

const KIND_ORDER: TimelineEvent["kind"][] = ["start", "finish", "blocked", "risk", "note"];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 连续这么多天没记录才标间隔：周末两天不算 */
const GAP_MIN = 3;

const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function TimelineView() {
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const project = useAppStore((s) => s.project);
  const notes = useAppStore((s) => s.dailyNotes);
  const removeDailyNote = useAppStore((s) => s.removeDailyNote);
  const openDetail = useAppStore((s) => s.openDetail);
  const noteDraft = useAppStore((s) => s.noteDraft);
  const setNoteDraft = useAppStore((s) => s.setNoteDraft);

  const [risks, setRisks] = useState<Risk[]>([]);
  // 日期筛选是浏览状态，不落库：下次进来看到的应该是完整的流水
  const [range, setRange] = useState<DayRange | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 右栏点了某天：等那天渲染出来再滚（可能要先清筛选）
  const [jump, setJump] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);

  useEffect(() => {
    if (!project) return;
    void api.loadProjectRisks(project.id).then(setRisks).catch(() => setRisks([]));
  }, [project, revision]);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  const days = useMemo(
    () => buildTimeline(tasks, notes, risks),
    [tasks, notes, risks],
  );

  const shown = useMemo(() => clipTimeline(days, range), [days, range]);
  const carried = useMemo(() => carriedBlocks(tasks, range), [tasks, range]);
  const marked = useMemo(() => new Set(days.map((d) => d.day)), [days]);

  const counts = useMemo(() => {
    const m = new Map<TimelineEvent["kind"], number>();
    for (const d of shown) for (const e of d.events) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [shown]);

  const todayDay = today();
  const presets = rangePresets(todayDay);

  const careers = useMemo(() => buildCareers(tasks, todayDay, range), [tasks, todayDay, range]);

  const jumpTo = (day: number) => {
    // 目标日被筛掉了就先清筛选
    if (range && (day < range.from || day > range.to)) setRange(null);
    setJump(day);
  };

  useEffect(() => {
    if (jump == null) return;
    // 那天未必有记录：落到它之前最近的一天
    const target = shown.find((d) => d.day <= jump) ?? shown[shown.length - 1];
    setJump(null);
    if (!target) return;
    scrollRef.current
      ?.querySelector(`[data-day="${target.day}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
    setFlash(target.day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, shown]);

  useEffect(() => {
    if (flash == null) return;
    const id = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(id);
  }, [flash]);

  // 有筛选时「记一笔」的默认日期夹进筛选区间
  const draftDay = range ? Math.min(Math.max(todayDay, range.from), range.to) : todayDay;

  const editNote = (e: TimelineEvent) =>
    e.note &&
    setNoteDraft({
      id: e.note.id,
      taskId: e.note.taskId,
      day: isoToDay(e.note.day),
      content: e.note.content,
    });

  return (
    // 两栏作为一组居中，多余宽度分到两侧
    <div className="@container flex min-h-0 flex-1 justify-center">
      <div ref={scrollRef} className="min-h-0 min-w-0 max-w-[820px] flex-1 overflow-y-auto">
        <div className="px-7 pb-16 pt-7">
          <div className="mb-4 flex items-end gap-3">
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-[var(--text)]">
                逐日流水
              </h2>
              <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                按日期查看开工、完成、受阻、风险和记录
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <RangeFilter value={range} onChange={setRange} marked={marked} />
              <ExportButton
                label="⤓ 导出 HTML"
                title={
                  range
                    ? `导出 ${formatRange(range)} 的记录，清除筛选可导出全部`
                    : "导出为网页文件，可直接转发"
                }
                size="sm"
                run={async () => (await import("../export/run")).exportTimelineToHtml(range)}
              />
              <button
                onClick={() => setNoteDraft({ taskId: null, day: draftDay })}
                className="rounded-[var(--r-m)] px-3 py-1 text-xs font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                记一笔
              </button>
            </div>
          </div>

          {/* 概览的计数跟着筛选走 */}
          <div className="mb-6 flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 border-y border-[var(--rule)] py-1.5">
            <div className="flex items-center gap-0.5">
              {presets.map((p) => {
                const on = sameRange(p.range, range);
                return (
                  <button
                    key={p.label}
                    onClick={() => setRange(p.range)}
                    className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                      on
                        ? "font-semibold text-[var(--accent)]"
                        : "text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
                    }`}
                    style={on ? { background: tint("var(--accent)", 10) } : undefined}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
              <span>
                <b className="font-semibold text-[var(--text)]">{shown.length}</b> 天
              </span>
              {KIND_ORDER.filter((k) => counts.has(k)).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="size-[6px] rounded-full" style={{ background: KIND_STYLE[k].dot }} />
                  {KIND_STYLE[k].label}
                  <b className="font-semibold text-[var(--text)]">{counts.get(k)}</b>
                </span>
              ))}
            </div>
          </div>

          {noteDraft && <Composer />}

          {days.length === 0 && !noteDraft && (
            <div className="rounded-xl border border-dashed border-[var(--rule)] px-4 py-10 text-center text-xs leading-relaxed text-[var(--text-dim)]">
              还没有记录。
              <br />
              点「记一笔」写下第一条。
            </div>
          )}

          {carried.length > 0 && (
            <Carried events={carried} onOpen={(e) => e.task && openDetail(e.task.id)} />
          )}

          {range && days.length > 0 && shown.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--rule)] px-4 py-10 text-center text-xs leading-relaxed text-[var(--text-dim)]">
              {formatRange(range)} {carried.length > 0 ? "没有新的记录。" : "没有任何记录。"}
              <div className="mt-3 flex justify-center gap-2">
                <button
                  onClick={() => setNoteDraft({ taskId: null, day: draftDay })}
                  className="rounded-[var(--r-m)] border border-[var(--rule)] px-3 py-1 text-[11px] text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  ＋ 记一笔
                </button>
                <button
                  onClick={() => setRange(null)}
                  className="rounded-[var(--r-m)] px-3 py-1 text-[11px] text-[var(--accent)] hover:underline"
                >
                  清除筛选
                </button>
              </div>
            </div>
          )}

          {/* key 跟着筛选变：换日期时整列重新入场 */}
          <div key={range ? `${range.from}-${range.to}` : "all"}>
            {shown.map((d, i) => {
              const prev = shown[i - 1];
              const newMonth = !prev || prev.iso.slice(0, 7) !== d.iso.slice(0, 7);
              const gap = prev ? prev.day - d.day - 1 : 0;
              return (
                <Fragment key={d.iso}>
                  {gap >= GAP_MIN && <Gap days={gap} />}
                  {newMonth && (
                    <MonthHeader
                      iso={d.iso}
                      count={shown.filter((x) => x.iso.slice(0, 7) === d.iso.slice(0, 7)).length}
                    />
                  )}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      type: "spring",
                      stiffness: 200,
                      damping: 26,
                      // 只错开头几行，屏幕外的不必排队
                      delay: Math.min(i, 10) * 0.025,
                    }}
                  >
                    <Day
                      d={d}
                      isToday={d.day === todayDay}
                      flash={d.day === flash}
                      onOpen={(e) => e.task && openDetail(e.task.id)}
                      onEdit={editNote}
                      onDelete={(e) => e.note && void removeDailyNote(e.note.id)}
                      onAdd={() => setNoteDraft({ taskId: null, day: d.day })}
                    />
                  </motion.div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* 右栏只在放得下时出现 */}
      <aside className="hidden min-h-0 w-[420px] shrink-0 overflow-y-auto border-l border-[var(--rule)] @[1080px]:block">
        <TimelineSide
          careers={careers}
          onJump={jumpTo}
          onOpen={openDetail}
        />
      </aside>
    </div>
  );
}

/** 月份分节，吸顶 */
function MonthHeader({ iso, count }: { iso: string; count: number }) {
  return (
    <div
      className="sticky top-0 z-10 -mx-2 mb-3 flex items-center gap-3 px-2 py-2"
      style={{
        background: "color-mix(in srgb, var(--surface) 86%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <span className="font-mono text-[11px] font-semibold tabular-nums tracking-wide text-[var(--text)]">
        {iso.slice(0, 4)} 年 {Number(iso.slice(5, 7))} 月
      </span>
      <span className="h-px flex-1 bg-[var(--rule)]" />
      <span className="font-mono text-[10px] tabular-nums text-[var(--text-dim)]">{count} 天</span>
    </div>
  );
}

function Gap({ days }: { days: number }) {
  return (
    <div className="mb-5 flex items-center gap-5">
      <div className="w-14 shrink-0" />
      <div className="flex flex-1 items-center gap-[19px] text-[10px] text-[var(--text-dim)]">
        <span className="ml-[4px] h-4 border-l border-dashed border-[var(--text-dim)] opacity-50" />
        <span className="opacity-70">{days} 天没有记录</span>
      </div>
    </div>
  );
}

function Day({
  d,
  isToday,
  flash,
  onOpen,
  onEdit,
  onDelete,
  onAdd,
}: {
  d: TimelineDay;
  isToday: boolean;
  /** 刚从右栏跳过来，高亮一下 */
  flash: boolean;
  onOpen: (e: TimelineEvent) => void;
  onEdit: (e: TimelineEvent) => void;
  onDelete: (e: TimelineEvent) => void;
  onAdd: () => void;
}) {
  const date = dayToDate(d.day);
  return (
    <div
      data-day={d.day}
      className="group/day -mx-2 mb-5 flex scroll-mt-11 gap-5 rounded-xl px-2 py-1 transition-colors duration-500"
      style={{ background: flash ? tint("var(--accent)", 9) : "transparent" }}
    >
      {/* 日期列定宽，右侧轴线才能对齐 */}
      <div className="w-14 shrink-0 text-right">
        <div
          className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums"
          style={{
            color: isToday ? "var(--accent)" : "var(--text)",
            opacity: !isToday && isWeekend(d.day) ? 0.45 : 1,
          }}
        >
          {String(date.getUTCDate()).padStart(2, "0")}
        </div>
        <div className="mt-1.5 text-[10px] leading-none text-[var(--text-dim)]">
          {WEEKDAYS[date.getUTCDay()]}
        </div>
        {isToday && (
          <span
            className="mt-1.5 inline-block rounded-[var(--r-m)] px-1.5 text-[9px] font-semibold leading-[15px] text-white"
            style={{ background: "var(--accent)" }}
          >
            今天
          </span>
        )}
      </div>

      <div className="relative min-w-0 flex-1 pl-6">
        <span
          className="absolute bottom-0 left-[4px] top-1 w-px"
          style={{ background: isToday ? tint("var(--accent)", 45) : "var(--rule)" }}
        />
        <div className="space-y-0.5">
          {d.events.map((e) => (
            <Event
              key={e.key}
              event={e}
              onOpen={() => onOpen(e)}
              onEdit={() => onEdit(e)}
              onDelete={() => onDelete(e)}
            />
          ))}
        </div>

        <button
          onClick={onAdd}
          className={`mt-1 text-[10px] text-[var(--text-dim)] transition-[color,opacity] hover:text-[var(--accent)] focus-visible:opacity-100 group-hover/day:opacity-100 ${
            isToday ? "" : "opacity-0"
          }`}
        >
          ＋ 记一笔
        </button>
      </div>
    </div>
  );
}

function KindPill({ kind }: { kind: TimelineEvent["kind"] }) {
  const style = KIND_STYLE[kind];
  return (
    <span
      className="shrink-0 rounded-[5px] px-1.5 text-[10px] font-semibold leading-[18px]"
      style={{ color: style.dot, background: tint(style.dot, 13) }}
    >
      {style.label}
    </span>
  );
}

function Event({
  event,
  onOpen,
  onEdit,
  onDelete,
}: {
  event: TimelineEvent;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const style = KIND_STYLE[event.kind];
  const editable = event.note != null;

  return (
    <div className="group relative -mx-2 flex items-start gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-[var(--row-hover)]">
      <span
        className="absolute left-[-16px] top-[9.5px] size-[9px] rounded-full"
        style={{ background: style.dot, boxShadow: "0 0 0 3px var(--surface)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-[20px] flex-wrap items-center gap-x-2 gap-y-0.5">
          <KindPill kind={event.kind} />
          {event.task && (
            <button
              onClick={onOpen}
              className="text-[13px] font-medium text-[var(--text)] hover:underline"
            >
              {event.task.name || "未命名"}
            </button>
          )}
          {!event.task && (
            <span className="text-[11px] text-[var(--text-dim)]">全项目</span>
          )}
          {event.days != null && event.days > 1 && (
            <span className="font-mono text-[10px] tabular-nums text-[var(--danger)]">
              共 {event.days} 天
            </span>
          )}
          {event.unresolved && (
            <span
              className="rounded px-1 text-[9px] font-semibold leading-[14px] text-white"
              style={{ background: "var(--danger)" }}
              title="未关闭，每天自动加一天"
            >
              未关闭
            </span>
          )}
          {event.backdated && (
            <span
              className="text-[10px] text-[var(--text-dim)]"
              title="记录时间晚于事情发生的日期"
            >
              事后补记
            </span>
          )}
        </div>
        {/* 开工/完成没有正文 */}
        {event.kind !== "start" && event.kind !== "finish" && (
          <div className="mt-0.5 text-xs leading-relaxed whitespace-pre-wrap text-[var(--text-dim)]">
            {event.text}
          </div>
        )}
      </div>

      {editable && (
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={onEdit}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)]"
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

/** 筛选区间之前开始、区间内仍在持续的受阻；置顶，不归入任何一天 */
function Carried({
  events,
  onOpen,
}: {
  events: TimelineEvent[];
  onOpen: (e: TimelineEvent) => void;
}) {
  return (
    <div
      className="mb-6 rounded-xl border px-3.5 py-3"
      style={{ borderColor: tint("var(--danger)", 28), background: tint("var(--danger)", 5) }}
    >
      <div className="mb-2 text-[10px] font-semibold tracking-wide text-[var(--danger)]">
        此前开始，仍在受阻
      </div>
      <div className="space-y-2">
        {events.map((e) => (
          <div key={e.key}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <button
                onClick={() => onOpen(e)}
                className="text-[13px] font-medium text-[var(--text)] hover:underline"
              >
                {e.task?.name || "未命名"}
              </button>
              <span className="font-mono text-[10px] tabular-nums text-[var(--danger)]">
                自 {dayToIso(e.since ?? 0).slice(5)} 起，共 {e.days} 天
              </span>
              {e.unresolved && (
                <span
                  className="rounded px-1 text-[9px] font-semibold leading-[14px] text-white"
                  style={{ background: "var(--danger)" }}
                  title="未关闭，每天自动加一天"
                >
                  未关闭
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed whitespace-pre-wrap text-[var(--text-dim)]">
              {e.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 记一笔。关联任务可选：全项目的事不该算到某条任务头上 */
function Composer() {
  const draft = useAppStore((s) => s.noteDraft)!;
  const setNoteDraft = useAppStore((s) => s.setNoteDraft);
  const addDailyNote = useAppStore((s) => s.addDailyNote);
  const editDailyNote = useAppStore((s) => s.editDailyNote);
  const taskMap = useAppStore((s) => s.tasks);

  const [text, setText] = useState(draft.content ?? "");
  const [day, setDay] = useState(dayToIso(draft.day));
  const [taskId, setTaskId] = useState<number | null>(draft.taskId);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(draft.content ?? "");
    setDay(dayToIso(draft.day));
    setTaskId(draft.taskId);
    ref.current?.focus();
  }, [draft]);

  const leaves = useMemo(
    () => [...taskMap.values()].filter((t) => ![...taskMap.values()].some((c) => c.parentId === t.id)),
    [taskMap],
  );

  const submit = () => {
    if (!text.trim()) return;
    if (draft.id != null) void editDailyNote(draft.id, day, text);
    else void addDailyNote(taskId, day, text);
    setNoteDraft(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 rounded-xl border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
        />
        <select
          value={taskId ?? ""}
          onChange={(e) => setTaskId(e.target.value ? Number(e.target.value) : null)}
          disabled={draft.id != null}
          className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] disabled:opacity-50"
        >
          <option value="">全项目（不关联任务）</option>
          {leaves.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "未命名"}
            </option>
          ))}
        </select>
      </div>

      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setNoteDraft(null);
          // 多行输入，裸 Enter 留给换行
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={3}
        placeholder="这天发生了什么？例如：三号机主轴异响，停了半天等维修"
        className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-dim)]">{shortcut("mod", "Enter")} 保存，Esc 取消</span>
        <button
          onClick={() => setNoteDraft(null)}
          className="ml-auto rounded-lg px-3 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="rounded-lg px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          保存
        </button>
      </div>
    </motion.div>
  );
}
