/**
 * 日报插件。
 *
 * 把某一天在事项里记下的「问题」和「风险」整理成一段可以直接贴出去的文字：
 *
 *     问题
 *     1. ……
 *     2. ……
 *
 *     风险
 *     1. ……
 *
 * 数据来自宿主的 api.data.items（API 1.1）—— 和事项页同一个合并层，
 * 所以这里看到的就是事项页里那些。
 *
 * 单文件、无 import：宿主从 Blob URL 加载插件，没有模块解析（见 registry.ts
 * 的 assertSelfContained）。React 用宿主给的 api.react —— 和宿主是同一个实例，
 * hooks 才能用。
 */

/* ------------------------------------------------------------------ */
/* 生成日报 —— 纯函数，单测直接 import 它                               */
/* ------------------------------------------------------------------ */

const RISK_LEVELS = ["高", "中", "低"];

/**
 * @param items  api.data.items.list() 的结果
 * @param date   "YYYY-MM-DD"
 * @param opts   withTask：每条后面带上关联任务和负责人
 *               carryOver：之前记的、到这天还没关的也算进来
 */
export function buildReport(items, date, opts = {}) {
  const { withTask = true, carryOver = false, title = "日报" } = opts;

  const inScope = (it) => it.day === date || (carryOver && !it.closed && it.day < date);
  // 未关闭在前，其余按优先级（没填的排最后）—— 读日报的人先看还悬着的、急的
  const order = (a, b) =>
    Number(a.closed) - Number(b.closed) || (a.priority ?? 9) - (b.priority ?? 9);

  const issues = items.filter((it) => it.kind === "issue" && inScope(it)).sort(order);
  const risks = items.filter((it) => it.kind === "risk" && inScope(it)).sort(order);

  const line = (it, i) => {
    let text = `${i + 1}. ${it.title || "（没写内容）"}`;
    const tags = [];
    if (it.riskLevel != null) tags.push(`${RISK_LEVELS[it.riskLevel] ?? "中"}风险`);
    if (withTask && it.taskName) tags.push(`任务：${it.taskName}`);
    if (withTask && it.personName) tags.push(`负责人：${it.personName}`);
    if (carryOver && it.day < date) tags.push(`${it.day.slice(5)} 记录`);
    if (tags.length) text += `（${tags.join("，")}）`;
    if (it.closed) text += it.resolution ? ` —— 已解决：${it.resolution}` : " —— 已关闭";
    return text;
  };

  const section = (name, list) =>
    [name, ...(list.length ? list.map(line) : ["1. 无"])].join("\n");

  return [`${title} ${date}`, "", section("问题", issues), "", section("风险", risks)].join("\n");
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 复制到剪贴板。clipboard API 不可用时退回选中 + execCommand */
async function copyText(text, textarea) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!textarea) return false;
    textarea.select();
    return document.execCommand("copy");
  }
}

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useRef, useState } = React;

  api.settings.field({
    key: "title",
    kind: "text",
    label: "日报标题",
    desc: "生成的第一行，后面自动接日期",
    def: "日报",
  });
  api.settings.field({
    key: "withTask",
    kind: "toggle",
    label: "每条带上关联任务和负责人",
    desc: "关掉之后每条只有一句话，适合贴进群里",
    def: true,
  });
  api.settings.field({
    key: "carryOver",
    kind: "toggle",
    label: "包含之前记的、还没关闭的",
    desc: "打开后，前几天记下但到今天仍未解决的问题和风险也会列进来",
    def: false,
  });

  function ReportView() {
    const [date, setDate] = useState(todayIso);
    const [version, setVersion] = useState(0);
    const [text, setText] = useState("");
    const [copied, setCopied] = useState(false);
    const box = useRef(null);

    // 事项、风险变了就重新生成 —— 在事项页记完一条，切过来就在里面
    useEffect(() => api.data.items.subscribe(() => setVersion((v) => v + 1)), []);

    const generate = () =>
      setText(
        buildReport(api.data.items.list(), date, {
          title: api.settings.get("title") || "日报",
          withTask: api.settings.getBool("withTask"),
          carryOver: api.settings.getBool("carryOver"),
        }),
      );
    useEffect(generate, [date, version]);

    const copy = async () => {
      if (await copyText(text, box.current)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    };

    return h(
      "div",
      { className: "dr-root" },
      h(
        "div",
        { className: "dr-bar" },
        h("span", { className: "dr-title" }, "日报"),
        h("input", {
          type: "date",
          className: "dr-date",
          value: date,
          onChange: (e) => e.target.value && setDate(e.target.value),
        }),
        date !== todayIso() &&
          h("button", { className: "dr-btn", onClick: () => setDate(todayIso()) }, "回到今天"),
        h(
          "button",
          { className: "dr-btn", onClick: generate, title: "丢掉手改的内容，按当前数据重新生成" },
          "重新生成",
        ),
        h(
          "button",
          { className: "dr-btn dr-primary", onClick: () => void copy() },
          copied ? "✓ 已复制" : "复制",
        ),
      ),
      h(
        "p",
        { className: "dr-hint" },
        "取这一天在事项里记下的「问题」和「风险」。下面的文字可以直接改，改完再复制。",
      ),
      h("textarea", {
        ref: box,
        className: "dr-text",
        value: text,
        spellCheck: false,
        onChange: (e) => setText(e.target.value),
      }),
    );
  }

  api.views.register(
    { type: "daily-report.view", label: "日报", hint: "今天记了哪些问题和风险 —— 一键整理成日报" },
    ReportView,
  );
}
