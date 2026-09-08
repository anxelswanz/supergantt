/**
 * Canvas 绘制。分两层，各自独立判断是否需要重绘（DESIGN.md §6.2）：
 *
 *   static  —— 时间轴、网格、周末底纹、今天线   仅在缩放/平移时重绘
 *   content —— 甘特条、进度、里程碑              数据变化或缩放时重绘
 *
 * 后面加交互层（幽灵条、吸附高亮）时，拖拽过程中就只有交互层每帧重绘。
 * 「不掉帧」靠的是这个分层，而不是把单次绘制优化得多快。
 */

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
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 受阻时段的斜纹图案。
 *
 * 形状走「图案」这条通道：色相已经给了归属（阶段/负责人）、明度给了进度，
 * 斜纹是另一条还空着的通道，而且半透明，底下的进度填充仍然读得出来。
 *
 * **颜色用红。** 原来是中性的白/深灰 —— 信息是准确的，但它安静得像装饰，
 * 一屏任务扫过去根本不会停在那几段上。受阻是这张图上唯一「出事了」的信号，
 * 它值得抢一次色相：红色在这个应用里始终只表示一件事（今天线、超期、受阻标识），
 * 语义不会被稀释。
 *
 * 红线下面垫一条更粗的衬线（浅色主题垫白、深色主题垫黑）。这不是装饰：
 * 甘特条本身的颜色是用户选的，按阶段/负责人着色时完全可能就是红或橙 ——
 * 没有衬底的话，红斜纹会在红条子上直接消失。衬线让它在任何底色上都跳得出来。
 *
 * 图案缓存在模块级：createPattern 每帧新建会持续产生离屏画布，滚动时肉眼可见地卡。
 */
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

  // —— 非工作日底纹。ppd 太小时一片糊，所以随缩放淡入 ——
  // 周末和节假日用不同颜色：都不干活，但「本来就是休息日」和
  // 「本该上班但放假了」在排期上是两回事，前者是常态、后者需要注意
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

  // —— 网格竖线。细刻度用浅线，上下文刻度用深线，透明度直接跟随各自权重 ——
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

  // 星期行只在日视图存在。为了不让日期标签在星期行淡入淡出时上下跳，
  // 它的 y 跟着星期行的权重连续插值 —— 和刻度阶梯同一套思路：没有模式切换。
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
    // —— 上行：上下文单位（月/年），标签吸附在视口左缘，滚远了也知道自己在哪 ——
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
        // 吸附：左缘被推出屏幕时把标签顶住左边，但不越过本格右界
        const sticky = Math.min(
          Math.max(x + 10, 10),
          Math.max(nextX - textW - 10, 10),
        );
        ctx.fillText(label, sticky, CONTEXT_ROW_Y);
      }
    }

    // —— 下行：细节单位（日/周/月/季），在格子里居中 ——
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
        // 非工作日的日期号淡一点，让「哪几天不干活」在时间轴上直接可读；
        // 节假日再进一步换色，和普通周末区分开
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
) {
  const { width, height } = vp;
  ctx.clearRect(0, 0, width, height);

  // 行虚拟化：只绘制视口内的行（DESIGN.md §6.5）
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
  // 结束日含当天，所以右界取 endDay + 1
  const x2 = vp.xOf(span.endDay + 1);
  if (x2 < -40 || x1 > vp.width + 40) return;

  const w = Math.max(2, x2 - x1);
  const isParent = task.hasChildren;
  const bars = barHeights(vp.rowHeight);
  const h = isParent ? bars.parent : bars.leaf;
  const y = rowY + (vp.rowHeight - h) / 2;
  const radius = isParent ? 2 : 5;

  // —— 还没动过：只画一圈虚线轮廓 ——
  // 实线代表「这件事真的发生了」。给没发生的事画实线，等于让一个还没开始的
  // 任务看起来和一个恰好按计划完成的任务一模一样
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

  // 轨道 = 同色低透明度；进度 = 同色实心。
  // 色相表达归属，明度对比表达进度 —— 两个信息各走各的视觉通道
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

  // —— 受阻时段：斜纹叠在条子上 ——
  // 多段先并成一层再画：两段半透明斜纹叠在一起会糊成更深的一块，
  // 反而看不出边界。具体几条、什么原因，交给详情面板逐条列。
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

  // 紧急度只标 P0，且用形状 + 颜色双编码（抗色盲、抗灰度打印）。
  // P1–P3 不在甘特条上出现 —— 真实项目里绝大多数任务是 P2，四档铺满全屏
  // 几乎不传递信息，却占着一整个视觉通道。稀缺才有信号价值。
  // 着色依据本身就是紧急度时，整根条子已经是紧急度色，三角纯属冗余。
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

  // —— 进度百分比。常驻显示，不只在拖动时才出现 ——
  // 进度是这张图上最常被问的数字，藏在 tooltip 里等于没有。
  // 0% 不画：一屏全是「0%」纯属噪音，空白本身就说明还没开始。
  const pct = Math.round(task.progress * 100);
  const pctLabel = `${pct}%`;
  ctx.font = `600 10px ${FONT_STACK}`;
  const pctW = pct > 0 ? ctx.measureText(pctLabel).width : 0;
  let pctDrawnInside = false;

  if (pct > 0 && w > pctW + 20) {
    // 贴右端画。文字落在填充区还是轨道上取决于进度，所以按它所在位置取色
    const pctCenter = x2 - 8 - pctW / 2;
    const onFilled = pctCenter < x1 + w * task.progress;
    ctx.fillStyle = onFilled ? paint.onFill : theme.axisTextDim;
    ctx.textAlign = "right";
    ctx.fillText(pctLabel, x2 - 8, y + h / 2);
    pctDrawnInside = true;
  }

  // —— 任务名。条子够宽就写在里面，且要避开右侧的百分比 ——
  const label = task.name;
  if (!label) return;
  ctx.font = `500 11px ${FONT_STACK}`;
  const textW = ctx.measureText(label).width;
  const reserved = pctDrawnInside ? pctW + 14 : 0;

  ctx.textAlign = "left";
  if (textW + 18 + reserved < w) {
    // 文字大部分压在填充区上时用反色，压在浅色轨道上时用正常文字色
    ctx.fillStyle = task.progress > 0.5 ? paint.onFill : theme.axisText;
    ctx.fillText(label, x1 + 9, y + h / 2);
  } else if (x2 < vp.width - 40) {
    ctx.fillStyle = theme.axisTextDim;
    // 百分比没能画进条子里时，把它跟在名字后面 —— 总得有个地方能读到
    ctx.fillText(
      pct > 0 && !pctDrawnInside ? `${label}  ${pctLabel}` : label,
      x2 + 8,
      y + h / 2,
    );
  }
}

