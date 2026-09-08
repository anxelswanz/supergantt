import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

/**
 * 挂到 document.body 上的浮层。
 *
 * 为什么必须走 portal 而不是就地 absolute：
 * 左侧网格外面套了三层裁剪 —— 单元格的 overflow-hidden、列表的
 * overflow-y-auto、面板自身的 overflow-hidden。就地定位的浮层会被其中任意
 * 一层切掉，而且是「有时候能看见、滚到某个位置就没了」这种最难查的表现。
 * portal 之后浮层不再属于任何一层的裁剪范围，位置由锚点实时算出来。
 */

interface Props {
  /** 触发元素，浮层贴着它定位 */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** 贴左边缘还是右边缘对齐 */
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
}

const GAP = 4;
const MARGIN = 8;

export function Popover({
  anchor,
  open,
  onClose,
  align = "left",
  width = 160,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return setPos(null);

    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = ref.current?.offsetHeight ?? 200;

      // 下方放不下就翻到上方，别让菜单被窗口底边切掉
      const below = r.bottom + GAP;
      const top = below + h > window.innerHeight - MARGIN ? r.top - GAP - h : below;

      const raw = align === "right" ? r.right - width : r.left;
      const left = Math.min(
        Math.max(raw, MARGIN),
        window.innerWidth - width - MARGIN,
      );

      setPos({ top: Math.max(MARGIN, top), left });
    };

    place();
    // 滚动或改窗口时重新贴，而不是关掉 —— 关掉会让「滚一下菜单就没了」很烦人
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // 延后一帧注册，否则触发打开的这一次点击会立刻把自己关掉
    const id = setTimeout(() => {
      document.addEventListener("pointerdown", onDown);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;

  return createPortal(
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        // 首帧还没量出高度，先藏起来，避免看到一次跳位
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[200] overflow-hidden rounded-lg border border-[var(--rule)] bg-[var(--surface)] py-1 shadow-2xl"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>,
    document.body,
  );
}

/** 菜单项，统一内边距和悬停态，免得每个调用方各写一遍 */
export function MenuItem({
  children,
  onClick,
  danger,
  active,
  hint,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-35 ${
        danger
          ? "text-[var(--text-dim)] hover:bg-rose-500/10 hover:text-rose-500"
          : "text-[var(--text)] hover:bg-[var(--row-hover)]"
      } ${active ? "font-semibold" : ""}`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && (
        <kbd className="shrink-0 font-mono text-[9px] text-[var(--text-dim)]">{hint}</kbd>
      )}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-[var(--rule)]" />;
}
