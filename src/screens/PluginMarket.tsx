import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type StoreIndexFetch } from "../db/api";
import { plugins } from "../plugins/registry";
import { useRegistry } from "../plugins/usePlugins";
import type { PluginRecord } from "../plugins/types";
import {
  MIRROR_SETTING,
  mirrorProblem,
  parseIndex,
  permissionAsk,
  rowState,
  searchPlugins,
  type PermissionAsk,
  type RowState,
  type StoreEntry,
  type StoreIndex,
} from "../plugins/store";
import { PROJECT_COLORS, useAppStore } from "../store/useAppStore";
import { Markdown } from "../markdown/MarkdownView";
import { Icon } from "../brand/Icon";

/**
 * 插件市场。参照 IDE 的扩展面板：左边搜索 + 列表，右边选中插件的详情。
 *
 * ## 搜索为什么不联网
 *
 * 全部插件都列在插件仓库的 index.json 里，打开市场时拉一次（Rust 侧，连不上退回缓存），
 * 之后边打边在本地筛。GitHub 的搜索 API 不登录每分钟只能调 10 次、国内访问不稳，
 * 边打边搜会撞墙；而且我们要搜的本来就只是这一份列表。
 *
 * ## 安装即启用
 *
 * 装之前的权限确认就是「同意它运行」，确认之后再让人去找「启用」按钮是多余的一步。
 * 更新时保持原来的启停状态：停用着的插件更新完还是停用的。
 */

/* ------------------------------------------------------------------ */
/* 在线列表                                                            */
/* ------------------------------------------------------------------ */

