/**
 * 复盘里的里程碑。两层：
 *
 *   ① 一条按真实日期比例画的横向时间轴 —— 节点之间隔多远、今天站在哪、
 *      哪个晚了多少（计划位置到实际位置那一截），一眼看完。
 *   ② 下面三栏，正好是汇报现场被追问的三句话：
 *      已达成（到得准不准）/ 该到没到 / 接下来。
 *
 * 以前是一列竖排的表：900px 宽的页面里，名字挤在左边、结论飘在最右，
 * 中间一大片空，节点一多整块被拉得很长，而且看不出时间上的远近。
 *
 * 状态的判定在 core/review.ts 的 milestoneMarks，这里只负责画。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import type { MilestoneMark, MilestoneState } from "../core/review";
import { dateToDay, dayToDate, dayToIso } from "../gantt/time";
import type { Person } from "../db/api";

const LATE = "#f43f5e";
const EARLY = "#10b981";

/** 今年的省掉年份 */
const shortDay = (day: number, thisYear: number) =>
  dayToDate(day).getUTCFullYear() === thisYear ? dayToIso(day).slice(5) : dayToIso(day);

const reached = (s: MilestoneState) => s.kind === "hit" || s.kind === "undated";

/** 节点实际落在轴上的哪一天：达成了的画在实际日，其余画在计划日 */
const landDay = (m: MilestoneMark) => (m.state.kind === "hit" && m.actual ? m.actual.startDay : m.plan.startDay);

interface Props {
  marks: MilestoneMark[];
  today: number;
  people: Person[];
  onOpen: (taskId: number) => void;
}

export function MilestoneTrack({ marks, today, people, onOpen }: Props) {
  const thisYear = dayToDate(today).getUTCFullYear();
  const done = marks.filter((m) => reached(m.state));
  const overdue = marks.filter((m) => m.state.kind === "overdue");
  const upcoming = marks.filter((m) => m.state.kind === "upcoming");
  const onTime = done.filter((m) => m.state.kind === "hit" && m.state.delta <= 0).length;
  const person = (m: MilestoneMark) => people.find((p) => p.id === m.task.personId) ?? null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="overflow-hidden rounded-xl border border-[var(--rule)] bg-[var(--surface)]">
        {/* —— 一行读完全局 —— */}
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-4 pt-3.5">
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-[26px] font-semibold leading-none tabular-nums text-[var(--text)]">
              {done.length}
            </span>
            <span className="font-mono text-[13px] tabular-nums text-[var(--text-dim)]">/ {marks.length}</span>
            <span className="ml-1 text-[11px] text-[var(--text-dim)]">个节点已达成</span>
          </span>
          {done.length > 0 && (
            <span className="text-[11px] text-[var(--text-dim)]">
              其中按时 <b className="font-mono font-semibold tabular-nums text-[var(--text)]">{onTime}</b> 个
            </span>
          )}
          {overdue.length > 0 && (
            <span className="text-[11px] font-semibold" style={{ color: LATE }}>
              {overdue.length} 个逾期未达成
            </span>
          )}
        </div>

        <Axis marks={marks} today={today} thisYear={thisYear} onOpen={onOpen} />

        {/* —— 三栏：已达成 / 该到没到 / 接下来 —— */}
        <div className="grid grid-cols-1 border-t border-[var(--rule)] sm:grid-cols-3 sm:divide-x sm:divide-[var(--rule)]">
          <Column title="已达成" count={done.length} color={EARLY} empty="还没有达成的节点">
            {done.map((m) => (
              <Row key={m.task.id} m={m} thisYear={thisYear} person={person(m)} onOpen={onOpen} />
            ))}
          </Column>
          <Column title="该到没到" count={overdue.length} color={LATE} empty="没有逾期的节点" alert>
            {overdue.map((m) => (
              <Row key={m.task.id} m={m} thisYear={thisYear} person={person(m)} onOpen={onOpen} />
            ))}
          </Column>
          <Column title="接下来" count={upcoming.length} color="var(--milestone)" empty="后面没有节点了">
            {upcoming.map((m) => (
              <Row key={m.task.id} m={m} thisYear={thisYear} person={person(m)} onOpen={onOpen} />
            ))}
          </Column>
        </div>
      </div>
    </MotionConfig>
  );
}

