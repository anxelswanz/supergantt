/**
 * 时间线导出 → 一份自包含的 HTML 文件。
 *
 * 为什么时间线要单独一个出口，而不是塞进那张 Excel：
 * Excel 那份是按**任务**排的（一行一件活，右边一条甘特条），发出去是给人
 * 核排期的。时间线问的是另一个问题 ——「那几天到底发生了什么」——
 * 它的正文是一段段人写的话，长短不一、还带层级，塞进单元格只会被截断，
 * 读的人得挨个点开格子。HTML 天生就排这种东西。
 *
 * 三条约束：
 *
 *  1. **单文件、零外部请求**。样式和脚本全内联，不引字体、不引图标。
 *     导出件的去处是微信、邮件附件、共享盘 —— 那些地方没有网，也没有
 *     和它一起被复制的 assets 目录。少一个依赖就少一种「在我这打不开」。
 *  2. **没有 JS 也是一份完整的文件**。筛选和正/倒序是脚本加的，但默认
 *     状态就是全部展开、按天倒序 —— 脚本没跑起来时读到的内容不缺一条。
 *  3. **只呈现，不重算**。事件聚合走 core/timeline 的 buildTimeline，
 *     和屏幕上看到的是同一份结果；这里再实现一遍迟早会和界面对不上。
 */

import { blockedDays } from "../core/blocked";
import { buildTimeline, type TimelineDay, type TimelineEvent } from "../core/timeline";
import type { DailyNote, Person, Risk } from "../db/api";
import { dayToDate, dayToIso, today } from "../gantt/time";
import { projectSpan, type ResolvedTask } from "../gantt/model";

