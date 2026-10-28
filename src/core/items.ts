/**
 * 事项视图的合并层（纯函数，单测见 core/items.test.ts）：item_notes 未分拣行、
 * 已分拣行指向的实体、以及全库的阻碍与风险实体，三者摊成一张清单。
 * 阻碍/风险实体必须全收（含非事项来源的），否则同一实体两处说法不同。
 */

import type { ItemKind, ItemNote, Risk } from "../db/api";
import { daysOf, describeBlocked, type BlockedPeriod } from "./blocked";
import { dayToIso, isoToDay } from "../gantt/time";
import type { Priority } from "../gantt/model";
import type { DayRange } from "./timeline";

/* ------------------------------------------------------------------ */
/* 类型清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 内置类型常量副本。库里的才是真相（可改名改色），这份只在查询失败或
 * 旧库刚导入时兜底，避免读不出 item_kinds 时事项视图整个白掉。
 */
export const BUILTIN_KINDS: ItemKind[] = [
  { key: "todo", label: "代办", color: "#4a93b4", requiresNote: false, builtin: true, sortOrder: 0 },
  { key: "issue", label: "问题", color: "#7a5f9e", requiresNote: true, builtin: true, sortOrder: 1 },
];

/**
 * 阻碍与风险的显示用伪类型：它们是实体不是分类，刻意不进 item_kinds 表，
 * 以免出现「有分类无实体」的悬空状态。颜色沿用两个面板已有的。
 */
export const BLOCKER_KIND = { key: "blocker", label: "阻碍", color: "#a83e3e" } as const;
export const RISK_KIND = { key: "risk", label: "风险", color: "#b0752a" } as const;

/** 未分拣那一行：灰的，不该抢颜色 */
export const UNSORTED_KIND = { key: "", label: "未分拣", color: "#8a9a9c" } as const;

/** 行上按钮的文案。筛选器里是「未分拣」（状态），这里是动作，刻意用两个词。 */
export const SORT_ACTION_LABEL = "加入到事项";

/** 类型 key → 标签；认不出的 key 原样返回 */
export function kindLabel(key: string | null, kinds: ItemKind[]): string {
  if (key == null) return UNSORTED_KIND.label;
  if (key === BLOCKER_KIND.key) return BLOCKER_KIND.label;
  if (key === RISK_KIND.key) return RISK_KIND.label;
  return kinds.find((k) => k.key === key)?.label ?? key;
}

export function kindColor(key: string | null, kinds: ItemKind[]): string {
  if (key == null) return UNSORTED_KIND.color;
  if (key === BLOCKER_KIND.key) return BLOCKER_KIND.color;
  if (key === RISK_KIND.key) return RISK_KIND.color;
  return kinds.find((k) => k.key === key)?.color ?? UNSORTED_KIND.color;
}

/* ------------------------------------------------------------------ */
/* 类型多起来之后                                                       */
/* ------------------------------------------------------------------ */

/** 超过这个数就上搜索框和「常用」分组（三五个类型时摆搜索框是噪音） */
export const MANY_KINDS = 8;

/**
 * 按当前项目里的使用条数取前几个当「常用」，单独成组放在完整清单之上
 * （整份菜单按频次排会天天变序，肌肉记忆建不起来）。只统计当前项目；
 * 新项目无数据时返回空数组，界面据此不显示该组。
 */
