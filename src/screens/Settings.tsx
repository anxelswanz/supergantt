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
import { REVEAL_LABEL, shortcut } from "../core/keys";
import { APP_VIEWS, PERMANENT_VIEW } from "../core/views";
import { BLOCKER_KIND, RISK_KIND, newKindKey } from "../core/items";
import type { ItemKind } from "../db/api";
import { plugins } from "../plugins/registry";
import { compareVersions, validateManifest } from "../plugins/manifest";
import type { PluginRecord, PluginSettingField } from "../plugins/types";
import { useRegistry } from "../plugins/usePlugins";
import {
  resolveDark,
  THEME_MODE_HINTS,
  THEME_MODE_LABELS,
  THEME_MODES,
} from "../core/themeMode";
import { exportDatabaseFile } from "../transfer/projectFile";
import { Avatar, fileToAvatarDataUrl } from "./Avatar";
import { CalendarPane } from "./CalendarSettings";
import { ExportButton } from "./ExportButton";

type Tab = "appearance" | "views" | "kinds" | "people" | "calendar" | "plugins" | "data";

const TABS: { id: Tab; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "views", label: "视图" },
  { id: "kinds", label: "事项类型" },
  { id: "people", label: "负责人" },
  { id: "calendar", label: "工作日历" },
  { id: "plugins", label: "插件" },
  { id: "data", label: "数据" },
];

