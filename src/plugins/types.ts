/**
 * 插件系统的类型定义。
 *
 * 这里是**唯一的契约来源** —— 插件作者看到的 manifest 字段、onload 收到的
 * api 形状，全部以本文件为准。改动这里的任何一个字段都是破坏性变更，
 * 要让 manifest 的 apiVersion 跟着涨（见 manifest.ts 的版本检查）。
 *
 * 设计参照 Obsidian：插件是一个目录，含 manifest + 一个导出 onload 的模块，
 * 宿主提供 api 对象，插件用注册方法把能力挂到宿主上，卸载时宿主统一回收。
 * 照搬它的形状而不照搬它的规模 —— Obsidian 那套 API 面是十年长出来的，
 * 这里按「内部开发者 + 完整视图扩展」的实际需要裁剪。
 */

import type { ComponentType } from "react";

/** 半兼容版本号，与项目文件格式同一套约定（DESIGN.md 变更 5） */
export interface Version {
  major: number;
  minor: number;
}

/**
 * manifest.json。
 *
 * 字段刻意少。每一个字段都必须回答「宿主拿着它能做什么决定」——
 * 加一个用不上的字段，插件作者就得猜它是什么意思。
 */
export interface PluginManifest {
  /** 唯一标识。必须等于所在目录名，见 plugin.rs 的 dir_name 说明 */
  id: string;
  /** 显示名。设置面板和视图标签用它 */
  name: string;
  version: string;
  /** 插件作者，纯展示 */
  author?: string;
  /** 一句话说明。设置面板里显示在名字下面 */
  description?: string;
  /**
   * 需要的宿主 API 主版本。
   *
   * 只比对 major：宿主 1.2 能跑要 1.0 的插件，跑不了要 2.0 的。
   * minor 的差异只记警告 —— 这正是「major 拒绝、minor 放行并报告」的意思，
   * 和项目文件格式的版本策略一致。
   */
  apiVersion: string;
  /** 入口文件，相对插件目录。缺省 main.js */
  main?: string;
  /** 视图注册的声明式部分。真正的渲染函数在 onload 里给 */
  views?: PluginViewDeclaration[];
}

/**
 * manifest 里声明的视图。
 *
 * 为什么视图的**元信息**在 manifest 里、**渲染实现**在代码里：
 * 宿主需要在加载任何插件代码之前就知道有哪些视图存在 —— 工具条的按钮
 * 是 DB 里的 active_view 决定的，如果视图标签要等 import() 完成才知道，
 * 打开项目时会先画一排错位的按钮再跳一下。声明和实现分开，声明可以
 * 在扫描阶段就读到，实现留到 onload。
 */
export interface PluginViewDeclaration {
  /** 视图 key。全局唯一，建议写成 "<插件id>.<名字>" 避免和内置视图撞 */
  type: string;
  /** 工具条上的标签，两三个字 */
  label: string;
  /** 悬停提示。写「它回答什么问题」，和 core/views.ts 里内置视图同一个规矩 */
  hint: string;
}

/**
 * 一个可渲染的视图。
 *
 * 返回 React 组件而不是 DOM 节点：插件作者用宿主给的 react 写 JSX，
 * 就能和内置视图共享同一套 hooks、Context 和错误边界 —— 换成挂载点 +
 * 手写 DOM 的话，插件里没有 hook，状态管理得自己造一套，等于把宿主
 * 已经解决过的问题又交给每个插件作者解决一遍。
 */
export interface RegisteredView extends PluginViewDeclaration {
  /** 来自哪个插件。内置视图为 "builtin"（见 core/views.ts 的收编逻辑） */
  pluginId: string;
  render: ComponentType;
}

/**
 * 注册返回的句柄。调用 dispose() 注销。
 *
 * 每一个 register 方法都返回它，宿主卸载插件时统一调一遍 —— 插件作者
 * 不需要记得自己注册过什么，也不会因为漏了清理而在热重载后出现两份按钮。
 */
export interface Disposable {
  dispose: () => void;
}

/**
 * 插件的设置项描述。
 *
 * 只支持这三种类型。不做自由表单是因为设置面板的排版纪律很严（见
 * Settings.tsx 的 Section 组件：每一项都要有一句解释为什么），
 * 让插件塞任意 React 进来等于放弃这条纪律。
 */
