/**
 * 云备份的前端一侧：读写配置、定时触发一轮同步、拉下来之后把界面刷新到新数据。
 * 真正的比对和传输在 Rust（src-tauri/src/cloud.rs），这里只管「什么时候跑」和「跑完怎么收尾」。
 */

import { create } from "zustand";
import { api, type CloudConfig, type CloudSyncReport } from "../db/api";
import { backupStamp } from "../transfer/projectFile";
import { useAppStore } from "../store/useAppStore";

const CONFIG_KEY = "cloud.config";

export const DEFAULT_CLOUD: CloudConfig = {
  enabled: false,
  url: "",
  anonKey: "",
  syncKey: "",
  intervalMin: 1,
};

export async function loadCloudConfig(): Promise<CloudConfig> {
  const raw = await api.getSetting(CONFIG_KEY).catch(() => null);
  if (!raw) return DEFAULT_CLOUD;
  try {
    return { ...DEFAULT_CLOUD, ...(JSON.parse(raw) as Partial<CloudConfig>) };
  } catch {
    return DEFAULT_CLOUD;
  }
}

export async function saveCloudConfig(config: CloudConfig): Promise<void> {
  await api.setSetting(CONFIG_KEY, JSON.stringify(config));
  useCloudStatus.setState({ config });
}

/** 设置页和状态栏都读这一份 */
export const useCloudStatus = create<{
  config: CloudConfig | null;
  running: boolean;
  last: CloudSyncReport | null;
  /** 整轮失败（连不上、没配置好），不是某个项目失败 */
  error: string | null;
}>(() => ({ config: null, running: false, last: null, error: null }));

/**
 * 跑一轮。正开着的项目先落库 —— Rust 从库里读快照，没落库的编辑不会被传上去；
 * 跑完如果它被云端覆盖了，就从库里重新打开它。
 */
export async function runCloudSync(): Promise<CloudSyncReport | null> {
  if (useCloudStatus.getState().running) return null;
  useCloudStatus.setState({ running: true });
  try {
    const st = useAppStore.getState();
    const openId = st.screen.name === "workspace" ? st.screen.projectId : null;
    if (st.persistence) await st.persistence.flush();

    const report = await api.cloudSync(openId, backupStamp(new Date()));
    useCloudStatus.setState({ last: report, error: null });
    await refreshAfter(report, openId);
    return report;
  } catch (e) {
    useCloudStatus.setState({ error: String(e) });
    return null;
  } finally {
    useCloudStatus.setState({ running: false });
  }
}

async function refreshAfter(report: CloudSyncReport, openId: number | null) {
  const st = useAppStore.getState();
  const changed = report.pulled.length > 0 || report.deletedLocal.length > 0;
  if (!changed) return;

  if (openId != null && report.pulled.some((p) => p.id === openId)) {
    // 换掉内存里的任务表。撤销栈跟着清空 —— 它记的是被覆盖之前那份数据上的操作
    st.persistence?.detach();
    st.detachGuards?.();
    const view = st.activeView;
    await st.openProject(openId);
    useAppStore.getState().setActiveView(view);
  }
  if (useAppStore.getState().screen.name === "list") await useAppStore.getState().loadProjects();
}

/** 应用挂载时调一次：按配置起定时器，配置变了自动重排。返回停止函数 */
export function startCloudSync(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let current: string | null = null;

  const arm = (config: CloudConfig | null) => {
    const key = config ? `${config.enabled}|${config.intervalMin}|${config.url}` : null;
    if (key === current) return;
    current = key;
    if (timer) clearInterval(timer);
    timer = null;
    if (!config?.enabled || !config.url) return;
    const minutes = Math.max(1, Math.round(config.intervalMin || 1));
    timer = setInterval(() => void runCloudSync(), minutes * 60_000);
    // 打开开关 / 启动应用时先跑一轮，不必干等一个周期
    void runCloudSync();
  };

  const unsubscribe = useCloudStatus.subscribe((s) => arm(s.config));
  void loadCloudConfig().then((c) => useCloudStatus.setState({ config: c }));

  return () => {
    unsubscribe();
    if (timer) clearInterval(timer);
  };
}