export interface TimelineHtmlInput {
  projectName: string;
  /** 项目色，做通篇的 accent */
  projectColor: string;
  /** 已经 resolve 过、且**全部展开**的任务 */
  tasks: ResolvedTask[];
  notes: DailyNote[];
  risks: Risk[];
  people: Person[];
  exportedAt: Date;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 和屏幕上的 KIND_STYLE 保持一致 —— 换了颜色的导出件读起来像另一个软件 */
const KINDS: { key: TimelineEvent["kind"]; label: string; color: string }[] = [
  { key: "start", label: "开工", color: "#6366f1" },
  { key: "finish", label: "完成", color: "#10b981" },
  { key: "blocked", label: "受阻", color: "#f43f5e" },
  { key: "risk", label: "风险", color: "#f59e0b" },
  { key: "note", label: "记录", color: "#64748b" },
];

const KIND_MAP = new Map(KINDS.map((k) => [k.key, k]));

const RISK_LEVELS = ["高", "中", "低"];

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function buildTimelineHtml(input: TimelineHtmlInput): string {
  const { projectName, projectColor, tasks, notes, risks, people, exportedAt } = input;

  const days = buildTimeline(tasks, notes, risks);
  const personOf = new Map(people.map((p) => [p.id, p]));
  const title = `${projectName || "项目"} · 时间线`;

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${styles(projectColor)}</style>`,
    "</head>",
    "<body>",
    '<div class="page">',
    header(projectName, exportedAt, days),
    summary(tasks, days, risks),
    spanBar(tasks),
    heatmap(days),
    filters(days),
    timeline(days, personOf),
    footer(exportedAt),
    "</div>",
    `<script>${script()}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** 导出件的文件名。和 Excel 那份同一套命名，只是换个后缀 */
export function timelineFileName(projectName: string, at: Date): string {
  const stem = (projectName || "项目").replace(/[\\/:*?"<>|]/g, " ").trim() || "项目";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${stem.slice(0, 60)}-时间线-${stamp}.html`;
}

/* ------------------------------------------------------------------ */
/* 各段                                                                */
/* ------------------------------------------------------------------ */

function header(projectName: string, exportedAt: Date, days: TimelineDay[]): string {
  const range =
    days.length > 0
      ? `${dayToIso(days[days.length - 1].day)} ～ ${dayToIso(days[0].day)}`
      : "还没有任何记录";

  return `<header class="head">
  <div class="head-title"><span class="dot"></span><h1>${esc(projectName || "未命名项目")}</h1></div>
  <p class="head-sub">逐日流水 · ${esc(range)}</p>
  <p class="head-meta">导出于 ${esc(formatDateTime(exportedAt))}</p>
</header>`;
}

/**
 * 摘要。
 *
 * 挑的这几个数都能直接进汇报：干了多少天、开了几件完了几件、卡了多久、
 * 还有多少风险没关。「记录条数」单独列出来是给写记录的人看的 ——
 * 一段时间下来一条没写，时间线本身就不可信。
 */
function summary(tasks: ResolvedTask[], days: TimelineDay[], risks: Risk[]): string {
  const counts = new Map<TimelineEvent["kind"], number>();
  for (const d of days) {
    for (const e of d.events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }

  const leaves = tasks.filter((t) => !t.hasChildren);
  const done = leaves.filter((t) => t.progress >= 1).length;
  // 去重后的受阻天数：同一天被两条记录同时覆盖，只能算一天
  const stuck = blockedDays(leaves.flatMap((t) => t.blocked));
  const openRisks = risks.filter((r) => !r.resolved).length;

  const cards = [
    { value: String(days.length), label: "有记录的天数" },
    { value: `${done} / ${leaves.length}`, label: "已完成任务" },
    { value: String(counts.get("start") ?? 0), label: "开工次数" },
    { value: String(stuck), label: "受阻天数", tone: stuck > 0 ? "warn" : "" },
    { value: `${openRisks} / ${risks.length}`, label: "未关闭风险", tone: openRisks > 0 ? "warn" : "" },
    { value: String(counts.get("note") ?? 0), label: "当日记录" },
  ];

  return `<section class="cards">${cards
    .map(
      (c) =>
        `<div class="card${c.tone ? ` ${c.tone}` : ""}"><div class="card-v">${esc(
          c.value,
        )}</div><div class="card-l">${esc(c.label)}</div></div>`,
    )
    .join("")}</section>`;
}

/**
 * 项目周期条：计划从哪天到哪天，今天走到了哪。
 *
 * 时间线是一串局部的日子，读的人很容易失去「这在整个项目的什么位置」的感觉 ——
 * 这一条就是那个坐标尺。
 */
function spanBar(tasks: ResolvedTask[]): string {
  if (tasks.length === 0) return "";

  const [start, end] = projectSpan(tasks);
  const total = Math.max(1, end - start + 1);
  const now = today();
  const elapsed = clamp01((now - start + 1) / total);

  // 今天落在项目区间外时不画游标：硬钉在 0% 或 100% 会被读成「刚开始 / 正好结束」
  const inRange = now >= start && now <= end;

  return `<section class="span">
  <div class="span-head"><span>${esc(dayToIso(start))}</span><span class="span-total">计划跨度 ${total} 天</span><span>${esc(
    dayToIso(end),
  )}</span></div>
  <div class="span-bar">
    <div class="span-fill" style="width:${(elapsed * 100).toFixed(2)}%"></div>
    ${inRange ? `<div class="span-now" style="left:${(elapsed * 100).toFixed(2)}%"><span>今天</span></div>` : ""}
  </div>
</section>`;
}

/**
 * 活动热力图：一列一周，一格一天，颜色深浅是那天的事件条数。
 *
 * 它回答的是时间线本身答不了的问题 ——「哪几段时间根本没动静」。
 * 逐日往下翻只看得到有记录的日子，空白是看不见的；这张图里空白是主角。
 */
function heatmap(days: TimelineDay[]): string {
  if (days.length === 0) return "";

  const byDay = new Map(days.map((d) => [d.day, d.events.length]));
  const last = days[0].day;
  const first = days[days.length - 1].day;

  // 对齐到周日开头、周六结尾，格子才排得成整齐的 7 行
  const from = first - dayToDate(first).getUTCDay();
  const to = last + (6 - dayToDate(last).getUTCDay());
  const weeks = Math.round((to - from + 1) / 7);

  const max = Math.max(...byDay.values());
  const cells: string[] = [];
  const labels: string[] = [];
  let lastMonth = -1;

  for (let w = 0; w < weeks; w++) {
    const colFirst = from + w * 7;
    const month = dayToDate(colFirst).getUTCMonth();
    // 每月的第一列打一个标签。同月只打一次，否则标签会连成一条糊掉的带子
    if (month !== lastMonth) {
      labels.push(`<span class="hm-label" style="grid-column:${w + 1}">${month + 1}月</span>`);
      lastMonth = month;
    }
    for (let r = 0; r < 7; r++) {
      const day = colFirst + r;
      const n = byDay.get(day) ?? 0;
      const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
      const iso = dayToIso(day);
      const inRange = day >= first && day <= last;
      cells.push(
        `<i class="hm-c l${level}${inRange ? "" : " out"}" style="grid-row:${r + 1};grid-column:${
          w + 1
        }" title="${esc(iso)} ${esc(WEEKDAYS[dayToDate(day).getUTCDay()])} · ${n} 条"></i>`,
      );
    }
  }

  return `<section class="heat">
  <div class="heat-scroll">
    <div class="hm-labels" style="grid-template-columns:repeat(${weeks},12px)">${labels.join("")}</div>
    <div class="hm" style="grid-template-columns:repeat(${weeks},12px)">${cells.join("")}</div>
  </div>
  <div class="heat-legend"><span>少</span><i class="hm-c l0"></i><i class="hm-c l1"></i><i class="hm-c l2"></i><i class="hm-c l3"></i><i class="hm-c l4"></i><span>多</span></div>
</section>`;
}

/**
 * 筛选条。
 *
 * 只列**这份文件里真的出现过**的类型 —— 摆一个点了之后什么都不会发生的
 * 「受阻」按钮，比没有这个按钮更让人困惑。
 */
function filters(days: TimelineDay[]): string {
  const present = new Set<TimelineEvent["kind"]>();
  for (const d of days) for (const e of d.events) present.add(e.kind);
  if (present.size === 0) return "";

  const buttons = KINDS.filter((k) => present.has(k.key)).map(
    (k) =>
      `<button class="chip on" data-kind="${k.key}"><i style="background:${k.color}"></i>${esc(
        k.label,
      )}</button>`,
  );

  return `<nav class="bar" hidden>
  <div class="chips">${buttons.join("")}</div>
  <button class="chip order" data-order="desc">↓ 最近在前</button>
</nav>`;
}

function timeline(days: TimelineDay[], personOf: Map<number, Person>): string {
  if (days.length === 0) {
    return `<main class="tl"><p class="empty">这个项目还没有任何记录。<br>在时间线里「记一笔」，或者在甘特图上右键某一天。</p></main>`;
  }

  const todayDay = today();

  const groups = days.map((d) => {
    const date = dayToDate(d.day);
    const isToday = d.day === todayDay;
    const events = d.events.map((e) => eventRow(e, personOf)).join("");

    return `<section class="day${isToday ? " today" : ""}" data-day="${d.day}">
  <div class="day-when">
    <div class="day-md">${esc(d.iso.slice(5))}${isToday ? " · 今天" : ""}</div>
    <div class="day-wd">${esc(WEEKDAYS[date.getUTCDay()])} · ${esc(d.iso.slice(0, 4))}</div>
  </div>
  <div class="day-events">${events}</div>
</section>`;
  });

  return `<main class="tl">${groups.join("\n")}</main>`;
}

function eventRow(e: TimelineEvent, personOf: Map<number, Person>): string {
  const kind = KIND_MAP.get(e.kind)!;
  const person = e.task?.personId != null ? personOf.get(e.task.personId) : undefined;

  const tags: string[] = [];
  if (e.days != null && e.days > 1) tags.push(`<span class="tag stuck">共 ${e.days} 天</span>`);
  // 还没关掉的阻碍：导出件是发出去给人看的，一个还在走的数必须标明白，
  // 否则收件人会把它当成最终结果
  if (e.unresolved) tags.push(`<span class="tag live">未关闭</span>`);
  if (e.level != null) {
    tags.push(`<span class="tag risk-l${e.level}">${esc(RISK_LEVELS[e.level] ?? "中")}风险</span>`);
  }
  // 事后补记要看得见：当时的判断和事后的追认，在复盘里分量不一样
  if (e.backdated) tags.push(`<span class="tag dim" title="写下的日子晚于它所说的日子">事后补记</span>`);

  const who = person
    ? `<span class="who"><i style="background:${esc(person.color)}"></i>${esc(person.name)}</span>`
    : "";

  // 开工 / 完成没有正文，标题行已经把话说完了
  const body =
    e.kind === "start" || e.kind === "finish"
      ? ""
      : `<div class="ev-body">${esc(e.text)}</div>`;

  return `<article class="ev" data-kind="${e.kind}">
  <span class="ev-dot" style="background:${kind.color}"></span>
  <div class="ev-main">
    <div class="ev-head">
      <span class="ev-kind" style="color:${kind.color}">${esc(kind.label)}</span>
      <span class="ev-task">${esc(e.task ? e.task.name || "未命名" : "全项目")}</span>
      ${who}${tags.join("")}
    </div>
    ${body}
  </div>
</article>`;
}

function footer(exportedAt: Date): string {
  return `<footer class="foot">由 Gantt 导出 · ${esc(
    formatDateTime(exportedAt),
  )} · 这份文件不依赖网络，可直接转发</footer>`;
}

/* ------------------------------------------------------------------ */
/* 样式与脚本                                                          */
/* ------------------------------------------------------------------ */

function styles(accent: string): string {
  return `
:root{--accent:${cssColor(accent)};--bg:#f8fafc;--surface:#fff;--text:#0f172a;--dim:#64748b;--rule:#e2e8f0;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--surface:#111827;--text:#e5e7eb;--dim:#94a3b8;--rule:#1f2937;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:860px;margin:0 auto;padding:32px 20px 56px}
h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.01em}
.head{margin-bottom:20px}
.head-title{display:flex;align-items:center;gap:9px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--accent);flex:none}
.head-sub{margin:6px 0 0;color:var(--dim);font-size:13px}
.head-meta{margin:2px 0 0;color:var(--dim);font-size:11px}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:10px 12px}
.card-v{font-size:19px;font-weight:650;letter-spacing:-.02em}
.card-l{margin-top:1px;color:var(--dim);font-size:11px}
.card.warn .card-v{color:var(--warn)}

.span{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:12px 14px;margin-bottom:16px}
.span-head{display:flex;justify-content:space-between;color:var(--dim);font-size:11px;margin-bottom:7px}
.span-total{font-weight:600}
.span-bar{position:relative;height:8px;border-radius:99px;background:var(--rule)}
.span-fill{height:100%;border-radius:99px;background:var(--accent);opacity:.75}
.span-now{position:absolute;top:-4px;width:2px;height:16px;background:#f43f5e}
.span-now span{position:absolute;top:18px;left:50%;transform:translateX(-50%);color:#f43f5e;font-size:10px;white-space:nowrap}

.heat{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:12px 14px 10px;margin-bottom:16px}
.heat-scroll{overflow-x:auto;padding:0 28px 2px 0}
.hm,.hm-labels{display:grid;gap:2px}
.hm-labels{margin-bottom:3px;height:12px}
.hm-label{color:var(--dim);font-size:10px;white-space:nowrap;pointer-events:none}
.hm{grid-template-rows:repeat(7,12px)}
.hm-c{width:12px;height:12px;border-radius:3px;background:var(--rule);display:inline-block}
.hm-c.out{opacity:.35}
.hm-c.l1{background:color-mix(in srgb,var(--accent) 30%,var(--rule))}
.hm-c.l2{background:color-mix(in srgb,var(--accent) 55%,var(--rule))}
.hm-c.l3{background:color-mix(in srgb,var(--accent) 78%,var(--rule))}
.hm-c.l4{background:var(--accent)}
.heat-legend{display:flex;align-items:center;gap:3px;justify-content:flex-end;margin-top:7px;color:var(--dim);font-size:10px}

.bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--rule);background:var(--surface);color:var(--dim);border-radius:99px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer}
.chip i{width:7px;height:7px;border-radius:50%;display:inline-block}
.chip.on{color:var(--text);border-color:color-mix(in srgb,var(--accent) 45%,var(--rule))}
.chip:not(.on){opacity:.5}
.chip.order{margin-left:auto;opacity:1}

.tl{display:flex;flex-direction:column;gap:18px}
.tl.asc{flex-direction:column-reverse}
.day{display:flex;gap:14px}
.day-when{width:96px;flex:none;text-align:right;padding-top:1px}
.day-md{font-size:12px;font-weight:650}
.day.today .day-md{color:var(--accent)}
.day-wd{color:var(--dim);font-size:10px}
.day-events{flex:1;min-width:0;border-left:1px solid var(--rule);padding-left:16px}
.ev{position:relative;display:flex;gap:8px;padding:3px 0}
.ev-dot{position:absolute;left:-20px;top:9px;width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 2px var(--bg)}
.ev-main{min-width:0;flex:1}
.ev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.ev-kind{font-size:10px;font-weight:600}
.ev-task{font-size:13px;font-weight:550}
.who{display:inline-flex;align-items:center;gap:4px;color:var(--dim);font-size:11px}
.who i{width:7px;height:7px;border-radius:50%;display:inline-block}
.tag{font-size:10px;color:var(--dim)}
.tag.stuck{color:#f43f5e}
.tag.live{background:#f43f5e;color:#fff;border-radius:3px;padding:0 3px;font-weight:600}
.tag.risk-l0{color:#ef4444}
.tag.risk-l1{color:#f59e0b}
.tag.risk-l2{color:var(--dim)}
.ev-body{color:var(--dim);font-size:12.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{border:1px dashed var(--rule);border-radius:12px;padding:36px;text-align:center;color:var(--dim);font-size:13px}

.foot{margin-top:28px;padding-top:12px;border-top:1px solid var(--rule);color:var(--dim);font-size:10px;text-align:center}

@media print{
  body{background:#fff}
  .bar{display:none}
  .day{break-inside:avoid}
}
@media (max-width:560px){
  .day{flex-direction:column;gap:4px}
  .day-when{width:auto;text-align:left;display:flex;align-items:baseline;gap:8px}
}`;
}

/**
 * 内联脚本：按类型筛选 + 正/倒序。
 *
 * 筛选条在 HTML 里是 `hidden` 的，由脚本自己解除 —— 脚本没跑起来时，
 * 页面上不会留下一排点了没反应的按钮。
 */
function script(): string {
  return `
(function(){
  var bar=document.querySelector('.bar');
  if(!bar)return;
  bar.hidden=false;
  var tl=document.querySelector('.tl');
  var off={};

  function apply(){
    document.querySelectorAll('.day').forEach(function(day){
      var shown=0;
      day.querySelectorAll('.ev').forEach(function(ev){
        var hide=!!off[ev.dataset.kind];
        ev.style.display=hide?'none':'';
        if(!hide)shown++;
      });
      // 一整天的事件都被筛掉了就连日期一起收起来，否则会剩下一串空日子
      day.style.display=shown?'':'none';
    });
  }

  bar.querySelectorAll('[data-kind]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var k=btn.dataset.kind;
      off[k]=!off[k];
      btn.classList.toggle('on',!off[k]);
      apply();
    });
  });

  var order=bar.querySelector('.order');
  order.addEventListener('click',function(){
    var asc=tl.classList.toggle('asc');
    order.dataset.order=asc?'asc':'desc';
    order.textContent=asc?'↑ 最早在前':'↓ 最近在前';
  });
})();`;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/**
 * HTML 转义。
 *
 * 记录正文是用户手写的自由文本，里面出现 `<` 和 `&` 是常事
 * （「压力 < 0.3MPa」「A&B 供应商」）—— 不转义的话，轻则内容凭空消失，
 * 重则整份文件从那一行起排版全乱。
 */
export function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 项目色进的是 CSS 值的位置，只放行十六进制；别的一律回退 */
function cssColor(value: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : "#6366f1";
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}
