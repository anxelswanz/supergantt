/**
 * 时间线的日期筛选：一个日历同时管「单日」和「一段日期」。
 *
 * 不分模式 —— 点一下就是只看那一天（当场生效），接着再点另一天，
 * 两次点选之间就成了一段。先选「我要单日还是区间」是在逼人回答一个
 * 他还没想好的问题：多数时候是先看了某一天，才决定往前再多看几天。
 *
 * 和 DatePicker 一样不用原生 <input type="date">（WKWebView 上是分段步进器），
 * 月历网格直接复用它的 monthGrid。
 *
 * 传了 `granular` 就多出「月 / 年」两档（事项视图要）：同样的点法，
 * 点一个月就是整月，再点另一个月就连成几个月。选出来的仍然只是一个
 * DayRange —— 按月、按年不过是首尾恰好落在月初月末的一段，筛选那头不用知道。
 */

import { useCallback, useMemo, useState } from "react";
import { type DayRange } from "../core/timeline";
import { dayToDate, dayToIso, isoToDay, isWeekend, today } from "../gantt/time";
import { monthGrid } from "./DatePicker";
import { Popover } from "./Popover";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (n: number) => String(n).padStart(2, "0");

/** 今年的日期省掉年份，跨年的才写全 —— 筛选条上每个字都占地方 */
const short = (day: number, withYear: boolean) =>
  withYear ? dayToIso(day) : dayToIso(day).slice(5);

export function formatRange(range: DayRange): string {
  const thisYear = dayToDate(today()).getUTCFullYear();
  // 整年、整月就说成「2026 年」「10 月」，比 01-01 – 12-31 好认得多
  const years = wholeYears(range);
  if (years) {
    return years.from === years.to ? `${years.from} 年` : `${years.from}–${years.to} 年`;
  }
  const months = wholeMonths(range);
  if (months) {
    const { from: a, to: b } = months;
    if (a.y === b.y) {
      const prefix = a.y === thisYear ? "" : `${a.y} 年 `;
      return a.m === b.m ? `${prefix}${a.m + 1} 月` : `${prefix}${a.m + 1}–${b.m + 1} 月`;
    }
    return `${a.y}-${pad(a.m + 1)} – ${b.y}-${pad(b.m + 1)}`;
  }
  const withYear =
    dayToDate(range.from).getUTCFullYear() !== thisYear ||
    dayToDate(range.to).getUTCFullYear() !== thisYear;
  if (range.from === range.to) {
    return `${short(range.from, withYear)} ${WEEKDAYS[dayToDate(range.from).getUTCDay()]}`;
  }
  return `${short(range.from, withYear)} – ${short(range.to, withYear)}`;
}

export const sameRange = (a: DayRange | null, b: DayRange | null) =>
  a === b || (a != null && b != null && a.from === b.from && a.to === b.to);

/** 快捷项。「全部」就是不筛，用 null 表示 */
export function rangePresets(now: number): { label: string; range: DayRange | null }[] {
  const { y, m } = monthOf(now);
  return [
    { label: "全部", range: null },
    { label: "今天", range: { from: now, to: now } },
    { label: "近 7 天", range: { from: now - 6, to: now } },
    { label: "本月", range: { from: monthStart(y, m), to: monthEnd(y, m) } },
  ];
}

type Unit = "day" | "month" | "year";

const UNIT_LABELS: { unit: Unit; label: string }[] = [
  { unit: "day", label: "日期" },
  { unit: "month", label: "月" },
  { unit: "year", label: "年" },
];

/** 年份一页 12 个，3 × 4 */
const YEARS_PER_PAGE = 12;

interface Props {
  value: DayRange | null;
  onChange: (range: DayRange | null) => void;
  /** 有记录的那些天，日历上打个点 —— 不然只能靠猜去点 */
  marked: Set<number>;
  /** 多给「月 / 年」两档粒度 */
  granular?: boolean;
  align?: "left" | "right";
}

