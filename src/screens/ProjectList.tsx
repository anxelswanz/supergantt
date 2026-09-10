import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { isoToDay, today } from "../gantt/time";
import {
  api,
  type DbImportOutcome,
  type DbImportPreview,
  type ImportOutcome,
  type ImportPreview,
  type ProjectSummary,
} from "../db/api";
import { REVEAL_LABEL, shortcut } from "../core/keys";
import { PROJECT_COLORS, useAppStore } from "../store/useAppStore";
import { DbImportDialog } from "./DbImportDialog";
import { ImportDialog } from "./ImportDialog";
import {
  commit,
  exportProjectFile,
  inspect,
  inspectDatabase,
  isDatabaseFile,
  isProjectFile,
  onProjectFileDrop,
  pickProjectFile,
} from "../transfer/projectFile";

/**
 * 项目列表。
 *
 * 这是低信息密度区，也是整个应用的第一印象 —— 表现力在这里放开
 * （DESIGN.md §4.3）。左侧网格的克制和这里的生动形成对比，本身就是设计语言。
 */

/**
 * 导入 / 导出的结果通知。
 *
 * 用一条横幅而不是弹窗：这两件事做完之后用户多半还要继续做别的，
 * 一个必须点掉的模态框在这里是纯摩擦。而覆盖导入需要一个「撤销」入口，
 * 横幅正好能挂住它 —— 和发错邮件后那几秒的撤回是同一个道理。
 */
type Notice =
  | { kind: "imported"; outcome: ImportOutcome }
  | { kind: "dbImported"; outcome: DbImportOutcome }
  | { kind: "exported"; path: string };