export function frequentKinds(
  kinds: ItemKind[],
  notes: ItemNote[],
  limit = 4,
): ItemKind[] {
  const used = new Map<string, number>();
  for (const n of notes) {
    // 判据同 export/itemKinds.countByKind：未分拣、已晋升的都不计
    if (n.kind == null || n.promotedKind != null) continue;
    used.set(n.kind, (used.get(n.kind) ?? 0) + 1);
  }
  if (used.size === 0) return [];

  return kinds
    .filter((k) => used.has(k.key))
    .sort(
      (a, b) =>
        (used.get(b.key) ?? 0) - (used.get(a.key) ?? 0) ||
        // 次数相同时按清单原序，不按字典序
        a.sortOrder - b.sortOrder ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

/** 按关键词筛类型，名称和 key 都参与匹配（搜 custom 可捞出全部自定义）。 */
export function searchKinds(kinds: ItemKind[], query: string): ItemKind[] {
  const q = query.trim().toLowerCase();
  if (!q) return kinds;
  return kinds.filter(
    (k) => k.label.toLowerCase().includes(q) || k.key.toLowerCase().includes(q),
  );
}

/* ------------------------------------------------------------------ */
/* 引用编码                                                            */
/* ------------------------------------------------------------------ */

/** 阻碍的引用 `"<taskId>/<periodId>"`。periodId 只在任务内唯一，故须带 taskId。 */
export const blockerRef = (taskId: number, periodId: string): string =>
  `${taskId}/${periodId}`;

export function parseBlockerRef(ref: string): { taskId: number; periodId: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const taskId = Number(ref.slice(0, slash));
  const periodId = ref.slice(slash + 1);
  if (!Number.isFinite(taskId) || !periodId) return null;
  return { taskId, periodId };
}

/** 风险的引用就是它的 id */
export const riskRef = (riskId: number): string => String(riskId);

/* ------------------------------------------------------------------ */
/* 行                                                                  */
/* ------------------------------------------------------------------ */

export type ItemSource = "note" | "blocker" | "risk";

/** 清单的一行。三种来源归一成同一形状，但保留原始数据以便精确写回。 */
export interface ItemRow {
  /** 列表 key，带来源前缀（三张表自增 id 会撞车，React 会串着复用 DOM） */
  key: string;
  source: ItemSource;
  /** 标题：阻碍优先用自己写的说明，不用归类标签 */
  title: string;
  /** 类型 key：业务类型 / 'blocker' / 'risk' / null = 未分拣 */
  kind: string | null;
  /** P0–P3；null = 没填过，界面显示空槽，不伪造「中」 */
  priority: Priority | null;
  personId: number | null;
  taskId: number | null;
  /** Unix 秒。排序用的那个时间，见 sortItems */
  createdAt: number;
  closed: boolean;
  /** 关闭原因。阻碍可不填，风险必填 */
  resolution: string | null;
  /** 来源事项 id；null = 不是分拣来的（如甘特上直接标的）。界面带 ⤴ 标记 */
  fromNoteId: number | null;
  /**
   * 指向的实体已被删除 —— 预期状态，不是损坏。显示原话 + 「已被删除」，
   * 并给出「重新分拣 / 改回未分拣」，否则原始信息只能随事项一起丢掉。
   */
  dangling: boolean;
  note?: ItemNote;
  blocker?: { taskId: number; period: BlockedPeriod; days: number; live: boolean };
  risk?: Risk;
}

/** 合并时需要从任务上读的字段 */
export interface ItemTask {
  id: number;
  name: string;
  personId: number | null;
  blocked: BlockedPeriod[];
}

const clampPriority = (v: number): Priority =>
  (v < 0 ? 0 : v > 3 ? 3 : Math.round(v)) as Priority;

/** 天序号 → Unix 秒。阻碍没有记录时刻，用起始日当排序依据 */
const dayToUnix = (day: number): number => Date.parse(`${dayToIso(day)}T00:00:00Z`) / 1000;

/** 三个来源合并成一张清单，不排序（见 sortItems），以便分别测。 */
export function mergeItems(input: {
  notes: ItemNote[];
  tasks: ItemTask[];
  risks: Risk[];
  today: number;
}): ItemRow[] {
  const { notes, tasks, risks, today } = input;

  // 已被事项认领的实体；记下认领者以便实体行显示 ⤴
  const claimedBlockers = new Map<string, ItemNote>();
  const claimedRisks = new Map<number, ItemNote>();
  for (const n of notes) {
    if (n.promotedKind === "blocker" && n.promotedRef) claimedBlockers.set(n.promotedRef, n);
    if (n.promotedKind === "risk" && n.promotedRef) {
      const id = Number(n.promotedRef);
      if (Number.isFinite(id)) claimedRisks.set(id, n);
    }
  }

  const out: ItemRow[] = [];

  /* ---- 来源 1 + 2：事项 ---- */
  for (const n of notes) {
    // 已分拣的不出自己那一行，由实体行代表；否则两行必然不同步
    if (n.promotedKind != null) continue;
    out.push(noteRow(n));
  }

  /* ---- 来源 3：阻碍实体 ---- */
  for (const task of tasks) {
    for (const period of task.blocked) {
      const ref = blockerRef(task.id, period.id);
      const owner = claimedBlockers.get(ref);
      claimedBlockers.delete(ref); // 剩下的就是悬挂引用，下面单独处理
      out.push({
        key: `blocker:${ref}`,
        source: "blocker",
        // 同 blocked.describeBlocked：自写说明优先于归类标签
        title: describeBlocked(period),
        kind: BLOCKER_KIND.key,
        priority: period.priority != null ? clampPriority(period.priority) : null,
        // 阻碍挂在活上，负责人即那条活的负责人（两处口径一致）
        personId: task.personId,
        taskId: task.id,
        createdAt: dayToUnix(period.from),
        // 只有「持续中」算未关闭
        closed: period.open !== true,
        resolution: period.resolution ?? null,
        fromNoteId: owner?.id ?? null,
        dangling: false,
        blocker: { taskId: task.id, period, days: daysOf(period, today), live: period.open === true },
      });
    }
  }

  /* ---- 来源 3：风险实体 ---- */
  for (const risk of risks) {
    const owner = claimedRisks.get(risk.id);
    claimedRisks.delete(risk.id);
    out.push({
      key: `risk:${risk.id}`,
      source: "risk",
      title: risk.content,
      kind: RISK_KIND.key,
      priority: risk.priority != null ? clampPriority(risk.priority) : null,
      // 风险表无负责人列，取所挂任务的负责人
      personId: tasks.find((t) => t.id === risk.taskId)?.personId ?? null,
      taskId: risk.taskId,
      createdAt: risk.createdAt,
      closed: risk.resolved,
      resolution: risk.resolution,
      fromNoteId: owner?.id ?? null,
      dangling: false,
      risk,
    });
  }

  /* ---- 悬挂引用：实体已被删，事项还指着它 ---- */
  for (const n of [...claimedBlockers.values(), ...claimedRisks.values()]) {
    out.push({ ...noteRow(n), dangling: true });
  }

  return out;
}

function noteRow(n: ItemNote): ItemRow {
  return {
    key: `note:${n.id}`,
    source: "note",
    title: n.name,
    kind: n.kind,
    priority: clampPriority(n.priority),
    personId: n.personId,
    taskId: n.taskId,
    createdAt: n.createdAt,
    closed: n.closedAt != null,
    resolution: n.resolution,
    fromNoteId: null,
    dangling: false,
    note: n,
  };
}

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

/** 同一时刻的先后：实体在事项之前 */
const SOURCE_RANK: Record<ItemSource, number> = { blocker: 0, risk: 1, note: 2 };

/**
 * 默认顺序：未关闭在前 → 创建时间倒序 → 实体在前。不按类型分组，
 * 这样分拣不会让行跳位置。阻碍/风险各自的规则只在同一时刻相撞时生效。
 */
export function sortItems(rows: ItemRow[]): ItemRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.closed) - Number(b.closed) ||
      b.createdAt - a.createdAt ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      // 阻碍：持续中的在前
      Number(b.blocker?.live ?? false) - Number(a.blocker?.live ?? false) ||
      // 风险：等级高在前（0 高 / 1 中 / 2 低，所以是数值升序）
      (a.risk?.level ?? 9) - (b.risk?.level ?? 9) ||
      a.key.localeCompare(b.key),
  );
}

