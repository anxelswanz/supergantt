/**
 * 插件运行时。
 *
 * 这是一个**模块级单例**，不是 React 状态。理由和 store 一样：插件注册的
 * 视图/命令/工具栏项必须能被非 React 的地方读到（快捷键监听、工具条渲染、
 * 设置面板），挂在某个组件的 state 里就够不着了。React 侧通过
 * useSyncExternalStore 订阅它（见 usePlugins）。
 *
 * 生命周期：
 *   boot()       应用启动时调一次，扫描目录、校验、加载所有启用的插件
 *   enable(id)   启用
 *   disable(id)  禁用，回收它注册的一切
 *   reload(id)   热重载：先卸再装（开发时用）
 *
 * 插件注册的东西一律通过 Disposable 回收，**由宿主负责而不是插件作者** ——
 * 作者只要 register 一次，卸载时不会漏清理，热重载也不会留下两份按钮。
 * 这是 Obsidian 的 registerView/registerEvent 那套的核心价值。
 *
 * ## 依赖方向
 *
 * 本模块 import store，store **不** import 本模块。插件注册的视图用字符串
 * key 表示，store 的 activeView 也收字符串 —— 校验一个 key 合不合法由
 * 读设置的地方（本模块和 core/views.ts）负责，不由 store 负责。这样依赖是
 * 单向的，插件 API 的读方法因此可以全是同步的：没有异步边界。
 *
 * 早期版本为了避免这个 import 用了动态 import()，代价是插件作者拿到的每个
 * 读方法都返回 Promise，于是在 React 组件的 render 里根本没法用。那是个
 * 明显的坏契约，换成单向依赖就消失了。
 *
 * 另一个贯穿全文件的取舍：宿主对插件**宽容**。任何一个插件坏掉（manifest
 * 写错、入口抛异常、把 React 打进了两个副本）都只影响它自己，应用照常启动，
 * 错误显示在设置面板里。插件系统最不能犯的错是「一个坏插件让甘特图打不开」。
 */

import * as React from "react";
import type { ComponentType } from "react";

import { api } from "../db/api";
import type { BlockedPeriod } from "../core/blocked";
import { kindLabel, mergeItems } from "../core/items";
import type { Task } from "../gantt/model";
import { useAppStore } from "../store/useAppStore";
import { HOST_API_VERSION, validateManifest } from "./manifest";
import type {
  Disposable,
  PluginApi,
  PluginCommand,
  PluginManifest,
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
  /** 全部被发现的插件，含坏的和关掉的。设置面板渲染它 */
  records: PluginRecord[];
  /** 当前可用的全部视图：内置在前，插件按注册顺序在后 */
  views: RegisteredView[];
  /** 已注册的命令，按 id 索引 */
  commands: Map<string, PluginCommand>;
  toolbar: PluginToolbarItem[];
  settingFields: { pluginId: string; field: PluginSettingField }[];
  /** 第一次扫描完成了没有。设置面板要区分「还没扫」和「扫了，一个都没有」 */
  booted: boolean;
  /** 扫描阶段的全局错误（比如读不了插件目录）。null = 没出错 */
  bootError: string | null;
}

