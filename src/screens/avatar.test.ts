import { describe, expect, it } from "vitest";
import { initialsOf } from "./Avatar";

/**
 * 头像缩写。中文名取「首字母」是没有意义的 ——
 * 「张三」的首字母是 Z，读者认不出来。
 */
describe("姓名缩写", () => {
  it("两字中文名整体显示", () => {
    expect(initialsOf("张三")).toBe("张三");
  });

  it("三字以上取后两位（后面是名，辨识度更高）", () => {
    expect(initialsOf("欧阳修")).toBe("阳修");
    expect(initialsOf("司马相如")).toBe("相如");
  });

  it("单字名原样显示", () => {
    expect(initialsOf("王")).toBe("王");
  });

  it("西文取前两个词的首字母并大写", () => {
    expect(initialsOf("ada lovelace")).toBe("AL");
    expect(initialsOf("Grace Brewster Murray Hopper")).toBe("GB");
    expect(initialsOf("Cher")).toBe("C");
  });

  it("空名字有兜底，不会渲染成空圆圈", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });

  it("前后空格不影响结果", () => {
    expect(initialsOf("  张三  ")).toBe("张三");
  });
});
