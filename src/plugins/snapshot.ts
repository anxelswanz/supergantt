/**
 * 项目快照的形状：宿主把项目此刻的样子拼成能原样交给模型的数据
 * （src/core/projectSnapshot.ts 生成，插件经 api.data.projectSnapshot() 拿到）。
 *
 * 全是名字和日期字符串，没有 id：半年后读出来时任务可能已改名或删除，
 * 快照必须自己说得清自己。插件仓库的 sdk/ 里有这份的副本。
 */

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
 * 全是名字和日期字符串，没有 id：半年后读出来时任务可能已改名或删除，
 * 快照必须自己说得清自己。
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


/** 「因为太多没全带上」的一句话说明；什么都没省就是 null */
export function omittedNote(s: Snapshot): string | null {
  const parts = [
    s.omitted.tasks > 0 && `任务 ${s.omitted.tasks} 条`,
    s.omitted.blockers > 0 && `阻碍 ${s.omitted.blockers} 段`,
    s.omitted.risks > 0 && `风险 ${s.omitted.risks} 条`,
    s.omitted.items > 0 && `事项 ${s.omitted.items} 条`,
    s.omitted.notes > 0 && `逐日记录 ${s.omitted.notes} 条`,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : null;
}
