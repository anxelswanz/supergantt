/**
 * 工作日历（DESIGN.md §1.5）。
 *
 * 「自然日」和「工作日」是两个不同的量，这个应用两个都要：
 *
 *   - **自然日**是存储与显示的口径。任务的 start/end/工期一律按自然日算，
 *     因为「这个活 8 月 3 号到 8 月 7 号」是用户脑子里的样子。
 *   - **工作日**是判断口径。「5 天的活」横跨周末实际只有 3 天工时，
 *     不把这件事显出来，排期会系统性乐观。
 *
 * 所以引擎必须知道哪天不干活，但绝不因此改变存储口径。
 *
 * 之前 isWeekend 是写死的周六周日，projects 表里的 work_days / holidays
 * 两列建好了却没有任何人读 —— 这个类就是那两列的消费方。
 */

import { dayToDate, dayToIso, isoToDay } from "../gantt/time";

/** 一周七天的中文简称，索引即 Date.getUTCDay()（0 = 周日） */
export const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export class WorkCalendar {
  /** 工作日的星期序号集合，0 = 周日 */
  readonly workDays: ReadonlySet<number>;
  /** 节假日的天序号集合 —— 即使落在工作日也不干活 */
  readonly holidays: ReadonlySet<number>;

  constructor(workDays: Iterable<number>, holidays: Iterable<number>) {
    this.workDays = new Set(workDays);
    this.holidays = new Set(holidays);
  }

  /** 默认周一到周五，无节假日。项目还没加载时用它，避免到处判空。 */
  static default(): WorkCalendar {
    return new WorkCalendar([1, 2, 3, 4, 5], []);
  }

  /**
   * 从 projects 表的两个 JSON 列构造。
   * 库里的数据可能被手工改坏，解析失败一律退回默认值 ——
   * 日历坏掉不该让整个项目打不开。
   */
  static fromProject(workDaysJson: string, holidaysJson: string): WorkCalendar {
    const workDays = parseJsonArray(workDaysJson)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

    const holidays = parseJsonArray(holidaysJson)
      .filter((v): v is string => typeof v === "string")
      .map((iso) => {
        try {
          return isoToDay(iso);
        } catch {
          return NaN;
        }
      })
      .filter(Number.isFinite);

    return new WorkCalendar(
      workDays.length > 0 ? workDays : [1, 2, 3, 4, 5],
      holidays,
    );
  }

  /** 序列化回 projects 表的两个列。节假日存 ISO 字符串，库里要能读懂。 */
  toJson(): { workDays: string; holidays: string } {
    return {
      workDays: JSON.stringify([...this.workDays].sort((a, b) => a - b)),
      holidays: JSON.stringify(
        [...this.holidays].sort((a, b) => a - b).map(dayToIso),
      ),
    };
  }

  isHoliday(day: number): boolean {
    return this.holidays.has(Math.floor(day));
  }

  /** 按星期算是否属于工作日，不看节假日 —— 用于区分「周末」和「调休日」 */
  isWeekend(day: number): boolean {
    return !this.workDays.has(dayToDate(Math.floor(day)).getUTCDay());
  }

  /** 真正干不干活：周末或节假日都算休息 */
  isWorkday(day: number): boolean {
    return !this.isWeekend(day) && !this.isHoliday(day);
  }

  isRest(day: number): boolean {
    return !this.isWorkday(day);
  }

  /**
   * 落在非工作日时吸附到之后最近的工作日。
   * 上限 400 天，防止用户把 work_days 配成空集时死循环。
   */
  snapForward(day: number): number {
    let d = Math.floor(day);
    for (let i = 0; i < 400 && this.isRest(d); i++) d += 1;
    return d;
  }

  /** 区间内（含首尾）的工作日天数。 */
  countWorkdays(startDay: number, endDay: number): number {
    let count = 0;
    for (let d = Math.floor(startDay); d <= Math.floor(endDay); d++) {
      if (this.isWorkday(d)) count++;
    }
    return count;
  }

  /** 自然日跨度（含首尾），与工作日数并列显示时用。 */
  countCalendarDays(startDay: number, endDay: number): number {
    return Math.max(1, Math.floor(endDay) - Math.floor(startDay) + 1);
  }

  withHolidayToggled(day: number): WorkCalendar {
    const next = new Set(this.holidays);
    const d = Math.floor(day);
    next.has(d) ? next.delete(d) : next.add(d);
    return new WorkCalendar(this.workDays, next);
  }

  withWorkDayToggled(weekday: number): WorkCalendar {
    const next = new Set(this.workDays);
    next.has(weekday) ? next.delete(weekday) : next.add(weekday);
    return new WorkCalendar(next, this.holidays);
  }
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
