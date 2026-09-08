/**
 * 时间线导出件的结构测试。
 *
 * 断言的同样是**收件人打开文件后能看到什么**：那天在不在、正文有没有被
 * HTML 吃掉、顺序是不是最近在前、有没有偷偷引一个打不开的外部资源。
 * 这几条错一条，导出件就是错的，而错法都很安静 —— 尤其是转义：
 * 一句「压力 < 0.3MPa」能让它后面的所有内容从页面上消失。
 */

import { describe, expect, it } from "vitest";
import { buildTimelineHtml, timelineFileName, type TimelineHtmlInput } from "./timelineHtml";
import { resolve, type Task } from "../gantt/model";
import { isoToDay } from "../gantt/time";
import type { DailyNote, Person, Risk } from "../db/api";

const AT = new Date(2026, 7, 9, 14, 30); // 2026-08-09 14:30 本地时间

function task(over: Partial<Task> & { id: number }): Task {
  return {
    parentId: null,
    name: `任务${over.id}`,
    startDay: isoToDay("2026-08-03"),
    endDay: isoToDay("2026-08-07"),
    actualStartDay: null,
    actualEndDay: null,
    progress: 0,
    priority: 2,
    personId: null,
    milestone: false,
    weight: null,
    collapsed: false,
    pinned: false,
    sortOrder: over.id,
    blocked: [],
    ...over,
  };
}

function note(over: Partial<DailyNote> & { id: number; day: string }): DailyNote {
  return {
    projectId: 1,
    taskId: null,
    content: "记录内容",
    createdAt: Math.floor(Date.parse(`${over.day}T09:00:00Z`) / 1000),
    updatedAt: Math.floor(Date.parse(`${over.day}T09:00:00Z`) / 1000),
    ...over,
  };
}

function input(over: Partial<TimelineHtmlInput> = {}): TimelineHtmlInput {
  return {
    projectName: "登月计划",
    projectColor: "#6366F1",
    tasks: over.tasks ?? resolve([task({ id: 1 })]),
    notes: [],
    risks: [],
    people: [],
    exportedAt: AT,
    ...over,
  };
}

