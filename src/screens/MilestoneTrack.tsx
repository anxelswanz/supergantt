/**
 * 复盘里的里程碑：一条从上往下走的路线，而不是一张日期表。
 *
 * 表格的问题是它把「已经过去的」「今天」「还没到的」排成一样的行，
 * 读的人得自己拿每个日期去和今天比。汇报现场被追问的永远是三句话：
 * 哪几个到了、到得准不准、哪个该到没到 —— 这三句话要在一眼里读出来。
 *
 *   · 左列是日期。晚了 / 早了的，计划日划掉、实际日写在下面 —— 差多少看字就知道
 *   · 中间是轨道。今天是轨道上的一道红线，线上方实线（已经走过），下方虚线（还没到）
 *   · 右列直接写结论：准时 / 晚 3 天 / 逾期 5 天 · 未达成 / 还有 12 天
 *
 * 状态的判定在 core/review.ts 的 milestoneMarks，这里只负责画。
 */

import { Fragment } from "react";
import { MotionConfig, motion } from "motion/react";
import type { MilestoneMark, MilestoneState } from "../core/review";
import { dayToDate, dayToIso } from "../gantt/time";
import type { Person } from "../db/api";
import { Avatar } from "./Avatar";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const LATE = "#f43f5e";
const EARLY = "#10b981";

/** 今年的省掉年份 —— 左列很窄，每个字都占地方 */
const shortDay = (day: number, thisYear: number) =>
  dayToDate(day).getUTCFullYear() === thisYear ? dayToIso(day).slice(5) : dayToIso(day);

interface Verdict {
  text: string;
  color: string;
  /** 实心底：只给「逾期未达成」—— 整块里唯一需要立刻有人站出来解释的 */
  solid?: boolean;
}

function verdictOf(s: MilestoneState): Verdict {
  switch (s.kind) {
    case "hit":
      return s.delta === 0
        ? { text: "准时达成", color: EARLY }
        : s.delta > 0
          ? { text: `晚 ${s.delta} 天达成`, color: LATE }
          : { text: `早 ${-s.delta} 天达成`, color: EARLY };
    case "undated":
      return { text: "已完成 · 未记实施日", color: "var(--text-dim)" };
    case "overdue":
      return { text: `逾期 ${s.days} 天 · 未达成`, color: LATE, solid: true };
    case "upcoming":
      return s.days === 0
        ? { text: "就是今天", color: "var(--accent)" }
        : { text: `还有 ${s.days} 天`, color: "var(--text-dim)" };
  }
}

const reached = (s: MilestoneState) => s.kind === "hit" || s.kind === "undated";

export function MilestoneTrack({
  marks,
  today,
  people,
  onOpen,
}: {
  marks: MilestoneMark[];
  today: number;
  people: Person[];
  onOpen: (taskId: number) => void;
}) {
  const thisYear = dayToDate(today).getUTCFullYear();
  // 今天那道线插在第一个「计划日不早于今天」的节点前面（marks 已按计划日排好）
  const todayAt = (() => {
    const i = marks.findIndex((m) => m.plan.startDay >= today);
    return i === -1 ? marks.length : i;
  })();

  const count = (k: MilestoneState["kind"]) => marks.filter((m) => m.state.kind === k).length;
  const hit = count("hit") + count("undated");
  const overdue = count("overdue");
  const upcoming = count("upcoming");

  return (
    <MotionConfig reducedMotion="user">
      <div className="rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] px-4 pb-2 pt-3">
        {/* 一行读完全局：几个到了、几个该到没到、几个还在前面 */}
        <div className="mb-3 flex items-center gap-3 border-b border-[var(--rule)] pb-3">
          <span className="font-mono text-[22px] font-semibold leading-none tabular-nums text-[var(--text)]">
            {hit}
            <span className="text-[13px] font-normal text-[var(--text-dim)]"> / {marks.length}</span>
          </span>
          <span className="text-[11px] text-[var(--text-dim)]">个节点已达成</span>
          <span className="ml-auto flex items-center gap-3 text-[10px] text-[var(--text-dim)]">
            {overdue > 0 && (
              <Legend color={LATE} label={`逾期 ${overdue}`} strong />
            )}
            {upcoming > 0 && <Legend color="var(--milestone)" label={`待到 ${upcoming}`} hollow />}
          </span>
        </div>

        <ol className="relative">
          {marks.map((m, i) => (
            <Fragment key={m.task.id}>
              {i === todayAt && <TodayLine day={today} thisYear={thisYear} first={i === 0} />}
              <Stop
                mark={m}
                index={i}
                first={i === 0 && todayAt !== 0}
                last={i === marks.length - 1 && todayAt !== marks.length}
                future={m.plan.startDay >= today}
                thisYear={thisYear}
                person={people.find((p) => p.id === m.task.personId) ?? null}
                onOpen={() => onOpen(m.task.id)}
              />
            </Fragment>
          ))}
          {todayAt === marks.length && <TodayLine day={today} thisYear={thisYear} last />}
        </ol>
      </div>
    </MotionConfig>
  );
}

/* 三列的宽度：日期 / 轨道 / 正文。TodayLine 要和 Stop 对齐，共用这一份 */
const GRID = "grid grid-cols-[76px_28px_minmax(0,1fr)] items-stretch";

