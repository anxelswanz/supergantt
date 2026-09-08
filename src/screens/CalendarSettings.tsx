import { useState } from "react";
import { WEEKDAY_NAMES, WorkCalendar } from "../core/calendar";
import { dayToDate, dayToIso } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { parseDate } from "./DatePicker";

/**
 * 工作日历配置（DESIGN.md §1.5）。
 *
 * 没有这个面板，「工作日」就只是写死的周六周日 —— 对国内项目基本没用，
 * 因为真正影响排期的是春节、国庆这种连续假期，以及调休把周末变成工作日。
 *
 * 按项目存，不是全局：不同项目可能跟不同团队/客户的作息走。
 */

/** 星期按钮的排列顺序：周一起始，符合中文日历习惯 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function CalendarPane() {
  return (
    <div>
      <h2 className="text-sm font-bold text-[var(--text)]">工作日历</h2>
      <p className="mb-4 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
        按项目存 —— 不同项目可能跟不同团队或客户的作息走。
        工期始终按<b className="text-[var(--text)]">自然日</b>存储和显示；
        这里配置的是哪些天不干活，影响时间轴底纹和工期列旁边那个工作日数。
      </p>
      <CalendarBody />
    </div>
  );
}

function CalendarBody() {
  const calendar = useAppStore((s) => s.calendar);
  const setCalendar = useAppStore((s) => s.setCalendar);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const holidays = [...calendar.holidays].sort((a, b) => a - b);

  const addHoliday = () => {
    const day = parseDate(draft);
    if (day == null) {
      setError("认不出这个日期，试试 2026-10-01 或 10-1");
      return;
    }
    setError(null);
    setDraft("");
    setCalendar(calendar.withHolidayToggled(day));
  };

  return (
    <div>
      {/* 每周工作日 */}
      <div className="mb-1.5 text-[10px] font-medium text-[var(--text-dim)]">
        每周工作日
      </div>
      <div className="mb-4 flex gap-1">
        {WEEK_ORDER.map((wd) => {
          const on = calendar.workDays.has(wd);
          return (
            <button
              key={wd}
              onClick={() => setCalendar(calendar.withWorkDayToggled(wd))}
              className={`h-8 flex-1 rounded-md text-[11px] font-medium transition-colors ${
                on
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-alt)] text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
            >
              {WEEKDAY_NAMES[wd]}
            </button>
          );
        })}
      </div>

      {/* 节假日 */}
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] font-medium text-[var(--text-dim)]">
          节假日 / 停工日
        </span>
        <span className="text-[10px] text-[var(--text-dim)] opacity-70">
          {holidays.length > 0 ? `${holidays.length} 天` : "无"}
        </span>
      </div>

      <div className="mb-2 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // 别让 Enter / ⌫ 冒泡到工作区的全局快捷键
            e.stopPropagation();
            if (e.key === "Enter") addHoliday();
          }}
          placeholder="2026-10-01"
          className="min-w-0 flex-1 rounded-md border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={addHoliday}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-transform active:scale-95"
        >
          添加
        </button>
      </div>

      {error && <div className="mb-2 text-[10px] text-rose-500">{error}</div>}

      {holidays.length > 0 && (
        <div className="max-h-[180px] overflow-y-auto rounded-md border border-[var(--rule)]">
          {holidays.map((day) => (
            <div
              key={day}
              className="group flex items-center gap-3 px-2.5 py-1.5 text-[11px] hover:bg-[var(--row-hover)]"
            >
              <span className="font-mono tabular-nums text-[var(--text)]">
                {dayToIso(day)}
              </span>
              <span className="text-[10px] text-[var(--text-dim)]">
                周{WEEKDAY_NAMES[dayToDate(day).getUTCDay()]}
              </span>
              <button
                onClick={() => setCalendar(calendar.withHolidayToggled(day))}
                className="ml-auto rounded px-1 text-[10px] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-[var(--rule)] pt-3">
        <span className="text-[10px] text-[var(--text-dim)]">
          每周 {calendar.workDays.size} 个工作日
        </span>
        <button
          onClick={() => setCalendar(WorkCalendar.default())}
          className="text-[10px] font-medium text-[var(--accent)] hover:underline"
        >
          恢复默认（周一至周五）
        </button>
      </div>
    </div>
  );
}
