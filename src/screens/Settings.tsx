import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type Person } from "../db/api";
import { COLOR_BY_LABELS, type ColorBy } from "../gantt/coloring";
import {
  ROW_HEIGHTS,
  ROW_HEIGHT_LABELS,
  type RowHeightKey,
} from "../gantt/theme";
import { PROJECT_COLORS, useAppStore } from "../store/useAppStore";
import { REVEAL_LABEL } from "../core/keys";
import { exportDatabaseFile } from "../transfer/projectFile";
import { Avatar, fileToAvatarDataUrl } from "./Avatar";
import { CalendarPane } from "./CalendarSettings";

/**
 * 设置面板。
 *
 * 三块内容按「改动频率」排序，不是按重要性：着色是随时会切的视图偏好，
 * 负责人偶尔维护，数据文件几乎不碰但出事时必须找得到。
 */

type Tab = "appearance" | "people" | "calendar" | "data";

const TABS: { id: Tab; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "people", label: "负责人" },
  { id: "calendar", label: "工作日历" },
  { id: "data", label: "数据" },
];

export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("appearance");

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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={onClose}
      className="fixed inset-0 z-[100] grid place-items-center bg-black/35 p-8 backdrop-blur-[2px]"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 200, damping: 26 }}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex h-[520px] w-[620px] overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--surface)] shadow-2xl"
      >
        <nav className="flex w-[132px] shrink-0 flex-col gap-0.5 border-r border-[var(--rule)] bg-[var(--surface-alt)] p-2.5">
          <div className="mb-2 px-2 pt-1 text-sm font-bold text-[var(--text)]">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={onClose}
            className="mt-auto rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            关闭 (Esc)
          </button>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {tab === "appearance" && <AppearancePane />}
          {tab === "people" && <PeoplePane />}
          {tab === "calendar" && <CalendarPane />}
          {tab === "data" && <DataPane />}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* 外观                                                                */
/* ------------------------------------------------------------------ */

function AppearancePane() {
  const colorBy = useAppStore((s) => s.colorBy);
  const setColorBy = useAppStore((s) => s.setColorBy);

  const hints: Record<ColorBy, string> = {
    stage: "顶层任务拿一个基色，它的每个后代拿一个同色系变体 —— 每一行都不重样，但一眼看得出同属一族。",
    assignee: "用每个人自己的颜色，和设置里的头像底色一致。未指派走中性灰。",
    priority: "固定映射，P0 永远是红的 —— 不会因为项目里恰好没有 P0 就让 P1 变红。",
    none: "全部用项目强调色。导出 PDF 或灰度打印时，彩色反而是干扰。",
  };

  return (
    <Section title="甘特条着色" desc="颜色由数据决定，不由行号决定 —— 这样每一个颜色都能被解释。">
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(COLOR_BY_LABELS) as ColorBy[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setColorBy(mode)}
            className={`rounded-xl border p-3 text-left transition-colors ${
              colorBy === mode
                ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                : "border-[var(--rule)] hover:border-[var(--text-dim)]"
            }`}
          >
            <div className="text-xs font-semibold text-[var(--text)]">
              {COLOR_BY_LABELS[mode]}
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
              {hints[mode]}
            </div>
          </button>
        ))}
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-dim)]">
        进度不和色相抢通道：已完成部分是该色实心，未完成部分是同色 18% 透明。
        紧急度只在甘特条上标 P0（左端红色小三角），完整的四档在左侧的「紧急」列。
      </p>

      <div className="mt-6">
        <h2 className="text-sm font-bold text-[var(--text)]">行高</h2>
        <p className="mb-3 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
          左侧网格和甘特图共用同一个行高，两侧永远对齐。
          甘特条的高度跟着一起缩放，不会在宽松档位下显得空旷。
        </p>
        <RowHeightPicker />
      </div>
    </Section>
  );
}