function Stop({
  mark,
  index,
  first,
  last,
  future,
  thisYear,
  person,
  onOpen,
}: {
  mark: MilestoneMark;
  index: number;
  first: boolean;
  last: boolean;
  /** 计划日还没到：轨道画虚线 */
  future: boolean;
  thisYear: number;
  person: Person | null;
  onOpen: () => void;
}) {
  const { state, plan, actual } = mark;
  const verdict = verdictOf(state);
  const slipped = state.kind === "hit" && state.delta !== 0 && actual != null;
  const planDay = plan.startDay;

  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index, 10) * 0.04, ease: [0.22, 1, 0.36, 1] }}
    >
      <button
        onClick={onOpen}
        title="打开这个里程碑的详情"
        className={`${GRID} group w-full rounded-lg text-left transition-colors hover:bg-[var(--row-hover)]`}
      >
        {/* —— 日期 —— */}
        <span className="flex flex-col items-end justify-center py-2.5 pr-1 font-mono tabular-nums">
          <span
            className={`text-[12px] leading-tight ${
              slipped ? "text-[var(--text-dim)] line-through decoration-1" : "font-semibold text-[var(--text)]"
            }`}
          >
            {shortDay(planDay, thisYear)}
          </span>
          {slipped ? (
            <span className="text-[12px] font-semibold leading-tight" style={{ color: verdict.color }}>
              {shortDay(actual.startDay, thisYear)}
            </span>
          ) : (
            <span className="text-[9px] leading-tight text-[var(--text-dim)]">
              {WEEKDAYS[dayToDate(planDay).getUTCDay()]}
            </span>
          )}
        </span>

        {/* —— 轨道 + 节点 —— */}
        <span className="relative flex items-center justify-center">
          <Rail top={!first} bottom={!last} futureTop={future} futureBottom={future} />
          <Node state={state} />
        </span>

        {/* —— 正文 —— */}
        <span className="flex min-w-0 items-center gap-2 py-2.5 pl-1.5 pr-2">
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-[13px] leading-tight ${
                reached(state) ? "text-[var(--text)]" : "font-medium text-[var(--text)]"
              }`}
            >
              {mark.task.name || "未命名"}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
              {person && <Avatar person={person} size={12} placeholder={false} />}
              {person?.name}
              {slipped && (
                <span className="font-mono tabular-nums">
                  {person ? "· " : ""}计划 {shortDay(planDay, thisYear)} → 实际{" "}
                  {shortDay(actual.startDay, thisYear)}
                </span>
              )}
            </span>
          </span>
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums"
            style={
              verdict.solid
                ? { background: verdict.color, color: "#fff" }
                : {
                    color: verdict.color,
                    background: `color-mix(in srgb, ${verdict.color} 11%, transparent)`,
                  }
            }
          >
            {verdict.text}
          </span>
          <span className="w-2 shrink-0 text-[11px] text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
            ›
          </span>
        </span>
      </button>
    </motion.li>
  );
}

/** 一格里的竖线，上下两半分开画 —— 今天那道线把同一格的上下切成实线和虚线 */
function Rail({
  top,
  bottom,
  futureTop,
  futureBottom,
}: {
  top: boolean;
  bottom: boolean;
  futureTop: boolean;
  futureBottom: boolean;
}) {
  const seg = (future: boolean) =>
    future
      ? "border-l-[1.5px] border-dashed border-[var(--rule)]"
      : "border-l-[1.5px] border-solid border-[color-mix(in_srgb,var(--text-dim)_45%,transparent)]";
  return (
    <>
      {top && <span className={`absolute left-1/2 top-0 h-1/2 -translate-x-[0.75px] ${seg(futureTop)}`} />}
      {bottom && (
        <span className={`absolute bottom-0 left-1/2 h-1/2 -translate-x-[0.75px] ${seg(futureBottom)}`} />
      )}
    </>
  );
}

/**
 * 菱形节点，和甘特图上里程碑同一个形状、同一个颜色（--milestone）：
 *   实心 = 到了；空心 = 还没到；红框 + 呼吸光圈 = 该到没到
 */
function Node({ state }: { state: MilestoneState }) {
  const overdue = state.kind === "overdue";
  const filled = reached(state);
  const color = overdue ? LATE : "var(--milestone)";
  return (
    <span className="relative grid size-4 place-items-center">
      {overdue && (
        <motion.span
          className="absolute inset-0 rotate-45 rounded-[3px]"
          style={{ background: LATE }}
          animate={{ scale: [1, 1.9], opacity: [0.35, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span
        className="relative size-[11px] rotate-45 rounded-[2.5px] transition-transform group-hover:scale-110"
        style={{
          background: filled ? color : "var(--surface-alt)",
          border: `2px solid ${color}`,
          opacity: state.kind === "undated" ? 0.6 : 1,
        }}
      />
    </span>
  );
}

function TodayLine({
  day,
  thisYear,
  first,
  last,
}: {
  day: number;
  thisYear: number;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <li aria-label="今天" className={`${GRID} h-6`}>
      <span className="flex items-center justify-end pr-1 font-mono text-[10px] font-semibold tabular-nums text-[var(--today,#f43f5e)]">
        今天 {shortDay(day, thisYear).slice(-5)}
      </span>
      <span className="relative flex items-center justify-center">
        <Rail top={!first} bottom={!last} futureTop={false} futureBottom />
        <span className="relative size-[7px] rounded-full bg-[var(--today,#f43f5e)] ring-[3px] ring-[var(--surface-alt)]" />
      </span>
      <span className="flex items-center pl-1.5 pr-2">
        <span className="h-px flex-1 bg-[linear-gradient(to_right,var(--today,#f43f5e),transparent)] opacity-50" />
      </span>
    </li>
  );
}

function Legend({
  color,
  label,
  hollow,
  strong,
}: {
  color: string;
  label: string;
  hollow?: boolean;
  strong?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5" style={strong ? { color, fontWeight: 600 } : undefined}>
      <span
        className="size-[7px] rotate-45 rounded-[1.5px]"
        style={{ background: hollow ? "transparent" : color, border: `1.5px solid ${color}` }}
      />
      {label}
    </span>
  );
}
