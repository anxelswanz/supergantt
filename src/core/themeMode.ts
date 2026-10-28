/**
 * 主题模式（DOM 与 Canvas 共用的唯一判据）。
 * 存 localStorage 而非 SQLite：同步可读，首帧前就定下，避免启动闪屏；且是设备级偏好。
 */

export type ThemeMode = "system" | "light" | "dark";

export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export const THEME_MODE_HINTS: Record<ThemeMode, string> = {
  system: "系统切到深色时跟着切，白天浅色、晚上深色自动换。",
  light: "永远浅色，不管系统怎么设。",
  dark: "永远深色 —— 夜里或投影时常这么用。",
};

/** localStorage 键。index.html 首帧脚本里硬编码了同一字符串。 */
export const THEME_STORAGE_KEY = "gantt.theme";

/** 认不出返回 null，由调用方兜底 */
export function parseThemeMode(raw: unknown): ThemeMode | null {
  return raw === "system" || raw === "light" || raw === "dark" ? raw : null;
}

/** 模式 + 系统偏好 → 是否深色。systemDark 由参数传入以保持纯函数可测。 */
export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/** 启动时读一次；读不到或坏掉返回 "system"。 */
export function readStoredThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    // 隐私模式或存储被禁时 localStorage 会抛
    return "system";
  }
}

/**
 * 系统当前是否深色。须容忍 matchMedia 不存在：store 在模块初始化时调用，
 * 而 jsdom 没有该 API、测试桩在 import 之后才装。
 */
export function readSystemDark(): boolean {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下只是下次回到「跟随系统」，忽略
  }
}

/**
 * 把模式落到 DOM 上并返回是否深色。`data-theme` 是唯一开关：styles.css 只认
 * `:root[data-theme="dark"]`，不要再加 @media 深色块。
 */
export function applyThemeMode(mode: ThemeMode, systemDark: boolean): boolean {
  const isDark = resolveDark(mode, systemDark);
  // 写解析后的结果而非模式，CSS 不需理解 system
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  return isDark;
}
