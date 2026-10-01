/**
 * 插件与 React 之间的那一层。
 *
 * 这里只放三样东西，都是插件系统的渲染侧必需、而又**不该**被 registry.ts
 * 那个纯逻辑单例拖进来的：订阅注册表、错误边界、视图宿主。
 *
 * 为什么单独一个文件而不是塞进 registry.ts：registry 被 boot() 在应用启动
 * 时调用，那时 React 根还没挂载。把组件放进去会让「加载一个插件」和
 * 「渲染一棵树」这两件事在 import 图里绑死，将来想在别处（比如 CLI 的
 * 测试里）只 import registry 就会把整个 React 组件树拉进来。
 */

import * as React from "react";
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useSyncExternalStore } from "react";

import { useAppStore } from "../store/useAppStore";
import { plugins, type RegistryState } from "./registry";
import type { RegisteredView } from "./types";

/* ------------------------------------------------------------------ */
/* 订阅注册表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 注册表的当前状态。注册/注销视图、命令、设置项都会让它变。
 *
 * useSyncExternalStore 要求 getSnapshot 在状态没变时返回**同一个引用**，
 * 这一点由 registry 的 commit() 保证：只有真正变更时才生成新对象
 * （见那里的 snapshot 变量）。直接在 getSnapshot 里 `{...state}` 会
 * 每次返回新对象，React 判定「一直在变」然后无限重渲染。
 */
export function useRegistry(): RegistryState {
  return useSyncExternalStore(plugins.subscribe, plugins.getSnapshot, plugins.getSnapshot);
}

/* ------------------------------------------------------------------ */
/* 视图清单                                                            */
/* ------------------------------------------------------------------ */

export interface ViewEntry {
  key: string;
  label: string;
  hint: string;
  /** "builtin" 表示内置视图，渲染走 Workspace 自己的组件 */
  pluginId: string;
  render: ComponentType | null;
}

/**
 * 完整视图清单：内置在前，插件在后。
 *
 * 内置的那几个由调用方传进来 —— 本模块不该知道 GanttView / BoardView
 * 这些组件在哪，那是 Workspace 的事。传进来而不是从 core/views.ts 里读，
 * 是因为「内置视图有哪些」和「它们的组件在哪」是两个信息，前者 core
 * 知道，后者只有 Workspace 知道。
 *
 * 注意这里**没有做「插件视图覆盖内置视图」的合并**。manifest 校验阶段
 * 已经挡掉了和内置 key 重名的注册（见 RESERVED_VIEW_TYPES），所以走到
 * 这里的 key 一定唯一；真出现重复说明有人绕过了校验，那时候保留两份让
 * 它显形，比静默地后者覆盖前者好。
 *
 * ⚠️ **`builtin` 必须由调用方 memo 好。** 它曾经被当成常量（用 ref 读、
 * 不进依赖），那在内置视图可以被用户关掉之后就错了：关掉看板时
 * `enabledViews` 变了、`builtin` 变了，但 views 没变，于是这份清单不重建 ——
 * 工具条上那个按钮赖着不走，而快捷键编号已经改了。
 *
 * 现在它进依赖。代价是传一个就地构造的数组字面量会让清单每帧重建；
 * 换来的是「内置视图清单会变」这件事真的被表达出来了。
 */
export function useViews(builtin: ViewEntry[]): ViewEntry[] {
  const { views } = useRegistry();

  return React.useMemo(() => {
    const fromPlugins: ViewEntry[] = views.map((v: RegisteredView) => ({
      key: v.type,
      label: v.label,
      hint: v.hint,
      pluginId: v.pluginId,
      render: v.render,
    }));
    return [...builtin, ...fromPlugins];
  }, [views, builtin]);
}

/* ------------------------------------------------------------------ */
/* 错误边界                                                            */
/* ------------------------------------------------------------------ */

