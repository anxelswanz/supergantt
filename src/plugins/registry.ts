/**
 * 插件运行时：模块级单例（非 React 状态），React 侧经 useSyncExternalStore 订阅。
 * 依赖单向 —— 本模块 import store，store 不 import 本模块，故插件 API 的读可全同步。
 * 注册物一律由宿主 Disposable 回收；一个坏插件不能影响其他插件和甘特图。
 */

import * as React from "react";
import type { ComponentType } from "react";


import { api } from "../db/api";
import { attachRun, ensureProcListener } from "../db/proc";
import type { BlockedPeriod } from "../core/blocked";
import { kindLabel, mergeItems, type ItemRow } from "../core/items";
import type { Task } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";
import { HOST_API_VERSION, validateManifest } from "./manifest";
import type {
  Disposable,
  PluginApi,
  PluginCommand,
  PluginItemAction,
  PluginItemBadge,
  PluginManifest,
  PluginProcess,
  PluginModule,
  PluginRecord,
  PluginSettingField,
  PluginToolbarItem,
  PluginViewDeclaration,
  ItemView,
  RegisteredView,
  TaskView,
} from "./types";

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export interface RegistryState {
  /** 全部被发现的插件，含坏的和关掉的 */
  records: PluginRecord[];
  /** 全部视图：内置在前，插件按注册顺序在后 */
  views: RegisteredView[];
  /** 已注册的命令，按 id 索引 */
  commands: Map<string, PluginCommand>;
  toolbar: PluginToolbarItem[];
  settingFields: { pluginId: string; field: PluginSettingField }[];
  /** 事项分拣菜单里的插件项 */
  itemActions: { pluginId: string; action: PluginItemAction }[];
  /** 事项行上的插件徽标 */
  itemBadges: { pluginId: string; badge: PluginItemBadge }[];
  /** 徽标版本号：插件状态宿主看不见，靠 refresh() 加一令事项页重画 */
  badgeVersion: number;
  /** 首次扫描是否完成，用于区分「还没扫」和「扫了但一个都没有」 */
  booted: boolean;
  /** 扫描阶段的全局错误；null = 没出错 */
  bootError: string | null;
}

const state: RegistryState = {
  records: [],
  views: [],
  commands: new Map(),
  toolbar: [],
  settingFields: [],
  itemActions: [],
  itemBadges: [],
  badgeVersion: 0,
  booted: false,
  bootError: null,
};

/** 已加载插件的运行时句柄。key 是插件 id */
interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  disposables: Disposable[];
  /** 注入到文档里的 <style>，卸载时删掉 */
  styleEl: HTMLStyleElement | null;
}
const loaded = new Map<string, LoadedPlugin>();

/* ------------------------------------------------------------------ */
/* 订阅：给 React 用                                                    */
/* ------------------------------------------------------------------ */

const listeners = new Set<() => void>();

