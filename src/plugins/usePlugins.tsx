/**
 * 插件与 React 之间的那一层：订阅注册表、错误边界、视图宿主。
 * 与 registry.ts 分开，免得只 import registry 就把 React 组件树拉进来。
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
 * 注册表的当前状态。getSnapshot 在没变时必须返回同一引用（registry.commit 保证），
 * 否则 useSyncExternalStore 会无限重渲染。
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
 * 完整视图清单：内置在前，插件在后。重名已由 manifest 校验挡掉，这里不做覆盖合并。
 * ⚠️ `builtin` 进依赖，调用方必须 memo 好 —— 内置视图可被关掉，清单要跟着重建。
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
 * 插件视图的错误边界，只包插件：插件抛错不该让甘特图整个白掉。
 * 也是热重载的前提 —— 错误状态下不重挂，改好后看到的仍是旧错误。
 */
class PluginBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
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
 * 插件视图外面那层容器。`data-plugin` 是 scopeCss 重写后的样式锚点；
 * 读 store.revision 让同步直读 store 的插件随数据变化重渲染。
 */
export function PluginViewHost({ view, children }: HostProps) {
  useAppStore((s) => s.revision);

  if (view.pluginId === "builtin") return <>{children}</>;

  return (
    <div data-plugin={view.pluginId} className="contents">
      <PluginBoundary label={view.label}>{children}</PluginBoundary>
    </div>
  );
}

/** 渲染一个视图；内置视图的 render 为 null，组件由调用方经 `fallback` 传入。 */
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