interface BoundaryProps {
  children: ReactNode;
  /** 出错时显示的那一行前缀，通常是插件名 */
  label: string;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * 插件视图的错误边界。
 *
 * **整个应用里唯一的一个**，而且只包插件。这不是巧合：内置视图在开发和
 * 评审里都会被跑到，插件不会 —— 一个内部作者写的、没人评审过的组件抛错，
 * 结果不该是甘特图整个白掉，那会让人觉得「这个软件坏了」而不是「那个
 * 插件坏了」。界面上必须把这个区别说清楚。
 *
 * 同时它也是热重载的前提：错误状态下不重挂的话，用户改好 main.js 点
 * 重载，看到的还是旧错误。
 */
class PluginBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 面包屑留给控制台 —— 设置面板只显示一句话，堆栈得有地方看
    console.error(`[plugin] ${this.props.label} 的视图渲染失败`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] p-5">
          <div className="mb-1.5 text-sm font-semibold text-[var(--text)]">
            {this.props.label} 的视图出错了
          </div>
          <div className="mb-3 text-xs leading-relaxed text-[var(--text-dim)]">
            这个视图是插件提供的，问题出在插件里，不影响项目的其余部分 ——
            数据没动，切回甘特图继续用就行。
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-[var(--surface)] p-2.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
            {error.message}
          </pre>
          <div className="mt-3 text-[11px] text-[var(--text-dim)]">
            改好插件的入口文件后，到 设置 → 插件 里点「重新加载」。
          </div>
        </div>
      </div>
    );
  }
}

/* ------------------------------------------------------------------ */
/* 视图宿主                                                            */
/* ------------------------------------------------------------------ */

interface HostProps {
  view: ViewEntry;
  children: ReactNode;
}

/**
 * 插件视图外面那层容器。
 *
 * 两件事：
 *
 * 1. **带上 `data-plugin="<id>"`** —— 插件的 CSS 被 scopeCss 重写成了
 *    `[data-plugin="<id>"] .note-card { ... }`，那个属性就得有个地方落下。
 *    没有这层容器，插件的样式一条都命中不了。
 *
 * 2. **把 store 的 revision 打进去** —— 插件读数据是同步直读 store
 *    （见 types.ts 的 PluginDataApi），所以它需要在任务变化时被重渲染。
 *    宿主已经维护着一个全应用统一的 revision 计数器（每个内置视图也是
 *    这么用的），这里读一下就把插件接进了同一条更新链路。
 *
 *    为什么不给插件 API 一个订阅式的接口：那样每个插件作者都要写
 *    useEffect + useState 去镜像一份宿主已经持有的状态，而这个镜像必然
 *    在某次改动上漏掉或滞后。读 revision 是零成本的，而且和内置视图
 *    走的完全是同一条路 —— 内置视图对这件事的正确答案是什么，插件就
 *    是什么。
 */
export function PluginViewHost({ view, children }: HostProps) {
  // 订阅任务变化。值本身不用，要的是「变了就重渲染」这个副作用
  useAppStore((s) => s.revision);

  if (view.pluginId === "builtin") return <>{children}</>;

  // key 带上 revision 之外还要带上 pluginId：重载后是同一个组件类型、
  // 同一棵位置的树，React 会复用实例；带上 id 保证换插件时状态不串
  return (
    <div data-plugin={view.pluginId} className="contents">
      <PluginBoundary label={view.label}>{children}</PluginBoundary>
    </div>
  );
}

/**
 * 渲染一个视图，自带边界和插件作用域。
 *
 * `fallback` 是内置视图的组件：内置视图的 render 在清单里是 null（它们是
 * Workspace 手里的常量，不该被 import 进插件系统），由调用方按 key 传进来。
 * 插件视图则用注册表给的那个 render。
 */
export function ViewRenderer({
  view,
  fallback,
}: {
  view: ViewEntry;
  fallback?: ComponentType;
}) {
  const Body = view.render ?? fallback ?? null;
  return (
    <PluginViewHost view={view}>
      {Body ? <Body /> : null}
    </PluginViewHost>
  );
}