/* ------------------------------------------------------------------ */
/* 手动顺序                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按手动顺序重排（order 为行 key 列表）。不在 order 里的排最前、保持原相对顺序，
 * 新记的因此在最上。失效 key 忽略；未关闭/已关闭的分区由视图自己做。
 */
export function applyManualOrder(rows: ItemRow[], order: string[]): ItemRow[] {
  if (order.length === 0) return rows;
  const pos = new Map(order.map((k, i) => [k, i]));
  const fresh = rows.filter((r) => !pos.has(r.key));
  const placed = rows.filter((r) => pos.has(r.key)).sort((a, b) => pos.get(a.key)! - pos.get(b.key)!);
  return [...fresh, ...placed];
}

/** 把 `from` 挪到 `to` 前/后。操作全部行而非筛出的子集，清掉筛选后不会大洗牌。 */
export function moveItem(
  keys: string[],
  from: string,
  to: string,
  place: "before" | "after",
): string[] {
  if (from === to || !keys.includes(from) || !keys.includes(to)) return keys;
  const rest = keys.filter((k) => k !== from);
  const at = rest.indexOf(to) + (place === "after" ? 1 : 0);
  return [...rest.slice(0, at), from, ...rest.slice(at)];
}

/** settings 里的 JSON → key 列表；坏数据当作没排过 */
export function parseItemOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

