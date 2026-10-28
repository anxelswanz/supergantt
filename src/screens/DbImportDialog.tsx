import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { DbImportItem, DbImportOutcome, DbImportPreview } from "../db/api";
import { commitDatabase } from "../transfer/projectFile";

/**
 * 导入整个数据库（.db）前的预检对话框。对号、校验、定名都在 Rust 侧（dbfile.rs）。
 * 不收改名输入：撞名时 Rust 已选好不撞的名字并写进 warnings。
 */
export function DbImportDialog({
  path,
  preview,
  onCancel,
  onDone,
}: {
  path: string;
  preview: DbImportPreview;
  onCancel: () => void;
  onDone: (outcome: DbImportOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const blocked = preview.problems.length > 0;
  const overwriting = preview.projects.filter((p) => p.targetId != null).length;
  const creating = preview.projects.length - overwriting;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const go = async () => {
    if (blocked || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      onDone(await commitDatabase(path));
    } catch (err) {
      setFailure(String(err));
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-[480px] max-w-full flex-col rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
      >
        <div
          className={`text-sm font-semibold ${blocked ? "text-[var(--danger)]" : "text-[var(--text)]"}`}
        >
          {blocked
            ? `无法导入，这个数据库有 ${preview.problems.length} 处问题`
            : "导入整个数据库"}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-dim)]" title={path}>
          {fileNameOf(path)}
        </div>

        {blocked ? (
          <>
            <ul className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {preview.problems.map((p) => (
                <li
                  key={p}
                  className="rounded-lg bg-[var(--danger)]/8 px-3 py-2 text-[11px] leading-relaxed text-[var(--text)]"
                >
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
              有一个项目不合格，所有项目都不导入。
              <span className="font-medium text-[var(--text)]">数据库未发生任何改动。</span>
            </p>
            <div className="mt-4 flex">
              <button
                onClick={onCancel}
                className="ml-auto rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white"
              >
                知道了
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-dim)]">
              共 {preview.projects.length} 个项目：新建 {creating} 个
              {overwriting > 0 && `，覆盖本机 ${overwriting} 个`}。
              本机独有的项目不受影响。
            </p>

            <ul className="mt-3 min-h-0 flex-1 divide-y divide-[var(--rule)] overflow-y-auto rounded-xl border border-[var(--rule)]">
              {preview.projects.map((item) => (
                <ProjectRow key={`${item.file.name}-${item.targetId ?? "new"}`} item={item} />
              ))}
            </ul>

            {preview.extraPeople.length > 0 && (
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
                另有 {preview.extraPeople.length} 位负责人会一并加入：
                {preview.extraPeople.join("、")}
              </p>
            )}

            {preview.warnings.map((w) => (
              <p
                key={w}
                className="mt-3 rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--warn)]"
              >
                {w}
              </p>
            ))}

            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
              导入前会把本机数据库快照到 <code>backups/</code>，导入后可撤销。
              {overwriting > 0 &&
                "被覆盖的项目会用文件版整个替换任务、依赖、风险、评论、当日记录和基线。同名负责人沿用本机的。"}
            </p>

            {failure && (
              <p className="mt-3 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--danger)]">
                {failure}
              </p>
            )}

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={onCancel}
                disabled={busy}
                className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={() => void go()}
                disabled={busy}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
              >
                {busy ? "导入中…" : `导入 ${preview.projects.length} 个项目`}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function ProjectRow({ item }: { item: DbImportItem }) {
  const { file, existing, matchedBy, finalName } = item;
  const renamed = finalName !== file.name;

  return (
    <li className="px-3.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text)]" title={finalName}>
          {finalName}
        </span>
        <span
          className={`shrink-0 rounded-[var(--r-m)] px-2 py-0.5 text-[10px] font-medium ${
            existing
              ? "bg-[var(--warn)]/10 text-[var(--warn)]"
              : "bg-[var(--ok)]/10 text-[var(--ok)] dark:text-[var(--ok)]"
          }`}
          title={
            matchedBy === "uuid"
              ? "项目标识一致，是同一个项目的另一个版本"
              : matchedBy === "name"
                ? "和本机项目同名，按同一个项目处理"
                : undefined
          }
        >
          {existing ? `覆盖本机「${existing.name}」` : "新建"}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-[var(--text-dim)]">
        {renamed && <span>原名「{file.name}」，</span>}
        {file.taskCount} 个任务
        {existing && existing.taskCount !== file.taskCount && `（本机 ${existing.taskCount} 个）`}
        {file.startDate && file.endDate && `，${file.startDate} – ${file.endDate}`}
      </div>
    </li>
  );
}

function fileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}