export function ProjectList() {
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.loadingProjects);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const createProject = useAppStore((s) => s.createProject);
  const openProject = useAppStore((s) => s.openProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const loadPeople = useAppStore((s) => s.loadPeople);

  const [creating, setCreating] = useState(false);
  /** 正在确认删除的项目。删项目是这个应用里唯一不可撤销的破坏性操作 */
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

  /** 预检通过、等用户拍板的那份文件 */
  const [pending, setPending] = useState<{ path: string; preview: ImportPreview } | null>(null);
  /** 同上，但拿来的是另一台电脑的整个库（.db） */
  const [pendingDb, setPendingDb] = useState<{ path: string; preview: DbImportPreview } | null>(
    null,
  );
  /** 读文件本身失败（不是数据有问题）—— 拖进来一个 .txt 就走这条 */
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const create = async (name: string) => {
    setCreating(false);
    if (!name.trim()) return;
    const color = PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
    const id = await createProject(name.trim(), color);
    await openProject(id);
  };

  const beginImport = useCallback(async (path: string) => {
    setNotice(null);
    const database = isDatabaseFile(path);
    if (!database && !isProjectFile(path)) {
      setReadError(
        `「${path.split(/[/\\]/).pop()}」不是 Gantt 能导入的文件（.ganttproj 项目文件或 .db 数据库）。`,
      );
      return;
    }
    setReading(true);
    setReadError(null);
    try {
      if (database) setPendingDb({ path, preview: await inspectDatabase(path) });
      else setPending({ path, preview: await inspect(path) });
    } catch (err) {
      setReadError(String(err));
    } finally {
      setReading(false);
    }
  }, []);

  /**
   * 拖文件进窗口就能导入。
   *
   * 这一步的价值不在于少点一次按钮，而在于跳过「在系统对话框里翻到 U 盘 /
   * 云盘目录」那一段 —— 那才是整个流程里最烦的地方，而且它每次都烦。
   */
  useEffect(
    () => onProjectFileDrop({ onHover: setDragging, onDrop: (p) => void beginImport(p) }),
    [beginImport],
  );

  /**
   * 撤销一次覆盖导入。
   *
   * 走的是和正常导入**完全相同**的那条路：把覆盖前自动存下的那份
   * .ganttproj 再导入一次。备份文件里带着原来的 uuid，所以它会精确命中
   * 同一个项目。没有第二套恢复逻辑 —— 一份代码只有被日常走过才可靠。
   */
  const undo = async (outcome: ImportOutcome) => {
    if (!outcome.backupPath) return;
    setUndoing(true);
    try {
      const preview = await inspect(outcome.backupPath);
      await commit(outcome.backupPath, preview.targetId, preview.suggestedName);
      await loadProjects();
      setNotice(null);
    } catch (err) {
      setReadError(`撤销失败：${err}`);
    } finally {
      setUndoing(false);
    }
  };

  /**
   * 撤销一次整库导入：把导入前的整库快照恢复回来。
   *
   * 和单项目的撤销不同，这里没法「把备份再导入一次」—— 一次整库导入可能
   * 覆盖了三个项目、新建了五个、还加了几个人。导入前那一刻的快照是唯一
   * 确定的口径，恢复它一步到位。
   */
  const undoDb = async (outcome: DbImportOutcome) => {
    setUndoing(true);
    try {
      await api.undoDbImport(outcome.backupPath);
      await Promise.all([loadProjects(), loadPeople()]);
      setNotice(null);
    } catch (err) {
      setReadError(`撤销失败：${err}`);
    } finally {
      setUndoing(false);
    }
  };

  const runExport = async (summary: ProjectSummary) => {
    setNotice(null);
    try {
      const { path } = await exportProjectFile(summary.project.id, summary.project.name);
      if (path) setNotice({ kind: "exported", path });
    } catch (err) {
      setReadError(`导出失败：${err}`);
    }
  };

  return (
    <div className="relative h-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <div className="mb-8 flex items-baseline gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">
            我的项目
          </h1>
          <span className="text-xs text-[var(--text-dim)]">
            {loading ? "加载中…" : `${projects.length} 个项目`}
          </span>
          <button
            onClick={() => void pickProjectFile().then((p) => { if (p) void beginImport(p); })}
            disabled={reading}
            title="从 .ganttproj 项目文件或另一台电脑导出的 .db 数据库导入（也可以把文件直接拖进窗口）"
            className="ml-auto rounded-full border border-[var(--rule)] px-4 py-2 text-xs font-semibold text-[var(--text-dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
          >
            {reading ? "读取中…" : "↧ 导入项目"}
          </button>
          <button
            onClick={() => setCreating(true)}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-95"
          >
            + 新建项目
          </button>
        </div>

        <AnimatePresence>
          {notice && (
            <NoticeBanner
              notice={notice}
              undoing={undoing}
              onUndo={() => {
                if (notice.kind === "imported") void undo(notice.outcome);
                else if (notice.kind === "dbImported") void undoDb(notice.outcome);
              }}
              onReveal={() =>
                notice.kind === "exported" && void api.revealPath(notice.path).catch(() => {})
              }
              onClose={() => setNotice(null)}
            />
          )}
          {readError && (
            <ErrorBanner message={readError} onClose={() => setReadError(null)} />
          )}
        </AnimatePresence>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-4">
          <AnimatePresence mode="popLayout">
            {creating && (
              <motion.div
                key="new"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                className="rounded-2xl border-2 border-dashed border-[var(--accent)] p-5"
              >
                <NewProjectInput
                  taken={(name) => projects.some((p) => p.project.name === name)}
                  onCommit={create}
                  onCancel={() => setCreating(false)}
                />
              </motion.div>
            )}

            {projects.map((summary) => (
              <ProjectCard
                key={summary.project.id}
                summary={summary}
                onOpen={() => void openProject(summary.project.id)}
                onDelete={() => setDeleting(summary)}
                onExport={() => void runExport(summary)}
                onRevealData={() => void api.revealDataDir().catch(() => {})}
              />
            ))}
          </AnimatePresence>
        </div>

        {!loading && projects.length === 0 && !creating && (
          <div className="mt-16 text-center text-sm leading-relaxed text-[var(--text-dim)]">
            还没有项目。点右上角新建一个开始，
            <br />
            或者把另一台电脑导出的 <code>.ganttproj</code> 或 <code>.db</code> 拖进这个窗口。
          </div>
        )}
      </div>

      {/* 拖入时整页变成接收区。半透明盖住内容，让「松手会发生什么」一目了然 */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-[var(--surface)]/85 p-10"
          >
            <div className="grid place-items-center gap-2 rounded-3xl border-2 border-dashed border-[var(--accent)] px-16 py-14">
              <div className="text-3xl">↧</div>
              <div className="text-sm font-semibold text-[var(--text)]">松开以导入项目</div>
              <div className="font-mono text-[11px] text-[var(--text-dim)]">.ganttproj · .db</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pending && (
          <ImportDialog
            path={pending.path}
            preview={pending.preview}
            onCancel={() => setPending(null)}
            onDone={(outcome) => {
              setPending(null);
              setNotice({ kind: "imported", outcome });
              void loadProjects();
            }}
          />
        )}
        {pendingDb && (
          <DbImportDialog
            path={pendingDb.path}
            preview={pendingDb.preview}
            onCancel={() => setPendingDb(null)}
            onDone={(outcome) => {
              setPendingDb(null);
              setNotice({ kind: "dbImported", outcome });
              void loadProjects();
              void loadPeople();
            }}
          />
        )}
        {deleting && (
          <DeleteProjectDialog
            summary={deleting}
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              const id = deleting.project.id;
              setDeleting(null);
              void deleteProject(id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function NoticeBanner({
  notice,
  undoing,
  onUndo,
  onReveal,
  onClose,
}: {
  notice: Notice;
  undoing: boolean;
  onUndo: () => void;
  onReveal: () => void;
  onClose: () => void;
}) {
  const imported = notice.kind === "imported" ? notice.outcome : null;
  const dbImported = notice.kind === "dbImported" ? notice.outcome : null;
  const exportedPath = notice.kind === "exported" ? notice.path : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className="mb-5 flex items-center gap-3 rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] px-4 py-3"
    >
      <span className="text-sm text-emerald-500">✓</span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--text)]">
        {imported ? (
          <>
            {imported.overwritten ? "已用文件版覆盖" : "已导入"}
            「<span className="font-semibold">{imported.name}</span>」
            <span className="text-[var(--text-dim)]">
              （{imported.taskCount} 个任务
              {imported.newPeople.length > 0 &&
                `，新增负责人 ${imported.newPeople.join("、")}`}
              ）
            </span>
            {imported.backupPath && (
              <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
                旧版已备份到 <code>backups/</code>，横幅关掉后文件仍在。
              </div>
            )}
          </>
        ) : dbImported ? (
          <>
            已导入数据库：新建 {dbImported.created} 个项目
            {dbImported.overwritten > 0 && `，覆盖 ${dbImported.overwritten} 个`}
            {dbImported.newPeople.length > 0 && (
              <span className="text-[var(--text-dim)]">
                （新增负责人 {dbImported.newPeople.join("、")}）
              </span>
            )}
            <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
              导入前的整库快照在 <code>backups/</code>，横幅关掉后文件仍在。
            </div>
          </>
        ) : (
          <>
            已导出到 <code className="text-[11px]">{exportedPath}</code>
          </>
        )}
      </div>

      {(imported?.backupPath || dbImported) && (
        <button
          onClick={onUndo}
          disabled={undoing}
          className="shrink-0 rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)] hover:bg-[var(--row-hover)] disabled:opacity-40"
        >
          {undoing ? "撤销中…" : "撤销"}
        </button>
      )}
      {notice.kind === "exported" && (
        <button
          onClick={onReveal}
          className="shrink-0 rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)] hover:bg-[var(--row-hover)]"
        >
          {REVEAL_LABEL}
        </button>
      )}
      <button
        onClick={onClose}
        className="shrink-0 rounded-lg px-1.5 py-1 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
      >
        ✕
      </button>
    </motion.div>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className="mb-5 flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3"
    >
      <span className="text-sm text-rose-500">!</span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--text)]">{message}</div>
      <button
        onClick={onClose}
        className="shrink-0 rounded-lg px-1.5 py-1 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
      >
        ✕
      </button>
    </motion.div>
  );
}

