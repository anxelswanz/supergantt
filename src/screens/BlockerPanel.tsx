/**
 * 全项目的阻碍清单 —— 包括**已经关掉的**。
 *
 * 看板卡片上只看得到此刻还卡着的那几条，那是行动视角：今天该给谁打电话。
 * 但「上个月一共卡了几次、都卡在什么上、每次多久」是另一个问题，
 * 而它的答案恰恰全在已经关掉的那些记录里 —— 那是复盘时唯一能回答
 * 「时间去哪儿了」的东西。关掉就从界面上消失，等于每个月把账本烧掉。
 *
 * 和风险清单是对称的两个面板：风险是「可能会挡路」，阻碍是「已经在挡路」。
 */

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  blockedDays,
  collectBlockers,
  describeBlocked,
  reasonLabel,
  type BlockReason,
} from "../core/blocked";
import { isInProgress } from "../core/board";
import { dayToIso, today } from "../gantt/time";
import { resolve, type ResolvedTask } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";

type Filter = "all" | "live" | "past";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "live", label: "持续中" },
  { key: "past", label: "已结束" },
];

export function BlockerPanel({
  onClose,
  onCompose,
}: {
  onClose: () => void;
  /** 新建走看板那个对话框 —— 选活、选原因、写说明，那套已经在了 */
  onCompose: () => void;
}) {
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const closeBlocker = useAppStore((s) => s.closeBlocker);
  const openDetail = useAppStore((s) => s.openDetail);

  const [filter, setFilter] = useState<Filter>("all");
  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  const all = useMemo(() => collectBlockers(tasks, day), [tasks, day]);
  const rows = useMemo(
    () =>
      filter === "all" ? all : all.filter((b) => (filter === "live" ? b.live : !b.live)),
    [all, filter],
  );

  const liveCount = all.filter((b) => b.live).length;
  // 去重后的累计天数：同一天被两条记录盖住只能算一天
  const totalDays = tasks.reduce((sum, t) => sum + blockedDays(t.blocked), 0);
  const canAdd = tasks.some((t) => !t.hasChildren && isInProgress(t, day));

  /** 按原因分组的天数 —— 「这个月的时间都卡在什么上」只有这张表答得了 */
  const byReason = useMemo(() => {
    const map = new Map<BlockReason, number>();
    for (const b of all) map.set(b.period.reason, (map.get(b.period.reason) ?? 0) + b.days);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 200, damping: 26 }}
      className="flex min-h-0 w-[380px] max-w-[45vw] shrink-0 flex-col border-l border-[var(--rule)] bg-[var(--surface)]"
    >
      {/* shrink-0：下面的列表是 flex-1（basis 0%），收缩权重为 0，
          容器一旦装不下，被压扁的会是这个头部 */}
      <div className="shrink-0 border-b border-[var(--rule)] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--text)]">阻碍清单</div>
            <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">
              全项目 · {liveCount} 条持续中 · 累计 {totalDays} 天没能推进
            </div>
          </div>
          <button
            onClick={onCompose}
            disabled={!canAdd}
            title={canAdd ? "记一条此刻还没解决的阻碍" : "现在没有进行中的任务"}
            className="shrink-0 rounded-full border border-[var(--rule)] px-2.5 py-1 text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:border-[#f43f5e] hover:text-[#f43f5e] disabled:pointer-events-none disabled:opacity-40"
          >
            ＋ 新建
          </button>
          <button
            onClick={onClose}
            title="关闭"
            className="grid size-6 shrink-0 place-items-center rounded text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-2 flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors"
              style={
                filter === f.key
                  ? { borderColor: "var(--accent)", color: "var(--accent)" }
                  : { borderColor: "var(--rule)", color: "var(--text-dim)" }
              }
            >
              {f.label}
              {f.key === "live" && liveCount > 0 ? ` ${liveCount}` : ""}
            </button>
          ))}
        </div>

        {/* 归因条：一眼看出时间主要卡在哪一类上。没有记录时不占地方 */}
        {byReason.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {byReason.map(([reason, days]) => (
              <span
                key={reason}
                className="rounded px-1.5 py-0.5 text-[9px] font-medium text-amber-600"
                style={{ background: "rgba(245,158,11,0.14)" }}
              >
                {reasonLabel(reason)} {days} 天
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 && (
          <div className="px-2 py-8 text-center text-[11px] leading-relaxed text-[var(--text-dim)]">
            {filter === "live"
              ? "现在没有卡住的活。"
              : filter === "past"
                ? "还没有已经结束的阻碍。"
                : "还没有记录任何阻碍。"}
            <br />
            记下来才能回答「这个月的时间去哪了」。
          </div>
        )}

        <div className="flex flex-col gap-1">
          {rows.map((b) => (
            <Row
              key={`${b.taskId}-${b.period.id}`}
              entry={b}
              tasks={tasks}
              onOpenTask={() => openDetail(b.taskId)}
              onClose={() => closeBlocker(b.taskId, b.period.id)}
            />
          ))}
        </div>
      </div>
    </motion.aside>
  );
}

function Row({
  entry,
  tasks,
  onOpenTask,
  onClose,
}: {
  entry: ReturnType<typeof collectBlockers>[number];
  tasks: ResolvedTask[];
  onOpenTask: () => void;
  onClose: () => void;
}) {
  const { period, days, live } = entry;
  // 任务被删掉之后这条记录还在清单里躺着的话，点开会是空的 —— 先确认它还在
  const alive = tasks.some((t) => t.id === entry.taskId);

  return (
    <div
      className={`group rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)] ${
        live ? "" : "opacity-70"
      }`}
      style={live ? { background: "rgba(244,63,94,0.06)" } : undefined}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none text-amber-600"
          style={{ background: "rgba(245,158,11,0.16)" }}
        >
          {reasonLabel(period.reason)}
        </span>
        <button
          onClick={onOpenTask}
          disabled={!alive}
          title={alive ? `${entry.taskName}　点击打开这条任务` : "任务已删除"}
          className="min-w-0 truncate text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] hover:underline disabled:no-underline disabled:hover:text-[var(--text-dim)]"
        >
          {entry.taskName}
        </button>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] tabular-nums"
          style={{ color: live ? "#f43f5e" : "var(--text-dim)" }}
        >
          {days} 天
        </span>
      </div>

      <div className="mt-0.5 text-[11px] leading-snug text-[var(--text)]">
        {describeBlocked(period)}
      </div>

      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="font-mono text-[9px] tabular-nums text-[var(--text-dim)]">
          {dayToIso(period.from)} → {live ? "至今" : dayToIso(period.to)}
        </span>
        {live && (
          <span
            className="rounded px-1 text-[9px] font-semibold leading-none text-white"
            style={{ background: "#f43f5e" }}
          >
            持续中
          </span>
        )}
        {/* 顺延过的天数关掉之后仍然留着 —— 回答「这条活为什么比原计划长」 */}
        {period.pushed ? (
          <span className="text-[9px] text-[var(--text-dim)]">
            顺延工期 {period.pushed} 天
          </span>
        ) : null}

        {live && (
          <button
            onClick={onClose}
            title="这条阻碍已解决"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-dim)] opacity-0 transition-opacity hover:text-emerald-600 group-hover:opacity-100"
          >
            ✓ 关闭
          </button>
        )}
      </div>
    </div>
  );
}
