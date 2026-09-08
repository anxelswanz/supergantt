import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { dayToDate, dayToIso, isoToDay, isWeekend, today } from "../gantt/time";

/**
 * 日期单元格编辑器：输入框 + 日历浮层。
 *
 * 两种输入方式并存是刻意的 —— 键盘流是这个应用的一等公民（DESIGN.md §5），
 * 从 Excel 粘一列日期进来、或者直接敲 `8-20`，都不该被迫去点日历。
 * 日历负责「我不确定 20 号是周几」这类场景。
 *
 * 没有用原生 <input type="date">：macOS 的 WKWebView 把它渲染成分段步进器
 * 而不是日历弹层，且完全无法配合周末底纹、今天标记这些语义着色。
 */

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

interface Props {
  /** 当前值（天序号） */
  value: number;
  /** 早于它的日期会被标灰，用于「结束日期不能早于开始日期」这类约束提示 */
  minDay?: number;
  onCommit: (day: number) => void;
  onCancel: () => void;
}

export function DatePicker({ value, minDay, onCommit, onCancel }: Props) {
  const [text, setText] = useState(dayToIso(value));
  const [cursor, setCursor] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [placeAbove, setPlaceAbove] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 靠近窗口底部时向上弹，否则日历会被截掉
  useLayoutEffect(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setPlaceAbove(rect.bottom + 300 > window.innerHeight);
  }, []);

  // 点到浮层外面就当作放弃
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onCancel();
    };
    // 延后一帧注册，否则触发打开的这一次点击会立刻把自己关掉
    const id = setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onCancel]);

  const commitText = () => {
    const parsed = parseDate(text);
    if (parsed == null) onCancel();
    else onCommit(parsed);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // 别让 Enter / ⌫ 被工作区的全局快捷键接走
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        commitText();
        return;
      case "Escape":
        e.preventDefault();
        onCancel();
        return;
      // 方向键在日历上走格子，走到哪输入框就同步显示到哪
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const step =
          e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : 7;
        const next = cursor + step;
        setCursor(next);
        setText(dayToIso(next));
        return;
      }
    }
  };

  const monthDate = dayToDate(cursor);
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();

  const shiftMonth = (delta: number) => {
    const d = dayToDate(cursor);
    const target = new Date(Date.UTC(year, month + delta, 1));
    // 保留「几号」，但月份天数不够时收敛到月末（1/31 → 2/28）
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(d.getUTCDate(), lastDay);
    const next = isoToDay(
      `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(day)}`,
    );
    setCursor(next);
    setText(dayToIso(next));
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseDate(e.target.value);
          if (parsed != null) setCursor(parsed);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded border border-[var(--accent)] bg-[var(--surface)] px-1 py-0.5 font-mono text-[11px] outline-none"
      />

      <motion.div
        initial={{ opacity: 0, y: placeAbove ? 4 : -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="absolute z-50 w-[232px] rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-2.5 shadow-xl"
        style={placeAbove ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <NavButton onClick={() => shiftMonth(-1)}>‹</NavButton>
          <span className="font-mono text-[11px] font-semibold tabular-nums text-[var(--text)]">
            {year} 年 {month + 1} 月
          </span>
          <NavButton onClick={() => shiftMonth(1)}>›</NavButton>
        </div>

        <div className="mb-1 grid grid-cols-7 gap-0.5">
          {WEEKDAY_LABELS.map((label, i) => (
            <div
              key={label}
              className={`grid h-5 place-items-center text-[10px] font-medium ${
                i >= 5 ? "text-[var(--text-dim)] opacity-60" : "text-[var(--text-dim)]"
              }`}
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {monthGrid(year, month).map((day) => (
            <DayCell
              key={day}
              day={day}
              inMonth={dayToDate(day).getUTCMonth() === month}
              selected={day === cursor}
              isToday={day === today()}
              disabled={minDay != null && day < minDay}
              onPick={() => onCommit(day)}
            />
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-[var(--rule)] pt-2">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommit(today())}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)] hover:bg-[var(--row-hover)]"
          >
            今天
          </button>
          <span className="text-[9px] text-[var(--text-dim)]">
            ↑↓←→ 选日 · Enter 确认
          </span>
        </div>
      </motion.div>
    </div>
  );
}

function DayCell({
  day,
  inMonth,
  selected,
  isToday,
  disabled,
  onPick,
}: {
  day: number;
  inMonth: boolean;
  selected: boolean;
  isToday: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const weekend = isWeekend(day);
  return (
    <button
      // 阻止默认行为，否则输入框失焦会先触发 onCancel，点击就落空了
      onMouseDown={(e) => e.preventDefault()}
      onClick={disabled ? undefined : onPick}
      disabled={disabled}
      className={`grid h-6 place-items-center rounded-md font-mono text-[11px] tabular-nums transition-colors ${
        selected
          ? "bg-[var(--accent)] font-semibold text-white"
          : disabled
            ? "cursor-not-allowed text-[var(--text-dim)] opacity-25"
            : weekend
              ? "text-[var(--text-dim)] hover:bg-[var(--row-hover)]"
              : "text-[var(--text)] hover:bg-[var(--row-hover)]"
      } ${inMonth ? "" : "opacity-35"}`}
      style={
        // 今天用一圈描边而不是填充，免得和「选中」抢视觉
        isToday && !selected
          ? { boxShadow: "inset 0 0 0 1.5px var(--today, #f43f5e)" }
          : undefined
      }
    >
      {dayToDate(day).getUTCDate()}
    </button>
  );
}

function NavButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}

/** 覆盖整个月的 6×7 网格，周一起始，前后补齐相邻月份。 */
function monthGrid(year: number, month: number): number[] {
  const first = isoToDay(`${year}-${pad(month + 1)}-01`);
  // getUTCDay 里 0 是周日；这里周一为一周之首，所以要把周日折算成 6
  const offset = (dayToDate(first).getUTCDay() + 6) % 7;
  const start = first - offset;
  return Array.from({ length: 42 }, (_, i) => start + i);
}

/** 接受 2026-08-03 / 2026/8/3 / 8-3（补当年）/ 20260803 四种写法。 */
export function parseDate(raw: string): number | null {
  const text = raw.trim().replace(/[/.]/g, "-");
  if (!text) return null;

  if (/^\d{8}$/.test(text)) {
    return safeIso(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`);
  }

  const parts = text.split("-").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;

  if (parts.length === 3) return safeIso(`${parts[0]}-${pad(parts[1])}-${pad(parts[2])}`);
  if (parts.length === 2) {
    return safeIso(`${new Date().getFullYear()}-${pad(parts[0])}-${pad(parts[1])}`);
  }
  return null;
}

/** 挡掉 2026-13-45 这种越界写法 —— Date.UTC 会默默进位，不能直接信它。 */
function safeIso(iso: string): number | null {
  const [, m, d] = iso.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const day = isoToDay(iso);
  const back = dayToDate(day);
  return back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? day : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