/** 要一字不差敲进去的那个词。大小写和首尾空格不计较 —— 保险要防手滑，不是防拼写 */
const CONFIRM_WORD = "delete";

/**
 * 删项目的保险。
 *
 * 别的删除都有退路：任务、受阻走命令栈，⌘Z 就回来了；风险和评论虽然不进
 * 撤销栈，但删错一条的代价是重敲一句话。**只有删项目没有退路** ——
 * 它带走整棵任务树、全部风险、评论和逐日记录，而且是级联删除，
 * 库里不留残影。备份帮得上忙，但那要用户知道去哪找、还得接受回滚到上次备份。
 *
 * 所以这里刻意让它「不好点」：要手敲一个词。二次点击那种保险防不住这种事故 ——
 * 它和「删一条风险」用的是同一个手势，而手已经学会了连点两下。
 * 敲字需要读一遍上面写的是什么，这一秒钟就是这个保险的全部价值。
 */
function DeleteProjectDialog({
  summary,
  onCancel,
  onConfirm,
}: {
  summary: ProjectSummary;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [text, setText] = useState("");
  const ok = text.trim().toLowerCase() === CONFIRM_WORD;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] max-w-full rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
      >
        <div className="text-sm font-semibold text-[var(--text)]">
          删除「{summary.project.name || "未命名项目"}」
        </div>

        {/* 把代价写成具体的数字。「此操作不可恢复」是套话，
            「37 个任务」才会让人停下来想一下 */}
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-dim)]">
          {summary.taskCount} 个任务，连同它们的风险、评论和逐日记录会一起删掉。
          <br />
          <span className="font-medium text-rose-500">这一步不能撤销</span>
          —— {shortcut("mod", "Z")} 救不回来，只能从 <code>backups/</code> 里的备份回滚。
        </p>

        <label className="mt-4 block text-[11px] text-[var(--text-dim)]">
          确认请输入 <code className="font-semibold text-[var(--text)]">{CONFIRM_WORD}</code>
        </label>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 敲完直接回车 —— 已经手打过一个词了，再逼着去够鼠标是白加摩擦
            if (e.key === "Enter" && ok) onConfirm();
          }}
          placeholder={CONFIRM_WORD}
          spellCheck={false}
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border bg-[var(--surface-alt)] px-2.5 py-1.5 font-mono text-xs text-[var(--text)] outline-none transition-colors"
          style={{ borderColor: ok ? "#f43f5e" : "var(--rule)" }}
        />

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={onCancel}
            className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={!ok}
            title={ok ? "删除这个项目" : `输入 ${CONFIRM_WORD} 才能删除`}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: "#f43f5e" }}
          >
            永久删除
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ProjectCard({
  summary,
  onOpen,
  onDelete,
  onExport,
  onRevealData,
}: {
  summary: ProjectSummary;
  onOpen: () => void;
  onDelete: () => void;
  onExport: () => void;
  onRevealData: () => void;
}) {
  const { project, taskCount, startDate, endDate, overdueCount, progress } = summary;

  return (
    <motion.button
      layoutId={`project-${project.id}`}
      onClick={onOpen}
      whileHover={{ y: -2 }}
      // dramatic 档：卡片展开成工作区是全应用最值得花力气的转场（DESIGN.md §9）
      transition={{ type: "spring", stiffness: 120, damping: 20 }}
      className="group relative flex flex-col gap-3 rounded-2xl border border-[var(--rule)] bg-[var(--surface-alt)] p-5 text-left"
    >
      <div className="flex items-start gap-3">
        <ProgressRing value={progress} color={project.color} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--text)]">
            {project.name}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
            {taskCount} 个任务
            {overdueCount > 0 && (
              <span className="ml-1.5 font-semibold text-rose-500">
                ⚠ {overdueCount} 逾期
              </span>
            )}
          </div>
        </div>
      </div>

      <SpanBar startDate={startDate} endDate={endDate} color={project.color} />

      <div className="font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
        {startDate && endDate ? `${startDate.slice(5)} – ${endDate.slice(5)}` : "尚无任务"}
      </div>

      {/*
        卡片本身是个 button，所以这两个只能是 span[role=button] ——
        button 套 button 在 HTML 里是非法的，浏览器会把内层拆出去。

        「数据目录」打开的是**全应用共用的那一个** SQLite 文件所在的目录：
        所有项目都在同一个库里（Settings → 数据文件那一节说的就是它）。
        放在卡片上是因为想找数据的人多半正站在项目列表这一屏，
        而不是记得先进某个项目再翻设置。
      */}
      <div className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onRevealData();
          }}
          title={`${REVEAL_LABEL}数据文件所在的目录（所有项目共用同一个 .db）`}
          className="rounded-lg px-2 py-1 text-[10px] font-medium text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ⧉ 数据目录
        </span>
        {/*
          「导出」在这里而不在工作区的工具条上。工具条那两个导出
          （Excel / 时间线 HTML）是**给人看**的排版件，是对外产出；
          .ganttproj 是**给这个软件看**的全保真数据，用途是换台电脑接着干。
          两类东西挤在同一栏里，用户迟早会带着一个 .xlsx 跑到另一台机器上，
          然后发现导不进去 —— 而那是白跑一趟才发现的。
        */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onExport();
          }}
          title="导出成 .ganttproj：完整数据，可以在另一台电脑上导回来"
          className="rounded-lg px-2 py-1 text-[10px] font-medium text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          ⤴ 导出
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除这个项目（要手动输入确认）"
          className="rounded-lg px-2 py-1 text-[10px] font-medium text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-rose-500"
        >
          删除
        </span>
      </div>
    </motion.button>
  );
}

