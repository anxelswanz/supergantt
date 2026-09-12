/**
 * 受阻时段：任务区间内「这几天没能正常推进」的记录。
 *
 * 它分两种，区别只在一个 `open` 标志上，后果却完全不同：
 *
 *   · **已关闭**（默认，也是历史数据的样子）—— 一段已经过去的事实，
 *     不动任何日期、工期、进度。⌥ 在甘特条上拖出来的就是这种。
 *   · **未关闭**（`open: true`）—— 一件此刻还在卡着的事。它每天跨天时
 *     自动把 `to` 推到今天，并**同步把任务的计划结束日往后顺延同样的天数**，
 *     直到用户手动关掉它（见 extendOpenBlocks / closeOpenBlocks）。
 *
 * 后一种是产品要的行为，但要清楚它买下了什么代价：一个标注动作从此产生了
 * 排期后果，而顺延几天并没有唯一正确答案 —— 设备坏 3 天，可能只损失 1 个
 * 工作日，也可能周末加班补回来了，系统猜不了。所以这里定了三条边界：
 *
 *   1. 只有**明确标成未关闭**的那种才会推日期；⌥ 拖出来的历史标注一天也不动
 *   2. 每推一天就记在 `pushed` 里，详情面板据此显示「已自动顺延 N 天」——
 *      用户至少看得见系统替他改了什么，而不是某天发现工期莫名其妙长了
 *   3. 自动顺延**不进撤销栈**（见 store.extendOpenBlockers）。它不是用户的
 *      操作，⌘Z 撤销它没有意义 —— 下一次跨天它还会回来
 *
 * 存储上它是任务行里的一个 JSON 字段，不是独立的表。这样它自动走现有的
 * 命令栈和整项目保存，零新机制 —— 而这是必须的：它由拖拽手势创建，
 * 而条子上其他拖拽（移动/改工期/调进度）全都可以 ⌘Z，唯独这个不行会很怪。
 */

import { dayToIso, isoToDay } from "../gantt/time";

export type BlockReason =
  | "quality"
  | "equipment"
  | "material"
  | "dependency"
  | "rework"
  | "other";

export const BLOCK_REASONS: { key: BlockReason; label: string }[] = [
  { key: "quality", label: "质量问题" },
  { key: "equipment", label: "设备故障" },
  { key: "material", label: "等料" },
  { key: "dependency", label: "外部依赖" },
  { key: "rework", label: "返工" },
  { key: "other", label: "其他" },
];

const REASON_KEYS = new Set(BLOCK_REASONS.map((r) => r.key));

export const reasonLabel = (key: BlockReason): string =>
  BLOCK_REASONS.find((r) => r.key === key)?.label ?? "其他";

export interface BlockedPeriod {
  /** 本地生成的稳定标识，用于列表 key 与删除 */
  id: string;
  /** 起止天序号，含首尾 */
  from: number;
  to: number;
  /**
   * 归类。留着它是为了将来能回答「这个项目多少受阻来自等料」——
   * 纯自由文本统计不出任何东西，一百条记录会有一百种写法。
   */
  reason: BlockReason;
  /** 自由文本，说清具体是什么。有它就优先显示它 */
  note?: string;
  /**
   * 还卡着，没关。缺省（历史数据、⌥ 拖出来的标注）一律当已关闭 ——
   * 让一个新字段的默认值去改写既有项目的排期是不可接受的。
   */
  open?: boolean;
  /**
   * 这一段迄今替任务顺延了几天。只由自动延长写入，用户改不了。
   *
   * 存下来是为了**可解释**：关掉之后它仍留在那里，回答「这条活为什么比
   * 原计划长了 5 天」。不存的话，顺延过的天数会和用户自己拖出来的工期
   * 混成一个数，事后谁也说不清。
   */
  pushed?: number;
  /**
   * 这段卡住最后是怎么过去的。**可不填**，和风险那边刻意相反。
   *
   * 风险关闭时强制写处置说明：关一条风险是个**判断**（「它不会发生了」），
   * 没有依据的判断，三个月后没人敢信。阻碍是既成事实，它的价值在于
   * 「卡了几天、卡在什么上」—— 那两项已经记在区间和归类里了。这里再强制
   * 填一句，只会让人为了关掉它而敷衍一句「好了」，反过来污染复盘。
   *
   * 所以它是给愿意多写一句的人准备的：「换了二号供应商，交期提前 5 天」
   * 这种话，是下次遇到同类阻碍时唯一有用的东西。
   */
  resolution?: string;
}

