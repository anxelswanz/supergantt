/**
 * 实施逾期自动顺延（core/rollover.ts）。
 *
 * 和 blockers.test.ts 是同一类风险：**系统自己改用户的排期**。所以这里逐条
 * 钉死准入条件 —— 什么该推、什么一天也不许动 —— 以及幂等（同一天跑两次
 * 不能推两天）。
 *
 * 开关挂在任务行上（autoRollover），不是全局设置，所以它和另外三个条件
 * 一样是「准入条件」之一，一并在 isOverdue 里验收。
 */

import { describe, expect, it } from "vitest";
import { isOverdue, rolloverOverdue, type RolloverHost } from "./rollover";

const TODAY = 1000;

const host = (over: Partial<RolloverHost> = {}): RolloverHost => ({
  endDay: TODAY - 3,
  actualStartDay: TODAY - 10,
  progress: 0.4,
  autoRollover: true,
  ...over,
});

describe("isOverdue —— 该不该顺延这条任务", () => {
  it("开了开关、已开工、没干完、计划结束日已过 —— 是逾期", () => {
    expect(isOverdue(host(), TODAY)).toBe(true);
  });

  it("没开开关的不推 —— 默认就是关的", () => {
    // 这是它和全局开关的根本区别：同一条活开不开，是它自己的排期决定
    expect(isOverdue(host({ autoRollover: false }), TODAY)).toBe(false);
  });

  it("没开工（实施起始日为空）的不算逾期", () => {
    // 没开工的逾期是「还没排上」，不是「干超时」，推它只会掩盖真正的问题
    expect(isOverdue(host({ actualStartDay: null }), TODAY)).toBe(false);
  });

  it("已干完（进度 100%）的不算逾期", () => {
    expect(isOverdue(host({ progress: 1 }), TODAY)).toBe(false);
  });

  it("计划结束日正好是今天 —— 还没过，不推", () => {
    expect(isOverdue(host({ endDay: TODAY }), TODAY)).toBe(false);
  });

  it("计划结束日在未来 —— 不推", () => {
    expect(isOverdue(host({ endDay: TODAY + 5 }), TODAY)).toBe(false);
  });

  it("开关和另外三个条件是「与」的关系，缺一不可", () => {
    // 开了开关但没开工、或开了开关但已干完，都不该推
    expect(isOverdue(host({ autoRollover: true, actualStartDay: null }), TODAY)).toBe(false);
    expect(isOverdue(host({ autoRollover: true, progress: 1 }), TODAY)).toBe(false);
  });
});

describe("rolloverOverdue —— 跨天顺延", () => {
  it("把计划结束日推到今天", () => {
    expect(rolloverOverdue(host() as never, TODAY)).toEqual({ endDay: TODAY });
  });

  it("幂等：推到今天之后，同一天再跑返回 null", () => {
    // 每分钟一次的跨天检查会反复调它，不能推一次就写一次库
    const after = host({ endDay: TODAY });
    expect(rolloverOverdue(after as never, TODAY)).toBeNull();
  });

  it("没开开关时返回 null —— 调用方据此不产生写入", () => {
    expect(rolloverOverdue(host({ autoRollover: false }) as never, TODAY)).toBeNull();
  });

  it("不满足条件时返回 null —— 调用方据此不产生写入", () => {
    expect(rolloverOverdue(host({ actualStartDay: null }) as never, TODAY)).toBeNull();
    expect(rolloverOverdue(host({ progress: 1 }) as never, TODAY)).toBeNull();
    expect(rolloverOverdue(host({ endDay: TODAY + 1 }) as never, TODAY)).toBeNull();
  });

  it("只动计划结束日，不碰实施日期", () => {
    // 实施日期是「实际怎么干的」的事实记录，自动顺延没有理由改写它
    const patch = rolloverOverdue(host() as never, TODAY);
    expect(patch).not.toHaveProperty("actualEndDay");
    expect(patch).not.toHaveProperty("actualStartDay");
    expect(patch).not.toHaveProperty("startDay");
  });

  it("不写开关本身 —— 顺延是后果，不是把开关关掉", () => {
    // 偷偷把 autoRollover 改成 false 会让「明天还推不推」变得不可预测
    expect(rolloverOverdue(host() as never, TODAY)).not.toHaveProperty("autoRollover");
  });

  it("逾期多天时一次推到今天，而不是只推一天", () => {
    // 应用关了一周、或者刚打开这个开关，中间漏掉的跨天要一次补齐
    const patch = rolloverOverdue(host({ endDay: TODAY - 7 }) as never, TODAY);
    expect(patch).toEqual({ endDay: TODAY });
  });
});
