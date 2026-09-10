/**
 * 平台抽象：快捷键，以及少数几处和操作系统有关的文案。
 *
 * macOS 用 ⌘、Windows/Linux 用 Ctrl。从第一行代码就走这个函数，
 * 不硬编码 metaKey —— 否则将来出 Windows 包时要翻遍全项目改判断
 * （DESIGN.md §10 跨平台注意事项第 3 条）。
 *
 * 显示给人看的快捷键同理：把「⌘]」摆给 Windows 用户看等于没写，
 * 他的键盘上没有这个键，也不认得 ⌥ 是 Alt。
 */

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function isMod(e: KeyboardEvent | MouseEvent | WheelEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** 显示用的修饰键符号。 */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";
export const ALT_LABEL = IS_MAC ? "⌥" : "Alt";
const SHIFT_LABEL = IS_MAC ? "⇧" : "Shift";

/**
 * 拼一个快捷键提示。
 *
 * `shortcut("mod", "]")` 在 Mac 上是「⌘]」，在 Windows 上是「Ctrl+]」；
 * `shortcut("shift", "↵")` 分别是「⇧↵」和「Shift+Enter」—— 两边各用
 * 自己系统菜单里的写法。
 */
export function shortcut(...keys: string[]): string {
  const label = (k: string) =>
    k === "mod"
      ? MOD_LABEL
      : k === "alt"
        ? ALT_LABEL
        : k === "shift"
          ? SHIFT_LABEL
          : !IS_MAC && k === "↵"
            ? "Enter"
            : k;
  return keys.map(label).join(IS_MAC ? "" : "+");
}

/** 「在访达中显示」—— 系统文件管理器叫什么名字，因平台而异。 */
export const REVEAL_LABEL = IS_MAC ? "在访达中显示" : "在资源管理器中显示";