export type PluginSettingField =
  | { key: string; kind: "text"; label: string; desc?: string; placeholder?: string; def?: string }
  | { key: string; kind: "toggle"; label: string; desc?: string; def?: boolean }
  | {
      key: string;
      kind: "select";
      label: string;
      desc?: string;
      options: { value: string; label: string }[];
      def?: string;
    };

/**
 * 插件拿到的设置读写把手。
 *
 * 值存在 settings 表里，key 会加上 "plugin.<插件id>." 前缀 ——
 * 否则两个插件都用 "theme" 当 key 就会互相覆盖，而且内置设置
 * （bar_color_by 之类）也会被插件改写。前缀在这里加，插件作者不必知道。
 */
export interface PluginSettings {
  get(key: string): string | null;
  getBool(key: string): boolean;
  set(key: string, value: string): void;
  /** 注册一个设置项，让它出现在设置面板的插件页里 */
  field(field: PluginSettingField): Disposable;
}

/** 命令。注册后在命令面板里可搜、可绑快捷键 */
export interface PluginCommand {
  /** 命令 id，同样建议带插件前缀 */
  id: string;
  label: string;
  /** 快捷键提示，如 "⌘⇧K"。**只是显示** —— 实际绑定由作者自己加监听 */
  hint?: string;
  run: () => void | Promise<void>;
}

/** 工具栏按钮 */
export interface PluginToolbarItem {
  id: string;
  /** 按钮上显示的字。建议短，工具条很挤 */
  label: string;
  title?: string;
  /** 只在某个视图下显示。不填则任何视图都显示 */
  onlyInView?: string;
  onClick: () => void;
}

/* ------------------------------------------------------------------ */
/* 数据访问                                                            */
/* ------------------------------------------------------------------ */

/**
 * 插件读任务用到的行。是 store 里 Task 的一个**只读投影**，不是 TaskRow。
 *
 * 不复用 Task 类型是为了让契约稳定：Task 是内部类型，重构它不该波及
 * 插件。这里只暴露插件真正用得上的字段，而且全是可序列化的原语。
 */
export interface TaskView {
  id: number;
  parentId: number | null;
  name: string;
  /** 天序号。用 api.util.toISODate 转成日期字符串 */
  startDay: number;
  endDay: number;
  progress: number;
  /** 0 高 / 1 中 / 2 低 / 3 无 */
  priority: number;
  personId: number | null;
  milestone: boolean;
  collapsed: boolean;
  /** 未关闭的阻碍条数 */
  openBlockers: number;
  /* 没有 note。任务备注刻意不在内存模型里（见 db/convert.ts：note 在保存时
     从原始行取回），store 手里那份不是最新的。给插件一个会过期的字段比
     不给更糟 —— 插件读到旧备注再写回去，就把用户刚写的内容覆盖了。 */
}

/**
 * 插件的数据 API。
 *
 * **全部同步**。这不是随手定的 —— 插件的视图是个 React 组件，它在 render
 * 期间读数据。异步接口逼着每个插件作者写 useEffect + useState 去镜像一份
 * 宿主已经持有的状态，那既啰嗦又必然出现「先画一帧空的」。
 *
 * 之所以能同步：宿主的数据本来就在内存里。任务在 store 的 tasks Map，
 * 逐日记录和风险在 store 里也是内存数组，没有一次读要走数据库。
 * （早期版本这里是 async，因为当时打算从 store 之外取数 —— 那个想法
 * 已经被丢掉了，见 registry.ts 顶部关于依赖方向的说明。）
 *
 * 分两层，对应项目里那条唯一的纪律（README:「任务数据只能经由命令栈修改」）：
 *
 *   tasks.*      —— 任务数据。**只读**。要改必须走命令栈，所以这里不提供
 *                   写方法。插件想改任务就走 act.*，由宿主构造命令。
 *   notes/risks  —— 即写即存的独立实体。直接读写，不进撤销栈 ——
 *                   这正是内置功能对它们的态度（见 store 里 dailyNotes 的注释：
 *                   ⌘Z 该撤销的是刚才那次拖拽，而不是把你写下的一句话抹掉）。
 */