/** 不可变快照：getSnapshot 必须返回同一引用，否则 React 无限重渲染。只在 commit() 换。 */
let snapshot: RegistryState = { ...state };
function commit() {
  snapshot = { ...state };
  for (const fn of listeners) fn();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): RegistryState {
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* 插件设置的值缓存                                                     */
/* ------------------------------------------------------------------ */

/**
 * 设置值缓存：api.settings.get 同步而底层 invoke 异步，故插件跑起来前把
 * 全部 plugin.* 一次读进内存（逐 key 读要求宿主先知道名字）。
 */
const settingCache = new Map<string, string>();
const PLUGIN_SETTING_PREFIX = "plugin.";

/** 加命名空间；插件作者不必知道前缀 */
const settingKey = (pluginId: string, key: string) => `${PLUGIN_SETTING_PREFIX}${pluginId}.${key}`;

/** 唯一的设置写路径（前缀在此拼）。先缓存再落库，顺序不能反；落库失败不回滚缓存。 */
export function setSettingValue(pluginId: string, key: string, value: string): void {
  settingCache.set(settingKey(pluginId, key), value);
  void api.setSetting(settingKey(pluginId, key), value).catch(() => {});
}

/** 把 settings 表里全部 plugin.* 读回缓存 */
async function warmSettings(): Promise<void> {
  const rows = await api
    .listSettingsWithPrefix(PLUGIN_SETTING_PREFIX)
    .catch(() => [] as [string, string][]);
  for (const [k, v] of rows) settingCache.set(k, v);
}

/** 声明时把默认值写进缓存，否则没存过时 get 返回 null 而不是 def */
function applyDefault(pluginId: string, field: PluginSettingField): void {
  const key = settingKey(pluginId, field.key);
  if (settingCache.has(key)) return;
  if (field.def === undefined) return;
  settingCache.set(key, typeof field.def === "boolean" ? String(field.def) : field.def);
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

export function allViews(): RegisteredView[] {
  return snapshot.views;
}

export function viewsFor(pluginId: string): RegisteredView[] {
  return snapshot.views.filter((v) => v.pluginId === pluginId);
}

export function findView(type: string): RegisteredView | null {
  return snapshot.views.find((v) => v.type === type) ?? null;
}

/** 内置视图的占位项：元信息在 core/views.ts，实现在 Workspace。 */
export function builtinViews(
  meta: { key: string; label: string; hint: string }[],
): RegisteredView[] {
  return meta.map((m) => ({
    type: m.key,
    label: m.label,
    hint: m.hint,
    pluginId: "builtin",
    // 占位：Workspace 认 pluginId === "builtin" 用自备组件；抛错以便「万一走到」时可见
    render: () => {
      throw new Error(`内置视图 "${m.key}" 的实现缺在 Workspace 里，不该走到注册表的 render`);
    },
  }));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function warn(msg: string) {
  console.error("[plugin]", msg);
}

const disposable = (fn: () => void): Disposable => {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
};

/* ------------------------------------------------------------------ */
/* 日期换算                                                            */
/* ------------------------------------------------------------------ */

/** 基准与 db/convert.ts 一致：2000-01-01 UTC = 第 0 天，两处必须同步改。 */
const EPOCH_MS = Date.UTC(2000, 0, 1);

export function daysToIso(day: number): string {
  const d = new Date(EPOCH_MS + day * 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function isoToDays(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_MS) / 86_400_000);
}

function todayDays(): number {
  const now = new Date();
  return Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH_MS) / 86_400_000,
  );
}

/* ------------------------------------------------------------------ */
/* 任务投影                                                            */
/* ------------------------------------------------------------------ */

/** Task → TaskView 的投影，隔离内部类型的重构 */
function toTaskView(t: Task): TaskView {
  return {
    id: t.id,
    parentId: t.parentId,
    name: t.name,
    startDay: t.startDay,
    endDay: t.endDay,
    progress: t.progress,
    priority: t.priority,
    personId: t.personId,
    milestone: t.milestone,
    collapsed: t.collapsed,
    openBlockers: countOpenBlockers(t.blocked),
  };
}

/** 判据必须和 core/blocked.ts 一致：只认 `open === true`，缺省算已关闭。 */
function countOpenBlockers(blocked: BlockedPeriod[] | undefined): number {
  if (!Array.isArray(blocked)) return 0;
  return blocked.filter((b) => b.open === true).length;
}

/** 事项清单快照，走 mergeItems 合并层；不排序 */
export function itemSnapshot(): ItemView[] {
  const s = useAppStore.getState();
  if (!s.project) return [];
  const tasks = [...s.tasks.values()];
  const rows = mergeItems({
    notes: s.itemNotes,
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, personId: t.personId, blocked: t.blocked })),
    risks: s.projectRisks,
    today: todayDays(),
  });
  const view = itemViewer();
  return rows.map(view);
}

/** ItemRow → ItemView 的投影。事项页也用它，保证与 data.items.list() 同形。 */
let viewerCache: { key: unknown[]; fn: (r: ItemRow) => ItemView } | null = null;

export function itemViewer(): (r: ItemRow) => ItemView {
  const s = useAppStore.getState();
  // 名字表按输入引用缓存，否则一屏几百行就是几百次重建同一张表
  const key = [s.tasks, s.people, s.itemKinds];
  if (viewerCache && viewerCache.key.every((k, i) => k === key[i])) return viewerCache.fn;
  const fn = buildViewer(s);
  viewerCache = { key, fn };
  return fn;
}

