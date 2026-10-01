/**
 * 主题模式（DOM 与 Canvas 共用的唯一判据）。
 *
 * 三档而不是两档：多出来的那一档是「跟随系统」。没有它的话，用户要么被锁死在
 * 一个固定主题里，要么只能跟着系统走 —— 而这两件事是不同的诉求：
 * 系统主题是按时间自动切的（白天浅色、晚上深色），但排期的人常常希望
 * 无论几点打开都是同一副面孔。
 *
 * 存 localStorage 而不是 SQLite 的 settings 表：数据库要等窗口起来之后才能异步读，
 * 那一段会先按默认主题画一帧再跳成真正的主题（启动闪白/闪黑）。localStorage 是同步的，
 * 能在首帧之前就定下来。而且主题本来就是**设备级**偏好 —— 我在这台机器上要深色，
 * 不代表我导出到另一台机器上的数据要跟着变，所以它不该跟数据库走。
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

/** localStorage 的键。index.html 的首帧脚本里也硬编码了同一个字符串。 */
export const THEME_STORAGE_KEY = "gantt.theme";

/** 从任意字符串里认出一个主题模式；认不出返回 null（调用方决定兜底） */
export function parseThemeMode(raw: unknown): ThemeMode | null {
  return raw === "system" || raw === "light" || raw === "dark" ? raw : null;
}

/**
 * 模式 + 系统当前偏好 → 到底用不用深色。
 *
 * 把 systemDark 作为参数传进来而不是在这里读 matchMedia，是为了让这个函数
 * 保持纯粹、可测 —— 判断规则是这套东西里唯一容易写错的地方
 * （「跟随系统」模式下系统变了要跟着变，另外两档下系统变了必须纹丝不动）。
 */
export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/** 启动时读一次缓存。读不到或坏掉都返回 "system" —— 默认跟随系统最不容易出错。 */
export function readStoredThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    // 隐私模式或存储被禁时 localStorage 会抛，主题不该因此让应用起不来
    return "system";
  }
}

/**
 * 系统当前是不是深色。
 *
 * 必须能容忍 matchMedia 不存在：store 是在**模块初始化**时读它的，而测试环境
 * 里 window.matchMedia 的桩通常是在 import 之后才装上的。之前的写法直接调用，
 * 结果所有 import 了 store 的测试在加载阶段就整个崩掉，连测试都没跑起来。
 * jsdom 默认没有这个 API，浏览器里则有 —— 判断"有没有"而不是"是不是浏览器"。
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
    // 存不下就只是下次启动回到「跟随系统」，不值得打断当前这次切换
  }
}

/**
 * 把模式落到 DOM 上，并返回最终是否深色。
 *
 * `data-theme` 是唯一开关：CSS 侧不再有 @media 深色块，深色变量只在
 * `:root[data-theme="dark"]` 下生效（见 styles.css）。这样「用户显式选了浅色」
 * 和「系统是深色」不会同时成立 —— 两份声明同时命中时谁赢取决于源码顺序，
 * 是个迟早会咬人的坑。
 */
export function applyThemeMode(mode: ThemeMode, systemDark: boolean): boolean {
  const isDark = resolveDark(mode, systemDark);
  // 属性写的是解析后的结果，不是模式本身：模式已经由 JS 记住了，
  // 属性只需要回答"现在画哪一套"，CSS 那边就不用再理解 system 是什么
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  return isDark;
}
