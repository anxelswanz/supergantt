/** AI 复盘文档 → Word。读 aiReview/markdown.ts 解析出的块树，和屏幕渲染同一棵。 */

import {
  BorderStyle,
  Document,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
} from "docx";
import { parseMarkdown, type Block, type Inline } from "../aiReview/markdown";

/** 纵向 A4 宽 11906，左右各留 1080（0.75 英寸） */
const PAGE_MARGIN = 1080;
const USABLE = 11906 - PAGE_MARGIN * 2;

/** 列表和引用每缩一级多少（twip） */
const INDENT = 360;

/** 半磅。正文 10.5pt（五号） */
const BODY = 21;
const HEADING_SIZE: Record<number, number> = { 1: 36, 2: 28, 3: 24, 4: 22 };
const HEADING_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const DIM = "64748B";
const RULE = { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" };

function runs(inlines: Inline[], base: Partial<IRunOptions> = {}): TextRun[] {
  return inlines.map((i) =>
    i.br
      ? new TextRun({ break: 1 })
      : new TextRun({
          size: BODY,
          ...base,
          text: i.text,
          bold: i.bold || base.bold,
          italics: i.italic,
          strike: i.strike,
          // 链接在 Word 里只留下划线，不做成可点的：这份文档多半会被打印或转 PDF
          underline: i.href ? {} : undefined,
          ...(i.code ? { font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "F1F5F9", color: "auto" } } : {}),
        }),
  );
}

interface Ctx {
  /** 左缩进（twip） */
  indent: number;
  /** 在引用块里：字色变淡 */
  quote: boolean;
}

function render(blocks: Block[], ctx: Ctx): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const base: Partial<IRunOptions> = ctx.quote ? { color: DIM } : {};

  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(
          new Paragraph({
            heading: HEADING_LEVEL[Math.min(b.level, 6) - 1],
            spacing: { before: b.level <= 2 ? 320 : 220, after: 120 },
            indent: { left: ctx.indent },
            children: runs(b.inlines, { bold: true, size: HEADING_SIZE[b.level] ?? BODY, color: "0F172A" }),
          }),
        );
        break;

      case "paragraph":
        out.push(
          new Paragraph({
            spacing: { after: 120, line: 340 },
            indent: { left: ctx.indent },
            children: runs(b.inlines, base),
          }),
        );
        break;

      case "list":
        b.items.forEach((item, i) => {
          // 记号直接写成文字，不走 Word 编号定义：那要预先声明每一级样式，而嵌套深度事先不知道
          const mark =
            item.checked === true ? "☑ " : item.checked === false ? "☐ " : b.ordered ? `${b.start + i}. ` : "• ";
          const [first, ...rest] = item.blocks;
          const lead = first?.type === "paragraph" ? first.inlines : [];
          out.push(
            new Paragraph({
              spacing: { after: 60, line: 320 },
              indent: { left: ctx.indent + INDENT, hanging: 260 },
              children: [new TextRun({ text: mark, size: BODY, ...base }), ...runs(lead, base)],
            }),
          );
          // 首段不是普通段落（比如列表项里直接是一张表）时，它也要出
          const tail = first && first.type !== "paragraph" ? item.blocks : rest;
          out.push(...render(tail, { ...ctx, indent: ctx.indent + INDENT }));
        });
        break;

      case "table":
        out.push(table(b), new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;

      case "quote":
        out.push(...render(b.blocks, { indent: ctx.indent + INDENT, quote: true }));
        break;

      case "code":
        for (const line of b.text.split("\n")) {
          out.push(
            new Paragraph({
              indent: { left: ctx.indent },
              shading: { type: ShadingType.CLEAR, fill: "F1F5F9", color: "auto" },
              children: [new TextRun({ text: line, font: "Consolas", size: 18 })],
            }),
          );
        }
        out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;

      case "rule":
        out.push(new Paragraph({ border: { bottom: RULE }, spacing: { before: 120, after: 240 }, children: [] }));
        break;
    }
  }
  return out;
}

function table(b: Extract<Block, { type: "table" }>): Table {
  const cols = Math.max(1, b.head.length);
  const width = Math.floor(USABLE / cols);
  const borders = { top: RULE, bottom: RULE, left: RULE, right: RULE };

  const cell = (inlines: Inline[], head: boolean) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      borders,
      shading: head ? { type: ShadingType.CLEAR, fill: "F1F5F9", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({ children: runs(inlines, { size: 18, bold: head }) })],
    });

  /** 行的格数可能少于表头（手改 Markdown 常见），补空格子 */
  const pad = (row: Inline[][]): Inline[][] =>
    Array.from({ length: cols }, (_, i) => row[i] ?? []);

  return new Table({
    width: { size: width * cols, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => width),
    rows: [
      new TableRow({ tableHeader: true, children: pad(b.head).map((c) => cell(c, true)) }),
      ...b.rows.map((r) => new TableRow({ cantSplit: true, children: pad(r).map((c) => cell(c, false)) })),
    ],
  });
}

export function buildReviewDocx(title: string, markdown: string): Document {
  return new Document({
    creator: "Gantt",
    title,
    // 和事项清单的 Word 导出同一个字体（export/items.ts）
    styles: { default: { document: { run: { font: "Microsoft YaHei" } } } },
    sections: [
      {
        properties: {
          page: { margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } },
        },
        children: render(parseMarkdown(markdown), { indent: 0, quote: false }),
      },
    ],
  });
}

export function reviewFileName(projectName: string, title: string, at: Date, ext: "md" | "docx"): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const stem = [clean(projectName) || "项目", clean(title) || "复盘"].join("-").slice(0, 80);
  return `${stem}-${stamp}.${ext}`;
}
