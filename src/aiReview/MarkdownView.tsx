/**
 * 复盘文档的阅读视图。
 *
 * 读的是 markdown.ts 解析出来的块树，一个块一个 React 元素 —— **不拼 HTML、
 * 不用 dangerouslySetInnerHTML**。文档内容来自模型和用户的手改，两者都可能
 * 带尖括号；当成文本渲染，它们就只是文本。
 *
 * Word 导出（export/aiReview.ts）读的是同一棵树。
 */

import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

function Inlines({ list }: { list: Inline[] }) {
  return (
    <>
      {list.map((i, k) => {
        if (i.br) return <br key={k} />;
        let node: ReactNode = i.text;
        if (i.code) {
          node = (
            <code className="rounded bg-[var(--surface-alt)] px-1 py-px font-mono text-[0.92em]">{node}</code>
          );
        }
        if (i.bold) node = <strong className="font-semibold text-[var(--text)]">{node}</strong>;
        if (i.italic) node = <em>{node}</em>;
        if (i.strike) node = <del>{node}</del>;
        // 不做成可点的链接：这是桌面应用里的一份文档，点一下把整个窗口导航走是事故
        if (i.href) node = <span className="underline decoration-dotted" title={i.href}>{node}</span>;
        return <Fragment key={k}>{node}</Fragment>;
      })}
    </>
  );
}

const HEADING: Record<number, string> = {
  1: "mt-0 mb-3 text-xl font-semibold text-[var(--text)]",
  2: "mt-8 mb-3 border-b border-[var(--rule)] pb-1.5 text-base font-semibold text-[var(--text)]",
  3: "mt-6 mb-2 text-sm font-semibold text-[var(--text)]",
  4: "mt-4 mb-1.5 text-[13px] font-semibold text-[var(--text)]",
};

function Blocks({ list }: { list: Block[] }) {
  return (
    <>
      {list.map((b, k) => {
        switch (b.type) {
          case "heading": {
            const Tag = `h${Math.min(b.level, 6)}` as "h1";
            return (
              <Tag key={k} className={HEADING[b.level] ?? HEADING[4]}>
                <Inlines list={b.inlines} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={k} className="my-2 leading-relaxed">
                <Inlines list={b.inlines} />
              </p>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            const plain = b.items.every((i) => i.checked === null);
            return (
              <Tag
                key={k}
                start={b.ordered ? b.start : undefined}
                className={`my-2 space-y-1 ${plain ? `pl-5 ${b.ordered ? "list-decimal" : "list-disc"}` : "list-none pl-0"}`}
              >
                {b.items.map((item, i) => (
                  <li key={i} className={`leading-relaxed ${item.checked === null ? "" : "flex gap-2"}`}>
                    {item.checked !== null && (
                      <span
                        aria-hidden
                        className="mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-[var(--text-dim)] text-[9px] leading-none"
                      >
                        {item.checked ? "✓" : ""}
                      </span>
                    )}
                    {/* 列表项里的首段不要段间距，否则每一项上下都多出一截空白 */}
                    <div className="min-w-0 flex-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                      <Blocks list={item.blocks} />
                    </div>
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div key={k} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {b.head.map((c, i) => (
                        <th
                          key={i}
                          className="border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1.5 text-left font-medium text-[var(--text)]"
                        >
                          <Inlines list={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} className="border border-[var(--rule)] px-2 py-1.5 align-top">
                            <Inlines list={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote
                key={k}
                className="my-3 border-l-2 border-[var(--rule)] pl-3 text-xs text-[var(--text-dim)]"
              >
                <Blocks list={b.blocks} />
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={k}
                className="my-3 overflow-x-auto rounded-lg bg-[var(--surface-alt)] p-3 font-mono text-xs leading-relaxed"
              >
                {b.text}
              </pre>
            );
          case "rule":
            return <hr key={k} className="my-6 border-[var(--rule)]" />;
        }
      })}
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  const tree = useMemo(() => parseMarkdown(source), [source]);
  return (
    // 全局样式关掉了文本选中（桌面应用不该有网页那种拖影），但文档是要被
    // 复制走的。那条规则打在 `*` 上，不继承，所以这里也得逐个元素打开
    <div className="text-[13px] text-[var(--text)] select-text [&_*]:select-text">
      <Blocks list={tree} />
    </div>
  );
}