const state: RegistryState = {
  records: [],
  views: [],
  commands: new Map(),
  toolbar: [],
  settingFields: [],
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

/**
 * 不可变快照。
 *
 * useSyncExternalStore 要求 getSnapshot 在同一状态下返回同一个引用，否则
 * React 判定「一直在变」而无限重渲染 —— 所以只在真正变更时（commit）
 * 生成新对象，平时返回上一次的。
 */
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
 * 设置值的内存缓存。
 *
 * 需要它是因为 `api.settings.get` 是**同步**的，而底层要走 async 的 invoke。
 * 同步接口对插件作者友好得多 —— 不用为了读一个开关把 onload 变成一串
 * await，也让组件里 `if (api.settings.getBool("x"))` 这种写法成立。
 *
 * 代价是宿主必须在插件跑起来之前把全部 `plugin.*` 读进内存。用
 * `listSettingsWithPrefix("plugin.")` 一次查回来（见 db.rs 里那个命令的
 * 说明：逐个 key 读要求宿主先知道名字，而「有哪些 key」是插件自己的事）。
 * 插件的配置都是小开关和短字符串，全读进来到不了几 KB。
 */
const settingCache = new Map<string, string>();
const PLUGIN_SETTING_PREFIX = "plugin.";

/** 加命名空间。前缀在这里加，插件作者不必知道 */
const settingKey = (pluginId: string, key: string) => `${PLUGIN_SETTING_PREFIX}${pluginId}.${key}`;

/**
 * 写一个插件设置值：先落缓存，再落库（不等写库完成）。
 *
 * **唯一的一条写路径**，插件的 api.settings.set 和设置面板都调它。
 * 之所以要收口：前缀是在这里拼的（"plugin.<id>.<key>"），如果面板自己
 * 拼一遍 strings，将来前缀规则一改，面板写的值插件就读不到了 ——
 * 而这种错配的现象是「设置面板里存住了，插件却当没设过」，很不好查。
 *
 * 顺序也不能反。插件读的是缓存（同步直读），先写库再更新缓存的话，
 * 中间那几毫秒里插件拿到的还是旧值；而设置项通常是「改完立刻要生效」。
 * 落库失败只吞掉，不回滚缓存：数据库写不进去时软件本身已经不正常了，
 * 让界面上的开关弹回去只会让用户更迷惑。
 */
export function setSettingValue(pluginId: string, key: string, value: string): void {
  settingCache.set(settingKey(pluginId, key), value);
  void api.setSetting(settingKey(pluginId, key), value).catch(() => {});
}

/** 把 settings 表里全部 plugin.* 读回缓存。启动时和每次加载插件后各调一次 */
async function warmSettings(): Promise<void> {
  const rows = await api
    .listSettingsWithPrefix(PLUGIN_SETTING_PREFIX)
    .catch(() => [] as [string, string][]);
  for (const [k, v] of rows) settingCache.set(k, v);
}

/** 插件声明的设置项的默认值也进缓存 —— 没存过的时候 get 要拿到 def 而不是 null */
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

/**
 * 内置视图的占位注册项。
 *
 * 内置视图的**元信息**（key/label/hint）在 core/views.ts，**实现**在
 * Workspace.tsx。这里只把元信息翻译成注册表的形状，让视图列表只有一个
 * 来源 —— 工具条不必写「先列内置的，再列插件的」。
 *
 * 为什么不把内置视图的组件也收进来：那会让本模块 import GanttView /
 * BoardView 一大串，插件系统就从「可选的一层」变成所有视图的必经之路 ——
 * 这个文件出问题时连甘特图都渲染不出来。元信息和实现分开，插件挂了
 * 也只是插件视图挂了。
 */
export function builtinViews(
  meta: { key: string; label: string; hint: string }[],
): RegisteredView[] {
  return meta.map((m) => ({
    type: m.key,
    label: m.label,
    hint: m.hint,
    pluginId: "builtin",
    // 占位。Workspace 见到 pluginId === "builtin" 会用自己的组件，不会走到
    // 这里；给一个明确抛错的实现而不是 null，是为了让「万一走到了」这件事
    // 在屏幕上看得见，而不是白屏
    render: () => {
      throw new Error(`内置视图 "${m.key}" 的实现缺在 Workspace 里，不该走到注册表的 render`);
    },
  }));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function warn(msg: string) {
  // 不引 UI 依赖。插件出问题时必须让用户看得见 —— 否则「我明明放进去了」
  // 会变成一个查不出来的问题
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

/**
 * 只实现插件 API 需要的最小集，**不 import core/dateLink 或 db/convert** ——
 * 那两个模块的内部表示随时可能重构，而插件契约必须稳定。
 *
 * 基准与 convert.ts 一致：2000-01-01 UTC = 第 0 天。两处必须同步修改。
 */
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

/**
 * store 里的 Task → 插件能看的 TaskView。
 *
 * 必须是投影而不是直接把 Task 给出去：Task 是内部类型（有 sortOrder、
 * weight、pinned、autoRollover、actualStartDay 这些插件用不上的字段），
 * 重构它不该波及插件。投影层就是那道隔离带。
 */
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

/**
 * 数还没关闭的阻碍。
 *
 * 判据是 `open === true`，**不是**「有结束时间」—— core/blocked.ts 明确
 * 规定 `open` 缺省（历史数据、⌥ 拖出来的标注）一律当已关闭，因为让一个新
 * 字段的默认值去改写既有项目的排期是不可接受的。这里必须和它一致，否则
 * 插件和内置的看板会把同一批数据数成两个数。
 */
function countOpenBlockers(blocked: BlockedPeriod[] | undefined): number {
  if (!Array.isArray(blocked)) return 0;
  return blocked.filter((b) => b.open === true).length;
}

/**
 * 事项清单快照。走和事项视图同一个合并层，见 types.ts 里 items 的说明。
 * 不排序 —— 顺序是视图的事，插件要什么顺序自己排。
 */
export function itemSnapshot(): ItemView[] {
  const s = useAppStore.getState();
  if (!s.project) return [];
  const tasks = [...s.tasks.values()];
  const taskName = new Map(tasks.map((t) => [t.id, t.name]));
  const personName = new Map(s.people.map((p) => [p.id, p.name]));

  return mergeItems({
    notes: s.itemNotes,
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, personId: t.personId, blocked: t.blocked })),
    risks: s.projectRisks,
    today: todayDays(),
  }).map((r) => ({
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
    // 阻碍没有记录时刻，用它开始的那天；其余按本地时区取日期 ——
    // 「今天记的」说的是用户墙上的今天，不是 UTC 的今天
    day: r.blocker ? daysToIso(r.blocker.period.from) : localDate(r.createdAt),
    closed: r.closed,
    resolution: r.resolution,
    riskLevel: r.risk ? r.risk.level : null,
  }));
}

