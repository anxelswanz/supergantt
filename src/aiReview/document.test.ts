import { describe, expect, it } from "vitest";
import { explainFailure, readStreamLine } from "./claude";
import { appendixMarkdown, assembleDocument, deltaText, FACTS_PLACEHOLDER, factsMarkdown, insertFacts } from "./facts";
import { parseMarkdown, plainText } from "./markdown";
import { buildAskPrompt, buildWritePrompt, extractJson, maskPlaceholder, normalizeQuestions, QUESTION_SCHEMA } from "./prompts";
import {
  answerText,
  emptySnapshot,
  isAnswered,
  parseReview,
  ROUND1_COUNT,
  ROUND2_COUNT,
  type Question,
  type Review,
  type Snapshot,
} from "./types";

const snapshot = (): Snapshot => ({
  ...emptySnapshot(),
  takenOn: "2026-10-12",
  projectName: "产线改造",
  summary: {
    ...emptySnapshot().summary,
    leafCount: 12,
    doneCount: 9,
    runningCount: 2,
    untouchedCount: 1,
    lateCount: 3,
    progress: 86,
    plan: { start: "2026-07-01", end: "2026-09-30" },
    actual: { start: "2026-07-01", end: "2026-10-12" },
    endDelta: 12,
    blockedDays: 9,
    openRisks: 1,
    closedRisks: 4,
  },
  attribution: [{ reason: "等料", days: 6, taskCount: 2 }],
  milestones: [{ name: "投产", plan: "2026-09-30", actual: "2026-10-12", delta: 12 }],
  tasks: [
    {
      name: "电机|安装",
      group: "设备",
      owner: "张三",
      plan: { start: "2026-08-01", end: "2026-08-10" },
      actual: { start: "2026-08-02", end: "2026-08-16" },
      startDelta: 1,
      endDelta: 6,
      durationDelta: 5,
      blockedDays: 3,
      progress: 100,
      milestone: false,
    },
    {
      name: "准时的那条",
      group: null,
      owner: null,
      plan: { start: "2026-08-01", end: "2026-08-10" },
      actual: { start: "2026-08-01", end: "2026-08-10" },
      startDelta: 0,
      endDelta: 0,
      durationDelta: 0,
      blockedDays: 0,
      progress: 100,
      milestone: false,
    },
  ],
});

const question = (over: Partial<Question> = {}): Question => ({
  id: "r1-0",
  round: 1,
  topic: "过程回顾",
  title: "电机安装为什么等了 3 天料？",
  why: "数据显示它受阻 3 天，原因是等料",
  multi: true,
  options: ["下单晚了", "供应商延期", "规格改过", "漏了这一项"],
  answer: null,
  ...over,
});

