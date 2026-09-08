/**
 * 日期三值联动（DESIGN.md §1.6）。
 *
 * 开始日期、结束日期、工期三个值只有两个自由度 —— 改一个，另外两个里
 * 必然有一个跟着动。哪个跟着动取决于用户是怎么改的，这套规则如果不集中在
 * 一处定义，就会在表单、拖拽、导入三个入口各写一套，然后互相矛盾。
 */

import { isWeekend } from "../gantt/time";

export interface Span {
  startDay: number;
  endDay: number;
}

export const durationOf = (s: Span) => Math.max(1, s.endDay - s.startDay + 1);

export interface LinkOptions {
  /**
   * 落点若为非工作日，吸附到之后最近的工作日。
   * 自动重排必须开（否则任务会不断被推到周六），用户手动拖拽默认不开 ——
   * 手动操作要绝对服从用户意图，哪怕他就是想安排在周日。
   */
  snapWorkday?: boolean;
}

const snap = (day: number, opts?: LinkOptions) => {
  if (!opts?.snapWorkday) return day;
  let d = day;
  while (isWeekend(d)) d += 1;
  return d;
};

/** 整体平移：保持工期，开始和结束一起动。 */
export function moveBy(span: Span, deltaDays: number, opts?: LinkOptions): Span {
  const duration = durationOf(span);
  const startDay = snap(span.startDay + deltaDays, opts);
  return { startDay, endDay: startDay + duration - 1 };
}

/** 拖动条子左边缘：保持结束日期，工期跟着变。 */
export function resizeStart(span: Span, newStart: number): Span {
  const startDay = Math.min(newStart, span.endDay);
  return { startDay, endDay: span.endDay };
}

/** 拖动条子右边缘：保持开始日期，工期跟着变。 */
export function resizeEnd(span: Span, newEnd: number): Span {
  const endDay = Math.max(newEnd, span.startDay);
  return { startDay: span.startDay, endDay };
}

/**
 * 表单里改开始日期：**保持工期**，结束日期跟着推。
 *
 * 这是整套规则里唯一有争议的一条 —— 另一种做法是保持结束日期、压缩工期。
 * 选「保持工期」是因为它符合更常见的意图：「这个活要干 5 天，只是往后挪了」。
 */
export function setStart(span: Span, newStart: number, opts?: LinkOptions): Span {
  return moveBy(span, newStart - span.startDay, opts);
}

/** 表单里改结束日期：保持开始日期，工期跟着变。 */
export function setEnd(span: Span, newEnd: number): Span {
  return resizeEnd(span, newEnd);
}

/** 表单里改工期：保持开始日期，结束日期跟着变。 */
export function setDuration(span: Span, days: number): Span {
  const duration = Math.max(1, Math.round(days));
  return { startDay: span.startDay, endDay: span.startDay + duration - 1 };
}

/** 里程碑是零工期的一个点，起止必须相同。 */
export function asMilestone(span: Span): Span {
  return { startDay: span.startDay, endDay: span.startDay };
}
