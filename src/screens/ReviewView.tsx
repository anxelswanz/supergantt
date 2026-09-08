/**
 * 复盘视图 —— 这个产品的高光时刻。
 *
 * 甘特图回答"活排在哪"，看板回答"现在怎么样"，这里回答**月底真正被问的那句**：
 * 计划和实际差在哪、为什么差、丢掉的天数去了哪。
 *
 * 全部只读。算术在 core/review.ts，这里只负责把它摆出来 —— 屏幕上的数字
 * 和导出的 Excel 必须来自同一份计算，否则这份东西一文不值。
 */

import { useEffect, useMemo, useState } from "react";
import {
  attribution,
  byUrgency,
  deviations,
  milestones,
  summarize,
  type Deviation,
} from "../core/review";
import { resolve } from "../gantt/model";
import { dayToIso } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { api, type Person, type Risk } from "../db/api";
import { Avatar } from "./Avatar";

const RISK_LABELS = ["高", "中", "低"];
const RISK_COLORS = ["#f43f5e", "#f59e0b", "#64748b"];

/** 偏差天数的显示：正数标红、负数标绿、0 留白 —— 一屏零散的「0 天」是噪音 */
function Delta({ days, suffix = "天" }: { days: number; suffix?: string }) {
  if (days === 0) return <span className="text-[var(--text-dim)]">—</span>;
  const late = days > 0;
  return (
    <span style={{ color: late ? "#f43f5e" : "#10b981" }} className="font-medium">
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
    // 风险不在内存模型里（它是另一张表），进这个视图时拉一次就够 ——
    // 复盘是个静态的读，不需要跟着每次编辑刷新
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
  const marks = useMemo(() => milestones(tasks), [tasks]);

  const openRisks = risks.filter((r) => !r.resolved);
  const maxReasonDays = Math.max(1, ...reasons.map((r) => r.days));

  if (summary.leafCount === 0) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-[var(--text-dim)]">
        还没有任务，复盘无从谈起
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[900px] space-y-6 p-6">
        {/* —— 一句话结论 ——
            摆在最上面的必须是"这个项目现在到底怎么样"，而不是一堆指标 */}
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
                　·　实际 {dayToIso(summary.actual.startDay)} →{" "}
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
            label="还没动过"
            value={`${summary.untouchedCount}`}
            note={`在做 ${summary.runningCount} · 完成 ${summary.doneCount}`}
          />
        </div>

        {/* —— 受阻归因 ——
            这是这个产品相对其他工具真正的差异点：别人只能说"晚了"，
            这里能说"晚在什么上" */}
        <Section title="时间丢在哪" hint="按原因合并区间统计；同一天既等料又返工时两边各算一次">
          {reasons.length === 0 ? (
            <Empty>没有受阻记录。⌥ 拖甘特条，或在看板里把卡片拖进「卡住」</Empty>
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
                        background: "#f43f5e",
                        opacity: 0.75,
                      }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs text-[var(--text)]">
                    {r.days} 天 · {r.taskCount} 条
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {marks.length > 0 && (
          <Section title="里程碑" hint="汇报现场真正被追问的就是这几个点">
            <table className="w-full text-xs">
              <thead className="text-[var(--text-dim)]">
                <tr className="border-b border-[var(--rule)]">
                  <Th className="text-left">节点</Th>
                  <Th>计划</Th>
                  <Th>实际</Th>
                  <Th>偏差</Th>
                </tr>
              </thead>
              <tbody>
                {marks.map((d) => (
                  <tr
                    key={d.task.id}
                    onClick={() => openDetail(d.task.id)}
                    className="cursor-pointer border-b border-[var(--rule)] last:border-0 hover:bg-[var(--row-hover)]"
                  >
                    <td className="py-2 text-[var(--text)]">{d.task.name || "未命名"}</td>
                    <Td>{dayToIso(d.plan.startDay)}</Td>
                    <Td>{d.actual ? dayToIso(d.actual.startDay) : "—"}</Td>
                    <Td>
                      <Delta days={d.startDelta} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <Section
          title="逐条偏差"
          hint="没做完的排前面，延得越狠越靠上 —— 从上往下讲，讲到没时间为止"
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
          这一页的每个数字都来自计划与实施两组日期的差，导出的 Excel 用的是同一份计算。
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
        {d.actual ? `${dayToIso(d.actual.startDay)} → ${dayToIso(d.actual.endDay)}` : "还没动过"}
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
        style={{ color: alert ? "#f43f5e" : "var(--text)" }}
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