/* ------------------------------------------------------------------ */
/* 时间轴                                                              */
/* ------------------------------------------------------------------ */

const LANES = 3;
const LANE_H = 19;
const AXIS_Y = LANES * LANE_H + 18;
const AXIS_H = AXIS_Y + 34;
const SIDE = 20;
const LABEL_MAX = 10;

/** 11px 字号下的大致宽度：中文一个字 ≈ 11px，ASCII ≈ 6.4px。只用来避让，不用很准 */
const textWidth = (s: string) => [...s].reduce((w, c) => w + (c.charCodeAt(0) < 256 ? 6.4 : 11), 0);
const clip = (s: string) => ([...s].length > LABEL_MAX ? [...s].slice(0, LABEL_MAX - 1).join("") + "…" : s);

interface Placed {
  m: MilestoneMark;
  x: number;
  planX: number;
  /** 标签所在的行，null = 挤不下，只留菱形（悬停看名字） */
  lane: number | null;
  left: number;
  text: string;
}

/**
 * 标签分行：从左到右，每个标签放进离轴最近、还放得下的那一行。
 * 三行都挤满了就不写字 —— 菱形还在，悬停有名字，下面三栏里也有。
 */
function placeLabels(marks: MilestoneMark[], x: (day: number) => number, width: number): Placed[] {
  const lanes: [number, number][][] = Array.from({ length: LANES }, () => []);
  return [...marks]
    .sort((a, b) => landDay(a) - landDay(b))
    .map((m) => {
      const px = x(landDay(m));
      const text = clip(m.task.name || "未命名");
      const w = textWidth(text) + 4;
      // 默认从菱形往右写；贴右边了就往左写
      const left = px + w > width - 4 ? px - w + 4 : px - 4;
      const lane = lanes.findIndex((spans) => spans.every(([l, r]) => left > r + 8 || left + w < l - 8));
      if (lane >= 0) lanes[lane].push([left, left + w]);
      return { m, x: px, planX: x(m.plan.startDay), lane: lane >= 0 ? lane : null, left, text };
    });
}

/** 月份刻度（每月 1 号）。跨得太久就隔几个月标一次，最多八个 */
function monthTicks(from: number, to: number) {
  const start = dayToDate(from);
  const months: Date[] = [];
  for (let i = 1; ; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    if (dateToDay(d) > to) break;
    months.push(d);
  }
  const every = Math.max(1, Math.ceil(months.length / 8));
  return months
    .filter((_, i) => i % every === 0)
    .map((d) => ({
      day: dateToDay(d),
      label: d.getUTCMonth() === 0 ? `${d.getUTCFullYear()} 年 1 月` : `${d.getUTCMonth() + 1} 月`,
    }));
}