function RowHeightPicker() {
  const rowHeightKey = useAppStore((s) => s.rowHeightKey);
  const setRowHeight = useAppStore((s) => s.setRowHeight);

  return (
    <div className="flex gap-2">
      {(Object.keys(ROW_HEIGHTS) as RowHeightKey[]).map((key) => (
        <button
          key={key}
          onClick={() => setRowHeight(key)}
          className={`flex flex-1 flex-col items-center gap-1.5 rounded-xl border p-3 transition-colors ${
            rowHeightKey === key
              ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
              : "border-[var(--rule)] hover:border-[var(--text-dim)]"
          }`}
        >
          {/* 用三条按真实比例缩放的横条预览，比只写「26px」直观得多 */}
          <span className="flex w-full flex-col gap-[3px]">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-full rounded-full bg-[var(--accent)]"
                style={{ height: Math.max(2, ROW_HEIGHTS[key] / 7), opacity: 0.85 - i * 0.2 }}
              />
            ))}
          </span>
          <span className="text-[11px] font-medium text-[var(--text)]">
            {ROW_HEIGHT_LABELS[key]}
          </span>
          <span className="font-mono text-[9px] text-[var(--text-dim)]">
            {ROW_HEIGHTS[key]}px
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

function PeoplePane() {
  const people = useAppStore((s) => s.people);
  const addPerson = useAppStore((s) => s.addPerson);
  const loadPeople = useAppStore((s) => s.loadPeople);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  const add = async () => {
    if (!draft.trim()) return;
    try {
      await addPerson(draft.trim());
      setDraft("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Section
      title="负责人"
      desc="全局共享，不按项目隔离 —— 同一个人通常同时出现在多个项目里。照片会压到 128px 存进数据库，所以复制那一个文件就是完整备份。"
    >
      <div className="mb-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void add();
          }}
          placeholder="姓名"
          className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={() => void add()}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-transform active:scale-95"
        >
          添加
        </button>
      </div>

      {error && <div className="mb-2 text-[10px] text-rose-500">{error}</div>}

      <div className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {people.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
        </AnimatePresence>
      </div>

      {people.length === 0 && (
        <div className="py-8 text-center text-xs text-[var(--text-dim)]">
          还没有负责人。上面加一个。
        </div>
      )}
    </Section>
  );
}

function PersonRow({ person }: { person: Person }) {
  const savePerson = useAppStore((s) => s.savePerson);
  const removePerson = useAppStore((s) => s.removePerson);

  const [name, setName] = useState(person.name);
  const [confirming, setConfirming] = useState(false);
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(person.name), [person.name]);

  const commitName = () => {
    const next = name.trim();
    if (!next || next === person.name) {
      setName(person.name);
      return;
    }
    void savePerson(person.id, next, person.color).catch(() => setName(person.name));
  };

  const pickAvatar = async (file: File) => {
    setBusy(true);
    try {
      // 压到 128px 再存 —— 头像躺在 SQLite 里，原图会把库撑大一个量级
      const dataUrl = await fileToAvatarDataUrl(file);
      await savePerson(person.id, person.name, person.color, dataUrl);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = async () => {
    if (!confirming) {
      setTaskCount(await api.countPersonTasks(person.id).catch(() => 0));
      setConfirming(true);
      return;
    }
    await removePerson(person.id);
  };

  return (
    <motion.div
      layout
      exit={{ opacity: 0, height: 0 }}
      className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--row-hover)]"
    >
      <button
        onClick={() => fileRef.current?.click()}
        title="点击上传照片"
        className="group/av relative shrink-0 overflow-hidden rounded-full"
      >
        <Avatar person={person} size={32} />
        {/* 悬停蒙层：把「这里可以点」说清楚，否则没人知道头像能换 */}
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/55 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/av:opacity-100">
          换
        </span>
        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/50 text-[8px] text-white">
            …
          </span>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pickAvatar(file);
          e.target.value = "";
        }}
      />

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(person.name);
        }}
        onBlur={commitName}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-[var(--text)] outline-none hover:border-[var(--rule)] focus:border-[var(--accent)]"
      />

      <button
        onClick={() => fileRef.current?.click()}
        className="shrink-0 rounded border border-[var(--rule)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
      >
        {person.avatar ? "换照片" : "上传照片"}
      </button>

      <ColorDots
        value={person.color}
        onPick={(color) => void savePerson(person.id, person.name, color)}
      />

      {person.avatar && (
        <button
          onClick={() => void savePerson(person.id, person.name, person.color, "")}
          title="移除照片，回到首字母头像"
          className="shrink-0 rounded px-1 text-[10px] text-[var(--text-dim)] hover:text-rose-500"
        >
          ✕
        </button>
      )}

      <button
        onClick={() => void askDelete()}
        onBlur={() => setConfirming(false)}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
          confirming
            ? "bg-rose-500 text-white opacity-100"
            : "text-[var(--text-dim)] opacity-0 hover:text-rose-500 group-hover:opacity-100"
        }`}
        title={
          confirming
            ? `确认删除。${taskCount ?? 0} 个任务会变成「未指派」，任务本身不会被删`
            : "删除"
        }
      >
        {confirming ? `确认（${taskCount ?? 0} 个任务将解除指派）` : "删除"}
      </button>
    </motion.div>
  );
}

function ColorDots({
  value,
  onPick,
}: {
  value: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5">
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          title="这个颜色同时用于头像底色和「按负责人着色」时的甘特条"
          className="size-3.5 rounded-full transition-transform hover:scale-125"
          style={{
            background: c,
            outline: c === value ? "2px solid var(--text)" : "none",
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

function DataPane() {
  const [dir, setDir] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.dataDir().then(setDir).catch(() => {});
  }, []);

  return (
    <Section title="数据文件" desc="全部数据都在这一个 SQLite 文件里，不联网、不上云。">
      <div className="mb-3 break-all rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] p-2.5 font-mono text-[10px] text-[var(--text-dim)]">
        {dir || "读取中…"}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void api.revealDataDir().catch(() => {})}
          className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          {REVEAL_LABEL}
        </button>
        <button
          onClick={() =>
            void api
              .backupNow()
              // Windows 的路径分隔符是 \，只按 / 切会把整条路径原样摆出来
              .then((p) => setMessage(`已备份到 ${p.split(/[/\\]/).pop()}`))
              .catch((e) => setMessage(`备份失败：${e}`))
          }
          className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          立即备份
        </button>
        <button
          onClick={() =>
            void exportDatabaseFile()
              .then(({ path }) => {
                if (path) setMessage(`已导出到 ${path}`);
              })
              .catch((e) => setMessage(`导出失败：${e}`))
          }
          title="把全部项目和负责人导出成一个 .db 文件，拿到另一台电脑（Mac 或 Windows）上导入"
          className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          导出数据库…
        </button>
      </div>

      {message && (
        <div className="mt-2 break-all text-[10px] text-[var(--text-dim)]">{message}</div>
      )}

      <IntegrityCheck />

      <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-dim)]">
        每次启动会自动备份到 <code>backups/</code>，保留最近 10 份。
        备份走 SQLite 的在线备份接口，包含尚未 checkpoint 的 WAL 内容 ——
        直接复制 .db 文件会漏掉最近的提交。
        <br />
        头像也存在这个文件里，所以复制它一份就是完整的数据副本。
        <br />
        换电脑（包括 Mac 和 Windows 之间）：点「导出数据库…」，把得到的 .db 拷过去，
        在那边的项目列表点「导入项目」选中它即可。本机独有的项目不会被抹掉。
      </p>
    </Section>
  );
}

/**
 * 完整性体检。
 *
 * 出过一次静默的跨项目数据损坏之后，「我怎么知道现在是好的」这个问题
 * 必须有一个能自己按的按钮来回答，而不是只能等下次出事。
 */
function IntegrityCheck() {
  const [state, setState] = useState<
    { status: "idle" } | { status: "running" } | { status: "done"; issues: string[] }
  >({ status: "idle" });

  const run = async () => {
    setState({ status: "running" });
    const issues = await api.checkIntegrity().catch((e) => [String(e)]);
    setState({ status: "done", issues });
  };

  return (
    <div className="mt-4 border-t border-[var(--rule)] pt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void run()}
          disabled={state.status === "running"}
          className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {state.status === "running" ? "检查中…" : "检查数据完整性"}
        </button>
        {state.status === "done" && state.issues.length === 0 && (
          <span className="text-[10px] font-medium text-emerald-600">
            ✓ 没有查出结构性问题
          </span>
        )}
      </div>

      {state.status === "done" && state.issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {state.issues.map((issue) => (
            <li key={issue} className="text-[10px] text-rose-500">
              ● {issue}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
        检查跨项目的父子引用、孤儿任务、自引用、越界日期和外键破损。
        其中跨项目引用最危险 —— 它会让删除一个项目的任务连带删掉另一个项目的子树，
        所以每次启动都会自动降级修复一遍。
      </p>
    </div>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-sm font-bold text-[var(--text)]">{title}</h2>
      <p className="mb-4 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">{desc}</p>
      {children}
    </div>
  );
}
