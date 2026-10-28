/**
 * 项目导出 → 单张 Excel 工作表：任务信息列 + 一列一个时间桶的甘特条，下方接风险表、受阻表。
 *
 * 甘特条用单元格边框画线而不用图片或填色：图片不跟着行走，行高或筛选一变就错位；
 * 整格填色行一多就糊。代价是线只能落在格子边上（取上下边缘），做不到居中。
 */

import ExcelJS from "exceljs";
import type { ResolvedTask } from "../gantt/model";
import type { WorkCalendar } from "../core/calendar";
import { dayToIso, today } from "../gantt/time";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { makeBarPainter, type ColorBy } from "../gantt/coloring";
import type { Person, Risk } from "../db/api";
import { blockedDays, mergeRanges, reasonLabel } from "../core/blocked";
import {
  barCells,
  buildBuckets,
  flatten,
  pickUnit,
  type AxisUnit,
  type Bucket,
} from "./timeAxis";

export interface ExportInput {
  projectName: string;
  projectColor: string;
  /** 已 resolve 且全部展开的任务，顺序即导出行序 */
  tasks: ResolvedTask[];
  people: Person[];
  calendar: WorkCalendar;
  colorBy: ColorBy;
  risks: Risk[];
  exportedAt: Date;
}

/* ---------------- 版面常量 ---------------- */

const FIXED_COLUMNS = [
  { header: "任务", width: 34 },
  { header: "负责人", width: 12 },
  { header: "紧急度", width: 9 },
  { header: "计划开始", width: 12 },
  { header: "计划结束", width: 12 },
  { header: "实际开始", width: 12 },
  { header: "实际结束", width: 12 },
  { header: "偏差", width: 8 },
  { header: "工期", width: 12 },
  { header: "进度", width: 9 },
  { header: "风险", width: 7 },
] as const;

const FIXED_COLS = FIXED_COLUMNS.length; // 8，甘特条从第 9 列（I）开始
const GANTT_COL_WIDTH: Record<AxisUnit, number> = { day: 2.7, week: 4.6, month: 5.6 };

const TITLE_ROW = 1;
const SUBTITLE_ROW = 2;
const GROUP_ROW = 4; // 时间轴上行：月 / 年
const HEADER_ROW = 5; // 列名 + 时间轴下行
const FIRST_TASK_ROW = 6;

const INK = "1F2937";
const INK_DIM = "6B7280";
const RULE = "D6DAE1";
const HEADER_BG = "F3F4F6";
const REST_BG = "E7E9EE";
/** 正文里的非工作日竖带，比表头那档淡得多，背景不能抢线的注意力 */
const REST_BAND = "F6F7F9";
const TODAY_BG = "FDE68A";
const TODAY_LINE = "F59E0B";
const RESOLVED_INK = "9CA3AF";

/** 受阻段线色，与屏幕上那条红斜纹同一信号（见 gantt/render.ts 的 hatchPattern） */
const BLOCKED_INK = "E11D48";

const RISK_LEVELS = ["高", "中", "低"];
const RISK_COLORS = ["#EF4444", "#F59E0B", "#64748B"];

const thin = (color = RULE) => ({ style: "thin" as const, color: { argb: color } });

/** 空项目也要能导出一份说得清的文件，给一个从今天起的默认窗口 */
const FALLBACK_SPAN = 30;