function useStoreIndex() {
  const [fetch, setFetch] = useState<StoreIndexFetch | null>(null);
  const [loading, setLoading] = useState(false);
  const [mirror, setMirror] = useState<string | null>(null);

  const load = async (m: string | null) => {
    setLoading(true);
    try {
      setFetch(await api.storeFetchIndex(m?.trim() || null));
    } catch (e) {
      setFetch({ raw: null, fetched_at: null, from_cache: true, error: (e as Error)?.message ?? String(e) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void api
      .getSetting(MIRROR_SETTING)
      .catch(() => null)
      .then((m) => {
        setMirror(m ?? "");
        void load(m);
      });
  }, []);

  const parsed = useMemo((): { index: StoreIndex | null; parseError: string | null } => {
    if (!fetch?.raw) return { index: null, parseError: null };
    try {
      return { index: parseIndex(fetch.raw), parseError: null };
    } catch (e) {
      return { index: null, parseError: (e as Error).message };
    }
  }, [fetch?.raw]);

  return {
    fetch,
    ...parsed,
    loading,
    mirror: mirror ?? "",
    refresh: () => void load(mirror),
    saveMirror: async (m: string) => {
      setMirror(m);
      await api.setSetting(MIRROR_SETTING, m.trim());
      await load(m);
    },
  };
}

type StoreState = ReturnType<typeof useStoreIndex>;

/** 列表里的一项：在线的、装着的，或者两者都是 */
interface Item {
  id: string;
  name: string;
  description?: string;
  author?: string;
  keywords?: string[];
  version: string;
  entry?: StoreEntry;
  record?: PluginRecord;
  state: RowState | null;
}

type Tab = "all" | "installed" | "updates";

const fmtTime = (sec: number) =>
  new Date(sec * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 插件没有图标：拿名字第一个字做字标，颜色按 id 固定 —— 同一个插件每次都是同一个颜色 */
function Monogram({ id, name, size }: { id: string; name: string; size: number }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = PROJECT_COLORS[h % PROJECT_COLORS.length];
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.26,
        fontSize: size * 0.44,
        color,
        background: `color-mix(in srgb, ${color} 13%, var(--surface))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 26%, transparent)`,
      }}
    >
      {[...name][0] ?? "?"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 市场                                                                */
/* ------------------------------------------------------------------ */

export function PluginMarket({ onClose }: { onClose: () => void }) {
  const { records, booted } = useRegistry();
  const store = useStoreIndex();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ entry: StoreEntry; ask: PermissionAsk } | null>(null);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Esc 关窗。确认框开着时归确认框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirm) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirm]);

  const items = useMemo<Item[]>(() => {
    const byId = new Map(records.map((r) => [r.manifest.id, r]));
    const out: Item[] = (store.index?.plugins ?? []).map((entry) => {
      const record = byId.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        author: entry.author,
        keywords: entry.keywords,
        version: entry.version,
        entry,
        record,
        state: rowState(entry, record ? { version: record.manifest.version, dev: record.dev } : undefined),
      };
    });
    // 装着、但不在列表里的：第三方的、手动拷进来的、开发目录里的
    const listed = new Set(out.map((i) => i.id));
    for (const r of records) {
      if (listed.has(r.manifest.id)) continue;
      out.push({
        id: r.manifest.id,
        name: r.manifest.name,
        description: r.manifest.description,
        author: r.manifest.author,
        version: r.manifest.version,
        record: r,
        state: null,
      });
    }
    return out;
  }, [store.index, records]);

  const counts = {
    all: items.length,
    installed: items.filter((i) => i.record).length,
    updates: items.filter((i) => i.state?.kind === "update").length,
  };

  const shown = useMemo(() => {
    const inTab =
      tab === "installed"
        ? items.filter((i) => i.record)
        : tab === "updates"
          ? items.filter((i) => i.state?.kind === "update")
          : items;
    return searchPlugins(inTab, query);
  }, [items, tab, query]);

  // 选中项不在当前列表里（换了标签、搜没了）就落到第一个
  const current = shown.find((i) => i.id === selected) ?? shown[0] ?? null;

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = (entry: StoreEntry) =>
    act(entry.id, async () => {
      const before = plugins.getSnapshot().records.find((r) => r.manifest.id === entry.id);
      await api.storeInstall(entry.id, entry.download.url, entry.download.sha256, store.mirror.trim() || null);
      await plugins.rescan();
      if (before?.enabled) {
        await plugins.reload(entry.id);
      } else if (!before) {
        // 新装：确认过权限了，直接启用
        await plugins.enable(entry.id);
      }
      const after = plugins.getSnapshot().records.find((r) => r.manifest.id === entry.id);
      if (after?.status === "error") throw new Error(`装好了，但启用失败：${after.error ?? "未知原因"}`);
      setNotice(
        before
          ? `已更新到 v${entry.version}${before.enabled ? "" : "（仍是停用状态）"}`
          : `已安装并启用 v${entry.version}`,
      );
    });

  const startInstall = (entry: StoreEntry, record?: PluginRecord) => {
    const ask = permissionAsk(entry, record && !record.dev ? record.manifest : null);
    if (ask) setConfirm({ entry, ask });
    else void install(entry);
  };

  const uninstall = (r: PluginRecord) => {
    if (!window.confirm(`卸载「${r.manifest.name}」？\n\n插件保存的数据会保留，重新安装后还在。`)) return;
    void act(r.manifest.id, async () => {
      if (r.enabled) await plugins.disable(r.manifest.id);
      await api.uninstallPlugin(r.manifest.id);
      await plugins.rescan();
      setNotice(`已卸载「${r.manifest.name}」`);
    });
  };

  const status = (() => {
    const f = store.fetch;
    if (store.loading) return { text: "正在读取插件列表…", warn: false };
    if (!f) return { text: "", warn: false };
    if (f.error && f.fetched_at) return { text: `离线 · 显示 ${fmtTime(f.fetched_at)} 的列表`, warn: true, title: f.error };
    if (f.error) return { text: "没连上插件仓库", warn: true, title: f.error };
    return { text: f.fetched_at ? `${fmtTime(f.fetched_at)} 更新` : "", warn: false };
  })();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={onClose}
      className="fixed inset-0 z-[110] grid place-items-center bg-[rgba(12,20,22,0.42)] p-6 backdrop-blur-[3px]"
    >
      <motion.div
        role="dialog"
        aria-label="插件市场"
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.99 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex h-[min(760px,90vh)] w-[min(1120px,94vw)] overflow-hidden rounded-[14px] border border-[var(--rule-strong)] bg-[var(--surface)]"
        style={{ boxShadow: "var(--shadow-pop), 0 40px 80px -32px rgba(12, 20, 22, 0.45)" }}
      >
        {/* ---------------- 左：搜索 + 列表 ---------------- */}
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-[var(--rule)] bg-[var(--surface-alt)]">
          <div className="px-4 pt-4 pb-3">
            <div className="mb-3 flex items-center gap-2">
              <Icon name="plugin" size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="text-[15px] font-semibold text-[var(--text)]">插件市场</span>
            </div>
            <label className="flex items-center gap-2 rounded-[9px] border border-[var(--rule)] bg-[var(--surface)] px-2.5 transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_10%,transparent)]">
              <Icon name="search" size={13} className="shrink-0 text-[var(--text-dim)]" />
              <input
                ref={searchRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // ↑↓ 在列表里挪选中，不用离开搜索框
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  if (shown.length === 0) return;
                  const i = current ? shown.indexOf(current) : -1;
                  const next = e.key === "ArrowDown" ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1);
                  setSelected(shown[next].id);
                }}
                placeholder="搜索插件：名称、用途、关键词"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  aria-label="清空搜索"
                  className="text-[var(--text-dim)] hover:text-[var(--text)]"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </label>

            <div className="mt-3 flex gap-1">
              {(
                [
                  ["all", "全部"],
                  ["installed", "已安装"],
                  ["updates", "有更新"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    tab === key
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-[0_0_0_1px_var(--rule)]"
                      : "text-[var(--text-dim)] hover:text-[var(--text)]"
                  }`}
                >
                  {label}
                  <span
                    className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                      key === "updates" && counts.updates > 0
                        ? "bg-[var(--accent)] text-[var(--on-accent)]"
                        : "text-[var(--text-dim)]"
                    }`}
                  >
                    {counts[key]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="listbox" aria-label="插件列表">
            {store.parseError && (
              <div className="m-2 rounded-lg bg-[var(--danger)]/5 p-2.5 text-[11px] text-[var(--danger)]">
                {store.parseError}
              </div>
            )}
            {shown.length === 0 && !store.loading && (
              <div className="px-4 py-10 text-center text-[11.5px] leading-relaxed text-[var(--text-dim)]">
                {query
                  ? `没有和「${query}」匹配的插件`
                  : tab === "updates"
                    ? "都是最新的"
                    : tab === "installed"
                      ? "还没有装插件"
                      : store.fetch?.error
                        ? "连不上插件仓库，也没有之前的列表。检查网络或在下面填下载加速前缀"
                        : "列表里还没有插件"}
              </div>
            )}
            {shown.map((item) => (
              <ListRow
                key={item.id}
                item={item}
                active={current?.id === item.id}
                onSelect={() => setSelected(item.id)}
              />
            ))}
          </div>

          {/* 底栏：列表的新鲜度 + 刷新 + 下载加速 */}
          <div className="border-t border-[var(--rule)] px-4 py-2.5">
            <div className="flex items-center gap-2 text-[10.5px]">
              <span
                className={`min-w-0 flex-1 truncate ${status.warn ? "text-[var(--warn)]" : "text-[var(--text-dim)]"}`}
                title={status.title ?? status.text}
              >
                {status.text}
              </span>
              <button
                onClick={() => setMirrorOpen((v) => !v)}
                className={`shrink-0 ${mirrorOpen || store.mirror ? "text-[var(--accent)]" : "text-[var(--text-dim)]"} hover:text-[var(--text)]`}
                title="连 GitHub 慢时，填一个下载加速前缀"
              >
                加速{store.mirror ? " · 开" : ""}
              </button>
              <button
                onClick={store.refresh}
                disabled={store.loading}
                className="shrink-0 rounded-md border border-[var(--rule)] px-2 py-0.5 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
              >
                {store.loading ? "…" : "刷新"}
              </button>
            </div>
            {mirrorOpen && <MirrorField store={store} />}
          </div>
        </aside>

        {/* ---------------- 右：详情 ---------------- */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          <button
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
            className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={14} />
          </button>

          {current ? (
            <Detail
              key={current.id}
              item={current}
              busy={busy === current.id}
              anyBusy={busy != null || !booted}
              error={error}
              notice={notice}
              onInstall={() => current.entry && startInstall(current.entry, current.record)}
              onToggle={(r) =>
                void act(r.manifest.id, () => (r.enabled ? plugins.disable(r.manifest.id) : plugins.enable(r.manifest.id)))
              }
              onReload={(r) => void act(r.manifest.id, () => plugins.reload(r.manifest.id))}
              onUninstall={uninstall}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-[12px] text-[var(--text-dim)]">
              {store.loading ? "正在读取插件列表…" : "选一个插件看详情"}
            </div>
          )}
        </section>
      </motion.div>

      <AnimatePresence>
        {confirm && (
          <PermissionDialog
            entry={confirm.entry}
            ask={confirm.ask}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const e = confirm.entry;
              setConfirm(null);
              void install(e);
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* 列表行                                                              */
/* ------------------------------------------------------------------ */

function stateBadge(item: Item): { text: string; tone: "accent" | "ok" | "dim" | "warn" | "dev" } | null {
  const r = item.record;
  if (r?.dev) return { text: "本地开发", tone: "dev" };
  if (item.state?.kind === "update") return { text: "可更新", tone: "accent" };
  if (r?.status === "error") return { text: "出错", tone: "warn" };
  if (r?.enabled) return { text: "已启用", tone: "ok" };
  if (r) return { text: "已停用", tone: "dim" };
  if (item.state?.kind === "incompatible") return { text: "需升级应用", tone: "warn" };
  return null;
}

const TONE: Record<string, string> = {
  accent: "bg-[var(--accent)] text-[var(--on-accent)]",
  ok: "text-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]",
  dim: "text-[var(--text-dim)] bg-[var(--surface-sunk)]",
  warn: "text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)]",
  dev: "text-[var(--milestone)] bg-[color-mix(in_srgb,var(--milestone)_14%,transparent)]",
};

function ListRow({ item, active, onSelect }: { item: Item; active: boolean; onSelect: () => void }) {
  const badge = stateBadge(item);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-[10px] px-2.5 py-3 text-left transition-colors ${
        active ? "bg-[var(--surface)] shadow-[0_0_0_1px_var(--rule)]" : "hover:bg-[var(--row-hover)]"
      }`}
    >
      <Monogram id={item.id} name={item.name} size={36} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-[var(--text)]">{item.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">v{item.version}</span>
        </span>
        {item.description && (
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-[17px] text-[var(--text-dim)]">
            {item.description}
          </span>
        )}
      </span>
      {badge && (
        <span className={`mt-0.5 shrink-0 rounded-full px-2 py-px text-[10px] font-medium ${TONE[badge.tone]}`}>
          {badge.text}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

function Detail({
  item,
  busy,
  anyBusy,
  error,
  notice,
  onInstall,
  onToggle,
  onReload,
  onUninstall,
}: {
  item: Item;
  busy: boolean;
  anyBusy: boolean;
  error: string | null;
  notice: string | null;
  onInstall: () => void;
  onToggle: (r: PluginRecord) => void;
  onReload: (r: PluginRecord) => void;
  onUninstall: (r: PluginRecord) => void;
}) {
  const { entry, record: r, state } = item;
  const exec = entry?.exec ?? r?.manifest.permissions?.exec ?? [];
  const ai = entry?.ai ?? r?.manifest.permissions?.ai ?? false;
  const skills = entry?.skills ?? r?.manifest.skills?.map((s) => s.name) ?? [];

  const primary = (() => {
    if (busy) return { label: "处理中…", run: undefined };
    if (state?.kind === "install") return { label: "安装", run: onInstall };
    if (state?.kind === "update") return { label: `更新到 v${entry!.version}`, run: onInstall };
    return null;
  })();

  const ghost =
    "h-8 rounded-lg border border-[var(--rule)] px-3 text-[12px] text-[var(--text)] transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="border-b border-[var(--rule)] px-8 pt-7 pb-6">
        <div className="flex items-start gap-5 pr-10">
          <Monogram id={item.id} name={item.name} size={64} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[20px] font-semibold leading-tight text-[var(--text)]">{item.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--text-dim)]">
              <span className="font-mono">{item.id}</span>
              <span className="text-[var(--rule-strong)]">·</span>
              <span className="font-mono">v{item.version}</span>
              {r && state?.kind === "update" && <span>（本机 v{r.manifest.version}）</span>}
              {item.author && (
                <>
                  <span className="text-[var(--rule-strong)]">·</span>
                  <span>{item.author}</span>
                </>
              )}
              {!entry && r && !r.dev && (
                <span title="不在在线插件列表里，不检查更新" className={`rounded-full px-2 py-px text-[10px] ${TONE.dim}`}>
                  本地
                </span>
              )}
              {r?.dev && (
                <span title={r.path} className={`rounded-full px-2 py-px text-[10px] font-medium ${TONE.dev}`}>
                  本地开发
                </span>
              )}
            </div>
            {item.description && (
              <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-[var(--text)]">{item.description}</p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {primary && (
                <button
                  onClick={primary.run}
                  disabled={!primary.run || anyBusy}
                  className="h-8 rounded-lg px-4 text-[12px] font-medium text-[var(--on-accent)] transition-[filter,transform] hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  {primary.label}
                </button>
              )}
              {r && (
                <button onClick={() => onToggle(r)} disabled={anyBusy} className={ghost}>
                  {r.enabled ? "停用" : "启用"}
                </button>
              )}
              {r?.enabled && (
                <button onClick={() => onReload(r)} disabled={anyBusy} className={ghost} title="重新加载插件代码，不用重启应用">
                  重新加载
                </button>
              )}
              {/* 开发目录的插件不卸载：那是你的源码。在设置 → 插件 → 开发者模式里移除 */}
              {r && !r.dev && (
                <button
                  onClick={() => onUninstall(r)}
                  disabled={anyBusy}
                  className={`${ghost} hover:text-[var(--danger)]`}
                  title="删除插件代码，插件保存的数据保留"
                >
                  卸载
                </button>
              )}
              {state?.kind === "current" && !busy && (
                <span className="text-[11.5px] text-[var(--text-dim)]">已是最新版</span>
              )}
            </div>

            {state?.kind === "incompatible" && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-[11.5px] ${TONE.warn}`}>{state.reason}</div>
            )}
            {state?.kind === "newer" && (
              <div className="mt-3 text-[11.5px] text-[var(--text-dim)]">
                本机装的 v{state.installed} 比列表里的新
              </div>
            )}
            {state?.kind === "dev" && (
              <div className="mt-3 text-[11.5px] text-[var(--text-dim)]">
                正在用开发目录里的源码。到设置 → 插件 → 开发者模式移除它之后才能在线安装
              </div>
            )}
            {r?.status === "error" && r.error && (
              <div className="mt-3 break-all rounded-lg bg-[var(--danger)]/5 px-3 py-2 text-[11.5px] text-[var(--danger)]">
                {r.error}
              </div>
            )}
            {error && (
              <div className="mt-3 break-all rounded-lg bg-[var(--danger)]/5 px-3 py-2 text-[11.5px] text-[var(--danger)]">
                {error}
              </div>
            )}
            {notice && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-[11.5px] ${TONE.ok}`}>✓ {notice}</div>
            )}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-8 px-8 py-6">
        <article className="min-w-0">
          {entry?.readme ? (
            // README 开头的「# 插件名」和上面的抬头重复，去掉
            <Markdown source={entry.readme.replace(/^\s*#\s[^\n]*\n+/, "")} />
          ) : (
            <p className="text-[12px] text-[var(--text-dim)]">这个插件没有附带说明。</p>
          )}
        </article>

        <aside className="space-y-5 text-[11.5px]">
          <Meta label="权限">
            {exec.length === 0 && skills.length === 0 && !ai ? (
              <span className="text-[var(--text-dim)]">不运行本机程序</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {ai && (
                  <code className="rounded bg-[var(--surface-sunk)] px-1.5 py-0.5 font-mono text-[10.5px]" title="零工具：读不了文件、跑不了命令">
                    发给 Claude
                  </code>
                )}
                {exec.map((p) => (
                  <code key={p} className="rounded bg-[var(--surface-sunk)] px-1.5 py-0.5 font-mono text-[10.5px]">
                    运行 {p}
                  </code>
                ))}
                {skills.map((sk) => (
                  <code key={sk} className="rounded bg-[var(--surface-sunk)] px-1.5 py-0.5 font-mono text-[10.5px]">
                    Skill {sk}
                  </code>
                ))}
              </div>
            )}
            <div className="mt-1.5 leading-relaxed text-[var(--text-dim)]">能读取全部项目数据</div>
          </Meta>
          {entry && (
            <Meta label="插件接口">
              <span className="font-mono">{entry.apiVersion}</span>
            </Meta>
          )}
          {entry && entry.download.size > 0 && (
            <Meta label="大小">{(entry.download.size / 1024).toFixed(1)} KB</Meta>
          )}
          {entry && entry.keywords.length > 0 && (
            <Meta label="关键词">
              <div className="flex flex-wrap gap-1">
                {entry.keywords.map((k) => (
                  <span key={k} className="rounded-full border border-[var(--rule)] px-2 py-px text-[10.5px] text-[var(--text-dim)]">
                    {k}
                  </span>
                ))}
              </div>
            </Meta>
          )}
          {r && (
            <Meta label="位置">
              <span className="break-all font-mono text-[10.5px] text-[var(--text-dim)]">{r.path}</span>
            </Meta>
          )}
        </aside>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-medium tracking-[0.06em] text-[var(--text-dim)]">{label}</div>
      <div className="text-[var(--text)]">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 下载加速前缀                                                        */
/* ------------------------------------------------------------------ */

/** 存在设置里，index 和 zip 都走它；sha256 校验保证镜像改不了装进来的内容 */
function MirrorField({ store }: { store: StoreState }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? store.mirror;
  const problem = mirrorProblem(value);

  const commit = () => {
    if (draft == null || problem || draft.trim() === store.mirror.trim()) return;
    void store.saveMirror(draft).finally(() => setDraft(null));
  };

  return (
    <div className="mt-2">
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-label="下载加速前缀"
        placeholder="留空直连 GitHub；例如 https://ghproxy.net/"
        spellCheck={false}
        className="w-full rounded-md border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 font-mono text-[10.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />
      <div className={`mt-1 text-[10px] leading-relaxed ${problem ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}`}>
        {problem ?? "下载后会校验 sha256，镜像改不了装进来的内容"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 权限确认                                                            */
/* ------------------------------------------------------------------ */

/**
 * 装之前的确认。新装列出全部能力，确认后直接启用；更新只在能力变多时出现，只列新增的。
 * 插件和宿主同一个 WebView，没有沙箱 —— 这一步就是边界
 */
function PermissionDialog({
  entry,
  ask,
  onCancel,
  onConfirm,
}: {
  entry: StoreEntry;
  ask: PermissionAsk;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onCancel();
      }}
      className="fixed inset-0 z-[130] grid place-items-center bg-black/30"
    >
      <motion.div
        role="alertdialog"
        aria-label={`安装 ${entry.name}`}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ type: "spring", stiffness: 340, damping: 28 }}
        onPointerDown={(e) => e.stopPropagation()}
        className="w-[420px] rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <Monogram id={entry.id} name={entry.name} size={36} />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-[var(--text)]">
              {ask.added ? `更新「${entry.name}」需要新的权限` : `安装「${entry.name}」v${entry.version}？`}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
              {entry.author ? `${entry.author} · ` : ""}来自 GitHub 上的 SuperGantt 插件仓库
            </div>
          </div>
        </div>

        <ul className="mt-4 space-y-2 text-[12px] leading-relaxed text-[var(--text)]">
          {!ask.added && <li>● 能读取你全部的项目、任务和事项，能修改任务（可撤销）</li>}
          {ask.ai && (
            <li>
              ● {ask.added ? "新增：" : ""}会把项目数据（任务名、负责人、记录内容）发给 Claude。Claude 是零工具调用，读不了文件、跑不了命令
            </li>
          )}
          {ask.exec.length > 0 && (
            <li>
              ● {ask.added ? "新增：" : ""}能运行本机程序{" "}
              {ask.exec.map((p) => (
                <code key={p} className="mx-0.5 rounded bg-[var(--surface-sunk)] px-1 font-mono text-[11px]">
                  {p}
                </code>
              ))}
            </li>
          )}
          {ask.skills.length > 0 && (
            <li>
              ● {ask.added ? "新增：" : ""}启用时把 Skill{" "}
              {ask.skills.map((sk) => (
                <code key={sk} className="mx-0.5 rounded bg-[var(--surface-sunk)] px-1 font-mono text-[11px]">
                  {sk}
                </code>
              ))}{" "}
              链接到 ~/.claude/skills
            </li>
          )}
          {!ask.added && <li className="text-[var(--text-dim)]">装好后立即启用，随时可以停用或卸载</li>}
        </ul>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-[12px] text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="h-8 rounded-lg px-4 text-[12px] font-medium text-[var(--on-accent)]"
            style={{ background: "var(--accent)" }}
          >
            {ask.added ? "同意并更新" : "安装并启用"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** 挂在工作区根上；开关在 store 里，工具条和设置页都能打开 */
export function PluginMarketHost() {
  const open = useAppStore((s) => s.pluginMarketOpen);
  const setOpen = useAppStore((s) => s.setPluginMarketOpen);
  return <AnimatePresence>{open && <PluginMarket onClose={() => setOpen(false)} />}</AnimatePresence>;
}