/**
 * 对照模式下垫在实施条下方的计划影子。
 *
 * 画成一条更细的条子而不是同等粗细：两条一样重时，一眼看不出哪条是"真的"。
 * 实施条是主角，计划只是参照物。
 *
 * **颜色承载「有没有守住这个计划」**：超出计划标红、落在计划内标绿。
 * 这是这条线上唯一空着的视觉通道 —— 实施条的色相已经给了归属（阶段/负责人），
 * 明度给了进度，所以偏差只能挂在计划影子上。全部画成灰色则等于浪费掉它。
 *
 * 还没开工的任务不画：那时实施条本身就是计划位置上的虚线，
 * 再垫一条同位置的计划线纯属重影。
 */
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

  // 口径和网格里的「偏差」列一致：看结束日 —— 「按时交付」说的就是这个。
  // 两处用不同口径的话，图上标红而表里写 0d，用户会以为程序坏了
  const gap = deviation(task);
  const late = (gap?.end ?? 0) > 0;
  const color = late ? theme.overdue : theme.onTime;

  const bars = barHeights(vp.rowHeight);
  const h = Math.max(3, Math.round(bars.leaf / 3));
  // 贴着行的下沿，不和实施条抢中间那条视觉主线
  const y = rowY + vp.rowHeight - h - 2;

  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  roundRect(ctx, x1, y, Math.max(2, x2 - x1), h, 1.5);
  ctx.fill();

  // 偏差天数写在计划条尾端外侧 —— 那正是「原本该在这儿结束」的位置
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
  /** 正在拖动的任务，以及要显示的浮动信息 */
  dragging: { index: number; label: string; snapped: boolean } | null;
  /** 鼠标横坐标，用于时间游标；离开画布时为 null */
  cursorX: number | null;
  /** 鼠标悬停在哪个任务上，用于同期高亮 */
  hoverId: number | null;
  /** 正在 ⌥ 拖出的受阻区间预览 */
  marking: { index: number; from: number; to: number } | null;
  /**
   * 当前视图。交互层画的框和手柄必须落在**这个视图正在画的那根条子**上，
   * 否则实施视图下条子在实施位置、框却还在计划位置。
   */
  mode: ViewMode;
}