export function Settings({
  onClose,
  initialTab = "appearance",
}: {
  onClose: () => void;
  /** 打开哪一页；分拣菜单会直接送到「事项类型」 */
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(
    // 认不出的页签回退到外观：这个值由调用方传入，不可信
    (TABS.some((t) => t.id === initialTab) ? initialTab : "appearance") as Tab,
  );

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
          {tab === "views" && <ViewsPane />}
          {tab === "kinds" && <ItemKindsPane />}
          {tab === "people" && <PeoplePane />}
          {tab === "calendar" && <CalendarPane />}
          {tab === "plugins" && <PluginsPane />}
          {tab === "data" && <DataPane />}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

/** 「停用」和「出错」要是两种颜色，不能混成一种 */
const PLUGIN_STATUS: Record<PluginRecord["status"], { label: string; cls: string }> = {
  loaded: { label: "已启用", cls: "text-[var(--ok)]" },
  disabled: { label: "已停用", cls: "text-[var(--text-dim)]" },
  error: { label: "出错", cls: "text-[var(--danger)]" },
};

function PluginsPane() {
  const { records, settingFields, booted, bootError } = useRegistry();

  const [dir, setDir] = useState("");
  const [message, setMessage] = useState("");
  /** 多个插件的操作可以同时进行，所以用集合而不是单个 id */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    void api
      .pluginsDir()
      .then((p) => {
        if (live) setDir(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /**
   * 插件异常不能冒到事件处理器外：React 19 的默认行为是整个根卸载，
   * 用户看到白屏且找不到原因。
   */
  const run = (pluginId: string, fn: () => Promise<void>): void => {
    setBusy((prev) => new Set(prev).add(pluginId));
    void fn()
      .catch((e: unknown) => setMessage(`${pluginId}：${(e as Error)?.message ?? e}`))
      .finally(() => {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      });
  };

  return (
    <Section
      title="插件"
      desc="插件可以添加视图，也可以修改任务数据（可撤销）。改完代码后点「重新加载」生效。"
    >
      <div className="mb-3 break-all rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] p-2.5 font-mono text-[10px] text-[var(--text-dim)]">
        {dir || "读取中…"}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void api.revealPluginsDir().catch(() => {})}
          className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          {REVEAL_LABEL}
        </button>
        <span className="text-[10px] text-[var(--text-dim)]">
          装插件：把文件夹拷进这个目录
        </span>
      </div>

      {message && (
        <div className="mb-3 break-all rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/5 p-2 text-[10px] text-[var(--danger)]">
          {message}
        </div>
      )}

      {/* 目录读不了是整页的问题，和单个插件出错分开显示 */}
      {bootError && (
        <div className="mb-3 break-all rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/5 p-2.5 text-[10px] leading-relaxed text-[var(--danger)]">
          {bootError}
        </div>
      )}

      <BundledList records={records} onError={setMessage} />

      {!booted && <p className="text-xs text-[var(--text-dim)]">正在扫描插件目录…</p>}

      {booted && records.length === 0 && !bootError && (
        <div className="rounded-lg border border-dashed border-[var(--rule)] p-4 text-xs leading-relaxed text-[var(--text-dim)]">
          还没有插件。在插件目录里新建一个文件夹，放两个文件：
          <div className="my-2 rounded bg-[var(--surface-alt)] p-2 font-mono text-[10px] leading-relaxed">
            quicknote/manifest.json
            <br />
            quicknote/main.js
          </div>
          manifest.json 里写 id、name、version、apiVersion；
          main.js 导出 <code>onload(api)</code>，再用 <code>api.views.register(...)</code>
          注册视图。重启应用后出现在这里。
        </div>
      )}

      <div className="space-y-2">
        {records.map((r) => {
          const status = PLUGIN_STATUS[r.status];
          const isBusy = busy.has(r.manifest.id) || !booted;
          const fields = settingFields.filter((f) => f.pluginId === r.manifest.id);

          return (
            <div
              key={r.manifest.id}
              className="rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] p-3"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-xs font-semibold text-[var(--text)]">
                      {r.manifest.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">
                      v{r.manifest.version}
                    </span>
                    <span className={`shrink-0 text-[10px] font-medium ${status.cls}`}>
                      {status.label}
                    </span>
                  </div>
                  {r.manifest.description && (
                    <div className="mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
                      {r.manifest.description}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-[10px] text-[var(--text-dim)]">
                    {r.manifest.id}
                    {r.manifest.author ? `（${r.manifest.author}）` : ""}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {r.enabled && (
                    <button
                      onClick={() => run(r.manifest.id, () => plugins.reload(r.manifest.id))}
                      disabled={isBusy}
                      title="重新加载插件代码，不用重启应用"
                      className="rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
                    >
                      {isBusy ? "…" : "重新加载"}
                    </button>
                  )}
                  {!r.enabled && (
                    <button
                      onClick={() => {
                        if (
                          !window.confirm(
                            `卸载「${r.manifest.name}」？\n\n插件保存的数据会保留，重新安装后还在。`,
                          )
                        )
                          return;
                        run(r.manifest.id, async () => {
                          await api.uninstallPlugin(r.manifest.id);
                          await plugins.rescan();
                        });
                      }}
                      disabled={isBusy}
                      title="删除插件代码，插件保存的数据保留"
                      className="rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)] disabled:opacity-50"
                    >
                      卸载
                    </button>
                  )}
                  <button
                    onClick={() =>
                      run(r.manifest.id, () =>
                        r.enabled ? plugins.disable(r.manifest.id) : plugins.enable(r.manifest.id),
                      )
                    }
                    disabled={isBusy}
                    className={`rounded-lg px-2.5 py-1 text-[10px] font-medium disabled:opacity-50 ${
                      r.enabled
                        ? "border border-[var(--rule)] text-[var(--text-dim)] hover:text-[var(--text)]"
                        : "bg-[var(--accent)] text-white"
                    }`}
                  >
                    {r.enabled ? "停用" : "启用"}
                  </button>
                </div>
              </div>

              {r.error && (
                <div className="mt-2 break-all rounded-lg bg-[var(--danger)]/5 p-2 text-[10px] leading-relaxed text-[var(--danger)]">
                  {r.error}
                </div>
              )}

              {r.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {r.warnings.map((w) => (
                    <li key={w} className="text-[10px] leading-relaxed text-[var(--warn)]">
                      ● {w}
                    </li>
                  ))}
                </ul>
              )}

              {fields.length > 0 && (
                <div className="mt-3 border-t border-[var(--rule)] pt-3">
                  {fields.map(({ field }) => (
                    <PluginFieldRow key={field.key} pluginId={r.manifest.id} field={field} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-dim)]">
        本软件的插件接口版本是{" "}
        <span className="font-mono">
          {plugins.hostVersion().major}.{plugins.hostVersion().minor}
        </span>
        。插件的 manifest 里 apiVersion 主版本必须与之一致，否则无法加载；次版本不同只提示警告。
        <br />
        插件能读到全部数据，只装可信来源的插件。
      </p>
    </Section>
  );
}

/** 随应用附带、可一键安装的插件。一个都没有时整段不出现；已装的也列出，按钮写「已安装」。 */
function BundledList({ records, onError }: { records: PluginRecord[]; onError: (m: string) => void }) {
  const [list, setList] = useState<
    { id: string; name: string; version: string; description?: string; installed: string | null }[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .listBundledPlugins()
      .then((raw) =>
        setList(
          raw.flatMap((b) => {
            const m = validateManifest(b.manifest_raw, b.dir_name);
            if (!m.ok) return [];
            let installed: string | null = null;
            if (b.installed_manifest_raw) {
              try {
                installed = String(JSON.parse(b.installed_manifest_raw).version ?? "0.0.0");
              } catch {
                installed = "0.0.0";
              }
            }
            return [
              {
                id: m.manifest.id,
                name: m.manifest.name,
                version: m.manifest.version,
                description: m.manifest.description,
                installed,
              },
            ];
          }),
        ),
      )
      .catch(() => setList([]));

  // records 变了（装了、卸了）就重读一遍已安装版本
  useEffect(() => {
    void load();
  }, [records]);

  if (list.length === 0) return null;

  const install = async (id: string) => {
    setBusy(id);
    try {
      const wasEnabled = records.find((r) => r.manifest.id === id)?.enabled ?? false;
      await api.installBundledPlugin(id);
      await plugins.rescan();
      // 更新正在使用的插件：重载让新代码立刻生效
      if (wasEnabled) await plugins.reload(id);
      await load();
    } catch (e) {
      onError(`${id}：${(e as Error)?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[10px] font-medium text-[var(--text-dim)]">可安装</div>
      <div className="space-y-1.5">
        {list.map((b) => {
          const state =
            b.installed == null ? "install" : compareVersions(b.version, b.installed) > 0 ? "update" : "current";
          return (
            <div
              key={b.id}
              className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--rule)] p-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-semibold text-[var(--text)]">{b.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">v{b.version}</span>
                </div>
                {b.description && (
                  <div className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-dim)]">{b.description}</div>
                )}
              </div>
              <button
                onClick={() => void install(b.id)}
                disabled={state === "current" || busy === b.id}
                className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium disabled:opacity-50 ${
                  state === "current"
                    ? "border border-[var(--rule)] text-[var(--text-dim)]"
                    : "bg-[var(--accent)] text-white"
                }`}
              >
                {busy === b.id
                  ? "…"
                  : state === "install"
                    ? "安装"
                    : state === "update"
                      ? `更新（当前 v${b.installed}）`
                      : "已安装"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 插件注册的一个设置项。
 *
 * 值直接读写 registry 的 settingCache，不经过本地 state：两份状态会分叉成
 * 「界面显示 A、插件拿到 B」。bump 只用来在写入后强制重渲染。
 */
function PluginFieldRow({ pluginId, field }: { pluginId: string; field: PluginSettingField }) {
  const [, bump] = useState(0);
  const raw = plugins.settingValue(pluginId, field.key);

  const write = (value: string) => {
    // key 前缀由 setSettingValue 拼，这里不要重复拼
    plugins.setSettingValue(pluginId, field.key, value);
    bump((n) => n + 1);
  };

  const label = (
    <div className="mb-1 text-[10px] font-medium text-[var(--text)]">{field.label}</div>
  );

  return (
    <div className="mb-3 last:mb-0">
      {label}
      {field.kind === "text" && (
        <input
          value={raw ?? field.def ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => write(e.target.value)}
          className="w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      )}

      {field.kind === "toggle" && (
        <button
          onClick={() => write(raw === "true" ? "false" : "true")}
          className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium ${
            raw === "true"
              ? "border-transparent bg-[var(--accent)] text-white"
              : "border-[var(--rule)] text-[var(--text-dim)]"
          }`}
        >
          {raw === "true" ? "开" : "关"}
        </button>
      )}

      {field.kind === "select" && (
        <select
          value={raw ?? field.def ?? ""}
          onChange={(e) => write(e.target.value)}
          className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {field.desc && (
        <div className="mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">{field.desc}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 视图与事项类型                                                       */
/* ------------------------------------------------------------------ */

/**
 * 视图页：只管开关哪些视图。
 *
 * 事项类型搬到了自己那一页 —— 清单会长，需要搜索框和分页。
 */
function ViewsPane() {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <Section
      title="启用哪些视图"
      desc="关掉的视图从工具条移除，快捷键编号依次前移。所有项目通用。"
    >
      <ViewToggles />

      <button
        onClick={() => openSettings("kinds")}
        className="mt-4 text-[10px] text-[var(--text-dim)] underline hover:text-[var(--text)]"
      >
        管理事项类型 →
      </button>
    </Section>
  );
}

function ViewToggles() {
  const enabled = useAppStore((s) => s.enabledViews);
  const setViewEnabled = useAppStore((s) => s.setViewEnabled);

  return (
    <div className="flex flex-col gap-1.5">
      {APP_VIEWS.map((v) => {
        const permanent = v.key === PERMANENT_VIEW;
        const on = permanent || enabled.includes(v.key);
        // 编号按启用后的次序算，和工具条、快捷键一致
        const index = enabled.indexOf(v.key);
        return (
          <button
            key={v.key}
            onClick={() => setViewEnabled(v.key, !on)}
            disabled={permanent}
            title={
              permanent
                ? "甘特是唯一能拖日期、改工期的视图，不能关闭"
                : v.hint
            }
            className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition-colors ${
              on
                ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                : "border-[var(--rule)] hover:border-[var(--text-dim)]"
            } disabled:cursor-default`}
          >
            <span
              className="grid size-4 shrink-0 place-items-center rounded text-[10px] leading-none text-white"
              style={{ background: on ? "var(--accent)" : "var(--rule)" }}
            >
              {on ? "✓" : ""}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="text-xs font-semibold text-[var(--text)]">{v.label}</span>
                {on && index >= 0 && (
                  <kbd className="font-mono text-[9px] text-[var(--text-dim)]">
                    {shortcut("mod", String(index + 1))}
                  </kbd>
                )}
                {permanent && (
                  <span className="ml-auto text-[9px] text-[var(--text-dim)]">不可关闭</span>
                )}
              </span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--text-dim)]">
                {v.hint}
              </span>
            </span>
          </button>
        );
      })}

      <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
        关闭正在看的视图会切回甘特。关闭不会删数据，重新打开就回来了。
      </p>
    </div>
  );
}

/**
 * 事项类型页。
 *
 * 阻碍和风险是实体不是类型，不在这张清单里。类型清单会长，所以带搜索和分页；
 * 每页 6 条，搜索跨全部类型，超过一页才出现翻页控件。
 */

/** 每页 6 条：6 行加头、新建和翻页刚好不出滚动条 */
const KINDS_PER_PAGE = 6;

function ItemKindsPane() {
  const kinds = useAppStore((s) => s.itemKinds);
  const saveItemKind = useAppStore((s) => s.saveItemKind);
  const removeItemKind = useAppStore((s) => s.removeItemKind);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const q = query.trim().toLowerCase();
  // 搜索跨全部类型，不只是当前页
  const shown = q
    ? kinds.filter(
        (k) => k.label.toLowerCase().includes(q) || k.key.toLowerCase().includes(q),
      )
    : kinds;

  const pages = Math.max(1, Math.ceil(shown.length / KINDS_PER_PAGE));
  // 删掉几条后当前页可能越界，夹回最后一页
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * KINDS_PER_PAGE, (current + 1) * KINDS_PER_PAGE);

  const builtin = kinds.filter((k) => k.builtin).length;

  return (
    <Section
      title="事项类型"
      desc="分拣事项时可选的类型，所有项目共用。"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-dim)]">
          共 {kinds.length} 个（{builtin} 个内置）
          {q && shown.length !== kinds.length && `，筛出 ${shown.length} 个`}
        </span>

        {/* 类型多于一页才给搜索框 */}
        {kinds.length > KINDS_PER_PAGE && (
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0); // 换了筛选条件，回到第一页
            }}
            placeholder="搜索类型…"
            className="ml-auto w-28 rounded-[var(--r-m)] border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-0.5 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        )}

        <ExportButton
          label="⤓ 导出"
          title="导出类型清单为 Excel：名称、颜色、关闭规则、本项目用量"
          size="sm"
          run={async () => (await import("../export/run")).exportItemKindsToExcel()}
        />
      </div>

      {/* 「新建类型」钉在列表上方，位置不随条数变 */}
      {adding ? (
        <div className="mb-1.5">
          <KindRow
            kind={{
              key: newKindKey(),
              label: "",
              color: PROJECT_COLORS[kinds.length % PROJECT_COLORS.length],
              requiresNote: false,
              builtin: false,
              sortOrder: kinds.length,
            }}
            draft
            onSave={(label, color, requiresNote) => {
              void saveItemKind(newKindKey(), label, color, requiresNote);
              setAdding(false);
              setQuery("");
              // 新建的排在最后，翻到它所在的那一页
              setPage(Math.floor(kinds.length / KINDS_PER_PAGE));
            }}
            onDelete={() => setAdding(false)}
          />
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mb-1.5 w-full rounded-xl border border-dashed border-[var(--rule)] py-1.5 text-[11px] text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          ＋ 新建类型
        </button>
      )}

      <div className="flex flex-col gap-1.5">
        {slice.map((k) => (
          <KindRow
            key={k.key}
            kind={k}
            onSave={(label, color, requiresNote) =>
              void saveItemKind(k.key, label, color, requiresNote)
            }
            onDelete={async () => {
              const n = await removeItemKind(k.key);
              setNotice(
                n > 0
                  ? `已删除。${n} 条事项退回「未分拣」，内容不受影响。`
                  : "已删除。",
              );
            }}
          />
        ))}

        {slice.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--rule)] py-6 text-center text-[10px] text-[var(--text-dim)]">
            没有匹配「{query}」的类型。
          </div>
        )}
      </div>

      {pages > 1 && (
        <div className="mt-2 flex items-center justify-center gap-2">
          <PageButton disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹
          </PageButton>
          <span className="font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
            {current + 1} / {pages}
          </span>
          <PageButton disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            ›
          </PageButton>
        </div>
      )}

      {notice && (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--ok)]">{notice}</p>
      )}

      <div className="mt-4 rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-2">
        <div className="mb-1 text-[10px] font-semibold text-[var(--text)]">
          为什么这里没有「阻碍」和「风险」
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--text-dim)]">
          它们会建立真实的记录，不只是标签。分拣成
          <span style={{ color: BLOCKER_KIND.color }}> 阻碍 </span>会在任务上记一段受阻：每天顺延计划结束日，计入复盘，卡片进入看板的受阻列。分拣成
          <span style={{ color: RISK_KIND.color }}> 风险 </span>会写进风险表。
        </p>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-dim)]">
        打开「关闭需写结论」后，关闭这类事项必须写一句怎么解决的，复盘时能看到。
        「代办」默认关闭，「问题」默认打开。
      </p>
    </Section>
  );
}

function PageButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 place-items-center rounded border border-[var(--rule)] text-[11px] leading-none text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function KindRow({
  kind,
  draft,
  onSave,
  onDelete,
}: {
  kind: ItemKind;
  /** 还没保存的新类型：直接进编辑态，取消就消失 */
  draft?: boolean;
  onSave: (label: string, color: string, requiresNote: boolean) => void;
  onDelete: () => void | Promise<void>;
}) {
  const [label, setLabel] = useState(kind.label);
  const [color, setColor] = useState(kind.color);
  const [requiresNote, setRequiresNote] = useState(kind.requiresNote);
  const [confirming, setConfirming] = useState(false);

  const dirty =
    label.trim() !== kind.label ||
    color !== kind.color ||
    requiresNote !== kind.requiresNote;

  return (
    <div className="flex items-center gap-2 rounded-xl border border-[var(--rule)] px-2.5 py-2">
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        title="标签颜色"
        className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      {/* 类型名会显示成事项行上的小标签，在入口处限长，避免到处截断 */}
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="类型名称"
        maxLength={12}
        autoFocus={draft}
        title="最多 12 字"
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-[var(--text)] outline-none hover:border-[var(--rule)] focus:border-[var(--accent)]"
      />

      <button
        onClick={() => setRequiresNote((v) => !v)}
        title="关闭这类事项时是否必须写一句怎么解决的"
        className="shrink-0 rounded-[var(--r-m)] border px-2 py-0.5 text-[9px] font-medium transition-colors"
        style={
          requiresNote
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : { borderColor: "var(--rule)", color: "var(--text-dim)" }
        }
      >
        {requiresNote ? "关闭需写结论" : "关闭即完成"}
      </button>

      {kind.builtin && (
        <span className="shrink-0 text-[9px] text-[var(--text-dim)]" title="内置类型可改名改色，但不能删">
          内置
        </span>
      )}

      {(dirty || draft) && label.trim() && (
        <button
          onClick={() => onSave(label, color, requiresNote)}
          className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          保存
        </button>
      )}

      {!kind.builtin &&
        (confirming ? (
          <button
            onClick={() => void onDelete()}
            className="shrink-0 rounded-md bg-[var(--danger)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--danger)]"
            title="用着这个类型的事项会改回「未分拣」，内容不丢"
          >
            {draft ? "取消" : "确认删除"}
          </button>
        ) : (
          <button
            onClick={() => (draft ? void onDelete() : setConfirming(true))}
            className="grid size-5 shrink-0 place-items-center rounded text-[11px] text-[var(--text-dim)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
            title={draft ? "取消" : "删除这个类型"}
          >
            {draft ? "✕" : "🗑"}
          </button>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 外观                                                                */
/* ------------------------------------------------------------------ */

function AppearancePane() {
  const colorBy = useAppStore((s) => s.colorBy);
  const setColorBy = useAppStore((s) => s.setColorBy);

  const hints: Record<ColorBy, string> = {
    stage: "每个顶层任务一个颜色，子任务用同色系的深浅变化。",
    assignee: "用负责人的头像颜色，未指派显示灰色。",
    priority: "按紧急程度着色，P0 始终是红色。",
    none: "全部用项目颜色，适合打印。",
  };

  return (
    <Section
      title="主题"
      desc="选浅色或深色后，不再随系统切换。"
    >
      <ThemePicker />

      <div className="mt-8">
      <Section title="甘特条着色" desc="选择按什么给甘特条上色。">
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
      </Section>
      </div>

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

/**
 * 主题三选一。
 *
 * 用竖排的单选列表而不是并排的三个色块：三档的差别是**行为**（跟不跟系统走），
 * 不是外观，需要一句话说清楚。色块预览只对「浅色/深色」有意义，
 * 「跟随系统」没有确定的外观可预览 —— 三个并排会诱导人按颜色挑，
 * 而真正该被读的是那句说明。
 */
function ThemePicker() {
  const themeMode = useAppStore((s) => s.themeMode);
  const systemDark = useAppStore((s) => s.systemDark);
  const setThemeMode = useAppStore((s) => s.setThemeMode);

  return (
    <div className="flex flex-col gap-2">
      {THEME_MODES.map((mode) => {
        // 每一档都画出它此刻实际会呈现的样子，用户不用切过去才知道
        const previewDark = resolveDark(mode, systemDark);
        const active = themeMode === mode;
        return (
          <button
            key={mode}
            onClick={() => setThemeMode(mode)}
            className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
              active
                ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                : "border-[var(--rule)] hover:border-[var(--text-dim)]"
            }`}
          >
            <ThemeSwatch dark={previewDark} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                {THEME_MODE_LABELS[mode]}
                {mode === "system" && (
                  <span className="rounded px-1 py-px text-[9px] font-medium text-[var(--text-dim)] ring-1 ring-[var(--rule)]">
                    系统当前{systemDark ? "深色" : "浅色"}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--text-dim)]">
                {THEME_MODE_HINTS[mode]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 一小块界面缩略：底色 + 两条"甘特条"，用固定色而非当前主题变量 —— 它要如实预览另一档长什么样 */
function ThemeSwatch({ dark }: { dark: boolean }) {
  return (
    <span
      className="flex size-9 shrink-0 flex-col justify-center gap-[3px] rounded-lg border px-1.5"
      style={{
        background: dark ? "#0b1020" : "#ffffff",
        borderColor: dark ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.12)",
      }}
    >
      <span
        className="h-[3px] w-[70%] rounded-full"
        style={{ background: dark ? "#4e9b86" : "#2f6d5e" }}
      />
      <span
        className="h-[3px] w-[45%] rounded-full"
        style={{ background: dark ? "rgba(255,255,255,0.28)" : "rgba(15,23,42,0.18)" }}
      />
    </span>
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
      desc="所有项目共用这份名单。"
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

      {error && <div className="mb-2 text-[10px] text-[var(--danger)]">{error}</div>}

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
        className="group/av relative shrink-0 overflow-hidden rounded-[var(--r-m)]"
      >
        <Avatar person={person} size={32} />
        {/* 悬停蒙层：把「这里可以点」说清楚，否则没人知道头像能换 */}
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/55 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/av:opacity-100">
          换
        </span>
        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-[var(--r-m)] bg-black/50 text-[8px] text-white">
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
          className="shrink-0 rounded px-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)]"
        >
          ✕
        </button>
      )}

      <button
        onClick={() => void askDelete()}
        onBlur={() => setConfirming(false)}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
          confirming
            ? "bg-[var(--danger)] text-white opacity-100"
            : "text-[var(--text-dim)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100"
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
        每次启动自动备份到 <code>backups/</code>，保留最近 10 份。
        <br />
        换电脑：点「导出数据库…」，在新电脑的项目列表点「导入项目」选中它。那边已有的项目不会被覆盖。
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
          <span className="text-[10px] font-medium text-[var(--ok)]">
            ✓ 没有查出结构性问题
          </span>
        )}
      </div>

      {state.status === "done" && state.issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {state.issues.map((issue) => (
            <li key={issue} className="text-[10px] text-[var(--danger)]">
              ● {issue}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
        检查任务层级、日期和引用是否损坏。每次启动也会自动修复一遍。
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
