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
import { APP_VIEWS, OPTIONAL_VIEWS, PERMANENT_VIEW } from "../core/views";
import { BLOCKER_KIND, RISK_KIND, newKindKey } from "../core/items";
import type { ItemKind } from "../db/api";
import { plugins } from "../plugins/registry";
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

/**
 * 设置面板。
 *
 * 三块内容按「改动频率」排序，不是按重要性：着色是随时会切的视图偏好，
 * 负责人偶尔维护，数据文件几乎不碰但出事时必须找得到。
 */

type Tab = "appearance" | "views" | "kinds" | "people" | "calendar" | "plugins" | "data";

const TABS: { id: Tab; label: string }[] = [
  { id: "appearance", label: "外观" },
  // 视图紧跟外观：两者都是「这个软件长什么样」。事项类型也在这一页 ——
  // 它属于「事项视图怎么用」，和负责人、工作日历那种项目数据不是一类
  { id: "views", label: "视图" },
  // 事项类型独立一页，不挂在「视图」下面：类型清单会长 —— 一个团队用上
  // 十几个类型是正常的 —— 而它需要搜索和分页，塞进别人的页脚底下放不开
  { id: "kinds", label: "事项类型" },
  { id: "people", label: "负责人" },
  { id: "calendar", label: "工作日历" },
  // 插件排在数据前面：它是「扩展这个软件」的地方，属于日常会来的，
  // 而数据页是出事才来的
  { id: "plugins", label: "插件" },
  { id: "data", label: "数据" },
];

