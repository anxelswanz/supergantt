import { describe, expect, it } from "vitest";
import { makeBarPainter, overlaps, variantOf, withAlpha } from "./coloring";
import { resolve, type Task } from "./model";

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `任务${id}`,
  startDay: 100,
  endDay: 104,
  progress: 0,
  priority: 2,
  personId: null,
  milestone: false,
  weight: null,
  collapsed: false,
  pinned: false,
  sortOrder: id,
  blocked: [],
  actualStartDay: null,
  actualEndDay: null,
  ...over,
});

/** 两个阶段各带两个子任务 */
const twoStages = () =>
  resolve([
    task(1),
    task(2, { parentId: 1, personId: 1 }),
    task(3, { parentId: 1, personId: 2 }),
    task(10),
    task(11, { parentId: 10, personId: 1 }),
    task(12, { parentId: 10, personId: null }),
  ]);

const PEOPLE = [
  { id: 1, name: "张三", color: "#4f46e5", avatar: null, sortOrder: 0 },
  { id: 2, name: "李四", color: "#059669", avatar: null, sortOrder: 1 },
];

const paint = (mode: Parameters<typeof makeBarPainter>[1]) => {
  const tasks = twoStages();
  const p = makeBarPainter(tasks, mode, false, "#6366f1", PEOPLE);
  return new Map(tasks.map((t) => [t.id, p(t)]));
};

/** 取色相，用来判断两个颜色是不是同一族 */
function hueOf(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return h * 360;
}

/** 色相之间的环形距离 */
const hueGap = (a: string, b: string) => {
  const raw = Math.abs(hueOf(a) - hueOf(b));
  return Math.min(raw, 360 - raw);
};

describe("按阶段着色", () => {
  it("阶段用基色，后代各自拿一个不同的变体 —— 每一行都不重样", () => {
    const c = paint("stage");
    const inStage = [c.get(1)!.fill, c.get(2)!.fill, c.get(3)!.fill];
    expect(new Set(inStage).size).toBe(3);
  });

  it("但后代仍留在阶段的色系里，一眼看得出是一族", () => {
    const c = paint("stage");
    expect(hueGap(c.get(1)!.fill, c.get(2)!.fill)).toBeLessThanOrEqual(30);
    expect(hueGap(c.get(1)!.fill, c.get(3)!.fill)).toBeLessThanOrEqual(30);
  });

  it("不同阶段的色系明显分开", () => {
    const c = paint("stage");
    expect(hueGap(c.get(1)!.fill, c.get(10)!.fill)).toBeGreaterThan(30);
  });
});

describe("同色系变体", () => {
  const BLUE = "#4f46e5";

  it("第 0 个变体就是基色本身", () => {
    expect(variantOf(BLUE, 0, false)).toBe(BLUE);
  });

  it("连续多个变体互不相同", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(variantOf(BLUE, i, false));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it("全部留在基色附近的色弧内，不跨出色系", () => {
    for (let i = 0; i < 30; i++) {
      expect(hueGap(BLUE, variantOf(BLUE, i, false))).toBeLessThanOrEqual(30);
    }
  });

  /**
   * 明度已经被进度占用（实心 vs 同色 18%）。变体的明度如果不设上下限，
   * 浅色子任务的实心段会和深色子任务的轨道段混淆。
   */
  it("明度钳在安全带内 —— 不会淡到轨道看不见，也不会暗到压过文字", () => {
    for (const isDark of [false, true]) {
      for (let i = 0; i < 30; i++) {
        const hex = variantOf(BLUE, i, isDark);
        const n = parseInt(hex.slice(1), 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
        const l = ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
        if (i === 0) continue; // 基色不受钳制
        expect(l).toBeGreaterThanOrEqual(isDark ? 50 : 30);
        expect(l).toBeLessThanOrEqual(isDark ? 82 : 62);
      }
    }
  });

  it("深色主题下的变体整体更亮，否则条子浮不出背景", () => {
    const lightness = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    };
    const light = Array.from({ length: 8 }, (_, i) => lightness(variantOf(BLUE, i + 1, false)));
    const dark = Array.from({ length: 8 }, (_, i) => lightness(variantOf(BLUE, i + 1, true)));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(dark)).toBeGreaterThan(avg(light));
  });

  it("同一个 index 永远给同一个颜色 —— 不随机", () => {
    expect(variantOf(BLUE, 5, false)).toBe(variantOf(BLUE, 5, false));
  });
});

