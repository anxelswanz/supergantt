/** Canvas 绘制。static（时间轴/网格）只在缩放平移时重绘，content（条子/进度/里程碑）随数据变。
 * 拖拽只有交互层每帧重绘——「不掉帧」靠这个分层，不是单次绘制快。 */

import { computeTickLayers, smoothstep, tickLabel, ticksOf } from "./scale";
import { dayToDate, dayToIso, today } from "./time";
import { WEEKDAY_NAMES, type WorkCalendar } from "../core/calendar";
import { AXIS_HEIGHT, barHeights, PRIORITY_COLORS, type Theme } from "./theme";
import { overlaps, type BarPaint, type ColorBy } from "./coloring";
import { mergeRanges, type BlockedPeriod } from "../core/blocked";
import { GRIP_MAGNET, progressGripX } from "./hitTest";
import { activeSpan, actualSpan, canEdit, deviation, planSpan, type ViewMode } from "../core/viewMode";
import type { ResolvedTask } from "./model";
import type { Viewport } from "./viewport";

const FONT_STACK =
  '"IBM Plex Sans Variable", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

/** 项目级里程碑：用户自设的独立节点，没有行，不属于任何任务。区别于 TaskRow.milestone（任务自己的标记，跟着行画）。 */
export interface GanttMilestone {
  id: number;
  name: string;
  /** 天序号 */
  day: number;
  color: string;
}

/** 受阻斜纹：色相给了归属、明度给了进度，形状通道留给「出事了」。
 * 红色斜纹下垫一条更粗的衬线，否则在红/橙条子上会消失。图案模块级缓存——每帧 createPattern 会持续产生离屏画布，滚动卡。 */
let hatchCache: { key: string; pattern: CanvasPattern } | null = null;

function hatchPattern(ctx: CanvasRenderingContext2D, isDark: boolean): CanvasPattern | null {
  const key = isDark ? "dark" : "light";
  if (hatchCache?.key === key) return hatchCache.pattern;

  const size = 6;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;

  // 画两条对角线并让它们跨出边界，平铺后才能接成连续的斜纹
  const stripes = () => {
    tctx.beginPath();
    tctx.moveTo(-size, size);
    tctx.lineTo(size, -size);
    tctx.moveTo(0, size * 2);
    tctx.lineTo(size * 2, 0);
    tctx.stroke();
  };

  // 衬线先画、更粗；红线压在它上面
  tctx.lineCap = "square";
  tctx.strokeStyle = isDark ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.75)";
  tctx.lineWidth = 3.2;
  stripes();

  // 深色底上用亮一档的玫红（#fb7185），纯 #f43f5e 在深底上会发闷
  tctx.strokeStyle = isDark ? "rgba(251,113,133,0.95)" : "rgba(225,29,72,0.85)";
  tctx.lineWidth = 1.8;
  stripes();

  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return null;
  hatchCache = { key, pattern };
  return pattern;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* 静态层                                                              */
/* ------------------------------------------------------------------ */

export function drawStatic(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  calendar: WorkCalendar,
) {
  const { width, height } = vp;
  const ppd = vp.pxPerDay;
  const [dayFrom, dayTo] = vp.visibleDays();

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, height);

  const bodyTop = AXIS_HEIGHT;
  const bodyH = height - bodyTop;

  // 非工作日底纹，随 ppd 淡入。周末与节假日分色（常态 vs 该上班却放假）
  const restAlpha = smoothstep(1.5, 6, ppd);
  if (restAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = restAlpha;
    for (let d = Math.floor(dayFrom); d <= dayTo; d++) {
      const holiday = calendar.isHoliday(d);
      if (!holiday && !calendar.isWeekend(d)) continue;
      ctx.fillStyle = holiday ? theme.holiday : theme.weekend;
      ctx.fillRect(vp.xOf(d), bodyTop, ppd, bodyH);
    }
    ctx.restore();
  }

  const layers = computeTickLayers(ppd);

  // 网格竖线，透明度跟随各刻度的权重
  ctx.save();
  for (const layer of layers) {
    const minorAlpha = layer.detail;
    const majorAlpha = layer.context;
    if (minorAlpha < 0.01 && majorAlpha < 0.01) continue;

    const useMajor = majorAlpha > minorAlpha;
    ctx.globalAlpha = useMajor ? majorAlpha : minorAlpha;
    ctx.strokeStyle = useMajor ? theme.gridMajor : theme.gridMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const day of ticksOf(layer.unit, dayFrom, dayTo)) {
      const x = Math.round(vp.xOf(day)) + 0.5; // 对齐半像素，避免 1px 线被抗锯齿糊成 2px
      ctx.moveTo(x, bodyTop);
      ctx.lineTo(x, height);
    }
    ctx.stroke();
  }
  ctx.restore();

  drawTodayLine(ctx, vp, theme);
  drawAxis(ctx, vp, theme, layers, calendar);
}

