/**
 * 快捷键的平台抽象。
 *
 * macOS 用 ⌘、Windows/Linux 用 Ctrl。从第一行代码就走这个函数，
 * 不硬编码 metaKey —— 否则将来出 Windows 包时要翻遍全项目改判断
 * （DESIGN.md §10 跨平台注意事项第 3 条）。
 */

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function isMod(e: KeyboardEvent | MouseEvent | WheelEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** 显示用的修饰键符号。 */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";