function buildViewer(s: ReturnType<typeof useAppStore.getState>): (r: ItemRow) => ItemView {
  const taskName = new Map([...s.tasks.values()].map((t) => [t.id, t.name]));
  const personName = new Map(s.people.map((p) => [p.id, p.name]));
  return (r) => ({
    key: r.key,
    source: r.source,
    title: r.title,
    kind: r.kind,
    kindLabel: kindLabel(r.kind, s.itemKinds),
    priority: r.priority,
    personId: r.personId,
    personName: r.personId == null ? null : (personName.get(r.personId) ?? null),
    taskId: r.taskId,
    taskName: r.taskId == null ? null : (taskName.get(r.taskId) ?? null),
    // 阻碍没有记录时刻，用起始日；其余按本地时区（「今天」指用户墙上的今天）
    day: r.blocker ? daysToIso(r.blocker.period.from) : localDate(r.createdAt),
    closed: r.closed,
    resolution: r.resolution,
    riskLevel: r.risk ? r.risk.level : null,
    closedDay: closedDayOf(r),
    noteId: r.note ? r.note.id : r.fromNoteId,
  });
}

function closedDayOf(r: ItemRow): string | null {
  if (!r.closed) return null;
  if (r.blocker) return daysToIso(r.blocker.period.to);
  if (r.risk) return r.risk.resolvedAt != null ? localDate(r.risk.resolvedAt) : null;
  if (r.note?.closedAt != null) return localDate(r.note.closedAt);
  return null;
}