function drawTodayLine(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
) {
  const t = today();
  const x = vp.xOf(t);
  const w = Math.max(2, vp.pxPerDay);
  if (x + w < 0 || x > vp.width) return;

  ctx.save();
  ctx.fillStyle = theme.todayGlow;
  ctx.fillRect(x, AXIS_HEIGHT, w, vp.height - AXIS_HEIGHT);
  ctx.strokeStyle = theme.today;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, AXIS_HEIGHT);
  ctx.lineTo(Math.round(x) + 0.5, vp.height);
  ctx.stroke();
  ctx.restore();
}

function drawAxis(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  layers: ReturnType<typeof computeTickLayers>,
  calendar: WorkCalendar,
) {
  const { width } = vp;
  const [dayFrom, dayTo] = vp.visibleDays();

  ctx.save();
  ctx.fillStyle = theme.surfaceAlt;
  ctx.fillRect(0, 0, width, AXIS_HEIGHT);

  const CONTEXT_ROW_Y = 16;
  const WEEKDAY_ROW_Y = 33;

  // 日期行的 y 跟着星期行权重连续插值，避免淡入淡出时标签上下跳
  const dayWeight = layers.find((l) => l.unit === "day")?.detail ?? 0;
  const DETAIL_ROW_Y = 41 + 8 * dayWeight;

  ctx.textBaseline = "middle";

  // —— 星期行 ——
  if (dayWeight > 0.01) {
    ctx.font = `500 10px ${FONT_STACK}`;
    ctx.textAlign = "center";
    for (const day of ticksOf("day", dayFrom, dayTo)) {
      const x = vp.xOf(day);
      if (x + vp.pxPerDay < 0 || x > width) continue;
      const rest = calendar.isRest(day);
      ctx.globalAlpha = dayWeight * (rest ? 0.5 : 0.85);
      ctx.fillStyle = calendar.isHoliday(day) ? theme.today : theme.axisTextDim;
      ctx.fillText(
        WEEKDAY_NAMES[dayToDate(day).getUTCDay()],
        x + vp.pxPerDay / 2,
        WEEKDAY_ROW_Y,
      );
    }
  }

  for (const layer of layers) {
    // 上行：上下文单位（月/年），标签吸附在视口左缘
    if (layer.context > 0.01) {
      ctx.globalAlpha = layer.context;
      ctx.fillStyle = theme.axisText;
      ctx.font = `600 12px ${FONT_STACK}`;
      ctx.textAlign = "left";

      const ticks = [...ticksOf(layer.unit, dayFrom, dayTo)];
      for (let i = 0; i < ticks.length; i++) {
        const x = vp.xOf(ticks[i]);
        const nextX = i + 1 < ticks.length ? vp.xOf(ticks[i + 1]) : width + 999;
        if (nextX < 0 || x > width) continue;

        const label = tickLabel(layer.unit, ticks[i]);
        const textW = ctx.measureText(label).width;
        // 吸附：顶住左边，但不越过本格右界
        const sticky = Math.min(
          Math.max(x + 10, 10),
          Math.max(nextX - textW - 10, 10),
        );
        ctx.fillText(label, sticky, CONTEXT_ROW_Y);
      }
    }

    // 下行：细节单位（日/周/月/季），格内居中
    if (layer.detail > 0.01) {
      ctx.globalAlpha = layer.detail;
      ctx.fillStyle = theme.axisTextDim;
      ctx.font = `500 11px ${FONT_STACK}`;
      ctx.textAlign = "center";

      const ticks = [...ticksOf(layer.unit, dayFrom, dayTo)];
      for (let i = 0; i < ticks.length; i++) {
        const x = vp.xOf(ticks[i]);
        const nextX = i + 1 < ticks.length ? vp.xOf(ticks[i + 1]) : x + 40;
        if (nextX < 0 || x > width) continue;
        // 非工作日淡显，节假日再换色
        if (layer.unit === "day") {
          const day = ticks[i];
          if (calendar.isHoliday(day)) {
            ctx.fillStyle = theme.today;
            ctx.globalAlpha = layer.detail * 0.8;
          } else if (calendar.isRest(day)) {
            ctx.globalAlpha = layer.detail * 0.45;
          }
        }
        ctx.fillText(tickLabel(layer.unit, ticks[i]), (x + nextX) / 2, DETAIL_ROW_Y);
        ctx.globalAlpha = layer.detail;
        ctx.fillStyle = theme.axisTextDim;
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.axisRule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_HEIGHT - 0.5);
  ctx.lineTo(width, AXIS_HEIGHT - 0.5);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 内容层                                                              */
/* ------------------------------------------------------------------ */

export function drawContent(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  tasks: ResolvedTask[],
  paintOf: (task: ResolvedTask) => BarPaint,
  colorBy: ColorBy,
  isDark: boolean,
  blockedOf: (task: ResolvedTask) => BlockedPeriod[],
  mode: ViewMode,
  compareOn: boolean,
  /** 项目级里程碑（用户自设的节点），画在最上层，见 drawMilestones */
  milestones: GanttMilestone[] = [],
) {
  const { width, height } = vp;
  ctx.clearRect(0, 0, width, height);

  // 行虚拟化：只绘制视口内的行
  const first = Math.max(0, Math.floor(vp.scrollY / vp.rowHeight));
  const last = Math.min(
    tasks.length - 1,
    Math.ceil((vp.scrollY + height - AXIS_HEIGHT) / vp.rowHeight),
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, AXIS_HEIGHT, width, height - AXIS_HEIGHT);
  ctx.clip();

  for (let i = first; i <= last; i++) {
    const task = tasks[i];
    if (!task) continue;
    const rowY = AXIS_HEIGHT + i * vp.rowHeight - vp.scrollY;

    if (i % 2 === 1) {
      ctx.fillStyle = theme.rowStripe;
      ctx.fillRect(0, rowY, width, vp.rowHeight);
    }

    // 里程碑不参与着色分组：它是「节点」不是「区间」，语义不同，
    // 让它保持独立的琥珀色反而更容易在一片彩色条子里被认出来
    // 对照：先在下面垫一条计划的影子，再画实施条
    if (compareOn && mode === "actual") {
      drawPlanGhost(ctx, vp, theme, task, rowY);
    }

    const active = activeSpan(task, mode);
    if (task.milestone) drawMilestone(ctx, vp, theme, task, rowY, active.span, active.ghost);
    else
      drawBar(
        ctx, vp, theme, task, rowY, paintOf(task), colorBy, isDark,
        blockedOf(task), active.span, active.ghost,
      );
  }

  ctx.restore();

  // 项目级里程碑画在任务层之上，不被条子盖住
  drawMilestones(ctx, vp, theme, milestones);
}

/** 项目级里程碑：贯穿内容区的竖虚线 + 顶部菱形与名称。
 * 不铺整宽横带（会遮住第一行条子），竖线画满整个内容区；标签重叠时只留菱形和竖线。 */
function drawMilestones(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  milestones: GanttMilestone[],
) {
  if (milestones.length === 0) return;

  const MARKER_Y = AXIS_HEIGHT + 11;
  const bodyBottom = vp.height;

  const sorted = [...milestones].sort((a, b) => a.day - b.day);
  let lastLabelRight = -Infinity;

  ctx.save();

  for (const m of sorted) {
    // 菱形对准这一天格子的中线（「这一天」是整格）
    const cx = vp.xOf(m.day) + vp.pxPerDay / 2;
    if (cx < -40 || cx > vp.width + 40) continue;

    // 贯穿内容区的竖虚线，25% 透明度：压在条子上也读得出是标记而非数据
    ctx.strokeStyle = m.color;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, MARKER_Y + 6);
    ctx.lineTo(cx, bodyBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 菱形
    const r = 5;
    ctx.save();
    ctx.translate(cx, MARKER_Y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = m.color;
    // 描一圈 surface 衬底，否则菱形会消失在同色系条子里
    ctx.strokeStyle = theme.surface;
    ctx.lineWidth = 2;
    roundRect(ctx, -r, -r, r * 2, r * 2, 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 名称
    const textX = cx + r + 6;
    const maxW = vp.width - textX - 8;
    // 和上一个标签叠了就不画（菱形和竖线还在，位置信息没丢）
    if (textX < lastLabelRight + 8 || maxW < 28) continue;

    ctx.font = `600 11px ${FONT_STACK}`;
    const text = fitText(ctx, m.name, maxW - 12);
    const tw = ctx.measureText(text).width;

    ctx.fillStyle = theme.surface;
    ctx.globalAlpha = 0.86;
    roundRect(ctx, textX - 5, MARKER_Y - 8, tw + 10, 16, 8);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = m.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, textX, MARKER_Y);
    lastLabelRight = textX + tw;
  }

  ctx.restore();
}

/** 截断到 maxW 以内，末位用省略号 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  task: ResolvedTask,
  rowY: number,
  paint: BarPaint,
  colorBy: ColorBy,
  isDark: boolean,
  blocked: BlockedPeriod[],
  span: { startDay: number; endDay: number },
  ghost: boolean,
) {
  const x1 = vp.xOf(span.startDay);
  // 结束日含当天，右界取 endDay + 1
  const x2 = vp.xOf(span.endDay + 1);
  if (x2 < -40 || x1 > vp.width + 40) return;

  const w = Math.max(2, x2 - x1);
  const isParent = task.hasChildren;
  const bars = barHeights(vp.rowHeight);
  const h = isParent ? bars.parent : bars.leaf;
  const y = rowY + (vp.rowHeight - h) / 2;
  const radius = isParent ? 2 : 5;

  // 还没动过：只画虚线轮廓。实线代表「真的发生了」
  if (ghost) {
    ctx.save();
    ctx.strokeStyle = paint.fill;
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    roundRect(ctx, x1 + 0.5, y + 0.5, w - 1, h - 1, radius);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 轨道 = 同色低透明度，进度 = 同色实心；色相管归属，明度管进度
  ctx.fillStyle = isParent ? paint.parent : paint.track;
  roundRect(ctx, x1, y, w, h, radius);
  ctx.fill();

  if (task.progress > 0 && !isParent) {
    ctx.save();
    roundRect(ctx, x1, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = paint.fill;
    ctx.fillRect(x1, y, w * task.progress, h);
    ctx.restore();
  }

  // 受阻斜纹。多段先并成一层，否则半透明叠加糊成一块、看不出边界
  if (blocked.length > 0) {
    const hatch = hatchPattern(ctx, isDark);
    if (hatch) {
      ctx.save();
      roundRect(ctx, x1, y, w, h, radius);
      ctx.clip();
      ctx.fillStyle = hatch;
      for (const [from, to] of mergeRanges(blocked)) {
        const bx1 = vp.xOf(from);
        const bx2 = vp.xOf(to + 1);
        ctx.fillRect(bx1, y, Math.max(1, bx2 - bx1), h);
      }
      ctx.restore();
    }
  }

  // 只标 P0（形状+颜色双编码，抗色盲/灰度）。P2 占绝大多数，四档铺满等于没信息；
  // 按紧急度着色时整条已是紧急度色，三角冗余
  if (task.priority === 0 && colorBy !== "priority" && w > 10) {
    ctx.fillStyle = PRIORITY_COLORS[0];
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x1 + 7, y);
    ctx.lineTo(x1, y + 7);
    ctx.closePath();
    ctx.fill();
  }

  if (isParent) return;

  ctx.textBaseline = "middle";

  // 进度百分比常驻显示（最常被问的数字）。0% 不画，满屏「0%」是噪音
  const pct = Math.round(task.progress * 100);
  const pctLabel = `${pct}%`;
  ctx.font = `600 10px ${FONT_STACK}`;
  const pctW = pct > 0 ? ctx.measureText(pctLabel).width : 0;
  let pctDrawnInside = false;

  if (pct > 0 && w > pctW + 20) {
    // 贴右端画；按文字落在填充区还是轨道上取色
    const pctCenter = x2 - 8 - pctW / 2;
    const onFilled = pctCenter < x1 + w * task.progress;
    ctx.fillStyle = onFilled ? paint.onFill : theme.axisTextDim;
    ctx.textAlign = "right";
    ctx.fillText(pctLabel, x2 - 8, y + h / 2);
    pctDrawnInside = true;
  }

  // 任务名：条子够宽写在条内，并避开右侧百分比
  const label = task.name;
  if (!label) return;
  ctx.font = `500 11px ${FONT_STACK}`;
  const textW = ctx.measureText(label).width;
  const reserved = pctDrawnInside ? pctW + 14 : 0;

  ctx.textAlign = "left";
  if (textW + 18 + reserved < w) {
    ctx.fillStyle = task.progress > 0.5 ? paint.onFill : theme.axisText;
    ctx.fillText(label, x1 + 9, y + h / 2);
  } else if (x2 < vp.width - 40) {
    ctx.fillStyle = theme.axisTextDim;
    ctx.fillText(
      pct > 0 && !pctDrawnInside ? `${label}  ${pctLabel}` : label,
      x2 + 8,
      y + h / 2,
    );
  }
}

/** 对照模式：实施条下方的计划影子。画得更细（实施是主角）。
 * 颜色承载是否守住计划（超出红/守时绿）——色相管归属、明度管进度，偏差只能挂在影子上。还没开工的任务不画（与虚线重影）。 */
function drawPlanGhost(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  task: ResolvedTask,
  rowY: number,
) {
  if (!actualSpan(task)) return;

  const plan = planSpan(task);
  const x1 = vp.xOf(plan.startDay);
  const x2 = vp.xOf(plan.endDay + 1);
  if (x2 < -40 || x1 > vp.width + 40) return;

  // 口径和网格「偏差」列一致，看结束日——两处不一致会出现图上标红而表里 0d
  const gap = deviation(task);
  const late = (gap?.end ?? 0) > 0;
  const color = late ? theme.overdue : theme.onTime;

  const bars = barHeights(vp.rowHeight);
  const h = Math.max(3, Math.round(bars.leaf / 3));
  // 贴着行的下沿，不抢中间视觉主线
  const y = rowY + vp.rowHeight - h - 2;

  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  roundRect(ctx, x1, y, Math.max(2, x2 - x1), h, 1.5);
  ctx.fill();

  if (gap && gap.end !== 0) {
    const label = gap.end > 0 ? `+${gap.end}d` : `${gap.end}d`;
    ctx.globalAlpha = 1;
    ctx.font = `600 9px ${FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.textAlign = gap.end > 0 ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.fillText(label, gap.end > 0 ? x2 + 4 : x1 - 4, y + h / 2);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 交互层                                                              */
/* ------------------------------------------------------------------ */

export interface InteractionState {
  selectedId: number | null;
  /** 正在拖动的任务及浮动信息 */
  dragging: { index: number; label: string; snapped: boolean } | null;
  /** 鼠标横坐标，用于时间游标；离开画布时为 null */
  cursorX: number | null;
  /** 鼠标悬停在哪个任务上，用于同期高亮 */
  hoverId: number | null;
  /** 正在 ⌥ 拖出的受阻区间预览 */
  marking: { index: number; from: number; to: number } | null;
  /** 当前视图。框和手柄必须落在该视图画的那根条子上，否则实施视图下框会停在计划位置。 */
  mode: ViewMode;
}

/** 交互层：拖拽和移动鼠标时每帧重绘，内容极少。 */
export function drawInteraction(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  tasks: ResolvedTask[],
  state: InteractionState,
) {
  const { width, height } = vp;
  ctx.clearRect(0, 0, width, height);

  drawCrosshair(ctx, vp, theme, state.cursorX);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, AXIS_HEIGHT, width, height - AXIS_HEIGHT);
  ctx.clip();

  drawPeers(ctx, vp, theme, tasks, state.hoverId);

  if (state.selectedId != null) {
    const index = tasks.findIndex((t) => t.id === state.selectedId);
    const task = tasks[index];
    if (task) {
      const rowY = AXIS_HEIGHT + index * vp.rowHeight - vp.scrollY;
      const sel = activeSpan(task, state.mode).span;
      const x1 = vp.xOf(sel.startDay);
      const x2 = vp.xOf(sel.endDay + 1);
      const bars = barHeights(vp.rowHeight);
      const h = task.hasChildren ? bars.parent : bars.leaf;
      const y = rowY + (vp.rowHeight - h) / 2;

      ctx.strokeStyle = theme.today;
      ctx.lineWidth = 2;
      roundRect(ctx, x1 - 2, y - 2, Math.max(6, x2 - x1) + 4, h + 4, 7);
      ctx.stroke();
    }
  }

  drawProgressGrip(ctx, vp, theme, tasks, state.hoverId, state.cursorX, state.mode);

  // 正在拖的受阻区间：实时预览
  if (state.marking) {
    const { index, from, to } = state.marking;
    const rowY = AXIS_HEIGHT + index * vp.rowHeight - vp.scrollY;
    const x1 = vp.xOf(from);
    const x2 = vp.xOf(to + 1);
    const h = barHeights(vp.rowHeight).leaf;
    const y = rowY + (vp.rowHeight - h) / 2;

    ctx.save();
    ctx.fillStyle = "rgba(244, 63, 94, 0.16)";
    ctx.strokeStyle = theme.today;
    ctx.lineWidth = 1.5;
    roundRect(ctx, x1, y - 2, Math.max(2, x2 - x1), h + 4, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  if (state.dragging) {
    const { index, label, snapped } = state.dragging;
    const task = tasks[index];
    if (task) {
      const rowY = AXIS_HEIGHT + index * vp.rowHeight - vp.scrollY;
      const x = vp.xOf(task.startDay);

      ctx.font = `600 11px ${FONT_STACK}`;
      const textW = ctx.measureText(label).width;
      const boxW = textW + 16;
      const boxX = Math.min(Math.max(x, 4), width - boxW - 4);
      const boxY = rowY - 26;

      // 吸附命中时点亮边框
      ctx.fillStyle = theme.axisText;
      roundRect(ctx, boxX, boxY, boxW, 22, 6);
      ctx.fill();
      if (snapped) {
        ctx.strokeStyle = theme.milestone;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fillStyle = theme.surface;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, boxX + 8, boxY + 11);
    }
  }

  ctx.restore();
}

/** 进度手柄：悬停时出现，让「拖填充右边界改进度」可见。
 * 只在可编辑进度的视图出现，可见性判断必须和 hitTest 一致，否则会「看得见抓不住」。 */
function drawProgressGrip(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  tasks: ResolvedTask[],
  hoverId: number | null,
  cursorX: number | null,
  mode: ViewMode,
) {
  if (hoverId == null || !canEdit("progress", mode)) return;
  const index = tasks.findIndex((t) => t.id === hoverId);
  const task = tasks[index];
  if (!task || task.hasChildren || task.milestone) return;

  // 未填实施日期的虚线条上没有进度填充可动（同 hitTest）
  const active = activeSpan(task, mode);
  if (active.ghost) return;

  const x1 = vp.xOf(active.span.startDay);
  const x2 = vp.xOf(active.span.endDay + 1);

  // 与命中检测共用 progressGripX，各算各的会出现「看得见抓不住」
  const x = progressGripX(x1, x2, task.progress);
  if (x == null) return;

  const rowY = AXIS_HEIGHT + index * vp.rowHeight - vp.scrollY;
  const h = barHeights(vp.rowHeight).leaf;
  const y = rowY + (vp.rowHeight - h) / 2;

  // 靠近时变大变亮，把可抓取区显式画出来
  const near =
    cursorX != null && Math.abs(cursorX - x) <= GRIP_MAGNET
      ? 1 - Math.abs(cursorX - x) / GRIP_MAGNET
      : 0;
  const halfW = 2.5 + near * 2;
  const inset = 2 - near * 2;

  ctx.save();
  ctx.fillStyle = near > 0.35 ? theme.today : theme.surface;
  ctx.strokeStyle = theme.axisText;
  ctx.lineWidth = 1 + near * 0.5;
  roundRect(ctx, x - halfW, y + inset, halfW * 2, h - inset * 2, halfW);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 时间游标：竖线 + 顶部日期胶囊。垂直顺序表达结构而非时间，重叠的条子可能隔十几行，只能把时间维度显式画出来。 */
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  cursorX: number | null,
) {
  if (cursorX == null || cursorX < 0 || cursorX > vp.width) return;

  const day = Math.floor(vp.dayAt(cursorX));
  // 吸到格子中心而非像素位置，否则读数随亚像素抖
  const x = Math.round(vp.xOf(day) + vp.pxPerDay / 2) + 0.5;

  ctx.save();
  ctx.strokeStyle = theme.axisText;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, AXIS_HEIGHT);
  ctx.lineTo(x, vp.height);
  ctx.stroke();
  ctx.setLineDash([]);

  const label = dayToIso(day);
  ctx.font = `600 10px ${FONT_STACK}`;
  const w = ctx.measureText(label).width + 12;
  const boxX = Math.min(Math.max(x - w / 2, 2), vp.width - w - 2);

  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.axisText;
  roundRect(ctx, boxX, AXIS_HEIGHT - 17, w, 15, 4);
  ctx.fill();

  ctx.fillStyle = theme.surface;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + w / 2, AXIS_HEIGHT - 9);
  ctx.restore();
}

/** 同期高亮：描出时间上与悬停条子重叠的条子，回答「此刻还有谁在并行」。 */
function drawPeers(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  tasks: ResolvedTask[],
  hoverId: number | null,
) {
  if (hoverId == null) return;
  const source = tasks.find((t) => t.id === hoverId);
  if (!source) return;

  const first = Math.max(0, Math.floor(vp.scrollY / vp.rowHeight));
  const last = Math.min(
    tasks.length - 1,
    Math.ceil((vp.scrollY + vp.height - AXIS_HEIGHT) / vp.rowHeight),
  );

  ctx.save();
  ctx.strokeStyle = theme.axisText;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.5;

  for (let i = first; i <= last; i++) {
    const task = tasks[i];
    // 父任务区间是子任务并集，几乎和所有东西重叠，标出来满屏噪音
    if (!task || task.id === hoverId || task.hasChildren) continue;
    if (!overlaps(source, task)) continue;

    const rowY = AXIS_HEIGHT + i * vp.rowHeight - vp.scrollY;
    const x1 = vp.xOf(task.startDay);
    const x2 = vp.xOf(task.endDay + 1);
    const h = barHeights(vp.rowHeight).leaf;
    roundRect(ctx, x1 - 1.5, rowY + (vp.rowHeight - h) / 2 - 1.5, Math.max(5, x2 - x1) + 3, h + 3, 6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMilestone(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  task: ResolvedTask,
  rowY: number,
  span: { startDay: number; endDay: number },
  ghost: boolean,
) {
  const cx = vp.xOf(span.startDay) + vp.pxPerDay / 2;
  if (cx < -20 || cx > vp.width + 20) return;
  const cy = rowY + vp.rowHeight / 2;
  const r = Math.max(5, Math.round(barHeights(vp.rowHeight).leaf * 0.4));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = !ghost && task.progress >= 1 ? theme.milestone : theme.surface;
  ctx.strokeStyle = theme.milestone;
  ctx.lineWidth = 2;
  if (ghost) ctx.setLineDash([3, 2]);
  roundRect(ctx, -r, -r, r * 2, r * 2, 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = theme.axisTextDim;
  ctx.font = `600 11px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(task.name, cx + r + 8, cy);
}
