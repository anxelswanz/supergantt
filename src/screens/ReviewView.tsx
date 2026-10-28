/**
 * 复盘视图，只读。算术全在 core/review.ts：屏幕和导出的 Excel 必须用同一份计算。
 */

import { useEffect, useMemo, useState } from "react";
import {
  attribution,
  byUrgency,
  deviations,
  milestoneMarks,
  summarize,
  type Deviation,
} from "../core/review";
import { resolve } from "../gantt/model";
import { dayToIso, today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { api, type Person, type Risk } from "../db/api";
import { Avatar } from "./Avatar";
import { MilestoneTrack } from "./MilestoneTrack";

const RISK_LABELS = ["高", "中", "低"];
const RISK_COLORS = ["var(--danger)", "#f59e0b", "#64748b"];

/** 偏差天数：正数红、负数绿、0 显示为横线 */
function Delta({ days, suffix = "天" }: { days: number; suffix?: string }) {
  if (days === 0) return <span className="text-[var(--text-dim)]">—</span>;
  const late = days > 0;
  return (
    <span style={{ color: late ? "var(--danger)" : "#10b981" }} className="font-medium">
      {late ? "+" : ""}
      {days} {suffix}
    </span>
  );
}

export function ReviewView() {
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const project = useAppStore((s) => s.project);
  const people = useAppStore((s) => s.people);
  const openDetail = useAppStore((s) => s.openDetail);

  const [risks, setRisks] = useState<Risk[]>([]);

  useEffect(() => {
    if (!project) return;
    // 风险在独立的表里，不在内存模型中，按需拉取
    void api.loadProjectRisks(project.id).then(setRisks).catch(() => setRisks([]));
  }, [project, revision]);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  const summary = useMemo(() => summarize(tasks), [tasks]);
  const rows = useMemo(() => deviations(tasks).sort(byUrgency), [tasks]);
  const reasons = useMemo(() => attribution(tasks), [tasks]);
  const todayDay = today();
  const marks = useMemo(() => milestoneMarks(tasks, todayDay), [tasks, todayDay]);

  const openRisks = risks.filter((r) => !r.resolved);
  const maxReasonDays = Math.max(1, ...reasons.map((r) => r.days));

  if (summary.leafCount === 0) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-[var(--text-dim)]">
        还没有任务，先去甘特图里添加任务
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[900px] space-y-6 p-6">
        <div>
          <div className="text-lg font-semibold text-[var(--text)]">
            {summary.endDelta > 0
              ? `整体比计划晚 ${summary.endDelta} 天`
              : summary.endDelta < 0
                ? `整体比计划早 ${-summary.endDelta} 天`
                : summary.actual
                  ? "整体与计划持平"
                  : "还没有任何实施记录"}
          </div>
          <div className="mt-1 text-xs text-[var(--text-dim)]">
            {summary.plan && (
              <>
                计划 {dayToIso(summary.plan.startDay)} → {dayToIso(summary.plan.endDay)}
              </>
            )}
            {summary.actual && (
              <>
                ，实际 {dayToIso(summary.actual.startDay)} →{" "}
                {dayToIso(summary.actual.endDay)}
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Stat label="总进度" value={`${Math.round(summary.progress * 100)}%`} note="按工期加权" />
          <Stat
            label="超期任务"
            value={`${summary.lateCount}`}
            note={`共 ${summary.leafCount} 条`}
            alert={summary.lateCount > 0}
          />
          <Stat
            label="累计受阻"
            value={`${summary.blockedDays} 天`}
            note={reasons[0] ? `最多：${reasons[0].label}` : "没有受阻记录"}
            alert={summary.blockedDays > 0}
          />
          <Stat
            label="未开始"
            value={`${summary.untouchedCount}`}
            note={`进行中 ${summary.runningCount}，已完成 ${summary.doneCount}`}
          />
        </div>

        <Section title="时间丢在哪" hint="按原因统计，同一天有多个原因时各算一次">
          {reasons.length === 0 ? (
            <Empty>没有受阻记录。⌥ 拖甘特条，或把看板卡片拖进「受阻」来记录</Empty>
          ) : (
            <div className="space-y-2">
              {reasons.map((r) => (
                <div key={r.reason} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs text-[var(--text-dim)]">
                    {r.label}
                  </span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--surface-alt)]">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${(r.days / maxReasonDays) * 100}%`,
                        background: "var(--danger)",
                        opacity: 0.75,
                      }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs text-[var(--text)]">
                    {r.days} 天（{r.taskCount} 条）
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {marks.length > 0 && (
          <Section title="里程碑">
            <MilestoneTrack
              marks={marks}
              today={todayDay}
              people={people}
              onOpen={openDetail}
            />
          </Section>
        )}

        <Section
          title="逐条偏差"
          hint="未完成的在前，延期越多越靠前"
        >
          <table className="w-full text-xs">
            <thead className="text-[var(--text-dim)]">
              <tr className="border-b border-[var(--rule)]">
                <Th className="text-left">任务</Th>
                <Th>计划</Th>
                <Th>实际</Th>
                <Th>开工</Th>
                <Th>收尾</Th>
                <Th>受阻</Th>
                <Th>进度</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <Row key={d.task.id} d={d} people={people} onOpen={() => openDetail(d.task.id)} />
              ))}
            </tbody>
          </table>
        </Section>

        {openRisks.length > 0 && (
          <Section title="未解决的风险" hint={`共 ${openRisks.length} 条`}>
            <div className="space-y-1.5">
              {openRisks.map((r) => {
                const t = taskMap.get(r.taskId);
                return (
                  <div
                    key={r.id}
                    onClick={() => openDetail(r.taskId)}
                    className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--row-hover)]"
                  >
                    <span
                      className="mt-[3px] rounded px-1 text-[10px] font-medium text-white"
                      style={{ background: RISK_COLORS[r.level] ?? RISK_COLORS[2] }}
                    >
                      {RISK_LABELS[r.level] ?? "低"}
                    </span>
                    <span className="text-xs text-[var(--text)]">{r.content}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--text-dim)]">
                      {t?.name || "未命名"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        <div className="pb-4 text-[10px] text-[var(--text-dim)]">
          本页数字与导出的 Excel 一致。
        </div>
      </div>
    </div>
  );
}

function Row({
  d,
  people,
  onOpen,
}: {
  d: Deviation;
  people: Person[];
  onOpen: () => void;
}) {
  const person = people.find((p) => p.id === d.task.personId) ?? null;
  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-[var(--rule)] last:border-0 hover:bg-[var(--row-hover)]"
    >
      <td className="py-2">
        <div className="flex items-center gap-1.5">
          <Avatar person={person} size={14} placeholder={false} />
          <span className="text-[var(--text)]">{d.task.name || "未命名"}</span>
        </div>
      </td>
      <Td>
        {dayToIso(d.plan.startDay)} → {dayToIso(d.plan.endDay)}
      </Td>
      <Td>
        {d.actual ? `${dayToIso(d.actual.startDay)} → ${dayToIso(d.actual.endDay)}` : "未开始"}
      </Td>
      <Td>
        <Delta days={d.startDelta} />
      </Td>
      <Td>
        <Delta days={d.endDelta} />
      </Td>
      <Td>{d.blockedDays > 0 ? `${d.blockedDays} 天` : "—"}</Td>
      <Td>{Math.round(d.task.progress * 100)}%</Td>
    </tr>
  );
}

function Stat({
  label,
  value,
  note,
  alert,
}: {
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] p-3">
      <div className="text-[10px] text-[var(--text-dim)]">{label}</div>
      <div
        className="mt-0.5 text-xl font-semibold"
        style={{ color: alert ? "var(--danger)" : "var(--text)" }}
      >
        {value}
      </div>
      {note && <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">{note}</div>}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
        {hint && <span className="text-[10px] text-[var(--text-dim)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const Th = ({ children, className = "text-right" }: { children: React.ReactNode; className?: string }) => (
  <th className={`py-1.5 font-normal ${className}`}>{children}</th>
);

const Td = ({ children }: { children: React.ReactNode }) => (
  <td className="py-2 text-right whitespace-nowrap text-[var(--text-dim)]">{children}</td>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-dashed border-[var(--rule)] px-3 py-4 text-center text-xs text-[var(--text-dim)]">
    {children}
  </div>
);
