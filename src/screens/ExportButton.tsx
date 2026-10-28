/**
 * 导出按钮：导出中 / 已导出 / 失败三态。
 *
 * 导出前先 flush：落库是防抖的，风险点和逐日记录直接查库，不 flush 会导出前后矛盾的文件。
 * 保存对话框里点取消不算失败，安静回到 idle。
 */

import { useState } from "react";
import { api } from "../db/api";
import { useAppStore } from "../store/useAppStore";
import { MenuItem, Popover } from "./Popover";

type Run = () => Promise<{ path: string | null }>;

interface Props {
  label: string;
  title: string;
  /** path 为 null 表示用户取消了保存对话框 */
  run?: Run;
  /** 多种格式时传这个：先弹菜单选格式；与 run 二选一 */
  formats?: { label: string; hint?: string; run: Run }[];
  /** 时间线里与「记一笔」并排，小一号 */
  size?: "md" | "sm";
}

export function ExportButton({ label, title, run, formats, size = "md" }: Props) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [detail, setDetail] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1 text-xs";

  const go = async (job: Run | undefined) => {
    if (state === "working" || !job) return;
    setState("working");
    try {
      await useAppStore.getState().persistence?.flush();
      const { path } = await job();
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
        title={`${detail}\n点击在文件管理器中显示`}
        className={`rounded-full bg-[var(--ok)]/12 font-medium text-[var(--ok)] transition-colors hover:bg-[var(--ok)]/20 ${pad}`}
      >
        ✓ 已导出
      </button>
    );
  }

  if (state === "error") {
    return (
      <span
        title={detail}
        className={`rounded-[var(--r-m)] bg-[var(--danger)]/12 font-medium text-[var(--danger)] ${pad}`}
      >
        导出失败
      </span>
    );
  }

  return (
    <>
      <button
        ref={setAnchor}
        onClick={() => (formats ? setMenuOpen((v) => !v) : void go(run))}
        disabled={state === "working"}
        title={title}
        className={`rounded-[var(--r-m)] border border-[var(--rule)] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text)] disabled:opacity-50 ${pad}`}
      >
        {state === "working" ? "导出中…" : formats ? `${label} ▾` : label}
      </button>
      {formats && (
        <Popover anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} align="right" width={180}>
          {formats.map((f) => (
            <MenuItem
              key={f.label}
              hint={f.hint}
              onClick={() => {
                setMenuOpen(false);
                void go(f.run);
              }}
            >
              {f.label}
            </MenuItem>
          ))}
        </Popover>
      )}
    </>
  );
}
