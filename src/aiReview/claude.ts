/**
 * 问 Claude 一次。上半把 `claude --output-format stream-json` 的输出读成事件，
 * 下半接到进程上；起参数由 src-tauri/src/ai_review.rs 决定。
 */

import { api } from "../db/api";
import { attachRun, ensureProcListener } from "../db/proc";

/* ------------------------------------------------------------------ */
/* 读输出                                                              */
/* ------------------------------------------------------------------ */

export type StreamEvent =
  /** 正文多出来的一小段（逐字流式） */
  | { type: "delta"; text: string }
  /** 一条完整的助手消息。没开逐字流式时，正文只能从这里拿 */
  | { type: "message"; text: string }
  /** 最后一行：成没成、结果是什么 */
  | { type: "result"; ok: boolean; text: string; structured: unknown };

/** stream-json 的一行 → 事件。和这次调用无关的行（初始化、限流通知、思考过程）返回 null */
export function readStreamLine(line: string): StreamEvent | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof ev !== "object" || ev === null) return null;

  if (ev.type === "stream_event") {
    const inner = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
      return { type: "delta", text: inner.delta.text };
    }
    return null;
  }

  if (ev.type === "assistant") {
    const content = (ev.message as { content?: { type?: string; text?: string }[] } | undefined)?.content;
    const text = (content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    return text ? { type: "message", text } : null;
  }

  if (ev.type === "result") {
    return {
      type: "result",
      ok: ev.is_error !== true,
      text: typeof ev.result === "string" ? ev.result : "",
      structured: ev.structured_output ?? null,
    };
  }
  return null;
}

/**
 * 把失败说成人话。最常见的是「装了但没登录 / 登录过期」，那时 claude
 * 给的是一句英文加斜杠命令，而用户此刻不在终端里。
 */
export function explainFailure(detail: string): string {
  const text = detail.trim();
  if (/login|log in|api key|authenticat|oauth|unauthorized|\b401\b|credential/i.test(text)) {
    return `Claude Code 还没登录，或者登录已经过期。请在终端里运行一次 claude 完成登录，再回来重试。${
      text ? `（原始信息：${text.slice(0, 200)}）` : ""
    }`;
  }
  if (/rate.?limit|overloaded|\b429\b|\b529\b|usage limit|quota/i.test(text)) {
    return `Claude 暂时用不了：用量到了上限，或者服务正忙。过一会儿再重试。（原始信息：${text.slice(0, 200)}）`;
  }
  return text ? text.slice(0, 500) : "claude 没有返回任何内容就退出了";
}

/* ------------------------------------------------------------------ */
/* 起进程                                                              */
/* ------------------------------------------------------------------ */

export type ClaudeResult =
  | { ok: true; text: string; structured: unknown }
  | { ok: false; error: string; cancelled: boolean };

export interface ClaudeRun {
  done: Promise<ClaudeResult>;
  cancel(): void;
}

export async function askClaude(
  prompt: string,
  opts: {
    /** 有值 = 要结构化输出；没有 = 普通文本，逐字流式 */
    schema?: string;
    /** 正文每多一段就调一次，参数是**到目前为止的全文** */
    onText?: (soFar: string) => void;
  } = {},
): Promise<ClaudeRun> {
  // 先挂监听再起进程，否则快的那几行输出会在监听挂上之前到达，直接丢掉
  await ensureProcListener();
  const runId = await api.aiReviewRun(prompt, opts.schema ?? null);

  let streamed = "";
  let lastMessage = "";
  // 断言而不是标注：它在回调里被赋值，标注的话 TS 会认定它永远是 null
  let result = null as Extract<StreamEvent, { type: "result" }> | null;
  const stderr: string[] = [];
  let cancelled = false;

  let finish!: (r: ClaudeResult) => void;
  const done = new Promise<ClaudeResult>((resolve) => {
    finish = resolve;
  });

  attachRun(runId, {
    onStdout(line) {
      const ev = readStreamLine(line);
      if (!ev) return;
      if (ev.type === "delta") {
        streamed += ev.text;
        opts.onText?.(streamed);
      } else if (ev.type === "message") {
        lastMessage = ev.text;
      } else {
        result = ev;
      }
    },
    onStderr(line) {
      if (line.trim()) stderr.push(line.trim());
    },
    finish(code) {
      if (cancelled) return finish({ ok: false, error: "已取消", cancelled: true });
      if (result?.ok) {
        // result.text 是权威全文；流式攒的那份只在它缺席时兜底
        return finish({
          ok: true,
          text: result.text || streamed || lastMessage,
          structured: result.structured,
        });
      }
      const detail = result?.text || stderr.slice(-5).join("\n") || (code != null ? `退出码 ${code}` : "");
      finish({ ok: false, error: explainFailure(detail), cancelled: false });
    },
  });

  return {
    done,
    cancel() {
      cancelled = true;
      void api.pluginKill(runId).catch(() => {});
    },
  };
}