const review = (over: Partial<Review> = {}): Review => ({
  id: 1,
  projectId: 7,
  title: "结项复盘",
  stage: "done",
  background: { kind: "final", goal: "9 月底投产", outcome: "10 月 12 日投产", extra: "" },
  snapshot: snapshot(),
  questions: [],
  document: "",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("数据表", () => {
  it("偏差的写法和复盘视图一致：晚是正数，0 留白", () => {
    expect([deltaText(6), deltaText(-2), deltaText(0)]).toEqual(["+6 天", "-2 天", "—"]);
  });

  it("数字原样来自快照；任务名里的竖线不会把表格拆坏", () => {
    const md = factsMarkdown(snapshot());
    expect(md).toContain("| 收尾偏差 | 比计划晚 12 天 |");
    expect(md).toContain("| 等料 | 6 天 | 2 条 |");
    expect(md).toContain("| 投产 | 2026-09-30 | 2026-10-12 | +12 天 |");
    expect(md).toContain("电机\\|安装");
    // 没有偏差也没受阻的任务不进「偏差最大的任务」
    expect(md).not.toContain("准时的那条");

    const tables = parseMarkdown(md).filter((b) => b.type === "table");
    expect(tables).toHaveLength(4);
    const top = tables[3];
    if (top.type !== "table") throw new Error("不是表格");
    expect(top.rows).toHaveLength(1);
    expect(plainText(top.rows[0][0])).toBe("电机|安装");
    expect(top.rows[0]).toHaveLength(top.head.length);
  });

  it("还没有实施记录时不说「持平」", () => {
    const s = snapshot();
    s.summary.actual = null;
    s.summary.endDelta = 0;
    expect(factsMarkdown(s)).toContain("| 收尾偏差 | 还没有实施记录 |");
  });
});

describe("把数据表放进正文", () => {
  const facts = "### 数据概览\n表";

  it("换掉占位行", () => {
    const out = insertFacts(`## 一、目标\n结论\n\n${FACTS_PLACEHOLDER}\n\n## 二、过程\n经过`, facts);
    expect(out).toBe("## 一、目标\n结论\n\n### 数据概览\n表\n\n## 二、过程\n经过");
  });

  it("模型多写了几个占位行：只留第一处", () => {
    const out = insertFacts(`a\n${FACTS_PLACEHOLDER}\nb\n${FACTS_PLACEHOLDER}\nc`, facts);
    expect(out.match(/数据概览/g)).toHaveLength(1);
    expect(out).not.toContain(FACTS_PLACEHOLDER);
  });

  it("模型没留占位行：插在第一章末尾，数据表一定在文档里", () => {
    const out = insertFacts("## 一、目标\n结论\n\n## 二、过程\n经过", facts);
    expect(out.indexOf("数据概览")).toBeGreaterThan(out.indexOf("结论"));
    expect(out.indexOf("数据概览")).toBeLessThan(out.indexOf("## 二、过程"));
  });

  it("连章节都没有：放最前面", () => {
    expect(insertFacts("一段话", facts).startsWith(facts)).toBe(true);
  });

  it("流式显示时占位行先遮成一句人话", () => {
    expect(maskPlaceholder(`a\n${FACTS_PLACEHOLDER}`)).not.toContain("{{");
  });
});

describe("拼成完整文档", () => {
  const body = `## 一、目标与结果\n基本达成。\n\n${FACTS_PLACEHOLDER}\n\n## 二、过程回顾\n经过。`;

  it("标题、说明行、正文、数据表、问答附录都在", () => {
    const r = review({ questions: [question({ answer: { picked: [0, 1], text: "合同签晚了", skipped: false } })] });
    const doc = assembleDocument(r, body, "2026-10-13");
    expect(doc.startsWith("# 结项复盘\n\n> 产线改造 · 结项复盘 · 数据截至 2026-10-12 · 生成于 2026-10-13")).toBe(true);
    expect(doc).toContain("| 总进度 | 86%（按工期加权） |");
    expect(doc).toContain("## 附录：问答记录");
    expect(doc).toContain("下单晚了；供应商延期。补充：合同签晚了");
    expect(doc).not.toContain(FACTS_PLACEHOLDER);
    expect(doc.indexOf("## 二、过程回顾")).toBeLessThan(doc.indexOf("## 附录"));
  });

  it("模型把全文包进了代码块，还自己加了一级标题：清掉", () => {
    const doc = assembleDocument(review(), "```markdown\n# 我起的标题\n\n" + body + "\n```", "2026-10-13");
    expect(doc.match(/^# /gm)).toHaveLength(1);
    expect(doc).not.toContain("```");
    expect(doc).not.toContain("我起的标题");
  });

  it("记录太多没全带上时，文档里要写明", () => {
    const s = snapshot();
    s.omitted.blockers = 15;
    expect(assembleDocument(review({ snapshot: s }), body, "2026-10-13")).toContain("未带入：阻碍 15 段");
  });
});

describe("问答附录", () => {
  it("回答是题目下面的子项 —— 第 10 题序号多一位，缩进也要跟上", () => {
    const qs = Array.from({ length: 10 }, (_, i) =>
      question({ id: `q${i}`, title: `第 ${i + 1} 题`, answer: { picked: [0], text: "", skipped: false } }),
    );
    const list = parseMarkdown(appendixMarkdown(qs)).find((b) => b.type === "list");
    if (list?.type !== "list") throw new Error("附录里没有列表");
    expect(list.items).toHaveLength(10);
    for (const item of list.items) {
      expect(item.blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    }
  });
});

describe("回答", () => {
  it("选了、写了、跳过都算答过；空着不算", () => {
    expect(isAnswered(question())).toBe(false);
    expect(isAnswered(question({ answer: { picked: [], text: "  ", skipped: false } }))).toBe(false);
    expect(isAnswered(question({ answer: { picked: [2], text: "", skipped: false } }))).toBe(true);
    expect(isAnswered(question({ answer: { picked: [], text: "自己写的", skipped: false } }))).toBe(true);
    expect(isAnswered(question({ answer: { picked: [], text: "", skipped: true } }))).toBe(true);
  });

  it("跳过和没答对读的人是一回事：这里没有信息", () => {
    expect(answerText(question())).toBe("（未回答）");
    expect(answerText(question({ answer: { picked: [], text: "", skipped: true } }))).toBe("（未回答）");
    expect(answerText(question({ answer: { picked: [], text: "自己写的", skipped: false } }))).toBe("自己写的");
    expect(appendixMarkdown([question()])).toContain("（未回答）");
  });
});

describe("出题结果", () => {
  const raw = (n: number, options = ["甲", "乙", "丙", "丁"]) => ({
    questions: Array.from({ length: n }, (_, i) => ({
      topic: "根因分析",
      title: `第 ${i + 1} 题`,
      why: "因为数据",
      multi: i % 2 === 0,
      options,
    })),
  });

  it("schema 是合法 JSON，Rust 那边要拿它压成一行", () => {
    expect(() => JSON.parse(QUESTION_SCHEMA)).not.toThrow();
  });

  it("题数不超过这一轮的上限，id 按轮次编号", () => {
    const r1 = normalizeQuestions(raw(12), 1);
    expect(r1).toHaveLength(ROUND1_COUNT);
    expect(r1[0]).toMatchObject({ id: "r1-0", round: 1, topic: "根因分析", multi: true, answer: null });
    const r2 = normalizeQuestions(raw(12), 2);
    expect(r2).toHaveLength(ROUND2_COUNT);
    expect(r2[2].id).toBe("r2-2");
  });

  it("选项去重、去空，最多留四个；不够两个的不是选择题，丢掉", () => {
    expect(normalizeQuestions(raw(1, ["甲", "甲", " ", "乙", "丙", "丁", "戊"]), 1)[0].options).toEqual([
      "甲",
      "乙",
      "丙",
      "丁",
    ]);
    expect(normalizeQuestions(raw(1, ["只有一个"]), 1)).toEqual([]);
  });

  it("不认识的归类退回一个合法值；完全不对的输入给空数组", () => {
    const q = normalizeQuestions({ questions: [{ topic: "瞎写", title: "题", options: ["a", "b"] }] }, 1)[0];
    expect(q).toMatchObject({ topic: "过程回顾", multi: false, why: "" });
    for (const bad of [null, "文字", {}, { questions: "x" }, { questions: [null, 3] }]) {
      expect(normalizeQuestions(bad, 1)).toEqual([]);
    }
  });

  it("没有结构化输出时，从正文里把 JSON 抠出来", () => {
    expect(extractJson('好的：\n```json\n{"questions":[]}\n```\n以上。')).toEqual({ questions: [] });
    expect(extractJson('前言 {"questions":[]} 后记')).toEqual({ questions: [] });
    expect(extractJson("没有 json")).toBe(null);
    expect(extractJson("{坏的}")).toBe(null);
  });
});

describe("提示词", () => {
  const answered = review({
    stage: "ask2",
    questions: [
      question({ answer: { picked: [1], text: "供应商换了产线", skipped: false } }),
      question({ id: "r1-1", title: "跳过的那题", answer: { picked: [], text: "", skipped: true } }),
    ],
  });

  /**
   * 每次调用都是全新进程、没有会话记忆（见 ai_review.rs），
   * 提示词少带一样，模型就是在瞎猜。
   */
  it("每一份都自带完整上下文：背景、快照、已有问答", () => {
    for (const prompt of [buildAskPrompt(answered, 2), buildWritePrompt(answered)]) {
      expect(prompt).toContain("9 月底投产");
      expect(prompt).toContain("10 月 12 日投产");
      expect(prompt).toContain(JSON.stringify(answered.snapshot));
      expect(prompt).toContain("电机安装为什么等了 3 天料？");
      expect(prompt).toContain("供应商延期。补充：供应商换了产线");
      expect(prompt).toContain("跳过的那题\n   回答：（未回答）");
    }
  });

  it("首轮没有问答可带，要 7 道；追问要 3 道", () => {
    const first = buildAskPrompt(review({ stage: "ask1" }), 1);
    expect(first).not.toContain("已经问过的问题");
    expect(first).toContain(`${ROUND1_COUNT} 道选择题`);
    expect(buildAskPrompt(answered, 2)).toContain(`${ROUND2_COUNT} 道追问`);
  });

  it("写文档：要留占位行、四类根源、SOP 与 Checklist 的格式都写明了", () => {
    const p = buildWritePrompt(answered);
    expect(p).toContain(FACTS_PLACEHOLDER);
    for (const word of ["规划不足", "技术评估失误", "沟通脱节", "执行力欠缺", "SOP", "- [ ]", "触发信号"]) {
      expect(p).toContain(word);
    }
    expect(p).not.toContain("额外要求");
  });

  it("阶段复盘和结项复盘的要求不同", () => {
    const stage = buildWritePrompt(review({ background: { ...answered.background, kind: "stage" } }));
    expect(stage).toContain("下一阶段的调整");
    expect(stage).toContain("没做完的任务不等于失败");
    expect(buildWritePrompt(answered)).toContain("后续行动");
  });

  it("重新生成时带上用户那句要求", () => {
    expect(buildWritePrompt(answered, " 归因写短一点 ")).toContain("## 用户对这一版的额外要求\n归因写短一点");
  });

  it("记录没全带上时要告诉模型：你看到的不是全部", () => {
    const s = snapshot();
    s.omitted.items = 9;
    expect(buildAskPrompt(review({ snapshot: s }), 1)).toContain("未带入：事项 9 条");
  });
});

describe("读 claude 的输出", () => {
  // 形状取自实测的 `claude -p --output-format stream-json`
  it("逐字流式的正文片段", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "# 蓝" } },
    });
    expect(readStreamLine(line)).toEqual({ type: "delta", text: "# 蓝" });
  });

  it("思考过程、初始化、限流通知都不是正文", () => {
    const thinking = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
    };
    for (const ev of [thinking, { type: "system", subtype: "init" }, { type: "rate_limit_event" }]) {
      expect(readStreamLine(JSON.stringify(ev))).toBe(null);
    }
    expect(readStreamLine("不是 json")).toBe(null);
    expect(readStreamLine("3")).toBe(null);
  });

  it("结果行：结构化输出、正文、成败", () => {
    expect(
      readStreamLine(
        JSON.stringify({ type: "result", is_error: false, result: "{}", structured_output: { questions: [] } }),
      ),
    ).toEqual({ type: "result", ok: true, text: "{}", structured: { questions: [] } });
    expect(
      readStreamLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })),
    ).toEqual({ type: "result", ok: false, text: "", structured: null });
  });

  it("完整的助手消息：没开逐字流式时正文从这里拿", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "正文" }] },
    });
    expect(readStreamLine(line)).toEqual({ type: "message", text: "正文" });
  });

  it("没登录和用量到顶要说成人话", () => {
    expect(explainFailure("Invalid API key · Please run /login")).toContain("在终端里运行一次 claude");
    expect(explainFailure("Claude usage limit reached")).toContain("过一会儿再重试");
    expect(explainFailure("")).toContain("没有返回任何内容");
    expect(explainFailure("别的错")).toBe("别的错");
  });
});

