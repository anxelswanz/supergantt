/**
 * 三次调用的提示词，以及把模型的出题结果收成 Question[]。
 *
 * 纯函数。每一份提示词都**自带完整上下文**（快照 + 背景 + 已有问答），
 * 不依赖模型那边的会话记忆 —— 理由见 src-tauri/src/ai_review.rs 顶部。
 *
 * 提示词全部走 stdin，所以这里怎么换行、带什么符号都没有限制。
 */

import { FACTS_PLACEHOLDER } from "./facts";
import { omittedNote } from "./snapshot";
import {
  answerText,
  OPTION_COUNT,
  REVIEW_KIND_LABEL,
  ROUND1_COUNT,
  ROUND2_COUNT,
  TOPICS,
  type Question,
  type Review,
  type Topic,
} from "./types";

/* ------------------------------------------------------------------ */
/* 出题的输出格式                                                      */
/* ------------------------------------------------------------------ */

/** 传给 `claude --json-schema` 的那份。Rust 那边会把它压成一行 */
export const QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...TOPICS] },
          title: { type: "string" },
          why: { type: "string" },
          multi: { type: "boolean" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["topic", "title", "why", "multi", "options"],
      },
    },
  },
  required: ["questions"],
});

/**
 * 模型给的题 → Question[]。
 *
 * schema 管得住形状，管不住数量和质量：选项可能给了六个、可能有空串、
 * 可能两个一模一样。这里收一遍 —— 少于两个可选项的题直接丢掉（那不是
 * 选择题），选项去重后最多留 OPTION_COUNT 个，题数不超过这一轮的上限。
 */
