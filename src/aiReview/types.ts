/**
 * AI 复盘的数据形状。
 *
 * 库里那张表（migrations/013_ai_reviews.sql）有三列是 JSON 字符串，Rust 不解析 ——
 * 它们长什么样**只由这个文件说了算**。改这里的任何一个字段都要想清楚旧记录
 * 读出来会怎样：复盘是长期留存的，上个月存的那份下个月还得打得开
 * （见下面的 parseReview，读不懂的一律退回安全的空值而不是抛错）。
 */

import type { AiReviewRow } from "../db/api";

/** 阶段复盘：项目还在进行；结项复盘：项目已经结束 */
export type ReviewKind = "stage" | "final";

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  stage: "阶段复盘",
  final: "结项复盘",
};

/**
 * 开始前那张小表单。
 *
 * 它存在的原因：项目表里没有「目标」这回事，而「目标与结果」是复盘的第一章。
 * 甘特数据能告诉模型进度和偏差，但「原本想达成什么、算不算成功」它无从得知。
 * 在出题**之前**问，出的题才能围绕「目标达成了多少、差在哪」。
 */
export interface Background {
  kind: ReviewKind;
  /** 项目目标与成功标准 */
  goal: string;
  /** 实际结果 */
  outcome: string;
  /** 补充说明：想重点聊什么、有什么背景是数据里看不出来的 */
  extra: string;
}

export const EMPTY_BACKGROUND: Background = { kind: "final", goal: "", outcome: "", extra: "" };

/**
 * 走到了哪一步。**只记「下一步该做什么」，不记「有没有进程在跑」** ——
 * 理由见迁移文件里 stage 那一列的注释。
 */
export type Stage = "ask1" | "answer1" | "ask2" | "answer2" | "write" | "done";

export const STAGES: Stage[] = ["ask1", "answer1", "ask2", "answer2", "write", "done"];

/** 复盘的四个部分，也是题目的归类 */
export const TOPICS = ["目标与结果", "过程回顾", "根因分析", "经验沉淀"] as const;
export type Topic = (typeof TOPICS)[number];

export interface Answer {
  /** 选中的选项下标。单选题最多一个 */
  picked: number[];
  /** 输入框里写的。可以单独写，也可以选完再补一句 */
  text: string;
  /** 明确跳过。和「还没答」是两回事：跳过的题文档里要如实写「未回答」 */
  skipped: boolean;
}

export interface Question {
  /** 稳定标识，`r1-0` 这种形状。回答按它存，不按下标 —— 下标会随轮次变 */
  id: string;
  /** 1 = 首轮，2 = 追问 */
  round: 1 | 2;
  topic: Topic;
  title: string;
  /** 为什么问这一题：它是由哪条数据或哪句回答引出来的 */
  why: string;
  multi: boolean;
  options: string[];
  /** null = 还没答 */
  answer: Answer | null;
}

/** 首轮题数 + 追问题数 = 进度条上的那个分母 */
export const ROUND1_COUNT = 7;
export const ROUND2_COUNT = 3;
export const OPTION_COUNT = 4;

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

export interface SnapSpan {
  start: string;
  end: string;
}

export interface SnapTask {
  name: string;
  /** 顶层父任务的名字（它所在的阶段）；自己就是顶层时为 null */
  group: string | null;
  owner: string | null;
  plan: SnapSpan;
  /** null = 还没动过 */
  actual: SnapSpan | null;
  /** 正数 = 晚 */
  startDelta: number;
  endDelta: number;
  durationDelta: number;
  blockedDays: number;
  /** 0–100 */
  progress: number;
  milestone: boolean;
}

export interface SnapBlocker {
  task: string;
  /** 归类标签：等料、返工… */
  reason: string;
  note: string;
  from: string;
  to: string;
  days: number;
  /** 还卡着 */
  open: boolean;
  /** 它替任务自动顺延了几天 */
  pushed: number;
  /** "P0"–"P3"；没填过为 null */
  priority: string | null;
  resolution: string;
}

export interface SnapRisk {
  task: string;
  content: string;
  /** 高 / 中 / 低 */
  level: string;
  priority: string | null;
  resolved: boolean;
  resolution: string;
  raisedOn: string;
  resolvedOn: string | null;
}

export interface SnapItem {
  title: string;
  /** 类型标签：代办、问题、自定义类型，或「未分拣」 */
  kind: string;
  priority: string;
  owner: string | null;
  task: string | null;
  closed: boolean;
  resolution: string;
  raisedOn: string;
}

export interface SnapNote {
  day: string;
  /** null = 项目级的当天记录 */
  task: string | null;
  content: string;
}

/** 每一类各有多少条因为超量没进快照 */
export interface Omitted {
  tasks: number;
  blockers: number;
  risks: number;
  items: number;
  notes: number;
}

/**
 * 点「开始复盘」那一刻的项目数据，之后不再变。
 *
 * 全是**名字和日期字符串**，没有 id、没有天序号：它要原样送给模型，也要在
 * 半年后被重新读出来渲染数据表 —— 那时候任务可能改名了、删掉了，id 指向的
 * 东西已经不是当时那个。快照必须自己说得清自己。
 */
