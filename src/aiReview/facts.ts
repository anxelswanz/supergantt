/**
 * 文档里的数据表 —— **由程序按快照直接写出来，不经过模型**。
 *
 * 模型转述数字是会出错的：把 6 天抄成 5 天，把两条任务的偏差加在一起。
 * 而这份文档是要发给别人的，数字和「复盘」视图对不上的那一刻它就没人信了。
 * 所以分工是：表格在这里生成，模型只写叙述和归因，并且只许引用快照里有的数。
 *
 * 纯函数，输出 Markdown。
 */

import { answerText, REVIEW_KIND_LABEL, type Question, type Review, type Snapshot } from "./types";
import { omittedNote } from "./snapshot";

/** 模型在「目标与结果」一章末尾留下的占位行，拼文档时换成数据表 */
export const FACTS_PLACEHOLDER = "{{数据概览}}";

/** 「偏差最大的任务」那张表列几行。再多就不是概览了，全量在「复盘」视图里 */
const TOP_TASKS = 8;

/** 表格单元格里不能有竖线和换行 */
const cell = (s: string | number | null | undefined): string =>
  String(s ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim() || "—";

const table = (head: string[], rows: (string | number | null)[][]): string =>
  [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");

/** 偏差天数：晚是正数。0 写成「—」，和复盘视图里 Delta 组件同一个规矩 */
export const deltaText = (days: number): string =>
  days === 0 ? "—" : `${days > 0 ? "+" : ""}${days} 天`;

const spanText = (s: { start: string; end: string } | null): string =>
  s ? `${s.start} → ${s.end}` : "—";

export function endDeltaText(s: Snapshot["summary"]): string {
  if (!s.actual) return "还没有实施记录";
  if (s.endDelta > 0) return `比计划晚 ${s.endDelta} 天`;
  if (s.endDelta < 0) return `比计划早 ${-s.endDelta} 天`;
  return "与计划持平";
}

export function factsMarkdown(snap: Snapshot): string {
  const s = snap.summary;
  const parts: string[] = [
    "### 数据概览",
    `> 以下表格由程序根据 ${snap.takenOn} 的项目数据直接生成，与「复盘」视图是同一份计算。`,
    table(
      ["指标", "数值"],
      [
        ["计划周期", spanText(s.plan)],
        ["实际周期", spanText(s.actual)],
        ["收尾偏差", endDeltaText(s)],
        ["总进度", `${s.progress}%（按工期加权）`],
        ["任务", `共 ${s.leafCount} 条：完成 ${s.doneCount} · 在做 ${s.runningCount} · 还没动过 ${s.untouchedCount}`],
        ["超期任务", `${s.lateCount} 条`],
        ["累计受阻", `${s.blockedDays} 天`],
        ["风险", `未关闭 ${s.openRisks} 条 · 已关闭 ${s.closedRisks} 条`],
      ],
    ),
  ];

  if (snap.attribution.length > 0) {
    parts.push(
      "**时间丢在哪**",
      table(
        ["受阻原因", "天数", "涉及任务"],
        snap.attribution.map((a) => [a.reason, `${a.days} 天`, `${a.taskCount} 条`]),
      ),
    );
  }

  if (snap.milestones.length > 0) {
    parts.push(
      "**里程碑**",
      table(
        ["节点", "计划", "实际", "偏差"],
        snap.milestones.map((m) => [m.name, m.plan, m.actual, m.actual ? deltaText(m.delta) : "—"]),
      ),
    );
  }

  // 快照里的任务已经按重要性排过序（snapshot.taskWeight），这里只挑「真有偏差」的前几条
  const top = snap.tasks.filter((t) => t.endDelta !== 0 || t.blockedDays > 0).slice(0, TOP_TASKS);
  if (top.length > 0) {
    parts.push(
      "**偏差最大的任务**",
      table(
        ["任务", "负责人", "计划", "实际", "收尾偏差", "受阻"],
        top.map((t) => [
          t.name,
          t.owner,
          spanText(t.plan),
          t.actual ? spanText(t.actual) : "还没动过",
          deltaText(t.endDelta),
          t.blockedDays > 0 ? `${t.blockedDays} 天` : "—",
        ]),
      ),
    );
  }

  return parts.join("\n\n");
}

/** 文档最上面那一行说明 */
function headerMarkdown(review: Review, generatedOn: string): string {
  const omitted = omittedNote(review.snapshot);
  const lines = [
    `> ${review.snapshot.projectName} · ${REVIEW_KIND_LABEL[review.background.kind]} · 数据截至 ${review.snapshot.takenOn} · 生成于 ${generatedOn}`,
  ];
  if (omitted) {
    lines.push(`> 项目记录较多，分析时只带入了最重要的部分；未带入：${omitted}。汇总数字仍按全量计算。`);
  }
  return lines.join("\n>\n");
}

/** 附录：问了什么、答了什么。归因写得对不对，读的人要能自己对一遍 */
export function appendixMarkdown(questions: Question[]): string {
  if (questions.length === 0) return "";
  const oneLine = (t: string) => t.replace(/\s*\n\s*/g, " ");
  const lines = questions.map((q, i) => {
    const mark = `${i + 1}. `;
    // 回答写成题目下面的子项，单独占一行。缩进要和序号等宽：到第 10 题序号多一位，
    // 少缩一格它就不再是子项，而是并进了题目那一段
    return `${mark}**${oneLine(q.title)}**\n${" ".repeat(mark.length)}- ${oneLine(answerText(q))}`;
  });
  return ["## 附录：问答记录", lines.join("\n")].join("\n\n");
}

/**
 * 把数据表放进模型写的正文。
 *
 * 正常情况模型会留下占位行。没留的话（它不是每次都听话）退而求其次：插在
 * 第二个二级标题之前，也就是第一章的末尾；连二级标题都不够两个，就放最前面。
 * 无论哪种，**数据表一定在文档里** —— 它是这份文档里唯一能直接对账的部分。
 */
export function insertFacts(body: string, facts: string): string {
  if (body.includes(FACTS_PLACEHOLDER)) {
    // 只换第一处；模型多写了几个的话，剩下的删掉
    const [head, ...rest] = body.split(FACTS_PLACEHOLDER);
    return `${head.trimEnd()}\n\n${facts}\n\n${rest.join("").trimStart()}`.trimEnd();
  }
  const headings = [...body.matchAll(/^## .*$/gm)];
  if (headings.length >= 2) {
    const at = headings[1].index;
    return `${body.slice(0, at).trimEnd()}\n\n${facts}\n\n${body.slice(at)}`;
  }
  return `${facts}\n\n${body}`;
}

/**
 * 模型写的正文 → 完整文档：标题、说明行、正文（含数据表）、问答附录。
 *
 * 模型被要求不写一级标题、不写开场白，但这里还是清理一遍：它偶尔会把整篇
 * 包进 ```markdown 代码块，或者自己加一个一级标题。
 */
export function assembleDocument(review: Review, body: string, generatedOn: string): string {
  let text = body.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^# .*\n+/, "");

  return [
    `# ${review.title}`,
    headerMarkdown(review, generatedOn),
    insertFacts(text, factsMarkdown(review.snapshot)),
    appendixMarkdown(review.questions),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}