export function RangeFilter({ value, onChange, marked, granular = false, align = "right" }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [unit, setUnit] = useState<Unit>("day");
  // 已经点了第一下（一天 / 一个月 / 一年）、还在等第二下
  const [pending, setPending] = useState<DayRange | null>(null);
  const [hover, setHover] = useState<DayRange | null>(null);
  const [view, setView] = useState(() => monthOf(value?.to ?? today()));

  const close = useCallback(() => {
    setOpen(false);
    setPending(null);
    setHover(null);
  }, []);

  const toggle = () => {
    if (open) return close();
    setView(monthOf(value?.to ?? today()));
    // 当前筛的是整年 / 整月，就直接翻到那一档，接着改
    setUnit(
      !granular || !value ? "day" : wholeYears(value) ? "year" : wholeMonths(value) ? "month" : "day",
    );
    setOpen(true);
  };

  const switchUnit = (u: Unit) => {
    setUnit(u);
    setPending(null);
    setHover(null);
  };

  const pick = (r: DayRange) => {
    if (pending == null) {
      onChange(r);
      setPending(r);
      return;
    }
    onChange(span(pending, r));
    close();
  };

  // 等第二下的时候，鼠标滑到哪就先把那一段画出来
  const shown = pending != null && hover != null ? span(pending, hover) : value;

  const now = today();
  const active = value != null;
  const nowMonth = monthOf(now);

  // 月、年格子上的点：那个月 / 那一年里有任何一天有记录
  const markedMonths = useMemo(() => {
    const set = new Set<string>();
    for (const d of marked) {
      const { y, m } = monthOf(d);
      set.add(`${y}-${m}`);
    }
    return set;
  }, [marked]);
  const markedYears = useMemo(
    () => new Set([...markedMonths].map((k) => Number(k.split("-")[0]))),
    [markedMonths],
  );

  const yearPageStart = Math.floor(view.y / YEARS_PER_PAGE) * YEARS_PER_PAGE;

  return (
    <>
      <div
        ref={setAnchor}
        className="flex items-center rounded-full border transition-colors"
        style={{
          borderColor: active
            ? "color-mix(in srgb, var(--accent) 55%, transparent)"
            : "var(--rule)",
          background: active
            ? "color-mix(in srgb, var(--accent) 9%, transparent)"
            : "transparent",
        }}
      >
        <button
          onClick={toggle}
          title={
            granular
              ? "按日期筛选：可按年、按月，或点两天选一段"
              : "按日期筛选：点一天看单日，再点一天选一段"
          }
          className="flex items-center gap-1.5 py-1 pl-2.5 pr-2 font-mono text-[11px] tabular-nums transition-colors"
          style={{ color: active ? "var(--accent)" : "var(--text-dim)" }}
        >
          <CalendarGlyph />
          <span className={active ? "font-semibold" : ""}>
            {value ? formatRange(value) : "全部日期"}
          </span>
        </button>
        {active && (
          <button
            onClick={() => {
              onChange(null);
              close();
            }}
            title="清除日期筛选"
            className="-ml-1 grid size-6 place-items-center rounded-full text-[11px] text-[var(--accent)] opacity-60 transition-opacity hover:opacity-100"
          >
            ✕
          </button>
        )}
      </div>

      <Popover anchor={anchor} open={open} onClose={close} align={align} width={252}>
        <div className="px-2.5 pb-1.5 pt-1.5">
          {granular && (
            <div className="mb-2 grid grid-cols-3 gap-0.5 rounded-md bg-[var(--surface-alt)] p-0.5">
              {UNIT_LABELS.map(({ unit: u, label }) => (
                <button
                  key={u}
                  onClick={() => switchUnit(u)}
                  className={`rounded py-0.5 text-[10px] font-medium transition-colors ${
                    unit === u
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                      : "text-[var(--text-dim)] hover:text-[var(--text)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="mb-2 flex items-center justify-between">
            <NavButton
              onClick={() =>
                setView(
                  unit === "day"
                    ? shift(view, -1)
                    : { ...view, y: view.y - (unit === "year" ? YEARS_PER_PAGE : 1) },
                )
              }
            >
              ‹
            </NavButton>
            <span className="font-mono text-[11px] font-semibold tabular-nums text-[var(--text)]">
              {unit === "day"
                ? `${view.y} 年 ${view.m + 1} 月`
                : unit === "month"
                  ? `${view.y} 年`
                  : `${yearPageStart} – ${yearPageStart + YEARS_PER_PAGE - 1}`}
            </span>
            <NavButton
              onClick={() =>
                setView(
                  unit === "day"
                    ? shift(view, 1)
                    : { ...view, y: view.y + (unit === "year" ? YEARS_PER_PAGE : 1) },
                )
              }
            >
              ›
            </NavButton>
          </div>

          {unit === "day" ? (
            <>
              <div className="mb-1 grid grid-cols-7">
                {WEEKDAY_LABELS.map((label, i) => (
                  <div
                    key={label}
                    className={`grid h-5 place-items-center text-[10px] font-medium text-[var(--text-dim)] ${
                      i >= 5 ? "opacity-60" : ""
                    }`}
                  >
                    {label}
                  </div>
                ))}
              </div>

              {/* 横向不留缝：区间的底色要连成一条带子，断开就读不出「一段」 */}
              <div
                className="grid grid-cols-7 gap-y-0.5"
                onPointerLeave={() => setHover(null)}
              >
                {monthGrid(view.y, view.m).map((day) => {
                  const inMonth = dayToDate(day).getUTCMonth() === view.m;
                  const inRange = shown != null && day >= shown.from && day <= shown.to;
                  const isEdge = shown != null && (day === shown.from || day === shown.to);
                  return (
                    <button
                      key={day}
                      onClick={() => pick({ from: day, to: day })}
                      onPointerEnter={() => setHover({ from: day, to: day })}
                      className={`relative grid h-7 place-items-center font-mono text-[11px] tabular-nums transition-colors ${
                        isEdge
                          ? "font-semibold text-white"
                          : isWeekend(day)
                            ? "text-[var(--text-dim)]"
                            : "text-[var(--text)]"
                      } ${inMonth ? "" : "opacity-35"} ${
                        inRange ? "" : "rounded-md hover:bg-[var(--row-hover)]"
                      } ${
                        inRange && day === shown!.from ? "rounded-l-md" : ""
                      } ${inRange && day === shown!.to ? "rounded-r-md" : ""}`}
                      style={{
                        background: isEdge
                          ? "var(--accent)"
                          : inRange
                            ? "color-mix(in srgb, var(--accent) 16%, transparent)"
                            : undefined,
                        // 今天用描边，免得和「选中」抢视觉（同 DatePicker）
                        boxShadow:
                          day === now && !isEdge
                            ? "inset 0 0 0 1.5px var(--today, #f43f5e)"
                            : undefined,
                      }}
                    >
                      {dayToDate(day).getUTCDate()}
                      {marked.has(day) && (
                        <span
                          className="absolute bottom-[3px] size-[3px] rounded-full"
                          style={{ background: isEdge ? "#fff" : "var(--accent)" }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-1" onPointerLeave={() => setHover(null)}>
              {Array.from({ length: 12 }, (_, i) => {
                const cell: DayRange =
                  unit === "month"
                    ? { from: monthStart(view.y, i), to: monthEnd(view.y, i) }
                    : { from: monthStart(yearPageStart + i, 0), to: monthEnd(yearPageStart + i, 11) };
                const isCurrent =
                  unit === "month"
                    ? view.y === nowMonth.y && i === nowMonth.m
                    : yearPageStart + i === nowMonth.y;
                const hasMark =
                  unit === "month"
                    ? markedMonths.has(`${view.y}-${i}`)
                    : markedYears.has(yearPageStart + i);
                const inRange = shown != null && cell.from >= shown.from && cell.to <= shown.to;
                const isEdge =
                  inRange && (cell.from === shown!.from || cell.to === shown!.to);
                return (
                  <button
                    key={i}
                    onClick={() => pick(cell)}
                    onPointerEnter={() => setHover(cell)}
                    className={`relative grid h-9 place-items-center rounded-md font-mono text-[11px] tabular-nums transition-colors ${
                      isEdge ? "font-semibold text-white" : "text-[var(--text)]"
                    } ${inRange ? "" : "hover:bg-[var(--row-hover)]"}`}
                    style={{
                      background: isEdge
                        ? "var(--accent)"
                        : inRange
                          ? "color-mix(in srgb, var(--accent) 16%, transparent)"
                          : undefined,
                      boxShadow:
                        isCurrent && !isEdge
                          ? "inset 0 0 0 1.5px var(--today, #f43f5e)"
                          : undefined,
                    }}
                  >
                    {unit === "month" ? `${i + 1} 月` : yearPageStart + i}
                    {hasMark && (
                      <span
                        className="absolute bottom-[4px] size-[3px] rounded-full"
                        style={{ background: isEdge ? "#fff" : "var(--accent)" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between border-t border-[var(--rule)] pt-2">
            <span className="text-[9px] text-[var(--text-dim)]">
              {pending != null
                ? `再点一${UNIT_NOUN[unit]}，选成一段`
                : `点一${UNIT_NOUN[unit]}看单${unit === "day" ? "日" : UNIT_NOUN[unit]} · 再点一${UNIT_NOUN[unit]}选一段`}
            </span>
            <span className="flex items-center gap-1 text-[9px] text-[var(--text-dim)]">
              <span className="size-[3px] rounded-full bg-[var(--accent)]" />
              有记录
            </span>
          </div>
        </div>
      </Popover>
    </>
  );
}

const UNIT_NOUN: Record<Unit, string> = { day: "天", month: "个月", year: "年" };

function CalendarGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="1" y="2" width="10" height="9" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1 5h10M4 1v2M8 1v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function NavButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}

interface Month {
  y: number;
  m: number;
}

const monthOf = (day: number): Month => {
  const d = dayToDate(day);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
};

const shift = ({ y, m }: Month, delta: number): Month => {
  const d = new Date(Date.UTC(y, m + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
};

const monthStart = (y: number, m: number): number => isoToDay(`${y}-${pad(m + 1)}-01`);

const monthEnd = (y: number, m: number): number =>
  monthStart(y, m) + new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - 1;

/** 两段合成从更早的开头到更晚的结尾。两次点选不保证先早后晚 */
const span = (a: DayRange, b: DayRange): DayRange => ({
  from: Math.min(a.from, b.from),
  to: Math.max(a.to, b.to),
});

/** 首尾恰好是月初、月末，就返回首尾两个月；否则 null */
export function wholeMonths(range: DayRange): { from: Month; to: Month } | null {
  const from = monthOf(range.from);
  const to = monthOf(range.to);
  return range.from === monthStart(from.y, from.m) && range.to === monthEnd(to.y, to.m)
    ? { from, to }
    : null;
}

/** 首尾恰好是 1 月 1 日、12 月 31 日，就返回首尾两年；否则 null */
export function wholeYears(range: DayRange): { from: number; to: number } | null {
  const months = wholeMonths(range);
  return months && months.from.m === 0 && months.to.m === 11
    ? { from: months.from.y, to: months.to.y }
    : null;
}