describe("按负责人着色", () => {
  it("同一个人跨阶段也是同色", () => {
    const c = paint("assignee");
    // 任务 2 和 11 都是张三，但分属两个阶段
    expect(c.get(2)!.fill).toBe(c.get(11)!.fill);
  });

  it("不同的人不同色", () => {
    const c = paint("assignee");
    expect(c.get(2)!.fill).not.toBe(c.get(3)!.fill);
  });

  it("用的是这个人自己的颜色，和头像底色一致", () => {
    const c = paint("assignee");
    expect(c.get(2)!.fill).toBe("#4f46e5"); // 张三
    expect(c.get(3)!.fill).toBe("#059669"); // 李四
  });

  it("没指派走中性色，不占用调色板", () => {
    const c = paint("assignee");
    expect(c.get(12)!.fill).not.toBe(c.get(2)!.fill);
    expect(c.get(12)!.fill).not.toBe(c.get(3)!.fill);
  });
});

describe("按紧急度着色", () => {
  it("是固定映射，不受项目里出现顺序影响", () => {
    // 只有 P2 和 P1 的项目里，P1 也不该拿到「第一个」颜色
    const a = makeBarPainter(
      resolve([task(1, { priority: 2 }), task(2, { priority: 1 })]),
      "priority",
      false,
      "#6366f1",
    );
    const b = makeBarPainter(
      resolve([task(1, { priority: 1 }), task(2, { priority: 2 })]),
      "priority",
      false,
      "#6366f1",
    );
    expect(a(resolve([task(1, { priority: 1 })])[0]).fill).toBe(
      b(resolve([task(1, { priority: 1 })])[0]).fill,
    );
  });
});

describe("单色模式", () => {
  it("全部用项目强调色", () => {
    const c = paint("none");
    expect(c.get(1)!.fill).toBe("#6366f1");
    expect(c.get(11)!.fill).toBe("#6366f1");
  });
});

describe("色相分配的稳定性", () => {
  it("按出现顺序取色，不按 id 哈希 —— 换 id 不换颜色", () => {
    const low = resolve([task(1), task(2, { parentId: 1 })]);
    const high = resolve([task(500), task(501, { parentId: 500 })]);
    const pl = makeBarPainter(low, "stage", false, "#000000");
    const ph = makeBarPainter(high, "stage", false, "#000000");
    expect(pl(low[0]).fill).toBe(ph(high[0]).fill);
  });

  it("超过调色板长度后循环，不会取到 undefined", () => {
    const many = resolve(Array.from({ length: 20 }, (_, i) => task(i + 1)));
    const p = makeBarPainter(many, "stage", false, "#000000");
    for (const t of many) expect(p(t).fill).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("进度与色相分走不同通道", () => {
  it("轨道是同色低透明度，填充是同色实心", () => {
    const c = paint("stage").get(2)!;
    expect(c.fill).toMatch(/^#/);
    expect(c.track).toMatch(/^rgba\(/);
    // 两者同源，所以轨道里必然含有填充色的 RGB 分量
    const rgb = c.track.match(/\d+/g)!.slice(0, 3).map(Number);
    const hex = parseInt(c.fill.slice(1), 16);
    expect(rgb).toEqual([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]);
  });

  it("条内文字颜色按填充色亮度自动反转", () => {
    // 亮色填充配深色字，暗色填充配白字
    expect(makeBarPainter(resolve([task(1)]), "none", false, "#fbbf24")(resolve([task(1)])[0]).onFill)
      .toBe("#0f172a");
    expect(makeBarPainter(resolve([task(1)]), "none", false, "#4f46e5")(resolve([task(1)])[0]).onFill)
      .toBe("#ffffff");
  });
});

describe("时间重叠判定", () => {
  const t = (s: number, e: number) => resolve([task(1, { startDay: s, endDay: e })])[0];

  it("区间相交算重叠，含端点相接", () => {
    expect(overlaps(t(100, 110), t(105, 120))).toBe(true);
    expect(overlaps(t(100, 110), t(110, 120))).toBe(true);
    expect(overlaps(t(100, 110), t(111, 120))).toBe(false);
  });

  it("包含关系也算重叠", () => {
    expect(overlaps(t(100, 200), t(120, 130))).toBe(true);
  });
});

describe("withAlpha", () => {
  it("十六进制转 rgba", () => {
    expect(withAlpha("#ff8000", 0.5)).toBe("rgba(255, 128, 0, 0.5)");
  });
});
