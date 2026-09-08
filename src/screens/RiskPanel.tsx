/**
 * 全局风险清单。
 *
 * 风险有两个录入口：任务详情里的那一段（写的时候你正看着这条活），和这里
 * （周会上过一遍全项目）。两个入口写进同一张表、读同一份 store.projectRisks，
 * 所以不存在「详情里关了、清单里还挂着」这种两份真相。
 *
 * 默认顺序：**未关闭在前 → 等级高在前 → 记得早的在前**（core/risks.sortRisks）。
 * 已关闭的沉底而不是隐藏 —— 「这个坑我们踩过并且填了」本身是信息。
 */

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { isInProgress } from "../core/board";
import { RISK_COLORS, RISK_LEVELS, sortRisks } from "../core/risks";
import { RiskRow } from "./RiskRow";
import { resolve, type ResolvedTask } from "../gantt/model";
import { today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";

export function RiskPanel({ onClose }: { onClose: () => void }) {
  const risks = useAppStore((s) => s.projectRisks);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const addRisk = useAppStore((s) => s.addRisk);
  const openDetail = useAppStore((s) => s.openDetail);

  const [onlyOpen, setOnlyOpen] = useState(false);

  const day = today();

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  /** 能挂风险的活：进行中的叶子任务。父任务的进度是汇总值，风险落不到它头上 */
  const candidates = useMemo(
    () => tasks.filter((t) => !t.hasChildren && isInProgress(t, day)),
    [tasks, day],
  );

  const nameOf = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return (id: number): string => byId.get(id)?.name || "未命名";
  }, [tasks]);

  const rows = useMemo(() => {
    const sorted = sortRisks(risks);
    return onlyOpen ? sorted.filter((r) => !r.resolved) : sorted;
  }, [risks, onlyOpen]);

  const open = risks.filter((r) => !r.resolved).length;

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 200, damping: 26 }}
      // max-w 是给窄窗口和「详情抽屉同时开着」准备的：两个 380px 的抽屉
      // 并排时，硬占宽度会把其中一个推出可视区，看上去就是「显示不全」
      className="flex min-h-0 w-[380px] max-w-[45vw] shrink-0 flex-col border-l border-[var(--rule)] bg-[var(--surface)]"
    >
      {/*
        shrink-0 是必须的，不是保险。列表用的是 flex-1（basis 0%），
        收缩权重 = shrink × basis = 0 —— 也就是说容器装不下时，被压扁的
        永远是这个头部和下面的新建区，而不是那个本该滚动的列表。
        表现出来就是：标题挤成一团、输入框被裁掉一半。
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--rule)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--text)]">风险清单</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">
            全项目 · 高风险在前 · {open} 条未关闭
          </div>
        </div>
        <button
          onClick={() => setOnlyOpen((v) => !v)}
          className="shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors"
          style={
            onlyOpen
              ? { borderColor: "var(--accent)", color: "var(--accent)" }
              : { borderColor: "var(--rule)", color: "var(--text-dim)" }
          }
        >
          只看未关闭
        </button>
        <button
          onClick={onClose}
          title="关闭"
          className="grid size-6 shrink-0 place-items-center rounded text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      <Composer candidates={candidates} onAdd={addRisk} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 && (
          <div className="px-2 py-8 text-center text-[11px] leading-relaxed text-[var(--text-dim)]">
            {onlyOpen ? "没有未关闭的风险。" : "还没有记录风险。"}
            <br />
            想到什么先写下来，别指望记得住。
          </div>
        )}

        <div className="flex flex-col gap-1">
          {rows.map((risk) => (
            <RiskRow
              key={risk.id}
              risk={risk}
              taskName={nameOf(risk.taskId)}
              onOpenTask={() => openDetail(risk.taskId)}
            />
          ))}
        </div>
      </div>
    </motion.aside>
  );
}

/**
 * 新建。
 *
 * 任务下拉里**只有进行中的活**（含被卡住的）—— 这是产品定的规矩，理由在
 * core/board.isInProgress。一个活都没在做的时候直接说清楚为什么不能记，
 * 比给一个点开是空的下拉框强。
 */
function Composer({
  candidates,
  onAdd,
}: {
  candidates: ResolvedTask[];
  onAdd: (taskId: number, content: string, level: number) => Promise<void>;
}) {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [level, setLevel] = useState(1);
  const [text, setText] = useState("");

  const target = taskId ?? candidates[0]?.id ?? null;
  const disabled = target == null || !text.trim();

  const submit = () => {
    if (target == null || !text.trim()) return;
    void onAdd(target, text, level);
    setText("");
  };

  if (candidates.length === 0) {
    return (
      <div className="shrink-0 border-b border-[var(--rule)] px-4 py-3 text-[10px] leading-relaxed text-[var(--text-dim)]">
        现在没有进行中的任务，记不了新风险。
        <br />
        风险要挂在正在做的那条活上，否则没人知道该由谁盯着。
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-[var(--rule)] px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <select
          value={target ?? ""}
          onChange={(e) => setTaskId(Number(e.target.value))}
          className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text)]"
        >
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "未命名"}
            </option>
          ))}
        </select>

        <div className="flex shrink-0 overflow-hidden rounded-md border border-[var(--rule)]">
          {RISK_LEVELS.map((label, i) => (
            <button
              key={label}
              onClick={() => setLevel(i)}
              title={`${label}风险`}
              className="px-1.5 py-1 text-[10px] font-medium transition-colors"
              style={
                level === i
                  ? { background: RISK_COLORS[i], color: "#fff" }
                  : { color: "var(--text-dim)" }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘↵ 提交，裸 ↵ 留给换行 —— 一条风险说清楚常常要一整句话
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={2}
        placeholder="这条活可能出什么问题？（⌘↵ 保存）"
        className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />

      <div className="mt-1.5 flex justify-end">
        <button
          onClick={submit}
          disabled={disabled}
          className="rounded-lg px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          记下来
        </button>
      </div>
    </div>
  );
}
