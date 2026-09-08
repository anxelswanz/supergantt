import { useEffect } from "react";
import { LayoutGroup } from "motion/react";
import { ProjectList } from "./screens/ProjectList";
import { Workspace } from "./screens/Workspace";
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const screen = useAppStore((s) => s.screen);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadPeople = useAppStore((s) => s.loadPeople);

  // 视图偏好是全局的，进哪个项目都一样，所以在应用挂载时读一次就够
  useEffect(() => {
    void loadSettings();
    void loadPeople();
  }, [loadSettings, loadPeople]);

  // LayoutGroup 让项目卡片和工作区共享同一个 layoutId，
  // 点击时卡片直接放大变形成工作区，而不是淡入淡出（DESIGN.md §4.3）
  return (
    <LayoutGroup>
      {screen.name === "list" ? <ProjectList /> : <Workspace />}
    </LayoutGroup>
  );
}