/**
 * 时间跨度条：项目起止区间 + 今天的位置 + 已完成比例。
 * 一眼看出「项目是过去式、进行中还是还没开始」，以及进度和时间是否匹配。
 */
function SpanBar({
  startDate,
  endDate,
  color,
}: {
  startDate: string | null;
  endDate: string | null;
  color: string;
}) {
  if (!startDate || !endDate) {
    return <div className="h-1.5 rounded-full bg-[var(--row-hover)]" />;
  }

  const start = isoToDay(startDate);
  const end = isoToDay(endDate);
  const span = Math.max(1, end - start);
  const todayPos = Math.min(1, Math.max(0, (today() - start) / span));

  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--row-hover)]">
      <div
        className="absolute inset-y-0 left-0 rounded-full opacity-30"
        style={{ width: "100%", background: color }}
      />
      {/* 今天线：时间过去了多少 */}
      <div
        className="absolute inset-y-0 w-0.5 bg-rose-500"
        style={{ left: `${todayPos * 100}%` }}
      />
    </div>
  );
}

function ProgressRing({ value, color }: { value: number; color: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid size-10 shrink-0 place-items-center">
      <svg viewBox="0 0 36 36" className="absolute size-10 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--rule)" strokeWidth="3" />
        <motion.circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - value) }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </svg>
      <span className="font-mono text-[10px] font-semibold tabular-nums text-[var(--text)]">
        {Math.round(value * 100)}
      </span>
    </div>
  );
}

