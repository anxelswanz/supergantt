import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import type { ImportOutcome, ImportPreview, SideSummary } from "../db/api";
import { commit } from "../transfer/projectFile";

/** 导入项目文件前的预检对话框。校验、匹配、落库都在 Rust 侧（transfer.rs），这里只排版。 */

export function ImportDialog({
  path,
  preview,
  onCancel,
  onDone,
}: {
  path: string;
  preview: ImportPreview;
  onCancel: () => void;
  onDone: (outcome: ImportOutcome) => void;
}) {
  const [name, setName] = useState(preview.suggestedName);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const blocked = preview.problems.length > 0;
  const overwrite = preview.existing !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  // 只挡住原样重提撞名的名字；真正的唯一性靠库层 UNIQUE 索引，失败走 failure 分支
  const nameTaken = preview.nameConflict && name.trim() === preview.suggestedName.trim();
  const canGo = !blocked && !busy && name.trim().length > 0 && !nameTaken;

  const go = async () => {
    if (!canGo) return;
    setBusy(true);
    setFailure(null);
    try {
      onDone(await commit(path, preview.targetId, name.trim()));
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
        className="w-[440px] max-w-full rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
      >
        {blocked ? (
          <Blocked preview={preview} path={path} onCancel={onCancel} />
        ) : (
          <>
            <div className="text-sm font-semibold text-[var(--text)]">
              {overwrite ? "本机已有这个项目" : "导入项目"}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-dim)]" title={path}>
              {fileNameOf(path)}
            </div>

            {overwrite ? (
              <Comparison preview={preview} />
            ) : (
              <Fresh file={preview.file} />
            )}

            {preview.warnings.map((w) => (
              <p
                key={w}
                className="mt-3 rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--warn)]"
              >
                {w}
              </p>
            ))}

            {preview.nameConflict && (
              <div className="mt-3 rounded-lg bg-[var(--warn)]/10 px-3 py-2.5">
                <p className="text-[11px] leading-relaxed text-[var(--warn)]">
                  「{preview.suggestedName}」会和本机另一个项目撞名，请换一个名字。
                </p>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void go()}
                  placeholder="换一个名字"
                  className="mt-2 w-full rounded-lg border bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none"
                  style={{ borderColor: nameTaken ? "#f59e0b" : "var(--rule)" }}
                />
              </div>
            )}

            {overwrite && (
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
                覆盖前会把本机版备份为 <code>.ganttproj</code> 存进 <code>backups/</code>，导入后可撤销。
              </p>
            )}

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
                disabled={!canGo}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
              >
                {busy
                  ? "导入中…"
                  : overwrite
                    ? preview.renameTo
                      ? "覆盖并改名"
                      : "覆盖本机版"
                    : "导入"}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

/** 文件不合格：列出问题，并明说数据库没动过。 */
function Blocked({
  preview,
  path,
  onCancel,
}: {
  preview: ImportPreview;
  path: string;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="text-sm font-semibold text-[var(--danger)]">
        无法导入，文件有 {preview.problems.length} 处问题
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-dim)]" title={path}>
        {fileNameOf(path)}
      </div>

      <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto">
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
        有问题时整个文件都不导入。
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
  );
}

function Fresh({ file }: { file: SideSummary }) {
  return (
    <div className="mt-3 rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] p-3.5">
      <div className="text-sm font-semibold text-[var(--text)]">{file.name}</div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
        {file.taskCount} 个任务，{file.peopleCount} 位负责人，{file.riskCount} 条风险，
        {file.commentCount} 条评论，{file.dailyNoteCount} 条当日记录
      </div>
      <div className="mt-1 font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
        {file.startDate && file.endDate ? `${file.startDate} – ${file.endDate}` : "尚无任务"}
      </div>
    </div>
  );
}

/** 本机版与文件版并排对比。不替用户判断哪边该留：较晚修改不等于更重要。 */
function Comparison({ preview }: { preview: ImportPreview }) {
  const local = preview.existing!;
  const file = preview.file;

  const rows: Array<[string, string, string, boolean]> = useMemo(() => {
    const r: Array<[string, string, string, boolean]> = [];
    if (local.name !== file.name) r.push(["名称", local.name, file.name, true]);
    r.push(["任务数", String(local.taskCount), String(file.taskCount), local.taskCount !== file.taskCount]);
    r.push(["负责人", String(local.peopleCount), String(file.peopleCount), local.peopleCount !== file.peopleCount]);
    r.push(["风险点", String(local.riskCount), String(file.riskCount), local.riskCount !== file.riskCount]);
    r.push(["当日记录", String(local.dailyNoteCount), String(file.dailyNoteCount), local.dailyNoteCount !== file.dailyNoteCount]);
    r.push(["最后修改", stamp(local.updatedAt), stamp(file.updatedAt), local.updatedAt !== file.updatedAt]);
    return r;
  }, [local, file]);

  const fileIsNewer = Number(file.updatedAt) > Number(local.updatedAt);

  return (
    <>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-dim)]">
        {preview.matchedBy === "uuid"
          ? "项目标识和本机这个项目一致，是它的另一个版本。"
          : "和本机这个项目同名，按同一个项目处理。"}
      </p>

      <div className="mt-3 overflow-hidden rounded-xl border border-[var(--rule)]">
        <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 bg-[var(--surface-alt)] px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-dim)]">
          <span />
          <span>本机</span>
          <span>文件{fileIsNewer && <span className="ml-1 text-[var(--accent)]">较新</span>}</span>
        </div>
        {rows.map(([label, a, b, differs]) => (
          <div
            key={label}
            className="grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-3 border-t border-[var(--rule)] px-3.5 py-1.5 text-xs"
          >
            <span className="w-14 shrink-0 text-[11px] text-[var(--text-dim)]">{label}</span>
            <span className={`truncate tabular-nums ${differs ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}>
              {a}
            </span>
            <span
              className={`truncate tabular-nums ${differs ? "font-semibold text-[var(--text)]" : "text-[var(--text)]"}`}
              title={b}
            >
              {b}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
        覆盖会用文件版<span className="font-semibold text-[var(--text)]">整个替换</span>
        本机版的任务、依赖、风险、评论、当日记录和基线。同名负责人沿用本机的。
      </p>
    </>
  );
}

/** Unix 秒字符串 → 本地「MM-DD HH:mm」。 */
function stamp(secs: string): string {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}