/**
 * 只有这一层在拖拽和移动鼠标时每帧重绘 —— 内容极少，所以「不掉帧」是结构性的，
 * 而不是靠优化绘制速度（DESIGN.md §6.2）。
 */
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

  // 正在拖的受阻区间：实时预览，松手才真的落下
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

      // 吸附命中时边框点亮 —— 声音反馈要到 v2 才有，v1 先给视觉
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

/**
 * 进度手柄。
 *
 * 「拖进度填充的右边界可以改进度」这件事，不画出来根本没人会发现 ——
 * 命中区一直都在，缺的只是可见性。悬停到某一行时才出现，不占常驻视觉。
 *
 * **只在实施视图出现，并且画在实施条上。** 进度记的是「实际干了多少」，
 * 计划视图里它不可编辑（viewMode.canEdit），画出来就是骗人。
 * 这里的可见性判断必须和 hitTest 的一致，否则又回到「看得见抓不住」。
 */
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
  // 父任务进度是汇总值，拖不动；里程碑没有区间
  if (!task || task.hasChildren || task.milestone) return;

  // 还没填过实施日期的虚线条上不画 —— 那上面没有进度填充可动（同 hitTest）
  const active = activeSpan(task, mode);
  if (active.ghost) return;

  const x1 = vp.xOf(active.span.startDay);
  const x2 = vp.xOf(active.span.endDay + 1);

  // 和命中检测共用同一个位置函数 —— 两边各算各的，就会出现
  // 「手柄看得见却抓不住」（0% 和 100% 时正是如此）
  const x = progressGripX(x1, x2, task.progress);
  if (x == null) return;

  const rowY = AXIS_HEIGHT + index * vp.rowHeight - vp.scrollY;
  const h = barHeights(vp.rowHeight).leaf;
  const y = rowY + (vp.rowHeight - h) / 2;

  // 鼠标靠近时手柄长大变亮 —— Canvas 里没法把系统光标吸过去，
  // 但把「可抓取区」明确地显示出来，手感上就是吸附
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

/**
 * 时间游标：跟随鼠标的竖线 + 顶部日期胶囊。
 *
 * 解决的是甘特图的一个固有矛盾 —— 垂直顺序表达的是**结构**（WBS 层级），
 * 不是时间。所以时间上重叠的两根条子，屏幕上可能隔着十几行，
 * 肉眼根本对不齐。重排行序解决不了（那会破坏层级），只能把时间维度显式画出来。
 */
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: Theme,
  cursorX: number | null,
) {
  if (cursorX == null || cursorX < 0 || cursorX > vp.width) return;

  const day = Math.floor(vp.dayAt(cursorX));
  // 吸到所在那一天的格子中心，而不是像素位置 —— 否则读数会跟着亚像素抖
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

/**
 * 同期高亮：悬停某根条子时，把所有**时间上与它重叠**的条子描出来。
 *
 * 直接回答「此刻还有谁在并行」—— 这正是屏幕上离得很远、却真正互相牵制的那些任务。
 */
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
    // 父任务的区间是子任务并集，几乎和所有东西都重叠，标出来只会满屏噪音
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