/**
 * 新建项目的输入框。
 *
 * 项目名在库里是唯一的（migrations/007_project_identity.sql），所以这里要挡重名。
 * 挡法是**边敲边比**，而不是提交后报错：这个输入框失焦即提交，
 * 提交失败再回头把字填回去，中间那一下必然会闪。已经加载好的项目列表
 * 就在手边，本地比一次字符串是零成本的。
 *
 * 不自动加「(2)」后缀：一旦允许「厂房建设」和「厂房建设 (2)」并存，
 * 名字作为「这是同一个项目吗」的兜底线索就废了，而那是 uuid 对不上时
 * 唯一还能用的手段。
 */
function NewProjectInput({
  taken,
  onCommit,
  onCancel,
}: {
  taken: (name: string) => boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const duplicate = trimmed.length > 0 && taken(trimmed);

  const submit = () => {
    if (duplicate) return;
    if (trimmed) onCommit(trimmed);
    else onCancel();
  };

  return (
    <>
      <input
        autoFocus
        value={value}
        placeholder="项目名称"
        className="w-full bg-transparent text-sm font-semibold text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        // 重名时不提交也不取消，把卡片和你敲的字都留在原地等你改
        onBlur={submit}
      />
      {duplicate && (
        <div className="mt-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          已有同名项目 —— 项目名要唯一
        </div>
      )}
    </>
  );
}
