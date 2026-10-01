import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "./Popover";

/**
 * 一个支持打字过滤的下拉框。
 *
 * 为什么不用原生 `<select>`：录入事项要求**全键盘、不碰鼠标**（设计稿 §4.2），
 * 而原生下拉的打字过滤只按首字母跳转 —— 任务名是「#12 电机安装」这种，
 * 首字母过滤等于没有。这里是「输入框 + 过滤列表」，打任意一段都能命中。
 *
 * 为什么不用内联语法（`@张三 #12 !0`）：那写法更快，但要求用户记住一套语法，
 * 而且中文输入法下 `@` `#` `!` 的输入状态容易干扰。显式下拉 + 键盘流是
 * 评审后定的方案（设计稿 §4.3）。
 *
 * ## 键盘约定
 *
 * 关着的时候：`↓` / `空格` / 任意可打印字符 → 打开（并把那个字符当作首个
 * 查询词）。**`Enter` 故意不打开** —— 它要留给外层的「保存并继续记下一条」。
 * 一个下拉框按 Enter 就展开的话，连记十条的那个流程会在每个字段上卡一下。
 *
 * 开着的时候：打字过滤、`↑↓` 移动、`Enter` 选中、`Esc` 关掉（都不外泄，
 * 否则 Esc 会顺带关掉整个弹窗）。
 */

export interface SelectOption<T> {
  value: T;
  label: string;
  /** 右侧小字，比如任务的「进行中」 */
  hint?: string;
  /** 左侧小圆点的颜色，比如优先级和负责人 */
  color?: string;
  /** 过滤时额外参与匹配的文本（任务编号之类） */
  search?: string;
}

interface Props<T> {
  value: T;
  options: SelectOption<T>[];
  onPick: (value: T) => void;
  /** 当前值在选项里找不到时显示这个 */
  placeholder?: string;
  width?: number;
  title?: string;
  /** 让外层知道下拉是开着的 —— 开着时 Enter 归下拉，不该触发保存 */
  onOpenChange?: (open: boolean) => void;
}

export function FilterSelect<T>({
  value,
  options,
  onPick,
  placeholder = "未选择",
  width = 200,
  title,
  onOpenChange,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = options.find((o) => o.value === value) ?? null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.search ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // 打开时把游标放在当前值上，而不是第一项 —— 打开再回车应该什么都没变
  useEffect(() => {
    if (!open) return;
    const at = shown.findIndex((o) => o.value === value);
    setCursor(at >= 0 ? at : 0);
    // 焦点要等 Popover 挂上来。rAF 比 setTimeout(0) 稳：后者偶尔早于挂载
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 过滤之后游标可能指到列表外面了
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, shown.length - 1)));
  }, [shown.length]);

  const commit = (index: number) => {
    const picked = shown[index];
    if (!picked) return;
    onPick(picked.value);
    setQuery("");
    change(false);
    // 焦点回到按钮，Tab 顺序才接得上
    anchor?.focus();
  };

  const onClosedKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === " ") {
      e.preventDefault();
      setQuery("");
      change(true);
      return;
    }
    // 直接打字就开始过滤。Enter 不在这里 —— 它归外层的「保存」
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setQuery(e.key);
      change(true);
    }
  };

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        title={title}
        onClick={() => change(!open)}
        onKeyDown={onClosedKey}
        className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1.5 text-left text-[11px] transition-colors focus:border-[var(--accent)] focus:outline-none"
        style={{ width }}
      >
        {current?.color && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: current.color }}
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${
            current ? "text-[var(--text)]" : "text-[var(--text-dim)]"
          }`}
        >
          {current?.label ?? placeholder}
        </span>
        <span className="shrink-0 text-[8px] text-[var(--text-dim)]">▼</span>
      </button>

      <Popover anchor={anchor} open={open} onClose={() => change(false)} width={width}>
        <div className="px-1.5 pb-1">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 一律不外泄：这些键在弹窗层另有含义（Esc 关窗、Enter 保存）
              e.stopPropagation();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                commit(cursor);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                change(false);
                anchor?.focus();
              }
            }}
            placeholder="打字过滤…"
            className="w-full rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-1.5 py-1 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div className="max-h-56 overflow-y-auto">
          {shown.length === 0 && (
            <div className="px-2.5 py-2 text-[10px] text-[var(--text-dim)]">没有匹配的</div>
          )}
          {shown.map((o, i) => (
            <button
              key={String(o.value)}
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => commit(i)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-[var(--text)]"
              style={i === cursor ? { background: "var(--row-hover)" } : undefined}
            >
              {o.color && (
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: o.color }}
                />
              )}
              <span
                className={`min-w-0 flex-1 truncate ${
                  o.value === value ? "font-semibold" : ""
                }`}
              >
                {o.label}
              </span>
              {o.hint && (
                <span className="shrink-0 text-[9px] text-[var(--text-dim)]">{o.hint}</span>
              )}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
