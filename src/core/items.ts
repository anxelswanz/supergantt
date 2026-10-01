/**
 * 事项视图的合并层 —— 把**三个来源**摊成一张清单。
 *
 * 这是整个事项功能里唯一需要想清楚的地方，所以它是纯函数，放在 core 里，
 * 由单测钉死（core/items.test.ts），不碰 UI 也不碰数据库。
 *
 * ## 为什么是三个来源而不是一张表
 *
 *   1. `item_notes` 里**还没分拣**的行 —— 直接编辑，写回 item_notes
 *   2. `item_notes` 里**已经分拣**的行 —— 内容按实体本身渲染，标 `⤴`
 *   3. 全库的阻碍（`tasks.blocked`）与风险（`risks`）实体 —— **包括不是从
 *      事项分拣来的那些**（⌥ 拖甘特条标的阻碍、任务详情里直接建的风险）
 *
 * 第 3 点不能省。如果清单只显示「有事项来源」的实体，那么在甘特上标的阻碍
 * 就不会出现在这里，用户会得到一个「同一个东西在两个地方说法不同」的工具 ——
 * 而那正是 DESIGN.md §1.2 反复在防的「两个真相」。
 *
 * ## 已分拣的事项不显示自己那行，只显示实体行
 *
 * 两个理由：一个事项占两行，列表里全是重复；以及两行会立刻不同步 ——
 * 改实体不会改事项，于是屏幕上同时出现两种说法。同一个错误。
 *
 * ## 代价：数据分在三处
 *
 * `item_notes` / `risks` / `tasks.blocked`，本模块是三者的合并层。
 * 换来的是不碰已经跑通的导出/导入路径，也不用给已开的风险做数据搬迁。
 */

import type { ItemKind, ItemNote, Risk } from "../db/api";
import { daysOf, describeBlocked, type BlockedPeriod } from "./blocked";
import { dayToIso, isoToDay } from "../gantt/time";
import type { Priority } from "../gantt/model";

/* ------------------------------------------------------------------ */
/* 类型清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 内置类型的常量副本。
 *
 * 库里也有这两行（migrations/011 + schema::ensure_builtin_kinds），这里再写一份
 * 不是重复：**一个读不出 item_kinds 的库不该让事项视图整个白掉**。库里那份是
 * 真相（用户可以改名改色），这份只在查询失败或旧库刚导入时兜一下底。
 */
export const BUILTIN_KINDS: ItemKind[] = [
  { key: "todo", label: "代办", color: "#0ea5e9", requiresNote: false, builtin: true, sortOrder: 0 },
  { key: "issue", label: "问题", color: "#a855f7", requiresNote: true, builtin: true, sortOrder: 1 },
];

/**
 * 阻碍与风险的标签和颜色。
 *
 * 它们**不在 `item_kinds` 表里**，这是刻意的：它们是实体，不是分类。
 * 做成那张表的两行会制造出「分类名叫阻碍、但底下没有任何实体」的悬空状态，
 * 而用户点进去看到的和看板、复盘里说的就不是一回事了。
 *
 * 但清单上总得给它们一个标签和一个颜色，所以这里是**显示用的伪类型**，
 * 不参与「分拣成什么」之外的任何逻辑。颜色沿用两个面板里已经在用的那两个
 * （阻碍玫红、风险琥珀），不新引入色相。
 */
export const BLOCKER_KIND = { key: "blocker", label: "阻碍", color: "#f43f5e" } as const;
export const RISK_KIND = { key: "risk", label: "风险", color: "#f59e0b" } as const;

/** 未分拣那一行的样子。灰的 —— 它在喊「还需要你做一个决定」，不该抢颜色 */
export const UNSORTED_KIND = { key: "", label: "未分拣", color: "#94a3b8" } as const;

/**
 * 行上那个按钮的文案，和筛选器里的「未分拣」刻意用两个词。
 *
 * 筛选器问的是**状态**（「现在有哪些还没想清楚」），所以那里是「未分拣」；
 * 行上那个按钮是一个**动作**，用户点它是为了做一件事，所以是动词短语。
 * 同一个概念在「描述它」和「做它」两个位置用不同措辞是对的 ——
 * 把按钮也写成「未分拣」，读起来像在陈述现状，没人会想到它能点。
 */
export const SORT_ACTION_LABEL = "加入到事项";

/** 显示某个类型 key 用什么标签。认不出来的 key 原样显示，不吞掉 */
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
/* 引用编码                                                            */
/* ------------------------------------------------------------------ */

/**
 * 阻碍的引用：`"<taskId>/<periodId>"`。
 *
 * 两段都要。`BlockedPeriod.id` 在一个任务内唯一，但事项这边不知道它属于谁 ——
 * 而清单要显示「卡在哪条活上」，总不能为了找它去遍历全项目的每一段阻碍。
 */
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

