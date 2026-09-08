/**
 * 时间坐标系。
 *
 * 甘特图内部一律用「天序号」(dayIndex) 表示时间，而不是 Date 对象：
 *   - 整数部分 = 从纪元起的第几天
 *   - 小数部分 = 当天内的位置（缩放/平移时是连续量，必须允许浮点）
 *
 * 全部走 UTC，避免夏令时导致「某天只有 23 小时」而让像素换算出现半天偏移。
 */

export const MS_PER_DAY = 86_400_000;

/** 纪元：2000-01-01 (UTC)。取足够早的日期，让所有实际项目的 dayIndex 为正。 */
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

/** 落在非工作日时，吸附到之后最近的工作日（DESIGN.md §1.5）。 */
export function snapToWorkday(day: number): number {
  let d = Math.floor(day);
  while (isWeekend(d)) d += 1;
  return d;
}

/** 自然日工期换算出的工作日数，用于详情面板的「自然日 7 天 / 工作日 5 天」。 */
export function workdaysBetween(startDay: number, endDay: number): number {
  let count = 0;
  for (let d = Math.floor(startDay); d <= Math.floor(endDay); d++) {
    if (!isWeekend(d)) count++;
  }
  return count;
}
