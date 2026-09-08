/**
 * 导出按钮：一个带完成态的小状态机。
 *
 * 两处在用 —— 工具条上的「导出 Excel」和时间线里的「导出 HTML」。抽出来是因为
 * 难的部分不是那个 `<button>`，是它周围的规矩：
 *
 *  · **导出前先 flush**。落库是防抖的（persistence.ts），刚拖完的那一下可能还没
 *    写进库；导出读的是内存里的任务表，但风险点和逐日记录是直接从库里查的，
 *    两边口径不一致会导出一份自相矛盾的文件。
 *  · **取消不是失败**。用户在保存对话框里点取消要安静地回到 idle，
 *    弹一个「导出失败」是在骂用户。
 *  · **导出完给个去处**。成功态本身就是「在访达中显示」的按钮，
 *    否则用户还得自己翻目录找那个文件。
 *
 * 生成器用 `() => import(...)` 传进来：exceljs 有 900KB，而导出是低频动作，
 * 挂在主包里等于让每一次冷启动都为一个多数会话根本不会点的按钮买单。
 */

import { useState } from "react";
import { api } from "../db/api";
import { useAppStore } from "../store/useAppStore";

interface Props {
  label: string;
  title: string;
  /** 真正干活的那一步；path 为 null 表示用户取消了保存对话框 */
  run: () => Promise<{ path: string | null }>;
  /** 时间线里那颗按钮跟「记一笔」并排，需要小一号 */
  size?: "md" | "sm";
}

export function ExportButton({ label, title, run, size = "md" }: Props) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [detail, setDetail] = useState("");

  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1 text-xs";

  const go = async () => {
    if (state === "working") return;
    setState("working");
    try {
      await useAppStore.getState().persistence?.flush();
      const { path } = await run();
      if (!path) return setState("idle");
      setDetail(path);
      setState("done");
      setTimeout(() => setState("idle"), 6000);
    } catch (err) {
      setDetail(String(err));
      setState("error");
      setTimeout(() => setState("idle"), 8000);
    }
  };

  if (state === "done") {
    return (
      <button
        onClick={() => void api.revealPath(detail).catch(() => {})}
        title={`${detail}\n点击在访达中显示`}
        className={`rounded-full bg-emerald-500/12 font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 ${pad}`}
      >
        ✓ 已导出
      </button>
    );
  }

  if (state === "error") {
    return (
      <span
        title={detail}
        className={`rounded-full bg-rose-500/12 font-medium text-rose-500 ${pad}`}
      >
        导出失败
      </span>
    );
  }

  return (
    <button
      onClick={() => void go()}
      disabled={state === "working"}
      title={title}
      className={`rounded-full border border-[var(--rule)] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text)] disabled:opacity-50 ${pad}`}
    >
      {state === "working" ? "导出中…" : label}
    </button>
  );
}
