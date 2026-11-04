import { describe, expect, it } from "vitest";
import { computeTickLayers } from "./scale";
import { MAX_PX_PER_DAY, MIN_PX_PER_DAY, nearestPreset, parseZoom, Viewport, ZOOM_PRESETS } from "./viewport";

/** 下行（细节行）此刻主要显示哪个单位 */
const detailUnit = (pxPerDay: number) =>
  computeTickLayers(pxPerDay).reduce((a, b) => (b.detail > a.detail ? b : a)).unit;

describe("缩放档位", () => {
  // 按钮写的是「日」，画出来就得是一格一天 —— 这是用户看得见的契约
  it.each([
    ["day", "day"],
    ["week", "week"],
    ["month", "month"],
  ] as const)("「%s」档位的刻度行显示 %s", (preset, unit) => {
    expect(detailUnit(ZOOM_PRESETS[preset])).toBe(unit);
  });

  it("新建的 Viewport 默认是周 —— 所以恢复缩放这一步不能省", () => {
    expect(new Viewport().pxPerDay).toBe(ZOOM_PRESETS.week);
  });

  it("setZoom 直接落到目标值，不留动画", () => {
    const vp = new Viewport();
    vp.setZoom(ZOOM_PRESETS.day);
    expect(vp.pxPerDay).toBe(ZOOM_PRESETS.day);
    expect(vp.step(1 / 60)).toBe(false);
  });

  it("nearestPreset 按对数距离取最近的档", () => {
    expect(nearestPreset(ZOOM_PRESETS.day)).toBe("day");
    expect(nearestPreset(30)).toBe("day");
    expect(nearestPreset(14)).toBe("week");
    expect(nearestPreset(0.5)).toBe("year");
  });
});

describe("parseZoom：读存档的缩放", () => {
  it("正常数值原样返回", () => {
    expect(parseZoom("36")).toBe(36);
    expect(parseZoom("7.25")).toBe(7.25);
  });

  it("没存过、存坏了都返回 null，由调用方用默认值", () => {
    for (const raw of [null, undefined, "", "  ", "abc", "0", "-3", "NaN", "Infinity"]) {
      expect(parseZoom(raw)).toBeNull();
    }
  });

  it("超出范围就钳住，不丢掉用户的选择", () => {
    expect(parseZoom("9999")).toBe(MAX_PX_PER_DAY);
    expect(parseZoom("0.001")).toBe(MIN_PX_PER_DAY);
  });
});