export interface ItemFilter {
  /** 类型 key；null = 筛「未分拣」。空数组 = 不筛 */
  kinds: (string | null)[];
  /** P0–P3。空数组 = 不筛 */
  priorities: Priority[];
  /** 负责人 id；null = 筛「未指派」。空数组 = 不筛 */
  people: (number | null)[];
  /** 关联任务 id；null = 筛「未关联任务」。空数组 = 不筛 */
  tasks: (number | null)[];
  /** 旧字段，界面上已经没有了；新的是 status */
  onlyOpen: boolean;
  /** 关闭状态："open" 只看未关闭，"closed" 只看已关闭。null / 缺省 = 不筛 */
  status?: ItemStatus | null;
  /** 搜索词，对标题和结论做大小写无关的包含匹配 */
  query: string;
  /** 记录日期区间，首尾都含；null / 缺省 = 不筛 */
  range?: DayRange | null;
}

export type ItemStatus = "open" | "closed";

export const EMPTY_FILTER: ItemFilter = {
  kinds: [],
  priorities: [],
  people: [],
  tasks: [],
  onlyOpen: false,
  status: null,
  query: "",
  range: null,
};

/** 一条事项记在哪天，日期筛选比的就是它。换算须与 shortDate 一致。 */
export const itemDay = (row: ItemRow): number =>
  isoToDay(new Date(row.createdAt * 1000).toISOString().slice(0, 10));

/** 可叠加筛选，每一维空着即不筛。priority 为 null 不会被优先级筛选命中。 */
export function filterItems(rows: ItemRow[], f: ItemFilter): ItemRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.onlyOpen && r.closed) return false;
    if (f.status === "open" && r.closed) return false;
    if (f.status === "closed" && !r.closed) return false;
    if (f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
    if (f.priorities.length > 0 && (r.priority == null || !f.priorities.includes(r.priority)))
      return false;
    if (f.people.length > 0 && !f.people.includes(r.personId)) return false;
    // 旧状态可能没有 tasks 这一维，当作不筛
    if (f.tasks?.length > 0 && !f.tasks.includes(r.taskId)) return false;
    if (f.range && (itemDay(r) < f.range.from || itemDay(r) > f.range.to)) return false;
    // 结论也搜：翻已关闭事项多半为了找当初怎么解决的
    if (q && !r.title.toLowerCase().includes(q) && !(r.resolution ?? "").toLowerCase().includes(q))
      return false;
    return true;
  });
}

export const hasFilter = (f: ItemFilter): boolean =>
  f.kinds.length > 0 ||
  f.priorities.length > 0 ||
  f.people.length > 0 ||
  (f.tasks?.length ?? 0) > 0 ||
  f.range != null ||
  f.status != null ||
  f.onlyOpen ||
  f.query.trim() !== "";

/* ------------------------------------------------------------------ */
/* 关闭规则                                                            */
/* ------------------------------------------------------------------ */

/**
 * 点圆圈的行为：click 单击即关；note 展开写「怎么解决的」；blocker 区间收到昨天、
 * 卡片离开受阻列；forbidden 未分拣。阻碍不强制结论（已记在区间与归类里），
 * 风险强制 —— 没有依据的判断三个月后没人敢信。
 */
export type ClosePolicy = "click" | "note" | "blocker" | "forbidden";

export function closePolicy(row: ItemRow, kinds: ItemKind[]): ClosePolicy {
  if (row.dangling) return "forbidden";
  if (row.source === "blocker") return "blocker";
  if (row.source === "risk") return "note";
  if (row.kind == null) return "forbidden";
  return kinds.find((k) => k.key === row.kind)?.requiresNote ? "note" : "click";
}

/* ------------------------------------------------------------------ */
/* 自定义类型的 key                                                    */
/* ------------------------------------------------------------------ */

/**
 * 新自定义类型的 key。`custom:` 前缀避免撞上将来的内置 key；
 * 用随机串而非名字，因为类型可改名而 item_notes.kind 指着 key。
 */
export const newKindKey = (): string =>
  `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 日期显示成 MM-DD，与清单其余时间列同口径 */
export function shortDate(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  return iso.slice(5);
}

/** 天序号版本，阻碍那一列用 */
export const shortDay = (day: number): string => dayToIso(day).slice(5);

/** ISO 日期串 → 天序号（悬挂引用重新分拣时用） */
export { isoToDay };