function Axis({
  marks,
  today,
  thisYear,
  onOpen,
}: {
  marks: MilestoneMark[];
  today: number;
  thisYear: number;
  onOpen: (taskId: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(860);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => el.clientWidth > 0 && setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { from, to } = useMemo(() => {
    const days = marks.flatMap((m) => [m.plan.startDay, landDay(m)]).concat(today);
    const lo = Math.min(...days);
    const hi = Math.max(...days);
    const pad = Math.max(3, Math.round((hi - lo) * 0.04));
    return { from: lo - pad, to: hi + pad };
  }, [marks, today]);

  const inner = width - SIDE * 2;
  const x = (day: number) => SIDE + ((day - from) / Math.max(1, to - from)) * inner;
  const placed = useMemo(() => placeLabels(marks, x, width), [marks, width, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const ticks = useMemo(() => monthTicks(from, to), [from, to]);
  const tx = x(today);

  return (
    <div ref={box} className="relative mx-0 select-none" style={{ height: AXIS_H }} aria-label="里程碑时间轴">
      {/* 月份刻度 */}
      {ticks.map((t) => (
        <span key={t.day} className="absolute" style={{ left: x(t.day), top: AXIS_Y - 4, height: 8 }}>
          <span className="absolute left-0 top-0 h-2 w-px bg-[var(--rule)]" />
          <span className="absolute left-1 top-3 whitespace-nowrap text-[9.5px] text-[var(--text-dim)] opacity-80">
            {t.label}
          </span>
        </span>
      ))}

      {/* 轴：走过的一段实线，还没到的一段虚线 */}
      <span
        className="absolute h-[1.5px] bg-[color-mix(in_srgb,var(--text-dim)_55%,transparent)]"
        style={{ left: SIDE, width: Math.max(0, tx - SIDE), top: AXIS_Y }}
      />
      <span
        className="absolute border-t-[1.5px] border-dashed border-[color-mix(in_srgb,var(--text-dim)_35%,transparent)]"
        style={{ left: tx, width: Math.max(0, width - SIDE - tx), top: AXIS_Y }}
      />

      {/* 今天 */}
      <span className="pointer-events-none absolute w-px" style={{ left: tx, top: 4, height: AXIS_Y + 6, background: LATE, opacity: 0.55 }} />
      <span
        className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-full px-1.5 font-mono text-[9.5px] font-semibold tabular-nums text-white"
        style={{ left: tx, top: AXIS_Y + 16, background: LATE }}
      >
        今天 {shortDay(today, thisYear)}
      </span>

      {placed.map((p, i) => (
        <Mark key={p.m.task.id} p={p} index={i} thisYear={thisYear} onOpen={() => onOpen(p.m.task.id)} />
      ))}
    </div>
  );
}

function Mark({ p, index, thisYear, onOpen }: { p: Placed; index: number; thisYear: number; onOpen: () => void }) {
  const { m, x, planX } = p;
  const s = m.state;
  const overdue = s.kind === "overdue";
  const color = overdue ? LATE : "var(--milestone)";
  const slip = s.kind === "hit" && s.delta !== 0;
  const slipColor = slip && s.delta > 0 ? LATE : EARLY;
  const labelTop = AXIS_Y - 14 - (p.lane ?? 0) * LANE_H - 12;
  const title = `${m.task.name || "未命名"} · 计划 ${shortDay(m.plan.startDay, thisYear)}${
    slip && m.actual ? ` · 实际 ${shortDay(m.actual.startDay, thisYear)}` : ""
  }`;

  return (
    <>
      {/* 计划日到实际日那一截：晚了红、早了绿，计划位置留一个空心的影子 */}
      {slip && (
        <>
          <span
            className="absolute h-[3px] rounded-full"
            style={{ left: Math.min(x, planX), width: Math.abs(x - planX), top: AXIS_Y - 0.75, background: slipColor, opacity: 0.55 }}
          />
          <span
            className="absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] border-[1.5px] bg-[var(--surface)]"
            style={{ left: planX, top: AXIS_Y + 0.75, borderColor: slipColor }}
          />
        </>
      )}

      {/* 引线 + 标签 */}
      {p.lane != null && (
        <>
          <span
            className="absolute w-px bg-[var(--rule)]"
            style={{ left: x, top: labelTop + 14, height: AXIS_Y - labelTop - 20 }}
          />
          <button
            onClick={onOpen}
            title={title}
            className="absolute whitespace-nowrap rounded bg-[var(--surface)] px-0.5 text-left text-[11px] leading-[14px] transition-colors hover:text-[var(--accent)]"
            style={{
              left: p.left,
              top: labelTop,
              color: overdue ? LATE : reached(s) ? "var(--text-dim)" : "var(--text)",
              fontWeight: overdue ? 600 : 400,
            }}
          >
            {p.text}
          </button>
        </>
      )}

      {/* 菱形：实心 = 到了；空心 = 还没到；红 + 呼吸光圈 = 该到没到 */}
      <motion.button
        onClick={onOpen}
        title={title}
        aria-label={title}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.05 + Math.min(index, 12) * 0.04, ease: [0.22, 1, 0.36, 1] }}
        className="group absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center"
        style={{ left: x, top: AXIS_Y + 0.75 }}
      >
        {overdue && (
          <motion.span
            className="absolute size-[11px] rotate-45 rounded-[2px]"
            style={{ background: LATE }}
            animate={{ scale: [1, 2], opacity: [0.35, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span
          className="relative size-[11px] rotate-45 rounded-[2px] transition-transform group-hover:scale-125"
          style={{
            background: reached(s) || overdue ? color : "var(--surface)",
            border: `2px solid ${color}`,
            opacity: s.kind === "undated" ? 0.55 : 1,
          }}
        />
      </motion.button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 三栏                                                                */
/* ------------------------------------------------------------------ */

function Column({
  title,
  count,
  color,
  empty,
  alert,
  children,
}: {
  title: string;
  count: number;
  color: string;
  empty: string;
  alert?: boolean;
  children: React.ReactNode;
}) {
  const hot = alert && count > 0;
  return (
    <section
      className="min-w-0 border-t border-[var(--rule)] px-2 pb-2.5 pt-3 first:border-t-0 sm:border-t-0"
      style={hot ? { background: `color-mix(in srgb, ${LATE} 4%, transparent)` } : undefined}
    >
      <h4 className="mb-1.5 flex items-center gap-2 px-2 text-[11px] font-semibold text-[var(--text)]">
        <span className="h-3 w-[3px] rounded-full" style={{ background: color }} />
        <span style={hot ? { color: LATE } : undefined}>{title}</span>
        <span className="font-mono text-[10px] font-normal tabular-nums text-[var(--text-dim)]">{count}</span>
      </h4>
      {count === 0 ? (
        <p className="px-2 py-1.5 text-[11px] text-[var(--text-dim)]">{empty}</p>
      ) : (
        <ul className="space-y-px">{children}</ul>
      )}
    </section>
  );
}

function verdictOf(s: MilestoneState): { text: string; color: string; strong?: boolean } {
  switch (s.kind) {
    case "hit":
      return s.delta === 0
        ? { text: "准时", color: EARLY }
        : s.delta > 0
          ? { text: `晚 ${s.delta} 天`, color: LATE, strong: true }
          : { text: `早 ${-s.delta} 天`, color: EARLY };
    case "undated":
      return { text: "未记实施日", color: "var(--text-dim)" };
    case "overdue":
      return { text: `逾期 ${s.days} 天`, color: LATE, strong: true };
    case "upcoming":
      return s.days === 0
        ? { text: "就是今天", color: "var(--accent)", strong: true }
        : { text: `还有 ${s.days} 天`, color: "var(--text-dim)" };
  }
}

function Row({
  m,
  thisYear,
  person,
  onOpen,
}: {
  m: MilestoneMark;
  thisYear: number;
  person: Person | null;
  onOpen: (taskId: number) => void;
}) {
  const v = verdictOf(m.state);
  const slipped = m.state.kind === "hit" && m.state.delta !== 0 && m.actual != null;
  return (
    <li>
      <button
        onClick={() => onOpen(m.task.id)}
        title="打开这个里程碑的详情"
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--row-hover)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-tight text-[var(--text)]">{m.task.name || "未命名"}</span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
            {slipped ? (
              <>
                <span className="line-through decoration-1 opacity-70">{shortDay(m.plan.startDay, thisYear)}</span>
                <span>→ {shortDay(m.actual!.startDay, thisYear)}</span>
              </>
            ) : (
              <span>{shortDay(m.plan.startDay, thisYear)}</span>
            )}
            {person && <span className="font-sans">· {person.name}</span>}
          </span>
        </span>
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums"
          style={{ color: v.color, fontWeight: v.strong ? 600 : 400 }}
        >
          {v.text}
        </span>
      </button>
    </li>
  );
}
