/**
 * 一条风险，和关掉它的那套流程。
 *
 * 两个地方在用（任务详情、全局风险清单），所以抽在这里 —— 关闭风险不再是
 * 点个勾那么简单，同一套流程复制两份，迟早会有一份忘了改。
 *
 * **关闭必须留下处置说明。** 原来这里是个 checkbox，点一下就算关了。
 * 那样记下来的东西没有价值：三个月后回看，只知道「这条风险关了」，
 * 不知道是换了供应商、改了工序绕过去，还是干脆接受了延期 —— 而后者才是
 * 下次遇到同类风险时唯一值得抄的东西。勾选记录的是「有人点过」，
 * 一句话记录的是「我们做了什么」。
 *
 * 关闭时间也一并记下。它不能靠 updated_at 猜：改一次措辞就会刷新 updated_at，
 * 而「什么时候不再是风险的」是个会被写进汇报的事实。
 */

import { useState } from "react";
import { motion } from "motion/react";
import { RISK_COLORS, RISK_LEVELS } from "../core/risks";
import { withAlpha } from "../gantt/coloring";
import { useAppStore } from "../store/useAppStore";
import type { Risk } from "../db/api";

export function RiskRow({
  risk,
  taskName,
  onOpenTask,
}: {
  risk: Risk;
  /** 全局清单里要显示风险挂在哪条活上；任务详情里已经知道了，不传 */
  taskName?: string;
  onOpenTask?: () => void;
}) {
  const resolveRisk = useAppStore((s) => s.resolveRisk);
  const reopenRisk = useAppStore((s) => s.reopenRisk);
  const removeRisk = useAppStore((s) => s.removeRisk);

  const [closing, setClosing] = useState(false);
  const [how, setHow] = useState("");
  const [confirming, setConfirming] = useState(false);

  const submit = () => {
    if (!how.trim()) return;
    void resolveRisk(risk.id, how);
    setHow("");
    setClosing(false);
  };

  return (
    <div
      className={`group rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)] ${
        risk.resolved ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        {/*
          未关闭时这个圆圈**不直接关掉风险**，只是展开下面那个输入框。
          它长得像 checkbox，但点下去的后果不是「打勾」而是「开始写处置说明」——
          这一步的摩擦是故意的，它正是这次改动的全部意义。
        */}
        <button
          onClick={() => {
            if (risk.resolved) return void reopenRisk(risk.id);
            setClosing((v) => !v);
          }}
          title={risk.resolved ? "重新打开（会清掉关闭时间和处置说明）" : "关闭这条风险，需要写清怎么解决的"}
          className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border text-[8px] leading-none transition-colors"
          style={{
            borderColor: risk.resolved ? "var(--text-dim)" : RISK_COLORS[risk.level],
            background: risk.resolved ? "var(--text-dim)" : "transparent",
            color: "#fff",
          }}
        >
          {risk.resolved ? "✓" : ""}
        </button>

        <div className="min-w-0 flex-1">
          {taskName != null && (
            <div className="flex items-baseline gap-1.5">
              <span
                className="shrink-0 rounded px-1 text-[9px] font-semibold leading-none"
                style={{
                  background: withAlpha(RISK_COLORS[risk.level], 0.16),
                  color: RISK_COLORS[risk.level],
                }}
              >
                {RISK_LEVELS[risk.level]}
              </span>
              <button
                onClick={onOpenTask}
                title={`${taskName}　点击打开这条任务`}
                className="min-w-0 truncate text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] hover:underline"
              >
                {taskName}
              </button>
            </div>
          )}

          {/* pre-wrap 保住录入时敲的换行；anywhere 兜住没有空格的超长串（URL、报错栈） */}
          <div
            className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] leading-relaxed text-[var(--text)] ${
              risk.resolved ? "line-through" : ""
            } ${taskName != null ? "mt-0.5" : ""}`}
          >
            {risk.content}
          </div>

          {taskName == null && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-[var(--text-dim)]">
              <span
                className="rounded px-1 font-medium"
                style={{
                  background: withAlpha(RISK_COLORS[risk.level], 0.16),
                  color: RISK_COLORS[risk.level],
                }}
              >
                {RISK_LEVELS[risk.level]}
              </span>
              {formatTime(risk.createdAt)}
            </div>
          )}

          {risk.resolved && <Resolution risk={risk} />}
        </div>

        <button
          onClick={() => {
            if (!confirming) return setConfirming(true);
            void removeRisk(risk.id);
          }}
          onBlur={() => setConfirming(false)}
          // 附注不进撤销栈，所以删除靠二次确认兜底，而不是靠 ⌘Z
          className={`shrink-0 rounded px-1 text-[9px] transition-opacity ${
            confirming
              ? "bg-rose-500 text-white opacity-100"
              : "text-[var(--text-dim)] opacity-0 hover:text-rose-500 group-hover:opacity-100"
          }`}
        >
          {confirming ? "确认" : "删除"}
        </button>
      </div>

      {closing && !risk.resolved && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="mt-1.5 overflow-hidden pl-[22px]"
        >
          <textarea
            autoFocus
            value={how}
            onChange={(e) => setHow(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setClosing(false);
                setHow("");
              }
              // ⌘↵ 提交，裸 ↵ 留给换行 —— 处置说明常常要写两句
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={2}
            placeholder="怎么解决的？（比如：改用二号供应商，交期提前 5 天）"
            className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[9px] text-[var(--text-dim)]">⌘↵ 关闭 · Esc 取消</span>
            <button
              onClick={() => {
                setClosing(false);
                setHow("");
              }}
              className="ml-auto rounded px-2 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={!how.trim()}
              title={how.trim() ? "关闭这条风险" : "写清楚怎么解决的才能关闭"}
              className="rounded-lg px-2.5 py-0.5 text-[10px] font-medium text-white disabled:opacity-40"
              style={{ background: "#10b981" }}
            >
              确认关闭
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

/** 已关闭的风险：什么时候关的、怎么关的 */
function Resolution({ risk }: { risk: Risk }) {
  return (
    <div className="mt-1 rounded-md border-l-2 border-emerald-500/50 bg-emerald-500/5 py-0.5 pl-2 text-[10px] leading-relaxed">
      <span className="font-medium text-emerald-600">
        {risk.resolvedAt != null ? `${formatTime(risk.resolvedAt)} 关闭` : "已关闭"}
      </span>
      {/* 这一列是后加的（migrations/008），之前关掉的风险确实没有说明 ——
          编一句放进去等于伪造记录，所以照实说它没有 */}
      <span className="ml-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-dim)]">
        {risk.resolution ?? "（早期记录，未留处置说明）"}
      </span>
    </div>
  );
}

function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