export interface Snapshot {
  version: 1;
  /** 拍快照的那一天，ISO */
  takenOn: string;
  projectName: string;
  summary: {
    leafCount: number;
    doneCount: number;
    runningCount: number;
    untouchedCount: number;
    lateCount: number;
    /** 0–100，按工期加权 */
    progress: number;
    plan: SnapSpan | null;
    actual: SnapSpan | null;
    /** 最晚实际结束 − 最晚计划结束 */
    endDelta: number;
    blockedDays: number;
    openRisks: number;
    closedRisks: number;
  };
  /** 受阻归因：时间丢在哪 */
  attribution: { reason: string; days: number; taskCount: number }[];
  milestones: { name: string; plan: string; actual: string | null; delta: number }[];
  tasks: SnapTask[];
  blockers: SnapBlocker[];
  risks: SnapRisk[];
  items: SnapItem[];
  notes: SnapNote[];
  omitted: Omitted;
}

export const emptySnapshot = (): Snapshot => ({
  version: 1,
  takenOn: "",
  projectName: "",
  summary: {
    leafCount: 0,
    doneCount: 0,
    runningCount: 0,
    untouchedCount: 0,
    lateCount: 0,
    progress: 0,
    plan: null,
    actual: null,
    endDelta: 0,
    blockedDays: 0,
    openRisks: 0,
    closedRisks: 0,
  },
  attribution: [],
  milestones: [],
  tasks: [],
  blockers: [],
  risks: [],
  items: [],
  notes: [],
  omitted: { tasks: 0, blockers: 0, risks: 0, items: 0, notes: 0 },
});

/* ------------------------------------------------------------------ */
/* 一份复盘                                                            */
/* ------------------------------------------------------------------ */

export interface Review {
  id: number;
  projectId: number;
  title: string;
  stage: Stage;
  background: Background;
  snapshot: Snapshot;
  questions: Question[];
  document: string;
  /** Unix 秒 */
  createdAt: number;
  updatedAt: number;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseAnswer(v: unknown): Answer | null {
  if (!isRecord(v)) return null;
  return {
    picked: Array.isArray(v.picked) ? v.picked.filter((n): n is number => Number.isInteger(n)) : [],
    text: str(v.text),
    skipped: v.skipped === true,
  };
}

export function parseQuestions(raw: string): Question[] {
  const v = parseJson(raw);
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((q, i) => ({
    id: str(q.id) || `q-${i}`,
    round: q.round === 2 ? 2 : 1,
    topic: (TOPICS as readonly string[]).includes(str(q.topic)) ? (q.topic as Topic) : "过程回顾",
    title: str(q.title),
    why: str(q.why),
    multi: q.multi === true,
    options: Array.isArray(q.options) ? q.options.map(str).filter(Boolean) : [],
    answer: parseAnswer(q.answer),
  }));
}

export function parseBackground(raw: string): Background {
  const v = parseJson(raw);
  if (!isRecord(v)) return { ...EMPTY_BACKGROUND };
  return {
    kind: v.kind === "stage" ? "stage" : "final",
    goal: str(v.goal),
    outcome: str(v.outcome),
    extra: str(v.extra),
  };
}

/**
 * 读快照。
 *
 * 只做「形状补齐」，不逐字段校验：快照是本程序自己写进去的，不是外来输入。
 * 补齐是为了将来加字段 —— 旧记录里没有的数组读出来是空数组，而不是让
 * 渲染数据表的代码在 undefined.map 上炸掉。
 */
export function parseSnapshot(raw: string): Snapshot {
  const v = parseJson(raw);
  const base = emptySnapshot();
  if (!isRecord(v)) return base;
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    ...base,
    ...(v as Partial<Snapshot>),
    summary: { ...base.summary, ...(isRecord(v.summary) ? (v.summary as Partial<Snapshot["summary"]>) : {}) },
    attribution: arr(v.attribution),
    milestones: arr(v.milestones),
    tasks: arr(v.tasks),
    blockers: arr(v.blockers),
    risks: arr(v.risks),
    items: arr(v.items),
    notes: arr(v.notes),
    omitted: { ...base.omitted, ...(isRecord(v.omitted) ? (v.omitted as Partial<Omitted>) : {}) },
  };
}

export function parseReview(row: AiReviewRow): Review {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    stage: (STAGES as string[]).includes(row.stage) ? (row.stage as Stage) : "ask1",
    background: parseBackground(row.background),
    snapshot: parseSnapshot(row.snapshot),
    questions: parseQuestions(row.questions),
    document: row.document,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 回答                                                                */
/* ------------------------------------------------------------------ */

/** 这一题算不算答过了：选了、写了，或者明确跳过 */
export function isAnswered(q: Question): boolean {
  const a = q.answer;
  return !!a && (a.skipped || a.picked.length > 0 || a.text.trim() !== "");
}

export const questionsOf = (qs: Question[], round: 1 | 2): Question[] =>
  qs.filter((q) => q.round === round);

/**
 * 一题的回答写成一句话。提示词和文档附录都用它，两边口径一致。
 * 没答和跳过都写成「未回答」—— 对读的人来说它们是一回事：这里没有信息。
 */
export function answerText(q: Question): string {
  const a = q.answer;
  if (!a || a.skipped) return "（未回答）";
  const picked = a.picked.map((i) => q.options[i]).filter(Boolean);
  const text = a.text.trim();
  if (picked.length === 0 && !text) return "（未回答）";
  return [picked.join("；"), text && (picked.length ? `补充：${text}` : text)].filter(Boolean).join("。");
}
