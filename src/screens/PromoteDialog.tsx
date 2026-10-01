import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { useAppStore } from "../store/useAppStore";
import { isInProgress } from "../core/board";
import { BLOCK_REASONS, type BlockReason } from "../core/blocked";
import { RISK_COLORS, RISK_LEVELS } from "../core/risks";
import { BLOCKER_KIND, RISK_KIND } from "../core/items";
import { PRIORITY_LABELS } from "../gantt/theme";
import type { ResolvedTask } from "../gantt/model";

export type PromoteTarget = "blocker" | "risk";

/**
 * 分拣成一个真实实体。
 *
 * ## 为什么这一步要弹个窗，而不是菜单里点一下就完
 *
 * 因为它真的在创建东西，而那个东西需要两项菜单给不了的信息：
 *
 *   · **挂在哪条活上** —— 阻碍和风险都只能挂在进行中的活上。事项可以不关联
 *     任务（那是它存在的理由之一），所以分拣时必须补上
 *   · **归类 / 等级** —— 阻碍的原因是复盘视图里唯一能回答「这个月时间去哪了」
 *     的数据；风险的等级决定它在清单里排哪
 *
 * 默认值尽量填好：候选任务预选事项已经关联的那条，阻碍的说明预填事项的标题。
 * 理想情况下用户只需要确认一下。
 *
 * ## 准入检查在这一步，不在录入时
 *
 * 录入的时候连类型都还没定，没什么可检查的；分拣时必须查，因为这一步才真的
 * 创建实体（设计稿 §6.2 规则一）。候选下拉**只列进行中的活** —— 事项关联的
 * 那条不在其中时就只是不预选，不报错：那条活可能还没开工，而这条事项记的
 * 东西是真实的，不该因此被拦住。
 */
export function PromoteDialog({
  noteId,
  target,
  tasks,
  day,
  onClose,
}: {
  noteId: number;
  target: PromoteTarget;
  tasks: ResolvedTask[];
  day: number;
  onClose: () => void;
}) {
  const note = useAppStore((s) => s.itemNotes.find((n) => n.id === noteId));
  const promoteToBlocker = useAppStore((s) => s.promoteToBlocker);
  const promoteToRisk = useAppStore((s) => s.promoteToRisk);

  /** 只列进行中的叶子任务 —— 和新建阻碍、新建风险同一个判据 */
  const candidates = useMemo(
    () => tasks.filter((t) => !t.hasChildren && isInProgress(t, day)),
    [tasks, day],
  );

  // 预选事项已经关联的那条活；它不在候选里就只是不预选
  const preselected = candidates.some((t) => t.id === note?.taskId) ? note!.taskId : null;
  const [taskId, setTaskId] = useState<number | null>(preselected ?? candidates[0]?.id ?? null);
  const [reason, setReason] = useState<BlockReason>("material");
  const [level, setLevel] = useState(1);
  const [note_, setNote] = useState("");

  // 预填阻碍的说明 = 事项的标题。那句话就是「具体是什么」的最好答案
  useEffect(() => {
    if (note) setNote(note.name);
  }, [note?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!note) return null;

  const blocker = target === "blocker";
  const accent = blocker ? BLOCKER_KIND.color : RISK_KIND.color;

  const submit = () => {
    if (taskId == null) return;
    if (blocker) void promoteToBlocker(noteId, taskId, reason, note_);
    else void promoteToRisk(noteId, taskId, level);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/30" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] max-w-[92vw] rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3.5 shadow-xl"
      >
        <div className="text-xs font-semibold text-[var(--text)]">
          分拣为{blocker ? "阻碍" : "风险"}
        </div>
        <div className="mb-2.5 mt-0.5 text-[10px] leading-relaxed text-[var(--text-dim)]">
          {blocker
            ? "会在那条活上建一条持续中的阻碍：终止日每天跟到今天，并同步顺延计划结束日，直到有人手动关掉它。"
            : "会建一条风险，挂在那条活上。关闭它的时候必须写清楚是怎么处置的。"}
        </div>

        {/* 原话。分拣之后这一行不会再单独出现在清单里（实体行代表它），
            所以在这儿摆出来，让用户确认自己正在给哪句话分类 */}
        <div className="mb-2.5 rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5">
          <div className="text-[11px] leading-snug text-[var(--text)]">{note.name}</div>
          <div className="mt-0.5 text-[9px] text-[var(--text-dim)]">
            {PRIORITY_LABELS[note.priority] ?? "P2 中"} ·
            优先级会跟着带到{blocker ? "这条阻碍" : "这条风险"}上
          </div>
        </div>

        {candidates.length === 0 ? (
          <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
            现在没有进行中的任务，分拣不了。
            <br />
            {blocker ? "阻碍" : "风险"}
            要挂在正在做的那条活上，否则没人知道该由谁去处理 ——
            这条事项先留在清单里，等那条活开工再来分拣。
          </div>
        ) : (
          <>
            <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
              挂在哪条活上
            </label>
            <select
              value={taskId ?? ""}
              onChange={(e) => setTaskId(Number(e.target.value))}
              className="mb-2.5 w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--text)]"
            >
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.id} {t.name || "未命名"}
                </option>
              ))}
            </select>
            {preselected == null && note.taskId != null && (
              <div className="mb-2.5 -mt-1.5 text-[9px] leading-snug text-[var(--text-dim)]">
                这条事项原来关联的那条活还没开工，所以没有预选它。
              </div>
            )}

            {blocker ? (
              <>
                <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
                  卡在什么上
                </label>
                <div className="mb-2.5 grid grid-cols-3 gap-1.5">
                  {BLOCK_REASONS.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setReason(r.key)}
                      className="rounded-lg border px-2 py-1.5 text-[11px] transition-colors"
                      style={
                        reason === r.key
                          ? { borderColor: accent, color: accent }
                          : { borderColor: "var(--rule)", color: "var(--text-dim)" }
                      }
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
                  具体是什么
                </label>
                <textarea
                  value={note_}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  rows={2}
                  placeholder="比如：三号机主轴异响，等厂家上门"
                  className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </>
            ) : (
              <>
                <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
                  多严重
                </label>
                <div className="mb-1 flex overflow-hidden rounded-lg border border-[var(--rule)]">
                  {RISK_LEVELS.map((label, i) => (
                    <button
                      key={label}
                      onClick={() => setLevel(i)}
                      className="flex-1 px-2 py-1.5 text-[11px] font-medium transition-colors"
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
                <div className="text-[9px] leading-snug text-[var(--text-dim)]">
                  等级是「多严重」，优先级是「先做哪个」—— 两个轴，互不替代。
                </div>
              </>
            )}
          </>
        )}

        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-3 py-1 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={taskId == null}
            className="rounded-lg px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            style={{ background: accent }}
          >
            分拣
          </button>
        </div>
      </motion.div>
    </div>
  );
}