export interface PluginDataApi {
  tasks: {
    /** 当前项目的任务快照。项目没打开时返回空数组 */
    list(): TaskView[];
    byId(id: number): TaskView | null;
    /** 订阅任务变化。宿主每次命令落地都会通知，返回值取消订阅 */
    subscribe(listener: () => void): () => void;
  };
  dailyNotes: {
    list(): { id: number; taskId: number | null; day: string; content: string }[];
    add(taskId: number | null, day: string, content: string): void;
    remove(id: number): void;
  };
  risks: {
    /** 未关闭的风险 */
    open(): { id: number; taskId: number; content: string; level: number }[];
    add(taskId: number, content: string, level: number): void;
  };
  /* 笔记是插件自己的数据。宿主不提供存储 —— 插件作者用 settings
     存小配置，要存大量结构化数据就自己在插件目录里写文件（走 fs 能力）。*/
}

/**
 * 修改动作。全部都经由命令栈，所以插件的操作**自动获得撤销/重做/落库**。
 *
 * 这是整个 API 里最关键的一层。如果插件直接改 store 里的 tasks，
 * 撤销栈会失效 —— 用户按 ⌘Z 会跳过插件那次修改撤掉更早的编辑，
 * 屏幕上出现一个没人预期过的中间状态。
 */
export interface PluginActionApi {
  /** 改任务字段。label 会出现在撤销按钮的提示里，写清楚改了什么 */
  patchTask(id: number, changes: Partial<TaskPatch>, label: string): void;
  /** 新建任务，返回新 id。插到 afterId 之后（null = 末尾） */
  addTask(name: string, afterId: number | null): number;
  deleteTask(id: number): void;
  /** 切顶层视图 */
  setActiveView(viewType: string): void;
}

/** 插件能改的任务字段。刻意比 Task 窄 —— 父任务日期是算出来的，改不了 */
export interface TaskPatch {
  name: string;
  startDay: number;
  endDay: number;
  progress: number;
  priority: 0 | 1 | 2 | 3;
  personId: number | null;
  milestone: boolean;
}

/**
 * 宿主交给插件的完整 api 对象。
 *
 * 这里**不暴露 Tauri 的 invoke**。插件拿到的每一个能力都是宿主显式给的；
 * 想加一个能力，得先在这里加一个方法，那一步就是评审点。等价于
 * Obsidian 的能力声明，但没有它那套运行时权限检查 —— 内部开发者场景下，
 * 代码审查比运行时拦截更有效，也更便宜。
 */
export interface PluginApi {
  /** 插件自己的 id，方便打日志 */
  readonly id: string;
  /** 宿主 API 版本，插件可以据此做降级 */
  readonly hostApiVersion: Version;
  /** React 本体。插件用它写 JSX，保证和宿主同一个实例 */
  readonly react: typeof import("react");
  views: {
    register(view: PluginViewDeclaration, render: ComponentType): Disposable;
  };
  commands: {
    register(command: PluginCommand): Disposable;
    /** 跑一个命令。给插件之间互相调用留的口子 */
    run(id: string): void;
  };
  toolbar: {
    register(item: PluginToolbarItem): Disposable;
  };
  settings: PluginSettings;
  data: PluginDataApi;
  act: PluginActionApi;
  /** 工具函数。日期换算这类每个插件都要写一遍的东西 */
  util: {
    /** 天序号 → "YYYY-MM-DD" */
    toISODate(day: number): string;
    /** "YYYY-MM-DD" → 天序号 */
    toDay(iso: string): number;
    today(): number;
  };
  /** 往控制台记一条日志，自动带插件前缀。开发时看日志用 */
  log(...args: unknown[]): void;
}

/**
 * 插件模块的默认导出。
 *
 * onunload 是可选的，但**强烈建议实现**：热重载和禁用开关都会调它。
 * 宿主会把 register 系列返回的 Disposable 自动回收掉，所以 onunload
 * 只需要清理插件自己加在 window/document 上的东西（事件监听、定时器）。
 */
export interface PluginModule {
  onload(api: PluginApi): void | Promise<void>;
  onunload?(): void;
}

/** 扫描 + 校验之后，一个插件的完整状态。设置面板直接渲染这个数组 */
export interface PluginRecord {
  manifest: PluginManifest;
  /** 目录绝对路径 */
  path: string;
  enabled: boolean;
  /**
   * 能不能用。
   *
   * 三态：ok / disabled（用户关的）/ error（manifest 坏了或加载时抛了）。
   * 设置面板要分开呈现 —— 「你关掉的」和「坏的」是两回事，
   * 前者不用管，后者需要修。
   */
  status: "loaded" | "disabled" | "error";
  /** status === "error" 时的原因。直接显示给用户，所以要说人话 */
  error?: string;
  /** 校验阶段的警告。不挡住加载，但要让作者看见 */
  warnings: string[];
}