/**
 * 一段受阻对外显示成什么。
 *
 * 自己写的说明优先于类型标签 —— 类型是给机器归类的，人要看的是「三号机主轴异响」
 * 这种具体的话。类型仍然以小标签的形式留在旁边，两者不互相取代。
 */
export function describeBlocked(period: BlockedPeriod): string {
  return period.note?.trim() || reasonLabel(period.reason);
}

export function newBlockId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 裁到任务区间内。
 *
 * 受阻时段是画在条子上的标注 —— 飘在条子外面的一段没有视觉锚点，也说不清属于谁。
 * 要表达「已经超出原计划」，正确的做法是先把任务拖长，再标。
 * 完全落在区间外的返回 null，调用方据此丢弃。
 */
export function clampToTask(
  period: BlockedPeriod,
  task: { startDay: number; endDay: number },
): BlockedPeriod | null {
  const from = Math.max(Math.floor(period.from), task.startDay);
  const to = Math.min(Math.floor(period.to), task.endDay);
  if (to < from) return null;
  return { ...period, from, to };
}

/**
 * 任务日期变了之后，把所有受阻时段重新裁一遍，顺手丢掉已经落空的。
 *
 * **持续中的那些不裁。** 它们是活的状态，不是历史标注：用户把实施区间往回
 * 拖一下，就静默丢掉一条正在计数的阻碍 —— 那条阻碍还在真实地卡着人，
 * 而丢失是永久的、无声的。飘出条子外最多是暂时的，下一次跨天检查会把它
 * 重新对齐（extendOpenBlocks 会顺延任务的结束日）。
 */
export function reclamp(
  periods: BlockedPeriod[],
  task: { startDay: number; endDay: number },
): BlockedPeriod[] {
  return periods.flatMap((p) => {
    if (p.open === true) return [p];
    const clamped = clampToTask(p, task);
    return clamped ? [clamped] : [];
  });
}

/**
 * 合并重叠/相邻的区间。
 *
 * 画图时只回答「这天受不受阻」这一个问题，所以多段必须先并成一层 ——
 * 两段半透明斜纹叠在一起会变成一块更深的糊斑，反而看不出边界。
 * 具体几条、分别什么原因，交给详情面板逐条列。
 */
export function mergeRanges(periods: BlockedPeriod[]): [number, number][] {
  if (periods.length === 0) return [];

  const sorted = [...periods].sort((a, b) => a.from - b.from);
  const out: [number, number][] = [[sorted[0].from, sorted[0].to]];

  for (const p of sorted.slice(1)) {
    const last = out[out.length - 1];
    // +1 是为了把「8/13–8/14」和「8/15–8/16」这种紧挨着的也并起来，
    // 中间没有正常推进的日子，画成两段会凭空多出一道断口
    if (p.from <= last[1] + 1) last[1] = Math.max(last[1], p.to);
    else out.push([p.from, p.to]);
  }
  return out;
}

/** 去重后的受阻天数。重叠的两段不能算两次。 */
export function blockedDays(periods: BlockedPeriod[]): number {
  return mergeRanges(periods).reduce((sum, [from, to]) => sum + (to - from + 1), 0);
}

/** 某一天是否落在任一受阻区间里 */
export function isBlockedOn(ranges: [number, number][], day: number): boolean {
  return ranges.some(([from, to]) => from <= day && day <= to);
}

/** 此刻还没关掉的那些段。看板、卡片标识、每日延长都问这一个问题 */
export const openBlocks = (periods: BlockedPeriod[]): BlockedPeriod[] =>
  periods.filter((p) => p.open === true);

/** 一段受阻到今天为止持续了多少天（含首尾）。daysOf 的别名，两个名字都在用 */
export const blockedSpanDays = (period: BlockedPeriod, today: number): number =>
  daysOf(period, today);

/* ------------------------------------------------------------------ */
/* 未关闭的受阻：每日延长与手动关闭                                     */
/* ------------------------------------------------------------------ */

