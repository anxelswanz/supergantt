/**
 * 界面图标。和图形标同一套几何语言：16 网格、1.4 描边、圆端点，只用 currentColor。
 * 新增图标照这个规格画，不要再混用字符（⚙ ↧ ✕ 之类在 Windows 上字重和基线都不齐）。
 */

import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "back"
  | "undo"
  | "redo"
  | "settings"
  | "import"
  | "export"
  | "folder"
  | "close"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "plus"
  | "more"
  | "trash"
  | "today";

const PATHS: Record<IconName, ReactNode> = {
  back: <path d="M9.5 3.5 5 8l4.5 4.5" />,
  undo: <path d="M5.5 4 3 6.5 5.5 9M3 6.5h6A3.5 3.5 0 0 1 12.5 10v1.5" />,
  redo: <path d="M10.5 4 13 6.5 10.5 9M13 6.5H7A3.5 3.5 0 0 0 3.5 10v1.5" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
    </>
  ),
  import: <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13.5h10" />,
  export: <path d="M8 10V2.5M4.8 5.7 8 2.5l3.2 3.2M3 13.5h10" />,
  folder: <path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  "chevron-down": <path d="M4.5 6.5 8 10l3.5-3.5" />,
  "chevron-right": <path d="M6.5 4.5 10 8l-3.5 3.5" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  more: (
    <>
      <circle cx="4" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  // 今天：一根竖线穿过一格，和图形标的今天线同一个意思
  today: <path d="M2.5 5.5h11v7h-11zM8 2.5v11" />,
};

export function Icon({
  name,
  size = 14,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