function localDate(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前任务快照 */
function taskSnapshot(): TaskView[] {
  const out: TaskView[] = [];
  for (const t of useAppStore.getState().tasks.values()) out.push(toTaskView(t));
  return out;
}

/* ------------------------------------------------------------------ */
/* 宿主 api 对象                                                       */
/* ------------------------------------------------------------------ */

function makeApi(manifest: PluginManifest, dir: string, disposables: Disposable[]): PluginApi {
  const id = manifest.id;
  const allowedExec = new Set(manifest.permissions?.exec ?? []);
  // 独立函数而不是对象方法：exec 要调它，插件也可能把 spawn 解构出来用，
  // 两种情况下都不能依赖 this
  const spawn: PluginApi["proc"]["spawn"] = (program, args, opts = {}) => {
    if (!allowedExec.has(program)) {
      return Promise.reject(
        new Error(`插件 ${id} 没有声明可以运行「${program}」—— 在 manifest 的 permissions.exec 里加上它`),
      );
    }
    return spawnProcess(id, program, args, opts, disposables);
  };
  const track = <T extends Disposable>(d: T): T => {
    disposables.push(d);
    return d;
  };
  const store = () => useAppStore.getState();

  return {
    id,
    hostApiVersion: HOST_API_VERSION,
    /** React 本体。hooks 认模块实例，插件须自己把 React 打进单文件入口（见 assertSelfContained）。 */
    react: React,

    views: {
      register(view: PluginViewDeclaration, render: ComponentType) {
        if (state.views.some((v) => v.type === view.type)) {
          throw new Error(`视图 "${view.type}" 已经被注册过了`);
        }
        const registered: RegisteredView = { ...view, pluginId: id, render };
        state.views = [...state.views, registered];
        commit();
        return track(
          disposable(() => {
            state.views = state.views.filter((v) => v !== registered);
            commit();
          }),
        );
      },
    },

    commands: {
      register(command: PluginCommand) {
        if (state.commands.has(command.id)) {
          throw new Error(`命令 "${command.id}" 已经被注册过了`);
        }
        state.commands.set(command.id, command);
        commit();
        return track(
          disposable(() => {
            state.commands.delete(command.id);
            commit();
          }),
        );
      },
      run(cmdId) {
        runCommand(cmdId);
      },
    },

    toolbar: {
      register(item: PluginToolbarItem) {
        state.toolbar = [...state.toolbar, item];
        commit();
        return track(
          disposable(() => {
            state.toolbar = state.toolbar.filter((t) => t !== item);
            commit();
          }),
        );
      },
    },

    settings: {
      get(key) {
        return settingCache.get(settingKey(id, key)) ?? null;
      },
      getBool(key) {
        return settingCache.get(settingKey(id, key)) === "true";
      },
      set(key, value) {
        setSettingValue(id, key, value);
      },
      field(field) {
        // 声明时就把默认值放进缓存，否则「刚注册、还没改过」时 get 拿到 null
        applyDefault(id, field);
        state.settingFields = [...state.settingFields, { pluginId: id, field }];
        commit();
        return track(
          disposable(() => {
            state.settingFields = state.settingFields.filter((f) => f.field !== field);
            commit();
          }),
        );
      },
    },

    data: {
      project() {
        const p = store().project;
        return p ? { id: p.id, name: p.name } : null;
      },
      people: {
        list() {
          return store().people.map((p) => ({ id: p.id, name: p.name }));
        },
      },
      tasks: {
        list: taskSnapshot,
        byId(taskId) {
          const t = store().tasks.get(taskId);
          return t ? toTaskView(t) : null;
        },
        subscribe(listener) {
          taskSubscribers.add(listener);
          // 返回裸 () => void 贴近通用取消订阅形状；卸载时由 track 统一回收
          track(
            disposable(() => {
              taskSubscribers.delete(listener);
            }),
          );
          return () => {
            taskSubscribers.delete(listener);
          };
        },
      },
      dailyNotes: {
        list() {
          return store().dailyNotes.map((n) => ({
            id: n.id,
            taskId: n.taskId,
            day: n.day,
            content: n.content,
          }));
        },
        add(taskId, day, content) {
          void store().addDailyNote(taskId, day, content);
        },
        remove(noteId) {
          void store().removeDailyNote(noteId);
        },
      },
      risks: {
        open() {
          return store()
            .projectRisks.filter((r) => !r.resolved)
            .map((r) => ({ id: r.id, taskId: r.taskId, content: r.content, level: r.level }));
        },
        add(taskId, content, level) {
          void store().addRisk(taskId, content, level);
        },
      },
      items: {
        list: itemSnapshot,
        subscribe(listener) {
          // 只在这几样变了时通知 —— 拖一下甘特条不该让日报重算一遍
          const off = useAppStore.subscribe((next, prev) => {
            if (
              next.itemNotes !== prev.itemNotes ||
              next.projectRisks !== prev.projectRisks ||
              next.itemKinds !== prev.itemKinds ||
              next.project !== prev.project
            )
              listener();
          });
          track(disposable(off));
          return off;
        },
      },
    },

    act: {
      /** 走 store 的 patchTask，自动进命令栈（撤销/重做/落库） */
      patchTask(taskId, changes, label) {
        store().patchTask(taskId, changes, label);
      },

      /**
       * 新建任务并返回新 id：addTaskAfter 返回 void，靠比对前后键集认出。
       * 两笔命令（插入 + 改名），⌘Z 要按两次。
       */
      addTask(name, afterId) {
        const s = store();
        const before = new Set(s.tasks.keys());
        s.addTaskAfter(afterId);
        let newId = -1;
        for (const key of store().tasks.keys()) {
          if (!before.has(key)) {
            newId = key;
            break;
          }
        }
        if (newId < 0) {
          warn(`插件 ${id} 新建任务失败：没有观察到新任务`);
          return -1;
        }
        store().patchTask(newId, { name }, `新建「${name}」`);
        return newId;
      },

      deleteTask(taskId) {
        store().deleteTask(taskId);
      },

      setActiveView(viewType) {
        if (!findView(viewType)) {
          warn(`插件 ${id} 想切到视图 "${viewType}"，但它不存在`);
          return;
        }
        store().setActiveView(viewType as never);
      },
    },

    dir,

    itemActions: {
      register(action: PluginItemAction) {
        const entry = { pluginId: id, action };
        state.itemActions = [...state.itemActions, entry];
        commit();
        return track(
          disposable(() => {
            state.itemActions = state.itemActions.filter((a) => a !== entry);
            commit();
          }),
        );
      },
    },

    itemBadges: {
      register(badge: PluginItemBadge) {
        const entry = { pluginId: id, badge };
        state.itemBadges = [...state.itemBadges, entry];
        commit();
        return track(
          disposable(() => {
            state.itemBadges = state.itemBadges.filter((b) => b !== entry);
            commit();
          }),
        );
      },
      refresh() {
        state.badgeVersion += 1;
        commit();
      },
    },

    proc: {
      which(program) {
        return api.pluginWhich(program);
      },
      spawn,
      async exec(program, args, opts = {}) {
        let stdout = "";
        let stderr = "";
        const p = await spawn(program, args, {
          stdin: opts.stdin,
          onStdout: (l) => (stdout += l + "\n"),
          onStderr: (l) => (stderr += l + "\n"),
        });
        const { code } = await p.done;
        return { code, stdout, stderr };
      },
    },

    storage: {
      read(name) {
        return api.pluginStorageRead(id, name);
      },
      write(name, content) {
        return api.pluginStorageWrite(id, name, content);
      },
    },

    util: {
      toISODate: daysToIso,
      toDay: isoToDays,
      today: todayDays,
    },

    log(...args: unknown[]) {
      console.log(`[${manifest.name}]`, ...args);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 子进程                                                              */
/* ------------------------------------------------------------------ */

/** 回调抛错记进插件日志（设置页可见），不只控制台 */
const guarded = (fn?: (line: string) => void) =>
  fn &&
  ((line: string) => {
    try {
      fn(line);
    } catch (e) {
      warn(`子进程回调抛错：${e}`);
    }
  });

async function spawnProcess(
  pluginId: string,
  program: string,
  args: string[],
  opts: { stdin?: string; onStdout?: (l: string) => void; onStderr?: (l: string) => void },
  disposables: Disposable[],
): Promise<PluginProcess> {
  await ensureProcListener();
  const runId = await api.pluginSpawn(pluginId, program, args, opts.stdin ?? null);

  let finish!: (code: number | null) => void;
  const done = new Promise<{ code: number | null }>((resolve) => {
    finish = (code) => resolve({ code });
  });
  // 分发在 db/proc.ts，与内置 AI 复盘共用
  attachRun(runId, {
    onStdout: guarded(opts.onStdout),
    onStderr: guarded(opts.onStderr),
    finish,
  });

  const kill = () => void api.pluginKill(runId).catch(() => {});
  // 停用/重载时杀掉插件起的进程，否则跑到一半的同步会在后台继续写
  const d = disposable(kill);
  disposables.push(d);
  void done.then(() => {
    const i = disposables.indexOf(d);
    if (i >= 0) disposables.splice(i, 1);
  });
  return { done, kill };
}

/* ------------------------------------------------------------------ */
/* Claude Skill 链接                                                    */
/* ------------------------------------------------------------------ */

/** 启用时建 Skill 链接，停用时拆。失败只记警告，不挡加载。 */
async function linkSkills(record: PluginRecord): Promise<void> {
  for (const sk of record.manifest.skills ?? []) {
    try {
      await api.pluginLinkSkill(record.manifest.id, sk.dir, sk.name);
    } catch (e) {
      const msg = `Skill「${sk.name}」没有链接到 ~/.claude/skills：${(e as Error)?.message ?? e}`;
      if (!record.warnings.includes(msg)) record.warnings = [...record.warnings, msg];
    }
  }
}

async function unlinkSkills(manifest: PluginManifest): Promise<void> {
  for (const sk of manifest.skills ?? []) {
    await api.pluginUnlinkSkill(manifest.id, sk.name).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 任务变更通知                                                        */
/* ------------------------------------------------------------------ */

const taskSubscribers = new Set<() => void>();

/** 命令落地后由 usePlugins 的 effect 调它。显式推送，避免选中之类变化也触发重算。 */
export function notifyTasksChanged(): void {
  for (const fn of taskSubscribers) fn();
}

/* ------------------------------------------------------------------ */
/* 加载 / 卸载                                                         */
/* ------------------------------------------------------------------ */

/** 入口须自包含单文件：Blob URL 无基准路径和模块解析，相对路径与裸模块名一律拒掉。 */
function assertSelfContained(source: string, pluginId: string): void {
  // 正则粗筛即可，不为插件入口引一个 AST 解析器进宿主核心
  const specifiers = [
    ...source.matchAll(/\bfrom\s*(["'])([^"']+)\1/g),
    ...source.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g),
    ...source.matchAll(/\bimport\s+(["'])([^"']+)\1/g),
  ].map((m) => m[2]);

  // 绝对 URL（blob:、data:、http(s):）放行：那是作者自己选的外部依赖
  const bad = specifiers.filter((s) => s.startsWith(".") || !/^[a-z][a-z0-9+.-]*:/i.test(s));
  if (bad.length === 0) return;
  throw new Error(
    `插件 ${pluginId} 的入口里有 import 不了的模块：${[...new Set(bad)].join("、")}。` +
      `插件是单文件加载的，不能 import 相对路径或其他包 —— 把这些代码一起写进入口文件，` +
      `或者先用打包工具打成一个 bundle`,
  );
}

/**
 * 给每条规则的选择器加 `[data-plugin="<id>"] ` 前缀（属性由 PluginViewHost 落下）。
 * 非完整 CSS 解析器：at-rule 原样跳过，否则 @keyframes 里的百分比选择器会失效。
 */
export function scopeCss(css: string, pluginId: string): string {
  const scope = `[data-plugin="${pluginId}"]`;
  let out = "";
  let i = 0;

  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === "{") depth++;
      else if (css[close] === "}") depth--;
      close++;
    }

    const head = css.slice(i, open);
    const body = css.slice(open, close);

    // at-rule 原样输出
    if (head.trim().startsWith("@")) {
      out += head + body;
      i = close;
      continue;
    }

    const scoped = head
      .split(",")
      .map((s) => {
        const t = s.trim();
        if (!t) return "";
        // :root / html / body 改写成作用域本身，否则会污染宿主的设计 token
        if (/^(:root|html|body)$/.test(t)) return scope;
        return `${scope} ${t}`;
      })
      .filter(Boolean)
      .join(", ");

    out += scoped + body;
    i = close;
  }
  return out;
}

/** 把源码实例化成模块并调 onload */
async function instantiate(
  manifest: PluginManifest,
  dir: string,
  source: string,
  css: string | null,
): Promise<void> {
  assertSelfContained(source, manifest.id);

  const disposables: Disposable[] = [];

  // 样式先注入；失败也只是没样式，不挡加载
  let styleEl: HTMLStyleElement | null = null;
  if (css) {
    styleEl = document.createElement("style");
    styleEl.dataset.pluginCss = manifest.id;
    styleEl.textContent = scopeCss(css, manifest.id);
    document.head.appendChild(styleEl);
  }

  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let module: PluginModule;
  try {
    // @vite-ignore：这个 URL 是运行时的，Vite 不该也无法在构建期分析它
    module = (await import(/* @vite-ignore */ url)) as PluginModule;
  } catch (e) {
    styleEl?.remove();
    throw new Error(`入口文件加载失败：${(e as Error).message}`);
  } finally {
    // 不撤销 blob 会一直占内存，热重载时尤其明显
    URL.revokeObjectURL(url);
  }

  if (typeof module.onload !== "function") {
    styleEl?.remove();
    throw new Error("入口文件没有导出 onload 函数");
  }

  const pluginApi = makeApi(manifest, dir, disposables);
  try {
    await module.onload(pluginApi);
  } catch (e) {
    // onload 抛错时可能已注册一半，全撤掉，免得「error 但视图还挂着」
    for (const d of [...disposables].reverse()) {
      try {
        d.dispose();
      } catch {
        /* 回收失败也要继续 */
      }
    }
    styleEl?.remove();
    throw new Error(`onload 执行失败：${(e as Error).message}`);
  }

  loaded.set(manifest.id, { manifest, module, disposables, styleEl });
}

/** 卸载一个插件并回收它注册的一切。不落盘启用状态 —— 那是调用方的事 */
function unload(pluginId: string): void {
  const entry = loaded.get(pluginId);
  if (!entry) return;

  // onunload 先跑，抛错也要继续回收，否则重载后留两份
  try {
    entry.module.onunload?.();
  } catch (e) {
    warn(`插件 ${pluginId} 的 onunload 抛错：${e}`);
  }

  // 逆序回收：后注册的先撤
  for (const d of [...entry.disposables].reverse()) {
    try {
      d.dispose();
    } catch (e) {
      warn(`插件 ${pluginId} 回收资源时抛错：${e}`);
    }
  }
  entry.styleEl?.remove();
  loaded.delete(pluginId);
}

/* ------------------------------------------------------------------ */
/* 启用状态                                                            */
/* ------------------------------------------------------------------ */

const ENABLED_KEY = "plugins_enabled";

/**
 * 启用状态存一个 JSON 数组（插件目录会被删，散落的 per-plugin key 清不掉）。
 * exists 区分「第一次运行」和「启用过但全关」（存着 `[]`）。
 */
async function readEnabled(): Promise<{ set: Set<string>; exists: boolean }> {
  const raw = await api.getSetting(ENABLED_KEY).catch(() => null);
  if (raw == null) return { set: new Set(), exists: false };
  try {
    const arr = JSON.parse(raw);
    return { set: new Set(Array.isArray(arr) ? (arr as string[]) : []), exists: true };
  } catch {
    return { set: new Set(), exists: true };
  }
}

async function persistEnabled(): Promise<void> {
  const ids = state.records.filter((r) => r.enabled).map((r) => r.manifest.id);
  await api.setSetting(ENABLED_KEY, JSON.stringify(ids)).catch(() => {});
}

/** manifest 坏掉时的占位记录，让设置面板能显示出来供用户修 */
function placeholderManifest(dirName: string): PluginManifest {
  return {
    id: dirName,
    name: dirName,
    version: "0.0.0",
    apiVersion: `${HOST_API_VERSION.major}.0`,
    views: [],
  };
}

/* ------------------------------------------------------------------ */
/* boot / enable / disable / reload                                    */
/* ------------------------------------------------------------------ */

/** 扫描插件目录并按记录启用。不抛错，全局失败记进 bootError */
export async function boot(): Promise<void> {
  try {
    await warmSettings();

    const [raw, enabled] = await Promise.all([api.listPlugins(), readEnabled()]);
    const records: PluginRecord[] = [];

    for (const r of raw) {
      const check = validateManifest(r.manifest_raw, r.dir_name);
      if (!check.ok) {
        records.push({
          manifest: placeholderManifest(r.dir_name),
          path: r.path,
          enabled: false,
          status: "error",
          error: check.error,
          warnings: [],
        });
        continue;
      }

      const manifest = check.manifest;
      // 新插件默认不启用：自动执行刚被拖进目录的代码是不该做的事
      const isEnabled = enabled.exists && enabled.set.has(manifest.id);

      const record: PluginRecord = {
        manifest,
        path: r.path,
        enabled: isEnabled,
        status: isEnabled ? "loaded" : "disabled",
        warnings: check.warnings,
      };
      records.push(record);

      if (!isEnabled) continue;

      if (!r.entry_raw) {
        record.status = "error";
        record.error = `找不到入口文件 ${manifest.main ?? "main.js"}`;
        continue;
      }
      try {
        await instantiate(manifest, r.path, r.entry_raw, r.css_raw);
        await linkSkills(record);
      } catch (e) {
        record.status = "error";
        record.error = (e as Error).message;
      }
    }

    state.records = records;
    state.booted = true;
    commit();
  } catch (e) {
    state.booted = true;
    state.bootError = `扫描插件目录失败：${(e as Error).message}`;
    commit();
  }
}

/** 启用，顺手重读目录，这样不用重启就能看到刚改过的插件 */
export async function enable(pluginId: string): Promise<void> {
  const record = state.records.find((r) => r.manifest.id === pluginId);
  if (!record) return;
  if (loaded.has(pluginId)) return;

  const raw = await api.listPlugins().catch(() => []);
  const dir = raw.find((r) => r.dir_name === pluginId);
  if (!dir) {
    record.enabled = false;
    record.status = "error";
    record.error = "插件目录不见了";
    commit();
    return;
  }

  const check = validateManifest(dir.manifest_raw, dir.dir_name);
  if (!check.ok) {
    record.enabled = false;
    record.status = "error";
    record.error = check.error;
    commit();
    return;
  }
  // manifest 可能在上次扫描后被改过，以这次为准
  record.manifest = check.manifest;
  record.warnings = check.warnings;

  if (!dir.entry_raw) {
    record.enabled = false;
    record.status = "error";
    record.error = `找不到入口文件 ${check.manifest.main ?? "main.js"}`;
    commit();
    return;
  }

  try {
    await instantiate(check.manifest, dir.path, dir.entry_raw, dir.css_raw);
    await linkSkills(record);
    record.enabled = true;
    record.status = "loaded";
    record.error = undefined;
  } catch (e) {
    record.enabled = false;
    record.status = "error";
    record.error = (e as Error).message;
  }

  await persistEnabled();
  commit();
}

/** 禁用并回收 */
export async function disable(pluginId: string): Promise<void> {
  const record = state.records.find((r) => r.manifest.id === pluginId);
  if (!record) return;

  unload(pluginId);
  await unlinkSkills(record.manifest);
  record.enabled = false;
  record.status = "disabled";
  record.error = undefined;
  await persistEnabled();
  commit();
}

/** 重扫目录，只增删记录、不动已加载的插件。不可改调 boot()：会重复实例化。 */
export async function rescan(): Promise<void> {
  const raw = await api.listPlugins().catch(() => null);
  if (!raw) return;
  const present = new Set(raw.map((r) => r.dir_name));

  // 目录没了的：卸掉、拆链接、移出列表
  for (const r of state.records) {
    if (present.has(r.manifest.id)) continue;
    unload(r.manifest.id);
    await unlinkSkills(r.manifest);
  }
  const kept = state.records.filter((r) => present.has(r.manifest.id));

  // 新出现的先不启用，同 boot
  const known = new Set(kept.map((r) => r.manifest.id));
  for (const r of raw) {
    if (known.has(r.dir_name)) continue;
    const check = validateManifest(r.manifest_raw, r.dir_name);
    kept.push(
      check.ok
        ? { manifest: check.manifest, path: r.path, enabled: false, status: "disabled", warnings: check.warnings }
        : {
            manifest: placeholderManifest(r.dir_name),
            path: r.path,
            enabled: false,
            status: "error",
            error: check.error,
            warnings: [],
          },
    );
  }
  kept.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  state.records = kept;
  await persistEnabled();
  commit();
}

/** 热重载：先卸再装。重载后工具条出现两个按钮 = 插件漏清了东西。 */
export async function reload(pluginId: string): Promise<void> {
  const record = state.records.find((r) => r.manifest.id === pluginId);
  const wasEnabled = record?.enabled ?? loaded.has(pluginId);
  unload(pluginId);
  if (record) record.status = "disabled";
  commit();
  await warmSettings();
  if (wasEnabled) await enable(pluginId);
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** 跑一个命令；命令面板和插件内部调用都走它 */
export function runCommand(id: string): void {
  const cmd = snapshot.commands.get(id);
  if (!cmd) {
    warn(`没有找到命令 "${id}"`);
    return;
  }
  void Promise.resolve()
    .then(() => cmd.run())
    .catch((e) => warn(`命令 "${id}" 执行失败：${e}`));
}

export const plugins = {
  getSnapshot,
  subscribe,
  boot,
  enable,
  disable,
  reload,
  rescan,
  allViews,
  viewsFor,
  findView,
  runCommand,
  notifyTasksChanged,
  /** 设置面板的插件页读它 */
  hostVersion: () => HOST_API_VERSION,
  /** 设置面板改完插件设置值后调它，同步缓存 */
  setSettingValue,
  /** 已加载插件的 id 列表 */
  loadedIds: () => [...loaded.keys()],
  /** 调试用：设置值缓存 */
  settingValue: (pluginId: string, key: string) => settingCache.get(settingKey(pluginId, key)) ?? null,
};