export function normalizeQuestions(raw: unknown, round: 1 | 2): Question[] {
  const list =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { questions?: unknown }).questions)
      ? ((raw as { questions: unknown[] }).questions as unknown[])
      : [];
  const limit = round === 1 ? ROUND1_COUNT : ROUND2_COUNT;

  const out: Question[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const title = typeof q.title === "string" ? q.title.trim() : "";
    const options = [
      ...new Set(
        (Array.isArray(q.options) ? q.options : [])
          .filter((o): o is string => typeof o === "string")
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    ].slice(0, OPTION_COUNT);
    if (!title || options.length < 2) continue;

    out.push({
      id: `r${round}-${out.length}`,
      round,
      topic: (TOPICS as readonly string[]).includes(q.topic as string) ? (q.topic as Topic) : "过程回顾",
      title,
      why: typeof q.why === "string" ? q.why.trim() : "",
      multi: q.multi === true,
      options,
      answer: null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从一段文字里把 JSON 抠出来。
 *
 * 正常情况用不上：结构化输出在 result 事件的 structured_output 里。这是给
 * 「CLI 版本太旧不认 --json-schema」留的退路 —— 那时模型会把 JSON 写在正文里，
 * 多半还包着代码块。
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const body = fenced ? fenced[1] : text;
  const from = body.indexOf("{");
  const to = body.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try {
    return JSON.parse(body.slice(from, to + 1));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 上下文                                                              */
/* ------------------------------------------------------------------ */

const orNone = (s: string): string => s.trim() || "（未填写）";

/** 三份提示词共用的开头：这是什么项目、用户说了什么、数据长什么样 */
function contextBlock(review: Review): string {
  const { background: bg, snapshot } = review;
  const omitted = omittedNote(snapshot);
  return [
    "# 项目背景（用户填写）",
    `- 项目：${snapshot.projectName}`,
    `- 复盘类型：${REVIEW_KIND_LABEL[bg.kind]}${
      bg.kind === "stage"
        ? "（项目还在进行中。没做完的任务不等于失败；重点是到目前为止学到了什么、下一阶段怎么调整）"
        : "（项目已经结束。重点是目标达成了多少、哪些经验可以带到下一个项目）"
    }`,
    `- 项目目标与成功标准：${orNone(bg.goal)}`,
    `- 实际结果：${orNone(bg.outcome)}`,
    `- 补充说明：${orNone(bg.extra)}`,
    "",
    "# 项目数据（程序从排期工具里导出的事实，截至 " + snapshot.takenOn + "）",
    "字段说明：偏差单位是天，正数 = 比计划晚，负数 = 比计划早；progress 是 0–100 的完成百分比；",
    "blockers 是任务受阻的时段（reason 是归类，note 是当时写的说明，open = 现在还卡着）；",
    "risks 是登记过的风险及其处置；items 是过程中随手记下的问题和待办；notes 是逐日记录。",
    omitted
      ? `注意：项目记录较多，下面只带入了最重要的部分（未带入：${omitted}）。summary 和 attribution 里的汇总数字是按全量算的。`
      : "",
    "```json",
    JSON.stringify(snapshot),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** 已有的问答，写成模型好读的样子 */
function qaBlock(questions: Question[]): string {
  if (questions.length === 0) return "";
  const lines = questions.map(
    (q, i) => `${i + 1}. 【${q.topic}】${q.title}\n   回答：${answerText(q)}`,
  );
  return ["# 已经问过的问题和用户的回答", ...lines].join("\n");
}

/* ------------------------------------------------------------------ */
/* 出题                                                                */
/* ------------------------------------------------------------------ */

const QUESTION_RULES = [
  "## 每道题的要求",
  `- 给出恰好 ${OPTION_COUNT} 个选项。选项要具体、彼此有实质区别，是这个项目里真实可能的情况，不要写成「很好 / 一般 / 较差」这种程度词。`,
  "- 不要给「其他」「以上都不是」这类选项：界面上始终有一个输入框，用户可以自己写。",
  "- multi：这道题是否允许多选。原因、因素类的问题通常应该多选（一件事很少只有一个原因）；评估达成程度、二选一的判断用单选。",
  "- title：直接问，一句话，点名具体的任务、时段或数字（用数据里的原名和原数）。不要问「项目进展顺利吗」这种不看数据也能问的问题。",
  "- why：一句话说明这道题是由哪条数据或哪句回答引出来的，让用户知道你为什么问。",
  `- topic：只能是 ${TOPICS.map((t) => `「${t}」`).join("、")} 之一。`,
  "- 只问用户才知道的事（原因、决策过程、当时的考虑）。数据里已经写明的事实不要再问一遍。",
  "- 不要臆造数据里没有的任务、人名或数字。",
  "- 用户看不到这份 JSON：title、why 和选项里不要出现英文字段名（如 endDelta、durationDelta），用中文把意思说出来。",
].join("\n");

export function buildAskPrompt(review: Review, round: 1 | 2): string {
  const first = round === 1;
  const task = first
    ? [
        `# 你的任务：出首轮的 ${ROUND1_COUNT} 道选择题`,
        "你要为这个项目主持一次复盘。先仔细读上面的背景和数据，找出最值得追问的地方：",
        "延期最多的任务、受阻时间最长的原因、反复出现的问题、提前完成的任务、高等级风险最后怎么收场的。",
        "",
        `然后出 ${ROUND1_COUNT} 道题，覆盖复盘的四个部分：`,
        "- 「目标与结果」1–2 题：对照用户写的目标，达成了多少，差距在哪。",
        "- 「过程回顾」2 题：最主要的卡点、阻塞点、重大问题是怎么发生和处理的。",
        "- 「根因分析」2–3 题：做得好的和没做好的，深层原因分别是什么。失败的根源是规划不足、技术评估失误、沟通脱节，还是执行力欠缺？哪些做法或决策是关键突破口？",
        "- 「经验沉淀」1 题：哪些做法值得固定下来，哪些坑要提醒后来的人。",
        "",
        "题目按上面的顺序排列。",
      ]
    : [
        `# 你的任务：出 ${ROUND2_COUNT} 道追问`,
        "用户已经答完了首轮。现在读他的回答，找出最值得深挖的地方，再问一层「为什么」：",
        "- 回答停在表面的地方（比如只说了「沟通不畅」，没说是谁和谁之间、在哪个环节、为什么当时没发现）。",
        "- 回答和数据对不上的地方（比如用户说进展顺利，但数据显示某条任务受阻了 12 天）。",
        "- 用户提到的做得好的做法：它具体是怎么做的，换个项目还成立吗，能不能写成固定流程。",
        "- 用户提到的问题：下次要靠什么信号提前发现它。",
        "",
        "用户跳过或没回答的题不要重复问。不要重复首轮已经问清楚的事。",
        `追问要建立在他的回答之上：title 里直接引用他选的或写的内容。topic 优先用「根因分析」和「经验沉淀」。`,
      ];

  return [contextBlock(review), first ? "" : qaBlock(review.questions), task.join("\n"), QUESTION_RULES]
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 写文档                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param instruction 「重新生成」时用户附带的一句要求；首次生成没有
 */
export function buildWritePrompt(review: Review, instruction = ""): string {
  const stage = review.background.kind === "stage";
  const task = [
    "# 你的任务：写这份复盘文档",
    "根据上面的背景、数据和全部问答，写一份详细、具体、可以直接发给团队的复盘文档。",
    "",
    "## 结构（严格使用下面这些二级标题，按这个顺序）",
    "",
    "## 一、目标与结果",
    "对照用户写的目标与成功标准，逐项说明达成情况和差距。先给出一段总体结论。",
    `这一章的**最后单独一行**写 \`${FACTS_PLACEHOLDER}\` —— 程序会把它替换成数据表。不要自己画数据表、不要罗列汇总数字。`,
    "",
    "## 二、过程回顾",
    "按时间或按主题，讲清楚项目过程中的主要卡点、阻塞点和重大问题：发生了什么、影响了什么（哪条任务、多少天）、当时是怎么处理的。",
    "",
    "## 三、根因分析",
    "分两个三级标题：",
    "- `### 做得好的：成功归因` —— 哪些做法或决策是关键突破口，为什么起了作用。",
    "- `### 没做好的：失败归因` —— 每个主要问题的深层原因。一层一层往下问为什么，不要停在现象上。每个问题最后明确归到一类根源：**规划不足**、**技术评估失误**、**沟通脱节**、**执行力欠缺**（确实不属于这四类时如实另写）。",
    "",
    "## 四、经验沉淀",
    "分两个三级标题：",
    "- `### 可以标准化的做法（SOP 草案）` —— 每条写成一个四级标题（`#### 做法名称`），下面用列表写四项：**适用场景**、**具体做法**（可执行的步骤）、**触发信号**（什么情况下该启动它）、**产出物**（SOP、技术文档还是可复用的组件/模板）。",
    "- `### 避坑指南与风险 Checklist` —— 先用一两句话说明每个坑是什么、怎么踩到的，然后给出一份可以直接并入团队风险检查表的清单，每项用 `- [ ]` 开头，写成一个可以打勾确认的检查动作，并注明在项目的哪个阶段检查。",
    "",
    stage ? "## 五、下一阶段的调整" : "## 五、后续行动",
    stage
      ? "针对上面的问题，下一阶段具体要改什么。用列表，每项写清楚做什么。"
      : "这次复盘之后具体要做的事。用列表，每项写清楚做什么。",
    "",
    "## 写作要求",
    "- **事实只有两个来源**：项目数据和用户的回答。引用数据时写「数据显示…」，引用回答时写「据复盘时的说明…」，两者不要混。不要臆造任何数据里没有的任务、人名、日期或数字。",
    "- 引用数字时使用数据里的原数，点名具体的任务名。",
    "- 用户标了「未回答」的题不要替他编答案。相关的分析如果因此缺少依据，在对应位置写一句「（这一点复盘时没有给出说明，待补充）」。",
    "- 推断和事实要分开：你自己的推断用「可能」「推测」这样的词标明。",
    "- 对事不对人：分析流程、决策和机制，不评价具体某个人。",
    "- 具体。「加强沟通」「提前规划」这种放在任何项目里都成立的话不要写；写这个项目里具体该改哪个环节、怎么改。",
    "- 不要写一级标题（程序会加标题），不要写开场白和结束语，不要把全文包在代码块里。直接从 `## 一、目标与结果` 开始。",
    "- 只用标准 Markdown：标题、段落、列表、任务列表、加粗、表格、引用。",
    "- 读者看不到那份 JSON：正文里不要出现英文字段名（如 endDelta、blockedDays），用中文把意思说出来。",
  ];

  const extra = instruction.trim();
  return [
    contextBlock(review),
    qaBlock(review.questions),
    task.join("\n"),
    extra ? `## 用户对这一版的额外要求\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 流式显示时，占位行还没被换掉 —— 先遮成一句人话 */
export const maskPlaceholder = (text: string): string =>
  text.replace(FACTS_PLACEHOLDER, "*（数据概览表将插入在这里）*");
