/**
 * SuperGantt 图形标：三条错位甘特条，一根今天线从中穿过。
 * 线左是已完成的实际（实心），线右是还没发生的计划（同色 30%）。
 * 规格见 demo/02：24u 网格，条高 4u、间距 3u，起点 x = 2/6/10，今天线 1.5u 宽、中心 x = 15、上下出头 2u。
 * 16px 以下改用像素对齐版：条高 3px、间距 2px、线 1px、无圆角。
 */

export type MarkTone = "auto" | "light" | "dark" | "inverse" | "mono";

interface Palette {
  bar: string;
  plan: string;
  line: string;
}

const PALETTES: Record<Exclude<MarkTone, "auto">, Palette> = {
  light: { bar: "#2f6d5e", plan: "rgba(47, 109, 94, 0.3)", line: "#b4442f" },
  dark: { bar: "#4e9b86", plan: "rgba(78, 155, 134, 0.3)", line: "#d97a69" },
  // 青绿底上的主 App 图标：条反白
  inverse: { bar: "#fbfcfc", plan: "rgba(251, 252, 252, 0.35)", line: "#d97a69" },
  mono: { bar: "currentColor", plan: "currentColor", line: "currentColor" },
};

/** auto 跟随 CSS 主题变量，深浅色自动切 */
const AUTO: Palette = {
  bar: "var(--accent)",
  plan: "color-mix(in srgb, var(--accent) 30%, transparent)",
  line: "var(--today)",
};

const BARS = [
  { x: 2, y: 3.5, w: 9 },
  { x: 6, y: 10.5, w: 13 },
  { x: 10, y: 17.5, w: 12 },
];
const LINE_X = 15;
const LINE_W = 1.5;

export function BrandMark({
  size = 24,
  tone = "auto",
  title,
}: {
  size?: number;
  tone?: MarkTone;
  title?: string;
}) {
  const c = tone === "auto" ? AUTO : PALETTES[tone];
  if (size <= 16) return <PixelMark size={size} c={c} title={title} />;

  // 单色版：计划段改成描边，今天线两侧各留 0.75u 切口
  const mono = tone === "mono";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="shrink-0"
    >
      {BARS.map((b) => {
        const solidW = Math.max(0, Math.min(b.w, LINE_X - b.x));
        const planX = LINE_X;
        const planW = b.x + b.w - LINE_X;
        return (
          <g key={b.y}>
            {planW > 0 &&
              (mono ? (
                <rect
                  x={planX + LINE_W / 2 + 0.75}
                  y={b.y + 0.5}
                  width={Math.max(0, planW - LINE_W / 2 - 1.25)}
                  height={3}
                  rx={0.75}
                  fill="none"
                  stroke={c.plan}
                  strokeWidth={1}
                />
              ) : (
                <rect x={planX - 1} y={b.y} width={planW + 1} height={4} rx={1} fill={c.plan} />
              ))}
            <rect
              x={b.x}
              y={b.y}
              width={mono && planW > 0 ? solidW - LINE_W / 2 - 0.75 : solidW + (planW > 0 ? 0.5 : 0)}
              height={4}
              rx={1}
              fill={c.bar}
            />
          </g>
        );
      })}
      <rect x={LINE_X - LINE_W / 2} y={1.5} width={LINE_W} height={21} rx={LINE_W / 2} fill={c.line} />
    </svg>
  );
}

/** 16px 像素对齐版：所有边落在整像素上 */
function PixelMark({ size, c, title }: { size: number; c: Palette; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="shrink-0"
    >
      <rect x={1} y={3} width={7} height={3} fill={c.bar} />
      <rect x={4} y={8} width={6} height={3} fill={c.bar} />
      <rect x={11} y={8} width={2} height={3} fill={c.plan} />
      <rect x={7} y={13} width={3} height={3} fill={c.bar} />
      <rect x={11} y={13} width={4} height={3} fill={c.plan} />
      <rect x={10} y={1} width={1} height={15} fill={c.line} />
    </svg>
  );
}

/**
 * 横版组合标。规格见 demo/04：IBM Plex Sans，「Super」500、「Gantt」600，字距 -2.5%，
 * 只靠字重区分、不用颜色；图形标高 = 字号 × 1.125，间距 = 字号 × 0.3。
 * 16px 以下字距回到 0。
 */
export function BrandLockup({
  fontSize = 16,
  tone = "auto",
}: {
  fontSize?: number;
  tone?: MarkTone;
}) {
  const markSize = Math.round(fontSize * 1.125);
  const textColor =
    tone === "dark" || tone === "inverse" ? "#fbfcfc" : tone === "mono" ? "currentColor" : "var(--text)";
  return (
    <span
      className="inline-flex items-center"
      style={{ gap: Math.round(fontSize * 0.3) }}
      aria-label="SuperGantt"
      role="img"
    >
      <BrandMark size={markSize} tone={tone} />
      <span
        aria-hidden="true"
        className="leading-none whitespace-nowrap"
        style={{
          fontSize,
          letterSpacing: fontSize < 16 ? 0 : "-0.025em",
          color: textColor,
        }}
      >
        <span style={{ fontWeight: 500 }}>Super</span>
        <span style={{ fontWeight: 600 }}>Gantt</span>
      </span>
    </span>
  );
}
