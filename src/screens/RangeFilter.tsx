/**
 * 时间线的日期筛选：一个日历同时管「单日」和「一段日期」。
 *
 * 不分模式 —— 点一下就是只看那一天（当场生效），接着再点另一天，
 * 两次点选之间就成了一段。先选「我要单日还是区间」是在逼人回答一个
 * 他还没想好的问题：多数时候是先看了某一天，才决定往前再多看几天。
 *
 * 和 DatePicker 一样不用原生 <input type="date">（WKWebView 上是分段步进器），
 * 月历网格直接复用它的 monthGrid。
 */

import { useCallback, useState } from "react";
import { normalizeRange, type DayRange } from "../core/timeline";
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
  const d = dayToDate(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const monthStart = isoToDay(`${y}-${pad(m + 1)}-01`);
  const monthEnd = monthStart + new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - 1;
  return [
    { label: "全部", range: null },
    { label: "今天", range: { from: now, to: now } },
    { label: "近 7 天", range: { from: now - 6, to: now } },
    { label: "本月", range: { from: monthStart, to: monthEnd } },
  ];
}

interface Props {
  value: DayRange | null;
  onChange: (range: DayRange | null) => void;
  /** 有记录的那些天，日历上打个点 —— 不然只能靠猜去点 */
  marked: Set<number>;
}

export function RangeFilter({ value, onChange, marked }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // 已经点了第一天、还在等第二天
  const [pending, setPending] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState(() => monthOf(value?.to ?? today()));

  const close = useCallback(() => {
    setOpen(false);
    setPending(null);
    setHover(null);
  }, []);

  const toggle = () => {
    if (open) return close();
    setView(monthOf(value?.to ?? today()));
    setOpen(true);
  };

  const pick = (day: number) => {
    if (pending == null) {
      onChange({ from: day, to: day });
      setPending(day);
      return;
    }
    onChange(normalizeRange(pending, day));
    close();
  };

  // 等第二下的时候，鼠标滑到哪就先把那一段画出来
  const shown =
    pending != null && hover != null ? normalizeRange(pending, hover) : value;

  const now = today();
  const active = value != null;

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
          title="按日期筛选：点一天看单日，再点一天选一段"
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

      <Popover anchor={anchor} open={open} onClose={close} align="right" width={252}>
        <div className="px-2.5 pb-1.5 pt-1.5">
          <div className="mb-2 flex items-center justify-between">
            <NavButton onClick={() => setView(shift(view, -1))}>‹</NavButton>
            <span className="font-mono text-[11px] font-semibold tabular-nums text-[var(--text)]">
              {view.y} 年 {view.m + 1} 月
            </span>
            <NavButton onClick={() => setView(shift(view, 1))}>›</NavButton>
          </div>

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
                  onClick={() => pick(day)}
                  onPointerEnter={() => setHover(day)}
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

          <div className="mt-2 flex items-center justify-between border-t border-[var(--rule)] pt-2">
            <span className="text-[9px] text-[var(--text-dim)]">
              {pending != null ? "再点一天，选成一段" : "点一天看单日 · 再点一天选一段"}
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
