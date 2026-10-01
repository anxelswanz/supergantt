import { useEffect } from "react";
import { LayoutGroup } from "motion/react";
import { ProjectList } from "./screens/ProjectList";
import { Workspace } from "./screens/Workspace";
import { plugins } from "./plugins/registry";
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const screen = useAppStore((s) => s.screen);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadPeople = useAppStore((s) => s.loadPeople);
  const setSystemDark = useAppStore((s) => s.setSystemDark);

  /**
   * 启动插件系统，**然后**读设置。
   *
   * 顺序不能反。`loadSettings` 会把上次的 active_view 恢复出来，而那个 key
   * 可能是某个插件注册的视图 —— 插件还没扫过的话，Workspace 查不到它就回退
   * 到甘特，用户会看到「打开软件总是先闪一下甘特图」。先 boot 再 loadSettings，
   * 恢复的那个视图当场就是对的。
   *
   * boot() 自己**不抛错**（坏插件只影响它自己），所以这里不需要 catch；
   * 插件目录整个读不了的情况记在 bootError 里，由设置面板显示。
   *
   * 这也让「同一批任务、几种看法」这件事对插件开放了：插件注册的视图和
   * 内置四个走完全同一条恢复路径。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await plugins.boot();
      if (cancelled) return;
      // 视图偏好是全局的，进哪个项目都一样，所以在应用挂载时读一次就够
      await loadSettings();
    })();
    void loadPeople();
    return () => {
      cancelled = true;
    };
  }, [loadSettings, loadPeople]);

  /**
   * 系统深浅变化的唯一监听源。
   *
   * 放在 App 而不是 GanttView：甘特图只是主题的一个消费方，而项目列表、设置面板
   * 这些它之外的界面同样要跟着变。之前监听在 GanttView 里，意味着离开甘特视图
   * 之后系统切主题就没人管了。
   *
   * 监听器**始终**挂着（即使当前是「浅色」档）—— setSystemDark 会自己判断
   * 该不该动 DOM，这样从固定档切回「跟随系统」时手头已经有最新的系统状态，
   * 不用临时再问一次。
   */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    // 挂载时对齐一次：首帧脚本读的是 localStorage，而 store 初值也是同一处，
    // 但两者运行时机不同，中间系统可能已经切过了
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [setSystemDark]);
  // LayoutGroup 让项目卡片和工作区共享同一个 layoutId，
  // 点击时卡片直接放大变形成工作区，而不是淡入淡出（DESIGN.md §4.3）
  return (
    <LayoutGroup>
      {screen.name === "list" ? <ProjectList /> : <Workspace />}
    </LayoutGroup>
  );
}
