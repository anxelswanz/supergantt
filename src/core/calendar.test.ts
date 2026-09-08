import { describe, expect, it } from "vitest";
import { WorkCalendar } from "./calendar";
import { isoToDay } from "../gantt/time";

const d = isoToDay;
// 2026-08-03 是周一
const MON = d("2026-08-03");

describe("默认日历", () => {
  it("周一到周五干活，周末不干", () => {
    const cal = WorkCalendar.default();
    expect(cal.isWorkday(MON)).toBe(true);
    expect(cal.isWorkday(d("2026-08-07"))).toBe(true); // 周五
    expect(cal.isWorkday(d("2026-08-08"))).toBe(false); // 周六
    expect(cal.isWorkday(d("2026-08-09"))).toBe(false); // 周日
  });
});

describe("自然日与工作日的区分", () => {
  it("跨一个周末：7 个自然日只有 5 个工作日", () => {
    const cal = WorkCalendar.default();
    const from = MON;
    const to = d("2026-08-09"); // 下周日
    expect(cal.countCalendarDays(from, to)).toBe(7);
    expect(cal.countWorkdays(from, to)).toBe(5);
  });

  it("节假日从工作日里扣掉，但不改变自然日跨度", () => {
    const cal = new WorkCalendar([1, 2, 3, 4, 5], [d("2026-08-05")]); // 周三放假
    expect(cal.countCalendarDays(MON, d("2026-08-07"))).toBe(5);
    expect(cal.countWorkdays(MON, d("2026-08-07"))).toBe(4);
  });

  it("单日区间至少算 1 个自然日", () => {
    const cal = WorkCalendar.default();
    expect(cal.countCalendarDays(MON, MON)).toBe(1);
  });
});

describe("周末与节假日是两回事", () => {
  it("节假日落在工作日上：isWeekend 为假但 isRest 为真", () => {
    const cal = new WorkCalendar([1, 2, 3, 4, 5], [d("2026-08-05")]);
    const wed = d("2026-08-05");
    expect(cal.isWeekend(wed)).toBe(false); // 按星期算是工作日
    expect(cal.isHoliday(wed)).toBe(true);
    expect(cal.isRest(wed)).toBe(true); // 但实际不干活
  });

  it("调休：把周六设成工作日", () => {
    const cal = new WorkCalendar([1, 2, 3, 4, 5, 6], []);
    expect(cal.isWorkday(d("2026-08-08"))).toBe(true); // 周六上班
    expect(cal.countWorkdays(MON, d("2026-08-09"))).toBe(6);
  });
});

describe("吸附到工作日", () => {
  it("周六推到下周一", () => {
    const cal = WorkCalendar.default();
    expect(cal.snapForward(d("2026-08-08"))).toBe(d("2026-08-10"));
  });

  it("已经是工作日就原地不动", () => {
    expect(WorkCalendar.default().snapForward(MON)).toBe(MON);
  });

  it("连续假期会跳过整段", () => {
    const cal = new WorkCalendar(
      [1, 2, 3, 4, 5],
      [d("2026-08-10"), d("2026-08-11"), d("2026-08-12")],
    );
    expect(cal.snapForward(d("2026-08-08"))).toBe(d("2026-08-13"));
  });

  it("工作日配成空集时不会死循环", () => {
    const cal = new WorkCalendar([], []);
    expect(Number.isFinite(cal.snapForward(MON))).toBe(true);
  });
});

describe("与数据库的往返", () => {
  it("序列化后再解析得到等价日历", () => {
    const cal = new WorkCalendar([1, 2, 3, 4, 5, 6], [d("2026-10-01"), d("2026-10-02")]);
    const { workDays, holidays } = cal.toJson();
    const back = WorkCalendar.fromProject(workDays, holidays);

    expect([...back.workDays].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(back.isHoliday(d("2026-10-01"))).toBe(true);
    expect(back.isHoliday(d("2026-10-03"))).toBe(false);
  });

  it("节假日存成 ISO 字符串，库里能直接读懂", () => {
    const cal = new WorkCalendar([1], [d("2026-10-01")]);
    expect(JSON.parse(cal.toJson().holidays)).toEqual(["2026-10-01"]);
  });

  it("库里的值坏掉时退回默认，不让项目打不开", () => {
    for (const bad of ["", "не json", "{}", "[]", "[9,99]"]) {
      const cal = WorkCalendar.fromProject(bad, bad);
      expect(cal.workDays.size).toBe(5);
      expect(cal.holidays.size).toBe(0);
    }
  });
});

describe("增量修改", () => {
  it("切换节假日是幂等的开关", () => {
    let cal = WorkCalendar.default();
    cal = cal.withHolidayToggled(MON);
    expect(cal.isHoliday(MON)).toBe(true);
    cal = cal.withHolidayToggled(MON);
    expect(cal.isHoliday(MON)).toBe(false);
  });

  it("切换工作日不影响节假日", () => {
    const cal = new WorkCalendar([1, 2, 3, 4, 5], [d("2026-10-01")]);
    const next = cal.withWorkDayToggled(6);
    expect(next.workDays.has(6)).toBe(true);
    expect(next.isHoliday(d("2026-10-01"))).toBe(true);
  });
});