function localDate(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前任务快照。一次遍历 Map 构造数组，代价可以忽略 */
function taskSnapshot(): TaskView[] {
  const out: TaskView[] = [];
  for (const t of useAppStore.getState().tasks.values()) out.push(toTaskView(t));
  return out;
}

/* ------------------------------------------------------------------ */
/* 宿主 api 对象                                                       */
/* ------------------------------------------------------------------ */

function makeApi(manifest: PluginManifest, disposables: Disposable[]): PluginApi {
  const id = manifest.id;
  const track = <T extends Disposable>(d: T): T => {
    disposables.push(d);
    return d;
  };
  const store = () => useAppStore.getState();

  return {
    id,
    hostApiVersion: HOST_API_VERSION,
    /**
     * React 本体。
     *
     * 插件要用 hooks 就得自己 `import React from "react"` —— 必须把它打进
     * 插件自己的包里，因为 hooks 认的是模块实例，宿主给一份、插件再打一份
     * 会让 useState 直接抛错。这里给的引用只是让插件在需要 React.Children
     * 这类顶层 API 时有地方拿。assertSelfContained 会挡住 import "react"
     * 的写法，所以插件作者实际上只能通过 esbuild/rollup 之类的工具把
     * React 打进入口文件 —— 那条路走的是打包器解析，不经过这一层。
     */
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
        // 声明的同时把默认值放进缓存，否则「刚注册、还没改过」时 get 拿到
        // 的是 null 而不是 def —— 那个 bug 只在第一次启动时出现
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
      tasks: {
        list: taskSnapshot,
        byId(taskId) {
          const t = store().tasks.get(taskId);
          return t ? toTaskView(t) : null;
        },
        subscribe(listener) {
          taskSubscribers.add(listener);
          // 返回裸的 () => void 而不是 Disposable：这个契约要尽量贴近
          // 「取消订阅」这个通用形状，插件作者一眼就认得。Disposable
          // 是宿主内部回收用的，track 会在卸载时统一调 dispose
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
      /**
       * 改任务字段。走 store 的 patchTask —— 那条路会构造 Edit、进命令栈，
       * 于是撤销/重做/落库全部自动正确。插件这一层的存在意义就是它。
       */
      patchTask(taskId, changes, label) {
        store().patchTask(taskId, changes, label);
      },

      /**
       * 新建任务，返回新 id。
       *
       * store 的 addTaskAfter 是 void 的，新 id 由它内部那个私有的 nextId()
       * 闭包产生，外面拿不到。这里在调用前后比对 tasks 的键集把新 id 认出来
       * —— 代价是一次 O(n) 的集合差，换来的是不必为了插件去改 store 的签名。
       *
       * 注意这是**两笔命令**（插入空名任务 + 改名），所以 ⌘Z 要按两次。一步
       * 到位的实现需要往命令栈里塞一个 store 不认识的新命令类型，那会破坏
       * 「命令一律由 edits 构造」这条纪律，不值得。
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
/* 任务变更通知                                                        */
/* ------------------------------------------------------------------ */

const taskSubscribers = new Set<() => void>();

/**
 * store 每次命令落地后由 usePlugins 的 effect 调它。
 *
 * 插件读数据是同步直读 store，这个通知只负责告诉它们「该重读了」。做成一
 * 个显式的推送而不是让插件自己 subscribe store：插件订阅的是「任务变了」，
 * 不是「store 里任何东西变了」（选中行、抽屉开合都不该让插件的视图重算）。
 */
export function notifyTasksChanged(): void {
  for (const fn of taskSubscribers) fn();
}

/* ------------------------------------------------------------------ */
/* 加载 / 卸载                                                         */
/* ------------------------------------------------------------------ */

/**
 * 插件源码里 import 了相对路径或裸模块名时，直接拒掉并说清楚。
 *
 * 插件是从 Blob URL 加载的，**没有基准路径也没有模块解析**：
 *   - `import "./helper.js"` → 浏览器相对当前页面找，404，而且报错信息里
 *     只有一串 blob: 开头的 URL，看不出是哪个 import 出的问题
 *   - `import "react"` → 同样解析不了（裸说明符需要 import map）
 *
 * 所以插件的入口必须是**自包含的单文件**，React 这类依赖要作者自己打包
 * 进去。这里不尝试重写这些说明符（把 "./helper.js" 变成绝对路径）—— 那需要
 * 把插件目录暴露成可请求的资源，而项目没开 fs 插件、也没配 assetProtocol
 * scope，等于为了一个方便打开一条读任意文件的路。与其做一个半吊子的重写，
 * 不如在加载前给出这句明确的报错。
 */
function assertSelfContained(source: string, pluginId: string): void {
  // 只挑出 import/export 语句里的说明符，不做真正的解析：插件入口是作者自己
  // 写的小文件，正则会误伤的场景（字符串字面量里出现 import "x"）在这里不
  // 存在，而引一个 AST 解析器进宿主核心不划算
  const specifiers = [
    ...source.matchAll(/\bfrom\s*(["'])([^"']+)\1/g),
    ...source.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g),
    ...source.matchAll(/\bimport\s+(["'])([^"']+)\1/g),
  ].map((m) => m[2]);

  // 相对路径和裸说明符都不行。绝对 URL（blob:、data:、http(s):）放行 ——
  // 那是作者自己选择的外部依赖，宿主没有立场替他判断
  const bad = specifiers.filter((s) => s.startsWith(".") || !/^[a-z][a-z0-9+.-]*:/i.test(s));
  if (bad.length === 0) return;
  throw new Error(
    `插件 ${pluginId} 的入口里有 import 不了的模块：${[...new Set(bad)].join("、")}。` +
      `插件是单文件加载的，不能 import 相对路径或其他包 —— 把这些代码一起写进入口文件，` +
      `或者先用打包工具打成一个 bundle`,
  );
}

/**
 * 把插件的样式关进命名空间。
 *
 * 插件作者写 `.note-card { ... }` 时不该操心撞宿主的名 —— 每条规则的选择器
 * 前面加上 `[data-plugin="<id>"] `，这个属性由宿主在插件视图外面那层容器上
 * 写好（见 Workspace 的 PluginViewHost）。
 *
 * 不是完整的 CSS 解析器：@media / @supports 原样保留（内部规则各自作为独立
 * rule 会被顺序扫描到时再处理），@keyframes 整块跳过（里面的百分比选择器加
 * 前缀就是无效语法）。够用，而且不会把插件样式表悄悄改坏。
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
    // 找配对的 }
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === "{") depth++;
      else if (css[close] === "}") depth--;
      close++;
    }

    const head = css.slice(i, open);
    const body = css.slice(open, close);

    // at-rule（@media / @keyframes / @font-face …）原样输出
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
        // :root / html / body 改写成作用域本身，否则插件的
        // `:root { --x: red }` 会污染宿主的设计 token（那样深浅色主题一起坏）
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
  source: string,
  css: string | null,
): Promise<void> {
  assertSelfContained(source, manifest.id);

  const disposables: Disposable[] = [];

  // 样式先注入。失败也只是没样式，不该挡住插件加载
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
    // blob 不撤会一直占着内存，热重载时尤其明显
    URL.revokeObjectURL(url);
  }

  if (typeof module.onload !== "function") {
    styleEl?.remove();
    throw new Error("入口文件没有导出 onload 函数");
  }

  const api = makeApi(manifest, disposables);
  try {
    await module.onload(api);
  } catch (e) {
    // onload 抛错时它可能已经注册了一半东西，全部撤掉，否则会留下一个
    // 「状态是 error 但视图还挂在工具条上」的幽灵插件
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

  // onunload 先跑：插件自己清 window 上的监听和定时器。抛错也要继续往下回收，
  // 否则一次失败的 onunload 会把它注册的视图永久留在宿主里，热重载之后
  // 变成两份
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
 * 启用状态存成一个 JSON 数组，而不是每个插件一个 key。
 *
 * 插件目录会被删掉，散落的 `plugin.<id>.enabled` 会变成 settings 表里永远
 * 清不掉的垃圾。一个数组读一次、写一次，插件消失时它的 id 自然从数组里被
 * 过滤掉。
 *
 * `exists` 这一位是必要的：从没启用过任何插件时（`plugins_enabled` 不存在），
 * 和「启用过、但现在一个都不启用」（存着 `[]`）是两种不同的状态。前者说明
 * 这是第一次运行，任何一个插件都不该自动跑起来。
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

/** manifest 坏掉时给个占位，好让设置面板把它显示出来让用户去修 */
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

/**
 * 扫描插件目录并按记录启用。
 *
 * **不抛错**：任何一个插件坏掉都只影响它自己。读不了插件目录这种全局失败
 * 记进 bootError，应用照常起。
 */
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
      // 从没见过的新插件默认**不**自动跑起来。用户先在设置里看一眼它是什么、
      // 再点启用 —— 自动执行刚被拖进目录的代码是不该做的事
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
        await instantiate(manifest, r.entry_raw, r.css_raw);
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

/** 启用。会重新读一遍目录，这样用户不必重启应用就能看到刚改过的插件 */
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
  // 目录里的 manifest 可能在上次扫描之后被改过，以上面这次为准
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
    await instantiate(check.manifest, dir.entry_raw, dir.css_raw);
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
  record.enabled = false;
  record.status = "disabled";
  record.error = undefined;
  await persistEnabled();
  commit();
}

/**
 * 热重载：先卸再装。**开发时主要靠它** —— 改完 main.js 回到设置面板点一下
 * 就行，不用重启应用。
 *
 * 它同时是 onunload 的验收手段：如果重载之后工具条上出现两个按钮，那就是
 * 插件漏清了东西（宿主回收的那部分不会出这个问题）。
 */
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

/** 跑一个命令。命令面板和插件内部调用都走它 */
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
  allViews,
  viewsFor,
  findView,
  runCommand,
  notifyTasksChanged,
  /** 设置面板的插件页读它 */
  hostVersion: () => HOST_API_VERSION,
  /** 设置面板改了插件设置项的值以后调它，让缓存同步 */
  setSettingValue,
  /** 当前已加载插件的 id 列表 */
  loadedIds: () => [...loaded.keys()],
  /** 调试用：设置值的当前缓存，设置面板改完值要能立刻反映出来 */
  settingValue: (pluginId: string, key: string) => settingCache.get(settingKey(pluginId, key)) ?? null,
};
