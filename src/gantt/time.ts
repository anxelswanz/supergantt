/**
 * 时间坐标：一律用「天序号」(dayIndex) 而非 Date。整数部分是从纪元起的天数，
 * 小数部分是当天内的位置。全部走 UTC，避免夏令时让像素换算偏移半天。
 */

export const MS_PER_DAY = 86_400_000;

/** 纪元 2000-01-01 (UTC)，取得够早，让实际项目的 dayIndex 为正。 */
const EPOCH_MS = Date.UTC(2000, 0, 1);

export function dateToDay(date: Date): number {
  return (date.getTime() - EPOCH_MS) / MS_PER_DAY;
}

export function dayToDate(day: number): Date {
  return new Date(EPOCH_MS + day * MS_PER_DAY);
}

/** 把 "2026-08-03" 这样的日期串转成 dayIndex（整数）。 */
export function isoToDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - EPOCH_MS) / MS_PER_DAY;
}

export function dayToIso(day: number): string {
  const d = dayToDate(Math.floor(day));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 今天（UTC 零点）的 dayIndex。 */
export function today(): number {
  const now = new Date();
  return (
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH_MS) /
    MS_PER_DAY
  );
}

/** 周六/周日返回 true。0 = 周日。 */
export function isWeekend(day: number): boolean {
  const wd = dayToDate(Math.floor(day)).getUTCDay();
  return wd === 0 || wd === 6;
}

/** 落在非工作日时，吸附到之后最近的工作日。 */
export function snapToWorkday(day: number): number {
  let d = Math.floor(day);
  while (isWeekend(d)) d += 1;
  return d;
}

/** 自然日区间换算成工作日数，用于详情面板的「自然日 7 天 / 工作日 5 天」。 */
export function workdaysBetween(startDay: number, endDay: number): number {
  let count = 0;
  for (let d = Math.floor(startDay); d <= Math.floor(endDay); d++) {
    if (!isWeekend(d)) count++;
  }
  return count;
}