/** extendOpenBlocks / closeBlocked 需要读写的那几个字段 */
export interface BlockedHost {
  blocked: BlockedPeriod[];
  endDay: number;
  actualEndDay: number | null;
}

/**
 * 跨天：把未关闭的受阻段推到今天，并给任务顺延同样的天数。
 *
 * 返回 null 表示这条任务没有要改的东西 —— 调用方据此不产生写入，
 * 否则每分钟一次的跨天检查会把整个项目反复写库。
 *
 * 两个容易写错的地方：
 *
 *  · **顺延取各段的最大值，不是求和。** 同一条活上同时开着两段受阻
 *    （等料 + 设备坏），它们卡的是同一批日子；加起来会让一天算两次，
 *    工期凭空翻倍。
 *  · **实施结束日跟着走，但只到盖住受阻段为止。** 还卡着就说明活没干完，
 *    实施区间不该在受阻段中间就结束；但也不该无缘无故比受阻段更长。
 */
export function extendOpenBlocks(task: BlockedHost, today: number): Partial<BlockedHost> | null {
  let push = 0;

  const blocked = task.blocked.map((p) => {
    if (p.open !== true || p.to >= today) return p;
    const delta = today - p.to;
    push = Math.max(push, delta);
    return { ...p, to: today, pushed: (p.pushed ?? 0) + delta };
  });

  if (push === 0) return null;

  const out: Partial<BlockedHost> = { blocked, endDay: task.endDay + push };
  if (task.actualEndDay != null && task.actualEndDay < today) {
    out.actualEndDay = today;
  }
  return out;
}

/**
 * 手动关掉某一段受阻。
 *
 * `to` 停在**昨天**，和「把卡片拖出受阻列」是同一套口径：点下「已解决」
 * 的那一刻起，这条活就不该再被算成今天正卡着 —— 否则卡片会赖在受阻列里
 * 直到明天，用户会以为按钮没生效再点一次。
 *
 * 今天才开、今天就关的那种（from >= today）整段丢掉：留一个 from > to 的
 * 空区间会污染后面所有按天统计的地方。
 */
export function closeBlocked(
  periods: BlockedPeriod[],
  periodId: string,
  today: number,
): BlockedPeriod[] {
  return periods.flatMap((p) => {
    if (p.id !== periodId) return [p];
    return closeOne(p, today);
  });
}

/** 把今天仍在生效的受阻段全部关掉。拖出受阻列、退回未开始、标完成都用它 */
export function closeOpenBlocks(periods: BlockedPeriod[], today: number): BlockedPeriod[] {
  return periods.flatMap((p) => {
    const live = p.open === true || (p.from <= today && today <= p.to);
    return live ? closeOne(p, today) : [p];
  });
}

/**
 * 改一条阻碍的区间（或它的「持续中」开关），并让任务给它腾出位置。
 *
 * 起始日往前越界一律夹回任务开始日：一条活还没开始就先卡住了，说不通；
 * 真要表达「开工前就在等料」，那是另一条活或者该改计划开始日。
 *
 * 结束日反过来 —— 越过任务尾部时**拉长任务**，而不是把这段裁回去。
 * 走到这一步的只有一种情况：一条持续中的阻碍已经卡过了原定的结束日
 * （手填的终止日在 UI 层就被夹在任务之内了，见 BlockedDetail）。那种情况下
 * 顺延是对的 —— 人还卡在那儿，计划日期该让位给事实。用 reclamp 裁回去的话，
 * 表现是「调了没反应」，最难查的那种 bug。
 *
 * `open` 被打开时把 `to` 顶到今天 —— 「一直持续到我手动关掉」这句话的
 * 起码含义就是「到此刻为止都还卡着」，让它停在过去某一天会自相矛盾。
 */
export function fitBlocked(
  task: { blocked: BlockedPeriod[]; startDay: number; endDay: number; actualEndDay: number | null },
  period: BlockedPeriod,
  today: number,
): { blocked: BlockedPeriod[]; endDay?: number; actualEndDay?: number } | null {
  if (!task.blocked.some((p) => p.id === period.id)) return null;

  const from = Math.max(Math.floor(period.from), task.startDay);
  let to = Math.max(from, Math.floor(period.to));
  if (period.open === true) to = Math.max(to, today);

  const fitted: BlockedPeriod = { ...period, from, to };
  const blocked = task.blocked.map((p) => (p.id === period.id ? fitted : p));

  const out: { blocked: BlockedPeriod[]; endDay?: number; actualEndDay?: number } = { blocked };
  if (to > task.endDay) out.endDay = to;
  if (task.actualEndDay != null && task.actualEndDay < to) out.actualEndDay = to;
  return out;
}