describe("buildTimelineHtml", () => {
  it("是一份完整的 HTML 文档，标题带项目名", () => {
    const html = buildTimelineHtml(input());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>登月计划 · 时间线</title>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("每一条记录都落在它自己的日子里", () => {
    const html = buildTimelineHtml(
      input({
        notes: [
          note({ id: 1, day: "2026-08-05", content: "三号机主轴异响" }),
          note({ id: 2, day: "2026-08-07", content: "维修完成，恢复生产" }),
        ],
      }),
    );

    expect(html).toContain("三号机主轴异响");
    expect(html).toContain("维修完成，恢复生产");
    expect(html).toContain("08-05");
    expect(html).toContain("08-07");
    // 最近的一天在前 —— 时间线是用来回顾的
    expect(html.indexOf("维修完成")).toBeLessThan(html.indexOf("三号机主轴异响"));
  });

  it("正文里的尖括号和 & 被转义，不会吃掉后面的内容", () => {
    const html = buildTimelineHtml(
      input({
        notes: [note({ id: 1, day: "2026-08-05", content: "压力 < 0.3MPa & A>B <b>粗体</b>" })],
      }),
    );

    expect(html).toContain("压力 &lt; 0.3MPa &amp; A&gt;B &lt;b&gt;粗体&lt;/b&gt;");
    expect(html).not.toContain("<b>粗体</b>");
  });

  it("任务名同样转义，且未命名有兜底", () => {
    const tasks = resolve([task({ id: 1, name: "<img onerror=x>", actualStartDay: isoToDay("2026-08-03"), actualEndDay: isoToDay("2026-08-06") })]);
    const html = buildTimelineHtml(input({ tasks }));
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).not.toContain("<img onerror=x>");
  });

  it("开工、完成、受阻、风险各自成为一条事件", () => {
    const tasks = resolve([
      task({
        id: 1,
        actualStartDay: isoToDay("2026-08-03"),
        actualEndDay: isoToDay("2026-08-06"),
        progress: 1,
        blocked: [
          { id: "b1", from: isoToDay("2026-08-04"), to: isoToDay("2026-08-05"), reason: "material" },
        ],
      }),
    ]);
    const risks: Risk[] = [
      {
        id: 9,
        taskId: 1,
        content: "供应商交期不确定",
        level: 0,
        resolved: false,
        createdAt: Math.floor(Date.parse("2026-08-05T02:00:00Z") / 1000),
        resolvedAt: null,
        resolution: null,
      },
    ];

    const html = buildTimelineHtml(input({ tasks, risks }));

    expect(html).toContain('data-kind="start"');
    expect(html).toContain('data-kind="finish"');
    expect(html).toContain('data-kind="blocked"');
    expect(html).toContain('data-kind="risk"');
    expect(html).toContain("等料");
    expect(html).toContain("共 2 天");
    expect(html).toContain("高风险");
    expect(html).toContain("供应商交期不确定");
  });

  it("负责人显示名字和颜色", () => {
    const people: Person[] = [{ id: 3, name: "老王", color: "#22c55e", avatar: null, sortOrder: 0 }];
    const tasks = resolve([
      task({ id: 1, personId: 3, actualStartDay: isoToDay("2026-08-03"), actualEndDay: isoToDay("2026-08-06") }),
    ]);
    const html = buildTimelineHtml(input({ tasks, people }));
    expect(html).toContain("老王");
    expect(html).toContain("#22c55e");
  });

  it("摘要统计的是去重后的受阻天数", () => {
    const tasks = resolve([
      task({
        id: 1,
        blocked: [
          { id: "b1", from: isoToDay("2026-08-03"), to: isoToDay("2026-08-05"), reason: "material" },
          // 与上一段重叠：3 天 + 3 天，但只有 4 天真的没推进
          { id: "b2", from: isoToDay("2026-08-04"), to: isoToDay("2026-08-06"), reason: "quality" },
        ],
      }),
    ]);
    const html = buildTimelineHtml(input({ tasks }));
    expect(html).toMatch(/<div class="card-v">4<\/div><div class="card-l">受阻天数<\/div>/);
  });

  it("不引用任何外部资源 —— 收件人那边可能没有网", () => {
    const html = buildTimelineHtml(
      input({ notes: [note({ id: 1, day: "2026-08-05" })] }),
    );
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(script|link|img)[^>]*\ssrc=/);
    expect(html).not.toContain("<link");
  });

  it("项目色只放行十六进制，别的回退到默认色", () => {
    const html = buildTimelineHtml(input({ projectColor: "red; } body { display:none } .x{" }));
    // 注入串一个字符都不能进到 CSS 里
    expect(html).not.toContain("red; }");
    expect(html).toContain("--accent:#6366f1");
  });

  it("空项目也给得出一份说得清的文件", () => {
    const html = buildTimelineHtml(input({ tasks: [], notes: [], risks: [] }));
    expect(html).toContain("还没有任何记录");
    // 一个筛选按钮都不该出现：点了什么也不会发生的按钮比没有更让人困惑
    expect(html).not.toContain('data-kind="note"');
    expect(html).toContain("</html>");
  });

  it("筛选条只列出真的出现过的类型", () => {
    const html = buildTimelineHtml(
      input({ notes: [note({ id: 1, day: "2026-08-05" })] }),
    );
    expect(html).toContain('data-kind="note"');
    expect(html).not.toContain('<button class="chip on" data-kind="blocked">');
  });

  it("热力图按整周铺格子，每周 7 天", () => {
    const html = buildTimelineHtml(
      input({
        notes: [
          note({ id: 1, day: "2026-08-05" }), // 周三
          note({ id: 2, day: "2026-08-18" }), // 两周后的周二
        ],
      }),
    );
    const cells = html.match(/class="hm-c l\d(?: out)?"/g) ?? [];
    // 8/2（周日）～ 8/22（周六）= 3 周，外加图例里的 5 个格子
    expect(cells.length).toBe(3 * 7 + 5);
  });
});

describe("timelineFileName", () => {
  it("带项目名、日期和 .html 后缀", () => {
    expect(timelineFileName("登月计划", AT)).toBe("登月计划-时间线-2026-08-09.html");
  });

  it("剔掉路径里不能出现的字符", () => {
    expect(timelineFileName('A/B:C*D?"E<F>G|H', AT)).toBe("A B C D  E F G H-时间线-2026-08-09.html");
  });

  it("空名字有兜底", () => {
    expect(timelineFileName("   ", AT)).toBe("项目-时间线-2026-08-09.html");
  });
});
