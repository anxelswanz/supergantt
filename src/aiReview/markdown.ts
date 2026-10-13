/**
 * Markdown → 一棵很小的块树。
 *
 * 复盘文档有两个去处：屏幕（aiReview/MarkdownView.tsx）和 Word（export/aiReview.ts）。
 * 两边**读同一棵树** —— 各自解析一遍 Markdown 的话，迟早出现「屏幕上是表格、
 * Word 里是一行竖线」。这和 core/review.ts 对数字的要求是同一条：看到的和
 * 发出去的必须是同一个东西。
 *
 * 语法分析交给 marked（只用它的词法器，不用它出 HTML —— 界面上不出现
 * dangerouslySetInnerHTML）。这里做的只是把它几十种 token 收成七种块：
 * 模型写的、用户手改的 Markdown 什么都可能出现，认不得的一律按纯文本留下，
 * 不丢内容。
 */

import { marked, type Token, type Tokens } from "marked";

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  href?: string;
  /** 硬换行。text 为空 */
  br?: boolean;
}

export interface ListItem {
  /** 任务列表项：true/false；普通列表项：null */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "code"; text: string }
  | { type: "rule" };

type Style = Omit<Inline, "text" | "br">;

/** marked 的词法器不解实体，`&amp;` 会原样留在 text 里 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const unescape = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

function inlines(tokens: Token[] | undefined, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlines((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlines((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inlines((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "link":
        out.push(...inlines((t as Tokens.Link).tokens, { ...style, href: (t as Tokens.Link).href }));
        break;
      case "codespan":
        out.push({ ...style, code: true, text: unescape((t as Tokens.Codespan).text) });
        break;
      case "br":
        out.push({ text: "", br: true });
        break;
      case "checkbox":
        // 任务列表的勾选框。勾没勾记在列表项上（ListItem.checked），这里不重复出
        break;
      case "image":
        // 文档里放不了图，留下替代文字
        out.push({ ...style, text: (t as Tokens.Image).text });
        break;
      default: {
        // text 也可能自己带一层 tokens（列表项里的那种）
        const sub = (t as { tokens?: Token[] }).tokens;
        if (sub?.length) out.push(...inlines(sub, style));
        else {
          const text = unescape((t as { text?: string }).text ?? t.raw ?? "");
          if (text) out.push({ ...style, text });
        }
      }
    }
  }
  return out;
}

function blocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
      // 紧凑写法的任务列表里，勾选框是列表项下的一个块级 token（松散写法时它在
      // 段落的行内 token 里）。两处都不出：勾没勾记在 ListItem.checked 上
      case "checkbox":
        break;
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({ type: "heading", level: h.depth, inlines: inlines(h.tokens) });
        break;
      }
      case "paragraph":
      case "text":
        out.push({ type: "paragraph", inlines: inlines((t as Tokens.Paragraph).tokens ?? [t]) });
        break;
      case "list": {
        const l = t as Tokens.List;
        out.push({
          type: "list",
          ordered: l.ordered,
          start: typeof l.start === "number" ? l.start : 1,
          items: l.items.map((item) => ({
            checked: item.task ? item.checked === true : null,
            blocks: blocks(item.tokens),
          })),
        });
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        out.push({
          type: "table",
          head: tb.header.map((c) => inlines(c.tokens)),
          rows: tb.rows.map((r) => r.map((c) => inlines(c.tokens))),
        });
        break;
      }
      case "blockquote":
        out.push({ type: "quote", blocks: blocks((t as Tokens.Blockquote).tokens) });
        break;
      case "code":
        out.push({ type: "code", text: (t as Tokens.Code).text });
        break;
      case "hr":
        out.push({ type: "rule" });
        break;
      default: {
        // html、def 之类：当成一段原样的文字。宁可难看，不丢内容
        const raw = (t.raw ?? "").trim();
        if (raw) out.push({ type: "paragraph", inlines: [{ text: raw }] });
      }
    }
  }
  return out;
}

export function parseMarkdown(md: string): Block[] {
  return blocks(marked.lexer(md, { gfm: true }));
}

/** 一串行内片段的纯文字。表格列宽估算、标题锚点这类地方用 */
export const plainText = (list: Inline[]): string => list.map((i) => (i.br ? "\n" : i.text)).join("");