/**
 * 清单里的一行。三种来源归一成同一个形状，渲染层只认这个。
 *
 * 原始数据（`note` / `blocker` / `risk`）也带着：行内交互要改的是实体本身，
 * 而「改哪一条」只有原始数据说得清。归一化成一个形状但不丢原件 ——
 * 列表好写，写回仍然精确。
 */
export interface ItemRow {
  /**
   * 列表 key，跨三种来源唯一。
   *
   * 带来源前缀而不是裸 id：三张表的自增 id 会撞车，React 会把一条风险的
   * DOM 复用给一条事项，表现是「改了一行，另一行的输入框跟着变」。
   */
  key: string;
  source: ItemSource;
  /** 标题。实体行按实体本身渲染（阻碍优先显示自己写的说明，不是归类标签） */
  title: string;
  /** 类型 key：业务类型 / 'blocker' / 'risk' / null = 未分拣 */
  kind: string | null;
  /**
   * P0–P3；null = 没填过。
   *
   * 历史的阻碍和风险确实没有优先级，界面显示一个空的优先级槽，不伪造一个
   * 「中」—— 和 blocked.open、tasks.autoRollover 是同一条规矩。
   */
  priority: Priority | null;
  personId: number | null;
  taskId: number | null;
  /** Unix 秒。排序用的那个时间，见 sortItems */
  createdAt: number;
  closed: boolean;
  /** 怎么关掉的。阻碍这一项可不填，风险必填 —— 既有差异的延续 */
  resolution: string | null;
  /**
   * 这条实体是从哪条事项分拣来的；null = 不是分拣来的（甘特上标的、
   * 详情里直接建的）。界面上带 `⤴` 标记，并据此提供「改回未分拣」的出路。
   */
  fromNoteId: number | null;
  /**
   * 引用指向的实体已经不存在了。
   *
   * **这是预期状态，不是损坏**：阻碍能删、风险能删（设计稿 §6.2 规则三）。
   * 此时这一行显示原始的那句话 + 「已被删除」，并给出「重新分拣 / 改回未分拣」
   * 两个出路。不给出路的话，用户唯一能做的就是把这条事项也删掉重记一遍，
   * 而它记录的原始信息（谁在什么时候说的）就此丢失。
   */
  dangling: boolean;
  note?: ItemNote;
  blocker?: { taskId: number; period: BlockedPeriod; days: number; live: boolean };
  risk?: Risk;
}

/** 合并时需要从任务上读的那几个字段 */
export interface ItemTask {
  id: number;
  name: string;
  personId: number | null;
  blocked: BlockedPeriod[];
}

const clampPriority = (v: number): Priority =>
  (v < 0 ? 0 : v > 3 ? 3 : Math.round(v)) as Priority;

/** 天序号 → Unix 秒。阻碍没有「记录时刻」，只能用它起始的那天当排序依据 */
const dayToUnix = (day: number): number => Date.parse(`${dayToIso(day)}T00:00:00Z`) / 1000;

/**
 * 三个来源合并成一张清单。**不排序** —— 排序是 sortItems 的事，
 * 分开是为了让「合并对不对」和「顺序对不对」能各自被测。
 */