/**
 * 把全项目的阻碍摊平成一张按时间排的清单 —— 看板的「阻碍」面板用它。
 *
 * 卡片上只看得到**此刻**卡着的那几条，那是行动视角；而「上个月到底卡了
 * 多少次、都卡在什么上」要的是另一张表。已经关掉的不该从界面上消失：
 * 它是复盘时唯一能回答「时间去哪了」的记录。
 *
 * 排序：**持续中的在最上面**（它们还要人去处理），其余按起始日倒序 ——
 * 越近的越常被问到。
 */
export interface BlockerEntry {
  taskId: number;
  taskName: string;
  period: BlockedPeriod;
  /** 到今天为止的天数；持续中的每天还在长 */
  days: number;
  live: boolean;
}

export function collectBlockers(
  tasks: { id: number; name: string; blocked: BlockedPeriod[] }[],
  today: number,
): BlockerEntry[] {
  const out: BlockerEntry[] = [];
  for (const task of tasks) {
    for (const period of task.blocked) {
      out.push({
        taskId: task.id,
        taskName: task.name || "未命名",
        period,
        days: daysOf(period, today),
        live: period.open === true,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      b.period.from - a.period.from ||
      a.period.id.localeCompare(b.period.id),
  );
}

/** 一条阻碍现在有多少天（含首尾）。持续中的按「到今天为止」算 */
export const daysOf = (period: BlockedPeriod, today: number): number =>
  Math.max(1, (period.open === true ? Math.max(period.to, today) : period.to) - period.from + 1);

function closeOne(period: BlockedPeriod, today: number): BlockedPeriod[] {
  const { open: _open, ...rest } = period;
  if (period.from >= today) return [];
  return [{ ...rest, to: Math.min(period.to, today - 1) }];
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 落库用 ISO 日期串，和 start_date / end_date 同一套口径 ——
 * 天序号隐含依赖代码里的纪元常量，写进 JSON 会让这份数据只有本程序读得懂。
 */
interface StoredPeriod {
  id: string;
  from: string;
  to: string;
  reason: string;
  note?: string;
  /** 只在未关闭时写出。缺省即已关闭，历史数据因此原样保持不变 */
  open?: boolean;
  pushed?: number;
  resolution?: string;
}

export function serializeBlocked(periods: BlockedPeriod[]): string {
  const rows: StoredPeriod[] = periods.map((p) => ({
    id: p.id,
    from: dayToIso(p.from),
    to: dayToIso(p.to),
    reason: p.reason,
    ...(p.note ? { note: p.note } : {}),
    ...(p.open ? { open: true } : {}),
    ...(p.pushed ? { pushed: p.pushed } : {}),
    ...(p.resolution ? { resolution: p.resolution } : {}),
  }));
  return JSON.stringify(rows);
}

/** 库里的值可能被手工改坏，任何一条解析不了就跳过它，不让整个项目打不开 */
export function parseBlocked(raw: string): BlockedPeriod[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: BlockedPeriod[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<StoredPeriod>;
    if (typeof row.from !== "string" || typeof row.to !== "string") continue;

    let from: number;
    let to: number;
    try {
      from = isoToDay(row.from);
      to = isoToDay(row.to);
    } catch {
      continue;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;

    out.push({
      id: typeof row.id === "string" && row.id ? row.id : newBlockId(),
      from,
      to,
      reason:
        typeof row.reason === "string" && REASON_KEYS.has(row.reason as BlockReason)
          ? (row.reason as BlockReason)
          : "other",
      ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
      ...(row.open === true ? { open: true } : {}),
      ...(typeof row.pushed === "number" && row.pushed > 0
        ? { pushed: Math.floor(row.pushed) }
        : {}),
      ...(typeof row.resolution === "string" && row.resolution.trim()
        ? { resolution: row.resolution.trim() }
        : {}),
    });
  }
  return out;
}
