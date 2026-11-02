import { describe, expect, it } from "vitest";
import { explainFailure, readStreamLine } from "./claude";

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