export function mergeItems(input: {
  notes: ItemNote[];
  tasks: ItemTask[];
  risks: Risk[];
  today: number;
}): ItemRow[] {
  const { notes, tasks, risks, today } = input;

  // 哪些实体已经被某条事项认领了。认领者的 id 一并记下 —— 实体行要显示 ⤴
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
    // 已分拣的事项不出自己那一行：实体行会代表它（下面那两段），
    // 否则同一件事占两行，而且两行必然立刻不同步
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
        // 自己写的说明优先于归类标签 —— 类型是给机器归类的，人要看的是
        // 「三号机主轴异响」这种具体的话（同 blocked.describeBlocked）
        title: describeBlocked(period),
        kind: BLOCKER_KIND.key,
        priority: period.priority != null ? clampPriority(period.priority) : null,
        // 阻碍挂在活上，所以「谁的」就是那条活的负责人。事项分拣过来时
        // 选的也是它 —— 两处一个口径，不会出现「清单里是张三、详情里是李四」
        personId: task.personId,
        taskId: task.id,
        createdAt: dayToUnix(period.from),
        // 「持续中」才算未关闭。已经过去的那些是历史事实，不需要人再去处理
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
      // 风险表上没有负责人一列。挂着它的那条活的负责人才是要盯这件事的人
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

  /* ---- 悬挂引用：实体被单独删掉了，事项还指着它 ---- */
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

/** 同一时刻上谁在前：实体在事项之前 —— 需要人今天去处理的那些排前面 */
const SOURCE_RANK: Record<ItemSource, number> = { blocker: 0, risk: 1, note: 2 };

/**
 * 默认顺序：**未关闭在前 → 创建时间倒序 → 实体在前**。
 *
 * 「按创建时间倒序、不按类型分组」是一个有代价的选择，但它买到的东西值这个价：
 * **分拣不改变行的位置**。记完抬头一看那条还在原地，不会找不到东西 ——
 * 按类型分组的话，每点一次分拣，那一行就跳到别处去了。
 *
 * 阻碍和风险各自的既有规则（持续中在前 / 等级高在前）在**同一时刻相撞**时
 * 才生效，不覆盖时间倒序。设计稿里那句「它们是实体，排序规则属于实体」说的是
 * 这个：实体之间比的是自己的规则，但一张按时间读的清单不能被某一类实体打断 ——
 * 否则「最近记了什么」这个问题就答不了了。§5.1 的示意图也正是这个顺序。
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
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

export interface ItemFilter {
  /** 类型 key；null = 筛「未分拣」。空数组 = 不筛 */
  kinds: (string | null)[];
  /** P0–P3。空数组 = 不筛 */
  priorities: Priority[];
  /** 负责人 id；null = 筛「未指派」。空数组 = 不筛 */
  people: (number | null)[];
  onlyOpen: boolean;
  /** 搜索词，对标题做大小写无关的包含匹配 */
  query: string;
}

export const EMPTY_FILTER: ItemFilter = {
  kinds: [],
  priorities: [],
  people: [],
  onlyOpen: false,
  query: "",
};

/**
 * 可叠加的筛选。每一维空着就是不筛那一维。
 *
 * 「没填优先级」（priority 为 null）**不会**被优先级筛选器命中 ——
 * 一条没填过优先级的历史风险不属于任何一档，硬塞进某一档就是伪造。
 */
export function filterItems(rows: ItemRow[], f: ItemFilter): ItemRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.onlyOpen && r.closed) return false;
    if (f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
    if (f.priorities.length > 0 && (r.priority == null || !f.priorities.includes(r.priority)))
      return false;
    if (f.people.length > 0 && !f.people.includes(r.personId)) return false;
    if (q && !r.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

export const hasFilter = (f: ItemFilter): boolean =>
  f.kinds.length > 0 ||
  f.priorities.length > 0 ||
  f.people.length > 0 ||
  f.onlyOpen ||
  f.query.trim() !== "";

/* ------------------------------------------------------------------ */
/* 关闭规则                                                            */
/* ------------------------------------------------------------------ */

/**
 * 点那个圆圈会发生什么。按类型区分（设计稿 §5.4）：
 *
 *   · `"click"`     —— 单击即关（代办，以及 requiresNote 关着的自定义类型）
 *   · `"note"`      —— 展开输入框，写「怎么解决的」（问题、风险）
 *   · `"blocker"`   —— 「标记为已解决」：区间收到昨天，卡片当场离开受阻列
 *   · `"forbidden"` —— 未分拣。还没决定它是什么，谈不上完成
 *
 * 为什么不是一个统一的「打勾」：一个 resolved 布尔把「这条不用管了」和
 * 「我们做了什么让它不用管」压成同一个比特，而后者才是复盘时唯一值得抄的
 * 东西（migrations/008_risk_resolution.sql 已经论证过一遍）。这条理由对
 * 「问题」同样成立，所以「问题」默认开着 requiresNote。
 *
 * 为什么阻碍不强制写结论、风险强制：阻碍是**既成事实**，它的价值在于
 * 「卡了几天、卡在什么上」，那两项已经记在区间和归类里了；风险是一个
 * **判断**（「它不会发生了」），没有依据的判断三个月后没人敢信。
 * 这是既有差异的延续，不是新引入的（见 core/blocked.ts 的 resolution 注释）。
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
 * 新自定义类型的 key。
 *
 * 带 `custom:` 前缀是为了让它永远不可能撞上将来新增的内置 key ——
 * 用户建了一个叫「阻碍」的自定义类型之后，内置语义不会被它悄悄顶掉。
 * 用随机串而不是名字：类型可以改名，而 key 是 item_notes.kind 指着的东西，
 * 改名不该让已有的事项全部失去类型。
 */
export const newKindKey = (): string =>
  `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 给界面用：日期显示成 MM-DD，和清单里其余时间列一个口径 */
export function shortDate(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  return iso.slice(5);
}

/** 天序号版本，阻碍那一列用 */
export const shortDay = (day: number): string => dayToIso(day).slice(5);

/** 反向：ISO 日期串转天序号。悬挂引用重新分拣时要用 */
export { isoToDay };