export function buildWorkbook(input: ExportInput): ExcelJS.Workbook {
  const { projectName, tasks, risks, exportedAt } = input;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Gantt";
  wb.created = exportedAt;

  const sheet = wb.addWorksheet(sanitizeSheetName(projectName), {
    views: [
      // 冻结列与表头：横向翻到明年时左边仍知道这行是谁的活
      { state: "frozen", xSplit: FIXED_COLS, ySplit: HEADER_ROW },
    ],
    properties: { defaultRowHeight: 18 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const buckets = layoutTimeAxis(input);
  const unit = buckets.length > 0 ? unitOf(buckets) : "day";

  applyColumnWidths(sheet, buckets.length, unit);
  writeTitle(sheet, input, buckets.length);
  writeTimeHeader(sheet, buckets);
  writeTaskRows(sheet, input, buckets);

  const lastTaskRow = FIRST_TASK_ROW + Math.max(tasks.length, 1) - 1;
  const afterRisks = writeRiskTable(sheet, risks, tasks, lastTaskRow + 3);
  writeBlockedTable(sheet, tasks, afterRisks + 2);

  return wb;
}

/* ------------------------------------------------------------------ */
/* 时间轴                                                              */
/* ------------------------------------------------------------------ */

function layoutTimeAxis({ tasks, calendar }: ExportInput): Bucket[] {
  let from = Infinity;
  let to = -Infinity;
  for (const t of tasks) {
    from = Math.min(from, t.startDay);
    to = Math.max(to, t.endDay);
    // 实施日期也算进范围，否则「计划 8/17 交、实际干到 8/22」那一截被截在纸外
    if (t.actualStartDay != null) from = Math.min(from, t.actualStartDay);
    if (t.actualEndDay != null) to = Math.max(to, t.actualEndDay);
  }
  if (!Number.isFinite(from)) {
    from = today();
    to = from + FALLBACK_SPAN;
  }

  // 两端各留两天，免得条子贴着纸边像被截断
  from -= 2;
  to += 2;

  const unit = pickUnit(to - from + 1);
  return buildBuckets(from, to, unit, (d) => calendar.isRest(d));
}

/** 从桶长反推粒度，免得把 unit 一路当参数传下去 */
function unitOf(buckets: Bucket[]): AxisUnit {
  const len = buckets[0].endDay - buckets[0].startDay + 1;
  if (len === 1) return "day";
  if (len === 7) return "week";
  return "month";
}

function applyColumnWidths(
  sheet: ExcelJS.Worksheet,
  bucketCount: number,
  unit: AxisUnit,
) {
  FIXED_COLUMNS.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width;
  });
  for (let i = 0; i < bucketCount; i++) {
    sheet.getColumn(FIXED_COLS + 1 + i).width = GANTT_COL_WIDTH[unit];
  }
}

function writeTitle(sheet: ExcelJS.Worksheet, input: ExportInput, bucketCount: number) {
  const { projectName, tasks, risks, exportedAt } = input;
  const lastCol = FIXED_COLS + bucketCount;

  const title = sheet.getCell(TITLE_ROW, 1);
  title.value = projectName || "未命名项目";
  title.font = { size: 14, bold: true, color: { argb: INK } };
  sheet.mergeCells(TITLE_ROW, 1, TITLE_ROW, Math.min(lastCol, FIXED_COLS));
  sheet.getRow(TITLE_ROW).height = 22;

  const open = risks.filter((r) => !r.resolved).length;
  const subtitle = sheet.getCell(SUBTITLE_ROW, 1);
  subtitle.value =
    `导出于 ${formatDateTime(exportedAt)}　·　${tasks.length} 个任务　·　` +
    `${open} 个未解决风险（共 ${risks.length} 条记录）`;
  subtitle.font = { size: 9, color: { argb: INK_DIM } };
  sheet.mergeCells(SUBTITLE_ROW, 1, SUBTITLE_ROW, Math.min(lastCol, FIXED_COLS));

  sheet.getRow(3).height = 6;
}

function writeTimeHeader(sheet: ExcelJS.Worksheet, buckets: Bucket[]) {
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 20;

  FIXED_COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center" };
    cell.border = { bottom: thin(INK_DIM) };
  });

  const t = today();

  buckets.forEach((bucket, i) => {
    const col = FIXED_COLS + 1 + i;
    const isToday = bucket.startDay <= t && t <= bucket.endDay;

    const cell = headerRow.getCell(col);
    cell.value = bucket.label;
    cell.font = {
      size: 8,
      bold: isToday,
      // 非工作日的日期号淡一点，和屏幕上的时间轴同一套语言
      color: { argb: bucket.rest ? INK_DIM : INK },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isToday ? TODAY_BG : bucket.rest ? REST_BG : HEADER_BG },
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: thin(INK_DIM) };
  });

  // —— 上行：把连续同月（或同年）的列合并成一格 ——
  const groupRow = sheet.getRow(GROUP_ROW);
  groupRow.height = 16;
  let runStart = 0;
  for (let i = 1; i <= buckets.length; i++) {
    if (i < buckets.length && buckets[i].group === buckets[runStart].group) continue;

    const from = FIXED_COLS + 1 + runStart;
    const to = FIXED_COLS + i;
    const cell = groupRow.getCell(from);
    cell.value = buckets[runStart].group;
    cell.font = { size: 9, bold: true, color: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    // 合并要在写完值之后 —— ExcelJS 合并后只有左上角单元格可写
    if (to > from) sheet.mergeCells(GROUP_ROW, from, GROUP_ROW, to);
    runStart = i;
  }
}