describe("读库里的旧记录", () => {
  /** 复盘是长期留存的：JSON 坏了、字段少了，也得打得开，不能让整个视图白屏 */
  it("读不懂的 JSON 一律退回安全的空值", () => {
    const r = parseReview({
      id: 1,
      projectId: 7,
      title: "旧的",
      stage: "不认识",
      background: "{坏",
      snapshot: '{"projectName":"产线改造","summary":{"leafCount":3}}',
      questions: '[{"title":"题","options":["a","b"],"answer":{"picked":[0,"x"]}}, 5]',
      document: "",
      createdAt: 0,
      updatedAt: 0,
    });
    expect(r.stage).toBe("ask1");
    expect(r.background).toEqual({ kind: "final", goal: "", outcome: "", extra: "" });
    expect(r.snapshot.summary).toMatchObject({ leafCount: 3, blockedDays: 0 });
    expect(r.snapshot.blockers).toEqual([]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({ id: "q-0", round: 1, answer: { picked: [0], text: "", skipped: false } });
    expect(() => factsMarkdown(r.snapshot)).not.toThrow();
  });
});

describe("Markdown 块树", () => {
  it("模型会用到的写法都认得", () => {
    const tree = parseMarkdown(
      [
        "## 四、经验沉淀",
        "一段 **粗** 和 `码`。",
        "- [ ] 开工前确认 **长周期物料** 已下单",
        "- [x] 已做",
        "",
        "1. 一",
        "2. 二",
        "",
        "> 引用",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(tree.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "table"]);

    const [, para, tasks, ordered] = tree;
    if (para.type !== "paragraph" || tasks.type !== "list" || ordered.type !== "list") throw new Error("形状不对");
    expect(para.inlines).toEqual([
      { text: "一段 " },
      { text: "粗", bold: true },
      { text: " 和 " },
      { text: "码", code: true },
      { text: "。" },
    ]);
    expect(tasks.items.map((i) => i.checked)).toEqual([false, true]);
    // 勾选框不重复出现在文字里
    const first = tasks.items[0].blocks[0];
    expect(first.type === "paragraph" && plainText(first.inlines)).toBe("开工前确认 长周期物料 已下单");
    expect(ordered).toMatchObject({ ordered: true, start: 1 });
    expect(ordered.items[0].checked).toBe(null);
  });

  it("认不得的东西当文字留下，不丢内容；实体要解开", () => {
    const tree = parseMarkdown("<div>原样</div>\n\nA &amp; B");
    expect(JSON.stringify(tree)).toContain("原样");
    const last = tree[tree.length - 1];
    expect(last.type === "paragraph" && plainText(last.inlines)).toBe("A & B");
  });
});