export function Settings({
  onClose,
  initialTab = "appearance",
}: {
  onClose: () => void;
  /** 从哪一页打开。事项的分拣菜单会直接把人送到「视图」页 */
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(
    // 认不出来的页签回退到外观，而不是白屏 —— 这个值是别处传进来的
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

/** 三态在界面上的样子。「关掉的」和「坏的」要能一眼分开 */
const PLUGIN_STATUS: Record<PluginRecord["status"], { label: string; cls: string }> = {
  loaded: { label: "已启用", cls: "text-emerald-600" },
  disabled: { label: "已停用", cls: "text-[var(--text-dim)]" },
  error: { label: "出错", cls: "text-rose-500" },
};

/**
 * 插件页。
 *
 * 这一页要回答三个问题，顺序就是它们在界面上的顺序：
 *
 *   1. 我的插件放哪？ —— 顶上那行路径 + 「打开插件目录」按钮。没有这一步，
 *      用户看完这一页不知道接下来该干什么。
 *   2. 现在装了哪些、哪个是坏的？ —— 列表。坏插件必须把原因写在这儿，
 *      而不是只丢进控制台：作者不在调试器前面的时候，看不懂为什么没生效。
 *   3. 某个插件有什么开关？ —— 挂在各自那张卡片下面。插件注册的设置项
 *      不定长，所以不做成全局区块，跟插件走才不会张冠李戴。
 *
 * 页面上**没有**安装/卸载。装 = 把目录拷进插件目录，卸 = 删掉它 ——
 * 这两件事用资源管理器做比在这画一个文件浏览器快得多，也不会被本程序
 * 的权限边界绊住（插件目录是宿主唯一不会去写的地方，见 plugin.rs）。
 */
function PluginsPane() {
  const { records, settingFields, booted, bootError } = useRegistry();

  /** directory 的路径要和 bootError 分开放：一个常态，一个故障 */
  const [dir, setDir] = useState("");
  const [message, setMessage] = useState("");
  /** 正在启用/停用/重载的插件 id。多个可以同时在飞，所以用集合 */
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
   * 包的层数不能省。
   *
   * 这里大部分调用链是「按钮 → async 函数 → 插件代码」，而插件代码是
   * 唯一不由我们审查的代码。让它把异常抛到事件处理器外面，React 19 的
   * 默认行为是整个根卸载 —— 用户看到的是白屏，且找不到任何原因。
   * 命令那条路径已经在 registry.runCommand 里兜住了，这条得在这儿兜。
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
      desc="插件是放在插件目录里的文件夹，改完代码不用重新构建 —— 到这儿点一下「重新加载」就生效。它们能往工具条上加视图，也能改任务数据（走命令栈，所以照样能撤销）。"
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
          装一个插件 = 把一个文件夹拷进去；卸掉 = 删掉它
        </span>
      </div>

      {message && (
        <div className="mb-3 break-all rounded-lg border border-rose-400/40 bg-rose-500/5 p-2 text-[10px] text-rose-500">
          {message}
        </div>
      )}

      {/* 读不了插件目录是整页级别的问题，和单个插件坏掉不是一回事 */}
      {bootError && (
        <div className="mb-3 break-all rounded-lg border border-rose-400/40 bg-rose-500/5 p-2.5 text-[10px] leading-relaxed text-rose-500">
          {bootError}
        </div>
      )}

      {!booted && <p className="text-xs text-[var(--text-dim)]">正在扫描插件目录…</p>}

      {booted && records.length === 0 && !bootError && (
        <div className="rounded-lg border border-dashed border-[var(--rule)] p-4 text-xs leading-relaxed text-[var(--text-dim)]">
          还没有插件。在插件目录里新建一个文件夹，放两个文件：
          <div className="my-2 rounded bg-[var(--surface-alt)] p-2 font-mono text-[10px] leading-relaxed">
            quicknote/manifest.json
            <br />
            quicknote/main.js
          </div>
          manifest 里写 id / name / version / apiVersion，
          main.js 导出一个 <code>onload(api)</code>，用 <code>api.views.register(...)</code>
          把界面挂上去。回这儿点「重新加载」就会出现在工具条里。
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
                    {r.manifest.author ? ` · ${r.manifest.author}` : ""}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {r.enabled && (
                    <button
                      onClick={() => run(r.manifest.id, () => plugins.reload(r.manifest.id))}
                      disabled={isBusy}
                      title="改完插件代码点这个，不用重启软件"
                      className="rounded-lg border border-[var(--rule)] px-2.5 py-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
                    >
                      {isBusy ? "…" : "重新加载"}
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
                <div className="mt-2 break-all rounded-lg bg-rose-500/5 p-2 text-[10px] leading-relaxed text-rose-500">
                  {r.error}
                </div>
              )}

              {r.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {r.warnings.map((w) => (
                    <li key={w} className="text-[10px] leading-relaxed text-amber-600">
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
        本软件提供的插件接口版本是{" "}
        <span className="font-mono">
          {plugins.hostVersion().major}.{plugins.hostVersion().minor}
        </span>
        。插件的 manifest 里 apiVersion 主版本要和它一致 —— 主版本不同会被直接拒绝，
        次版本不同只给一条警告，和项目文件的版本策略是同一套。
        <br />
        插件跑在本程序里，看得到全部数据。装之前先确认来源。
      </p>
    </Section>
  );
}

/**
 * 插件注册的一个设置项。
 *
 * 值不经过任何本地 state —— 直接读写 settingCache。缓存在 registry 里，
 * 插件读的也是它，中间不隔一层 React 状态，就不会出现「界面显示 A、
 * 插件实际拿到 B」这种两份状态不同步的问题（那种 bug 只在点了别的按钮
 * 触发重渲染时才暴露，极其难查）。
 *
 * bump 只用来在写入后强制重渲染 —— 缓存不是 useSyncExternalStore 的源，
 * React 不会自己知道它变了。
 */
function PluginFieldRow({ pluginId, field }: { pluginId: string; field: PluginSettingField }) {
  const [, bump] = useState(0);
  const raw = plugins.settingValue(pluginId, field.key);

  const write = (value: string) => {
    // 缓存和落库都在这一个调用里，key 的前缀也由它拼 —— 这里别自己再写一遍
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
 * 事项类型本来也在这一页（它们都是「这个软件摆成什么样」的全局偏好），
 * 后来拆出去了 —— 类型清单会长，一个团队用上十几个类型是正常的，
 * 而它需要搜索框和分页。那些东西挂在别人的页脚底下放不开。
 */
function ViewsPane() {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <Section
      title="启用哪些视图"
      desc="关掉的视图连快捷键一起消失，⌘1–⌘5 的编号跟着重新算，不留死键。这是全局偏好，不随项目走。"
    >
      <ViewToggles />

      {/* 事项类型搬到了自己那一页，这里留一条路 —— 原来它在本页底下，
          习惯了的人到这儿找不到会以为功能没了 */}
      <button
        onClick={() => openSettings("kinds")}
        className="mt-4 text-[10px] text-[var(--text-dim)] underline hover:text-[var(--text)]"
      >
        事项的类型清单搬到「事项类型」那一页了 →
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
        // 编号按**启用后的次序**算，和工具条、快捷键完全一致
        const index = enabled.indexOf(v.key);
        return (
          <button
            key={v.key}
            onClick={() => setViewEnabled(v.key, !on)}
            disabled={permanent}
            title={
              permanent
                ? "甘特不能关：它是唯一能拖日期、改工期的面，关掉之后这个软件就没有排期能力了"
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
        正在看的那个视图被关掉时会自动切回甘特。关掉的视图不会丢任何数据 ——
        它只是不再占工具条上的一个位置，重新打开就回来了。
        {OPTIONAL_VIEWS.length} 个可关，甘特始终在。
      </p>
    </div>
  );
}

/**
 * 事项类型页。
 *
 * **阻碍和风险不在这张清单里**，所以页面上要写明白为什么 —— 否则用户会
 * 在这找它们，找不到就以为是漏了。它们是实体不是分类：一条阻碍会推排期、
 * 进复盘的归因图、让卡片上看板的受阻列，而一个类型标签做不到其中任何一件
 * （设计稿 §6.3）。做成这张表的两行只会制造出「名字叫阻碍、底下没有实体」
 * 的悬空状态。
 *
 * ## 为什么要搜索和分页
 *
 * 类型是全局的，一个团队用上十几个是正常的（设计稿 §7 里把「类型总数超过
 * 十个」列成了触发条件）。一次性铺开的话，这张 520px 高的面板会变成一条
 * 长滚动条，而「新建类型」那个按钮被顶到最底下 —— 要加一个类型得先滚到底。
 *
 * 所以：**新建按钮钉在列表上方**（它的位置不随条数变），列表每页 6 条，
 * 搜索跨全部而不只是当前页。只有超过一页时才出现翻页控件 —— 三个类型的
 * 时候摆一个「1/1」是纯噪音。
 */

/** 每页几条。按面板高度定的：6 行 + 头 + 新建 + 翻页刚好不出现滚动条 */
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
  // 搜索跨**全部**类型，不只是当前页 —— 分页是显示手段，不该缩小搜索范围
  const shown = q
    ? kinds.filter(
        (k) => k.label.toLowerCase().includes(q) || k.key.toLowerCase().includes(q),
      )
    : kinds;

  const pages = Math.max(1, Math.ceil(shown.length / KINDS_PER_PAGE));
  // 删掉几条之后当前页可能已经越界了，夹回最后一页
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * KINDS_PER_PAGE, (current + 1) * KINDS_PER_PAGE);

  const builtin = kinds.filter((k) => k.builtin).length;

  return (
    <Section
      title="事项类型"
      desc="事项分拣时能选的类型。全局定义，所有项目共用 —— 类型是「这个团队怎么给事情分类」，不是某个项目的属性。"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-dim)]">
          共 {kinds.length} 个（{builtin} 个内置）
          {q && shown.length !== kinds.length && ` · 筛出 ${shown.length} 个`}
        </span>

        {/* 搜索框只在真的多起来之后才出现 —— 三个类型的时候它是纯噪音 */}
        {kinds.length > KINDS_PER_PAGE && (
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0); // 换了筛选条件还停在第 3 页，多半是空的
            }}
            placeholder="搜索类型…"
            className="ml-auto w-28 rounded-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-0.5 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        )}

        <ExportButton
          label="⤓ 导出"
          title="把类型清单导出成 Excel：名称、颜色、关闭规则、本项目用了多少条"
          size="sm"
          run={async () => (await import("../export/run")).exportItemKindsToExcel()}
        />
      </div>

      {/*
        「新建类型」钉在列表**上方**。
        放在下面的话它的位置会随条数变，而加一个类型得先滚到底 ——
        这一页最高频的动作不该是最难点到的那个。
      */}
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
              // 新建的排在最后，直接翻到它所在的那一页
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
                  ? `已删除。${n} 条用着这个类型的事项退回了「未分拣」—— 内容都还在。`
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

      {/* 翻页控件只在超过一页时出现 */}
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
        <p className="mt-2 text-[10px] leading-relaxed text-emerald-600">{notice}</p>
      )}

      <div className="mt-4 rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-2">
        <div className="mb-1 text-[10px] font-semibold text-[var(--text)]">
          为什么这里没有「阻碍」和「风险」
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--text-dim)]">
          它们是<strong>实体</strong>，不是分类。事项分拣成
          <span style={{ color: BLOCKER_KIND.color }}> 阻碍 </span>会真的在那条活上建一段受阻
          —— 它每天跨天顺延计划结束日、进复盘的归因图、让卡片落进看板的受阻列；分拣成
          <span style={{ color: RISK_KIND.color }}> 风险 </span>会真的写进风险表。
          一个只打标签的「阻碍」做不到其中任何一件，于是同一个词在三个地方指不同的事，
          而用户没法知道哪个算数。
        </p>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-dim)]">
        「关闭需写结论」这个开关值得认真选：一个只打勾的关闭，把「这条不用管了」和
        「我们做了什么让它不用管」压成了同一个比特，而后者才是复盘时唯一值得抄的东西。
        「代办」默认关着（关掉一个打电话确认交期的待办，没什么结论可写），
        「问题」默认开着。
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
  /** 还没落库的新行：直接进编辑态，取消就消失 */
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
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="类型名称"
        autoFocus={draft}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-[var(--text)] outline-none hover:border-[var(--rule)] focus:border-[var(--accent)]"
      />

      <button
        onClick={() => setRequiresNote((v) => !v)}
        title="关闭这一类事项时，是否必须写一句「怎么解决的」"
        className="shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium transition-colors"
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
            className="shrink-0 rounded-md bg-rose-500/12 px-2 py-0.5 text-[10px] font-medium text-rose-500"
            title="用着这个类型的事项会退回「未分拣」，内容不会丢"
          >
            {draft ? "取消" : "确认删除"}
          </button>
        ) : (
          <button
            onClick={() => (draft ? void onDelete() : setConfirming(true))}
            className="grid size-5 shrink-0 place-items-center rounded text-[11px] text-[var(--text-dim)] hover:bg-rose-500/10 hover:text-rose-500"
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
    stage: "顶层任务拿一个基色，它的每个后代拿一个同色系变体 —— 每一行都不重样，但一眼看得出同属一族。",
    assignee: "用每个人自己的颜色，和设置里的头像底色一致。未指派走中性灰。",
    priority: "固定映射，P0 永远是红的 —— 不会因为项目里恰好没有 P0 就让 P1 变红。",
    none: "全部用项目强调色。导出 PDF 或灰度打印时，彩色反而是干扰。",
  };

  return (
    <Section
      title="主题"
      desc="默认跟随系统。选了浅色或深色就一直用那一套，不再随系统切换 —— 排期的人常常希望几点打开都是同一副面孔。"
    >
      <ThemePicker />

      <div className="mt-8">
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
        style={{ background: dark ? "#818cf8" : "#6366f1" }}
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