/* ------------------------------------------------------------------ */
/* 任务行                                                              */
/* ------------------------------------------------------------------ */

function writeTaskRows(
  sheet: ExcelJS.Worksheet,
  input: ExportInput,
  buckets: Bucket[],
) {
  const { tasks, people, calendar, colorBy, projectColor, risks } = input;

  // 导出件落在白纸上，强制浅色主题取色，深色主题提亮过的颜色印白底看不清
  const paintOf = makeBarPainter(tasks, colorBy, false, projectColor, people);
  const personName = new Map(people.map((p) => [p.id, p.name]));

  const t = today();

  const openRiskCount = new Map<number, number>();
  for (const r of risks) {
    if (r.resolved) continue;
    openRiskCount.set(r.taskId, (openRiskCount.get(r.taskId) ?? 0) + 1);
  }

  if (tasks.length === 0) {
    const cell = sheet.getCell(FIRST_TASK_ROW, 1);
    cell.value = "这个项目还没有任务";
    cell.font = { size: 10, italic: true, color: { argb: INK_DIM } };
    return;
  }

  tasks.forEach((task, index) => {
    const rowNumber = FIRST_TASK_ROW + index;
    const row = sheet.getRow(rowNumber);
    row.height = 17;
    // Excel 原生大纲：outlineLevel 与 depth 都从 0 起，可直接用
    if (task.depth > 0) row.outlineLevel = task.depth;

    const paint = paintOf(task);
    const isParent = task.hasChildren;

    const name = row.getCell(1);
    name.value = task.milestone ? `◆ ${task.name || "未命名"}` : task.name || "未命名";
    name.font = { size: 10, bold: isParent, color: { argb: INK } };
    // 缩进和大纲级别双管齐下：大纲折叠起来时缩进仍然表达层级
    name.alignment = { vertical: "middle", indent: task.depth };

    const assignee = row.getCell(2);
    assignee.value = (task.personId != null && personName.get(task.personId)) || "—";
    assignee.font = {
      size: 10,
      color: { argb: task.personId != null ? INK : RESOLVED_INK },
    };
    assignee.alignment = { vertical: "middle", horizontal: "center" };

    const priority = row.getCell(3);
    priority.value = PRIORITY_LABELS[task.priority] ?? "";
    priority.font = {
      size: 9,
      bold: task.priority === 0,
      color: { argb: flatten(PRIORITY_COLORS[task.priority] ?? "#94A3B8", 1) },
    };
    priority.alignment = { vertical: "middle", horizontal: "center" };

    // 日期写 ISO 文本而非 Excel 日期序列号：序列号会被区域设置重排格式（8/1 vs 1/8），
    // ISO 串无歧义且字典序即日期序
    for (const [col, day] of [
      [4, task.startDay],
      [5, task.endDay],
    ] as const) {
      const cell = row.getCell(col);
      cell.value = dayToIso(day);
      cell.font = { size: 10, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    }

    // 没开工写「—」而非空单元格，否则分不清「没开工」和「忘了填」
    const hasActual = task.actualStartDay != null && task.actualEndDay != null;
    for (const [col, day] of [
      [6, task.actualStartDay],
      [7, task.actualEndDay],
    ] as const) {
      const cell = row.getCell(col);
      cell.value = day != null ? dayToIso(day) : "—";
      cell.font = { size: 10, color: { argb: day != null ? INK : RESOLVED_INK } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    }

    const gapCell = row.getCell(8);
    const gap = hasActual ? task.actualEndDay! - task.endDay : null;
    gapCell.value = gap == null ? "—" : gap > 0 ? `+${gap}d` : `${gap}d`;
    gapCell.font = {
      size: 10,
      bold: gap != null && gap !== 0,
      color: {
        // 和屏幕上同一条规则：超出计划红、落在计划内绿
        argb:
          gap == null
            ? RESOLVED_INK
            : gap > 0
              ? flatten("#DC2626", 1)
              : flatten("#059669", 1),
      },
    };
    gapCell.alignment = { vertical: "middle", horizontal: "center" };

    const natural = calendar.countCalendarDays(task.startDay, task.endDay);
    const working = calendar.countWorkdays(task.startDay, task.endDay);
    const duration = row.getCell(9);
    // 与详情面板同口径：自然日 · 工作日。只给自然日会让排期系统性乐观
    duration.value = task.milestone ? "—" : `${natural} · ${working}`;
    duration.font = { size: 10, color: { argb: INK } };
    duration.alignment = { vertical: "middle", horizontal: "center" };

    const progress = row.getCell(10);
    progress.value = task.progress;
    progress.numFmt = "0%";
    progress.font = { size: 10, color: { argb: INK } };
    progress.alignment = { vertical: "middle", horizontal: "center" };

    const open = openRiskCount.get(task.id) ?? 0;
    const riskCell = row.getCell(11);
    riskCell.value = open > 0 ? open : "—";
    riskCell.font = {
      size: 10,
      bold: open > 0,
      color: { argb: open > 0 ? flatten(RISK_COLORS[0], 1) : RESOLVED_INK },
    };
    riskCell.alignment = { vertical: "middle", horizontal: "center" };

    for (let c = 1; c <= FIXED_COLS; c++) {
      row.getCell(c).border = { bottom: thin() };
    }

    // —— 甘特条：一根条子 = 一串相邻单元格的下边框，Excel 会把相邻同色边框连成一条线。
    // 甘特区不画行分隔线，免得条子淹没在网格里。
    const kinds = barCells(task, buckets);
    const blockedRanges = mergeRanges(task.blocked);
    // 有实际日期时，甘特条画实际；没有就画计划，且画成虚线表示「还没开工」
    const barSpan = hasActual
      ? { startDay: task.actualStartDay!, endDay: task.actualEndDay!, progress: task.progress, milestone: task.milestone }
      : task;
    const actualKinds = barCells(barSpan, buckets);
    // 计划线画上边框、实施线画下边框，一行里两条线天然对照；只在实际与计划不一致时画计划线
    if (hasActual) {
      kinds.forEach((kind, i) => {
        if (kind === "none" || kind === "milestone") return;
        const cell = row.getCell(FIXED_COLS + 1 + i);
        cell.border = {
          ...(cell.border ?? {}),
          top: { style: "hair", color: { argb: INK_DIM } },
        };
      });
    }

    actualKinds.forEach((kind, i) => {
      const bucket = buckets[i];
      const cell = row.getCell(FIXED_COLS + 1 + i);

      // 非工作日竖带：背景不是条子，做得极淡，只帮眼睛数格子
      if (bucket.rest) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REST_BAND } };
      }
      // 今天：一条竖线（左边框），和屏幕上的今天线对应
      if (bucket.startDay <= t && t <= bucket.endDay) {
        cell.border = { ...(cell.border ?? {}), left: { style: "thin", color: { argb: TODAY_LINE } } };
      }

      if (kind === "none") return;

      if (kind === "milestone") {
        cell.value = "◆";
        cell.font = { size: 10, bold: true, color: { argb: flatten("#F59E0B", 1) } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        return;
      }

      // 进度靠线的粗细而不是色块深浅：已完成段粗实线、未完成段细线，条长仍是完整工期。
      // 父任务是子任务并集、不表达自己的进度，整根用中等粗细免得盖过叶子。
      // 受阻格换虚线并改色，和屏幕上的斜纹同一「图案」通道，不抢颜色。
      const isBlocked = blockedRanges.some(
        ([from, to]) => from <= bucket.endDay && bucket.startDay <= to,
      );

      const style: ExcelJS.BorderStyle = isBlocked
        ? "mediumDashed"
        : !hasActual
          ? "dashed" // 还没开工：计划位置上一条虚线
          : isParent
          ? "medium"
          : kind === "fill"
            ? "thick"
            : "thin";
      const argb = isBlocked
        ? BLOCKED_INK
        : !hasActual
          ? flatten(paint.fill, 0.5)
          : isParent
          ? flatten(paint.fill, 0.7)
          : kind === "fill"
            ? flatten(paint.fill, 1)
            : flatten(paint.fill, 0.55);

      cell.border = { ...(cell.border ?? {}), bottom: { style, color: { argb } } };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 风险点表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 风险表挤在同一张 sheet 上，整张表必须落在 A–H 之内：表格冻结了 xSplit = 8，
 * 跨冻结线的合并单元格在 Excel 里会左半钉住右半跟滚，看上去支棱出去。
 * 所以长文本只能合并 A–H 内的相邻列凑宽度。
 */
function writeRiskTable(
  sheet: ExcelJS.Worksheet,
  risks: Risk[],
  tasks: ResolvedTask[],
  startRow: number,
): number {
  const taskName = new Map(tasks.map((t) => [t.id, t.name || "未命名"]));
  const open = risks.filter((r) => !r.resolved).length;

  // A 所属任务 | B 等级 | C–E 内容 | F 状态 | G–H 记录时间
  const CONTENT_FROM = 3;
  const CONTENT_TO = 5;
  const STATUS_COL = 6;
  const TIME_FROM = 7;
  const TIME_TO = FIXED_COLS; // 8，正好停在冻结线上，不越界

  const title = sheet.getCell(startRow, 1);
  title.value = `风险点（${open} 个未解决　·　共 ${risks.length} 条）`;
  title.font = { size: 12, bold: true, color: { argb: INK } };
  sheet.getRow(startRow).height = 22;

  const headerRow = startRow + 1;
  const headers: [number, number, string][] = [
    [1, 1, "所属任务"],
    [2, 2, "等级"],
    [CONTENT_FROM, CONTENT_TO, "内容"],
    [STATUS_COL, STATUS_COL, "状态"],
    [TIME_FROM, TIME_TO, "时间"],
  ];
  for (const [from, to, text] of headers) {
    const cell = sheet.getCell(headerRow, from);
    cell.value = text;
    cell.font = { size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: from === 1 ? "left" : "center" };
    cell.border = { bottom: thin(INK_DIM) };
    if (to > from) sheet.mergeCells(headerRow, from, headerRow, to);
  }
  sheet.getRow(headerRow).height = 18;

  if (risks.length === 0) {
    const cell = sheet.getCell(headerRow + 1, 1);
    cell.value = "还没有记录风险。";
    cell.font = { size: 10, italic: true, color: { argb: INK_DIM } };
    return headerRow + 1;
  }

  risks.forEach((risk, index) => {
    const rowNumber = headerRow + 1 + index;
    const row = sheet.getRow(rowNumber);
    // 已解决的整行褪色：留着它是为了复盘，但它不该和活着的风险抢注意力
    const ink = risk.resolved ? RESOLVED_INK : INK;

    const name = row.getCell(1);
    name.value = taskName.get(risk.taskId) ?? "（任务已删除）";
    name.font = { size: 10, color: { argb: ink } };
    name.alignment = { vertical: "top", wrapText: true };

    const level = row.getCell(2);
    level.value = RISK_LEVELS[risk.level] ?? "?";
    level.font = {
      size: 10,
      bold: !risk.resolved && risk.level === 0,
      color: { argb: risk.resolved ? RESOLVED_INK : flatten(RISK_COLORS[risk.level] ?? "#64748B", 1) },
    };
    level.alignment = { vertical: "top", horizontal: "center" };

    const content = row.getCell(CONTENT_FROM);
    // 处置说明跟在风险正文下面而不另开一列：A–H 已排满，挤会把正文压成竖缝。
    // 富文本换行、变小、变绿，一眼分得出哪句是问题、哪句是处置。
    content.value =
      risk.resolved && risk.resolution
        ? {
            richText: [
              { text: risk.content, font: { size: 10, color: { argb: ink }, strike: true } },
              {
                text: `\n处置：${risk.resolution}`,
                font: { size: 9, color: { argb: RESOLVED_INK }, italic: true },
              },
            ],
          }
        : risk.content;
    content.font = {
      size: 10,
      color: { argb: ink },
      strike: risk.resolved,
    };
    // 风险内容是整份导出里唯一的长文本，不换行就会被右边的单元格切掉
    content.alignment = { vertical: "top", wrapText: true };
    sheet.mergeCells(rowNumber, CONTENT_FROM, rowNumber, CONTENT_TO);

    const status = row.getCell(STATUS_COL);
    status.value = risk.resolved ? "已解决" : "未解决";
    status.font = {
      size: 10,
      bold: !risk.resolved,
      color: { argb: risk.resolved ? RESOLVED_INK : flatten(RISK_COLORS[0], 1) },
    };
    status.alignment = { vertical: "top", horizontal: "center" };

    const time = row.getCell(TIME_FROM);
    // 关闭时刻和记录时刻都要写：「这条风险挂了多久」是复盘会真会问的问题
    time.value =
      risk.resolvedAt != null
        ? `记录 ${formatDateTime(new Date(risk.createdAt * 1000))}\n关闭 ${formatDateTime(
            new Date(risk.resolvedAt * 1000),
          )}`
        : formatDateTime(new Date(risk.createdAt * 1000));
    time.font = { size: 9, color: { argb: RESOLVED_INK } };
    time.alignment = { vertical: "top", horizontal: "center", wrapText: true };
    sheet.mergeCells(rowNumber, TIME_FROM, rowNumber, TIME_TO);

    for (let c = 1; c <= FIXED_COLS; c++) {
      row.getCell(c).border = { bottom: thin() };
    }
  });

  return headerRow + risks.length;
}

/* ------------------------------------------------------------------ */
/* 受阻时段表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 图上的虚线只说「哪几天卡了」，说不出为什么，所以另给一张表。
 * 和风险表同样须落在 A–H 之内。
 */
function writeBlockedTable(
  sheet: ExcelJS.Worksheet,
  tasks: ResolvedTask[],
  startRow: number,
) {
  const rows = tasks.flatMap((task) =>
    task.blocked.map((period) => ({ task, period })),
  );

  const totalDays = tasks.reduce((sum, t) => sum + blockedDays(t.blocked), 0);

  const title = sheet.getCell(startRow, 1);
  title.value = `受阻时段（${rows.length} 段　·　累计 ${totalDays} 天）`;
  title.font = { size: 12, bold: true, color: { argb: INK } };
  sheet.getRow(startRow).height = 22;

  const headerRow = startRow + 1;
  // A 任务 | B–C 区间 | D 天数 | E 原因 | F–H 备注
  const headers: [number, number, string][] = [
    [1, 1, "所属任务"],
    [2, 3, "受阻区间"],
    [4, 4, "天数"],
    [5, 5, "原因"],
    [6, FIXED_COLS, "备注"],
  ];
  for (const [from, to, text] of headers) {
    const cell = sheet.getCell(headerRow, from);
    cell.value = text;
    cell.font = { size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: from === 1 ? "left" : "center" };
    cell.border = { bottom: thin(INK_DIM) };
    if (to > from) sheet.mergeCells(headerRow, from, headerRow, to);
  }
  sheet.getRow(headerRow).height = 18;

  if (rows.length === 0) {
    const cell = sheet.getCell(headerRow + 1, 1);
    cell.value = "没有记录受阻时段。";
    cell.font = { size: 10, italic: true, color: { argb: INK_DIM } };
    return;
  }

  rows.forEach(({ task, period }, index) => {
    const rowNumber = headerRow + 1 + index;
    const row = sheet.getRow(rowNumber);

    const name = row.getCell(1);
    name.value = task.name || "未命名";
    name.font = { size: 10, color: { argb: INK } };
    name.alignment = { vertical: "top", wrapText: true };

    const range = row.getCell(2);
    range.value = `${dayToIso(period.from)} → ${dayToIso(period.to)}`;
    range.font = { size: 10, color: { argb: INK } };
    range.alignment = { vertical: "top", horizontal: "center" };
    sheet.mergeCells(rowNumber, 2, rowNumber, 3);

    const days = row.getCell(4);
    days.value = period.to - period.from + 1;
    days.font = { size: 10, color: { argb: INK } };
    days.alignment = { vertical: "top", horizontal: "center" };

    const reason = row.getCell(5);
    reason.value = reasonLabel(period.reason);
    reason.font = { size: 10, bold: true, color: { argb: BLOCKED_INK } };
    reason.alignment = { vertical: "top", horizontal: "center" };

    const note = row.getCell(6);
    note.value = period.note ?? "";
    note.font = { size: 10, color: { argb: INK_DIM } };
    note.alignment = { vertical: "top", wrapText: true };
    sheet.mergeCells(rowNumber, 6, rowNumber, FIXED_COLS);

    for (let c = 1; c <= FIXED_COLS; c++) {
      row.getCell(c).border = { bottom: thin() };
    }
  });
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

/**
 * Excel 工作表名不能含 : \ / ? * [ ]，且不超 31 字符。违规不报错，
 * 而是存出一个打不开的文件。
 */
export function sanitizeSheetName(name: string): string {
  const cleaned = (name || "").replace(/[:\\/?*[\]]/g, " ").trim();
  return cleaned.slice(0, 31) || "甘特图";
}

/** 文件名同理：去掉路径分隔符和 Windows 保留字符 */
export function safeFileName(projectName: string, at: Date): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${stem.slice(0, 60)}-${stamp}.xlsx`;
}

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}
