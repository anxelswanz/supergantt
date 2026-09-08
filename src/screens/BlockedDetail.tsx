/**
 * 一条阻碍的详情：改归类、挪起始日、调天数、开关「持续中」。
 *
 * 为什么值得一个独立面板：抽屉里那一行放得下的只有「归类 + 区间 + 天数」，
 * 而真正要改的东西——受阻到底持续了几天、它还在不在继续——需要能一边看
 * 一边试。挤在 380px 的行里做，每个控件都只剩几十像素。
 *
 * 面板里有两件容易被当成同一件事的东西，所以分成两个控件写清楚：
 *
 *   · **持续中**（开关）—— 管的是「明天还要不要自动 +1」
 *   · **标记为已解决**（按钮）—— 管的是「这件事结束了」，区间收到昨天，
 *     卡片当场离开受阻列
 *
 * 合成一个开关会出事：用户关掉开关本意是「不卡了」，结果区间还盖着今天，
 * 卡片赖在受阻列里不走，他会以为按钮坏了。
 */

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { BLOCK_REASONS, type BlockedPeriod, type BlockReason } from "../core/blocked";
import { dayToIso, isoToDay, today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";

export function BlockedDetail({
  taskId,
  period,
  onClose,
}: {
  taskId: number;
  period: BlockedPeriod;
  onClose: () => void;
}) {
  const task = useAppStore((s) => s.tasks.get(taskId));
  const updateBlocked = useAppStore((s) => s.updateBlocked);
  const removeBlocked = useAppStore((s) => s.removeBlocked);
  const closeBlocker = useAppStore((s) => s.closeBlocker);

  const day = today();

  const [reason, setReason] = useState<BlockReason>(period.reason);
  const [from, setFrom] = useState(period.from);
  /** 用户填的终止日。持续中时这个值不参与显示 —— 那种情况下终点就是今天 */
  const [until, setUntil] = useState(period.to);
  const [live, setLive] = useState(period.open === true);
  const [note, setNote] = useState(period.note ?? "");

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

  if (!task) return null;

  /**
   * 终点。
   *
   * 手填的那条**夹在任务的计划结束日之内**：受阻是画在条子上的标注，
   * 飘在条子外面的一段没有视觉锚点，也说不清属于谁。要表达「已经拖过了
   * 原计划」，该做的是先把任务拖长，再来标这一段。
   *
   * 持续中的那条不受这条限制 —— 它的终点是今天，而今天是事实，不是用户
   * 填进来的数。任务的计划结束日反过来跟着它走（extendOpenBlocks 每天顺延）。
   */
  const to = live
    ? Math.max(from, day)
    : Math.min(task.endDay, Math.max(from, until));
  const days = to - from + 1;

  // 手填的终止日已经被夹在任务之内，所以这里只剩一种情况：持续中的那条
  // 已经卡过了原定的结束日。这事得当场说，而不是等用户保存完回到甘特图上
  // 才发现条子变长了
  const stretches = to > task.endDay;

  const save = () => {
    updateBlocked(taskId, {
      ...period,
      reason,
      from,
      to,
      ...(live ? { open: true } : { open: undefined }),
      ...(note.trim() ? { note: note.trim() } : { note: undefined }),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-6" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-full rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">阻碍详情</h2>
          <span className="truncate text-[11px] text-[var(--text-dim)]">
            {task.name || "未命名任务"}
          </span>
          {/* 这里原本还有一个「持续中」小徽章。删了：下面那个开关本身就是
              状态显示，而且离得只有两行 —— 同一件事在一屏里说两遍，
              用户会以为它们是两个不同的东西 */}
        </div>

        {/* 归类 */}
        <label className="mt-4 mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
          卡在什么上
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {BLOCK_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              className="rounded-lg border px-2 py-1.5 text-[11px] transition-colors"
              style={
                reason === r.key
                  ? { borderColor: "#f43f5e", color: "#f43f5e" }
                  : { borderColor: "var(--rule)", color: "var(--text-dim)" }
              }
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* 起始日 + 天数 */}
        <div className="mt-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
              从哪天起
            </label>
            <input
              type="date"
              value={dayToIso(from)}
              min={dayToIso(task.startDay)}
              onChange={(e) => {
                if (!e.target.value) return;
                // 任务开始之前谈不上「推不动」，夹回去（同 blocked.fitBlocked）
                setFrom(Math.max(task.startDay, isoToDay(e.target.value)));
              }}
              className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-[11px] text-[var(--text)]"
            />
          </div>

          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
              到哪天为止
            </label>
            <input
              type="date"
              value={dayToIso(to)}
              min={dayToIso(from)}
              max={dayToIso(task.endDay)}
              disabled={live}
              title={
                live
                  ? "持续中：终点就是今天，明天会自动变成明天"
                  : `这段受阻的最后一天，最晚到任务结束日 ${dayToIso(task.endDay)}`
              }
              onChange={(e) => {
                if (!e.target.value) return;
                // 两头都夹：倒着填收成一天，往后填不过任务结束日。
                // date 控件的 min/max 只挡得住点选，手打的日期照样进得来
                setUntil(
                  Math.min(task.endDay, Math.max(from, isoToDay(e.target.value))),
                );
              }}
              className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-[11px] text-[var(--text)] disabled:opacity-55"
            />
          </div>
        </div>

        <div className="mt-1.5 font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
          {dayToIso(from)} → {live ? `${dayToIso(to)}（今天）` : dayToIso(to)}　共 {days} 天
        </div>

        {/* 持续中开关 */}
        <button
          onClick={() => {
            // 从持续中切到已结束时，把终止日带成今天 —— 它上一秒显示的就是今天，
            // 突然跳回一个更早的旧值会让人以为自己刚才填的东西丢了
            if (live) setUntil(Math.min(task.endDay, Math.max(from, day)));
            setLive((v) => !v);
          }}
          className="mt-3 flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors"
          style={{
            borderColor: live ? "#f43f5e" : "var(--rule)",
            background: live ? "rgba(244,63,94,0.06)" : "transparent",
          }}
        >
          <span
            className="mt-0.5 grid h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors"
            style={{ background: live ? "#f43f5e" : "var(--rule)" }}
          >
            <span
              className="block size-3 rounded-full bg-white transition-transform"
              style={{ transform: live ? "translateX(12px)" : "translateX(0)" }}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium text-[var(--text)]">
              持续中
            </span>
            <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--text-dim)]">
              {live
                ? "一直卡到手动关掉为止：终止日每天自动跟到今天，并同步把任务的计划结束日往后顺延。"
                : "已经结束的一段：终点就是上面填的那天（最晚到任务结束日），不再自动延长。"}
              {period.pushed ? `　已累计顺延 ${period.pushed} 天。` : ""}
            </span>
          </span>
        </button>

        {stretches && (
          <div className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-600">
            这条阻碍已经卡过了任务原定的结束日（{dayToIso(task.endDay)}）——
            保存时会把计划结束日顺延到 {dayToIso(to)}。要停在原计划上，
            就把「持续中」关掉并填一个终止日期。
          </div>
        )}

        {/* 说明 */}
        <label className="mt-3 mb-1 block text-[10px] font-medium text-[var(--text-dim)]">
          具体是什么
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          rows={2}
          placeholder="比如：三号机主轴异响，等厂家上门"
          className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />

        <div className="mt-4 flex items-center gap-2">
          {/* 删除进撤销栈，所以不需要二次确认 —— ⌘Z 就能回来 */}
          <button
            onClick={() => {
              removeBlocked(taskId, period.id);
              onClose();
            }}
            className="rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-dim)] transition-colors hover:text-rose-500"
          >
            删除
          </button>

          {/* 「结束了」和「不再自动延长」是两件事，见文件顶部 */}
          {live && (
            <button
              onClick={() => {
                closeBlocker(taskId, period.id);
                onClose();
              }}
              title="这件事已经解决：区间收到昨天，卡片当场离开受阻列"
              className="rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-dim)] transition-colors hover:border-emerald-500 hover:text-emerald-600"
            >
              ✓ 标记为已解决
            </button>
          )}

          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            onClick={save}
            className="rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            保存
          </button>
        </div>
      </motion.div>
    </div>
  );
}
